import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SESSION_TITLE_LENGTH, SessionStore } from "../src";
import type { AgentSession, ModeTransition, ToolCallRecord } from "@freebuff/agent-core";

let hasSqlJs = true;
try {
  // Keep the package's test command useful in an offline checkout. CI and
  // consumers install the declared sql.js dependency and execute all tests.
  require("sql.js");
} catch {
  hasSqlJs = false;
}

const maybe = hasSqlJs ? test : test.skip;

const session: AgentSession = {
  id: "session-1",
  workspaceId: "workspace-1",
  title: "Storage test",
  createdAt: 100,
  updatedAt: 100,
  activeMode: "implement",
  providerId: "fake",
  modelId: "fake-model",
  status: "idle",
};

async function withStore(run: (store: SessionStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const path = join(directory, "sessions.sqlite");
  try {
    const store = await SessionStore.open({ filePath: path, now: () => 1_000 });
    try {
      await run(store, path);
    } finally {
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SessionStore", () => {
  maybe("persists normalized and provider transcripts across reopen", async () => {
    await withStore(async (store, path) => {
      await store.createSession(session);
      await store.appendMessage(session.id, {
        role: "assistant",
        content: "answer",
        providerFrames: [{ providerId: "fake", modelId: "fake-model", sequence: 1, payload: { opaque: true } }],
      });
      await store.appendProviderMessage(session.id, { providerId: "fake", modelId: "fake-model", payload: { raw: "frame" } });
      await store.close();
      const reopened = await SessionStore.open({ filePath: path });
      try {
        const snapshot = await reopened.openSession(session.id);
        expect(snapshot?.messages).toHaveLength(1);
        expect(snapshot?.messages[0].message.providerFrames).toHaveLength(1);
        expect(snapshot?.providerMessages[0].payload).toEqual({ raw: "frame" });
        const exported = await reopened.exportSession(session.id);
        expect(exported?.messages[0].message.providerFrames).toBeUndefined();
        expect(exported?.providerMessages).toBeUndefined();
      } finally {
        await reopened.close();
      }
    });
  });

  maybe("records the core step, tool, approval, transition, and usage shapes", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.appendStep({ id: "step-1", sessionId: session.id, sequence: 1, status: "running", startedAt: 101 });
      const call: ToolCallRecord = { id: "call-1", sessionId: session.id, stepId: "step-1", toolName: "read_file", rawArguments: "{}", status: "running" };
      await store.recordToolCall(call);
      await store.recordApproval({ id: "approval-1", sessionId: session.id, callId: call.id, request: { toolName: call.toolName, path: "src/index.ts" }, mode: "implement", policyRevision: "p1", scope: { kind: "turn" }, workspaceTrusted: true, createdAt: 102 });
      await store.recordToolResult({ sessionId: session.id, stepId: "step-1", callId: call.id, result: { content: "ok" }, createdAt: 103 });
      await store.updateStep("step-1", { status: "completed", endedAt: 104, finishReason: "tool_calls" });
      const transition: ModeTransition = { from: "plan", to: "implement", timestamp: 105, reason: "plan-approved" };
      await store.recordModeTransition(session.id, transition);
      await store.recordUsage({ id: "usage-1", sessionId: session.id, stepId: "step-1", inputTokens: 3, outputTokens: 4, createdAt: 106 });
      const snapshot = await store.openSession(session.id);
      expect(snapshot?.steps[0].status).toBe("completed");
      expect(snapshot?.toolCalls[0].toolName).toBe("read_file");
      expect(snapshot?.toolResults[0].result.content).toBe("ok");
      expect(snapshot?.approvals[0].policyRevision).toBe("p1");
      expect(snapshot?.modeTransitions[0]).toEqual(transition);
      expect(snapshot?.usage[0].totalTokens).toBe(7);
    });
  });

  maybe("recovers running sessions and pending approvals after a host restart", async () => {
    await withStore(async (store, path) => {
      await store.createSession({ ...session, status: "waiting_for_approval" });
      await store.appendStep({ id: "step-1", sessionId: session.id, sequence: 1, status: "waiting_for_approval", startedAt: 101 });
      await store.recordToolCall({ id: "call-1", sessionId: session.id, stepId: "step-1", toolName: "write_file", rawArguments: "{}", status: "awaiting_approval" });
      await store.recordApproval({ id: "approval-1", sessionId: session.id, callId: "call-1", request: { toolName: "write_file" }, createdAt: 102 });
      await store.close();
      const reopened = await SessionStore.open({ filePath: path, now: () => 2_000 });
      try {
        expect(reopened.lastRecovery).toEqual({ sessionIds: [session.id], approvalIds: ["approval-1"] });
        expect((await reopened.getSession(session.id))?.status).toBe("cancelled");
        expect((await reopened.openSession(session.id))?.approvals[0].decision).toEqual({ effect: "deny", source: "hard-safety", reason: "Approval expired when the host restarted." });
      } finally {
        await reopened.close();
      }
    });
  });

  maybe("bounds exports and writes an actual SQLite file atomically", async () => {
    await withStore(async (store, path) => {
      await store.createSession(session);
      await store.appendMessage(session.id, { role: "user", content: "one" });
      await store.appendMessage(session.id, { role: "assistant", content: "two" });
      const exported = await store.exportSession(session.id, { limit: 1 });
      expect(exported?.messages).toHaveLength(1);
      expect(exported?.truncated).toBe(true);
      const bytes = await readFile(path);
      expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\0");
    });
  });

  maybe("renames a session within its workspace and persists the trimmed title", async () => {
    await withStore(async (store, path) => {
      await store.createSession(session);

      const renamed = await store.renameSession(session.id, "  A better title  ", { workspaceId: session.workspaceId });
      expect(renamed).toMatchObject({ id: session.id, workspaceId: session.workspaceId, title: "A better title" });
      expect(renamed?.updatedAt).toBe(1_000);
      expect(await store.renameSession(session.id, "wrong workspace", { workspaceId: "another-workspace" })).toBeUndefined();
      expect(await store.getSession(session.id, { workspaceId: "another-workspace" })).toBeUndefined();
      expect(await store.getSession(session.id, { workspaceId: session.workspaceId })).toMatchObject({ title: "A better title" });

      await store.close();
      const reopened = await SessionStore.open({ filePath: path });
      try {
        expect((await reopened.getSession(session.id))?.title).toBe("A better title");
      } finally {
        await reopened.close();
      }
    });
  });

  maybe("deletes only the scoped session and cascades every related record", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.appendMessage(session.id, { id: "message-1", role: "user", content: "hello" });
      await store.appendProviderMessage(session.id, { id: "provider-1", providerId: "fake", modelId: "fake-model", payload: { raw: true } });
      await store.appendStep({ id: "step-1", sessionId: session.id, sequence: 1, status: "completed", startedAt: 101, endedAt: 102 });
      await store.recordToolCall({ id: "call-1", sessionId: session.id, stepId: "step-1", toolName: "read_file", rawArguments: "{}", status: "completed" });
      await store.recordToolResult({ id: "result-1", sessionId: session.id, stepId: "step-1", callId: "call-1", result: { content: "ok" }, createdAt: 103 });
      await store.recordApproval({ id: "approval-1", sessionId: session.id, callId: "call-1", request: { toolName: "read_file" }, createdAt: 104 });
      await store.recordModeTransition(session.id, { from: "plan", to: "implement", timestamp: 105, reason: "plan-approved" });
      await store.recordUsage({ id: "usage-1", sessionId: session.id, stepId: "step-1", inputTokens: 1, outputTokens: 2, createdAt: 106 });

      expect(await store.deleteSession(session.id, { workspaceId: "another-workspace" })).toBe(false);
      expect(await store.getSession(session.id)).toBeDefined();
      expect(await store.deleteSession(session.id, { workspaceId: session.workspaceId })).toBe(true);
      expect(await store.getSession(session.id)).toBeUndefined();
      expect(await store.openSession(session.id)).toBeUndefined();
      expect(await store.exportSession(session.id)).toBeUndefined();

      // Reusing every child id is a public-interface proof that the cascades
      // removed rows from all related tables, not only the session header.
      await store.createSession({ ...session, title: "Replacement" });
      await store.appendMessage(session.id, { id: "message-1", role: "user", content: "again" });
      await store.appendProviderMessage(session.id, { id: "provider-1", providerId: "fake", modelId: "fake-model", payload: { raw: false } });
      await store.appendStep({ id: "step-1", sessionId: session.id, sequence: 1, status: "completed", startedAt: 201 });
      await store.recordToolCall({ id: "call-1", sessionId: session.id, stepId: "step-1", toolName: "read_file", rawArguments: "{}", status: "completed" });
      await store.recordToolResult({ id: "result-1", sessionId: session.id, stepId: "step-1", callId: "call-1", result: { content: "again" }, createdAt: 203 });
      await store.recordApproval({ id: "approval-1", sessionId: session.id, callId: "call-1", request: { toolName: "read_file" }, createdAt: 204 });
      await store.recordModeTransition(session.id, { from: "plan", to: "implement", timestamp: 205, reason: "plan-approved" });
      await store.recordUsage({ id: "usage-1", sessionId: session.id, stepId: "step-1", inputTokens: 1, outputTokens: 2, createdAt: 206 });
      expect((await store.openSession(session.id))?.messages[0].message.content).toBe("again");
    });
  });

  maybe("supports explicit host-only provider export while retaining bounded safe defaults", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.appendMessage(session.id, {
        role: "assistant",
        content: "answer",
        providerFrames: [{ providerId: "fake", modelId: "fake-model", sequence: 1, payload: { opaque: true } }],
      });
      await store.appendProviderMessage(session.id, { providerId: "fake", modelId: "fake-model", payload: { raw: "frame" } });

      const safe = await store.exportSession(session.id);
      expect(safe?.messages[0].message.providerFrames).toBeUndefined();
      expect(safe?.providerMessages).toBeUndefined();

      const hostOnly = await store.exportSession(session.id, {
        includeProviderFrames: true,
        includeProviderMessages: true,
        limit: 1,
      });
      expect(hostOnly?.messages[0].message.providerFrames).toHaveLength(1);
      expect(hostOnly?.providerMessages).toHaveLength(1);
      expect(hostOnly?.truncated).toBe(false);
      expect(await store.exportSession(session.id, { workspaceId: "another-workspace" })).toBeUndefined();
    });
  });

  maybe("rejects empty and overlong session titles", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await expect(store.renameSession(session.id, "   ")).rejects.toThrow("non-empty");
      await expect(store.renameSession(session.id, "x".repeat(MAX_SESSION_TITLE_LENGTH + 1))).rejects.toThrow(String(MAX_SESSION_TITLE_LENGTH));
    });
  });
});
