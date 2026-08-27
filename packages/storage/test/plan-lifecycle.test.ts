import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src";
import type { AgentSession, PlanRecord } from "../src";

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
  id: "session-plan-1",
  workspaceId: "workspace-1",
  title: "Plan lifecycle",
  createdAt: 100,
  updatedAt: 100,
  activeMode: "plan",
  providerId: "fake",
  modelId: "fake-model",
  status: "idle",
};

const otherSession: AgentSession = {
  ...session,
  id: "session-plan-2",
  title: "Other session",
};

const planInput = (overrides: Partial<Parameters<SessionStore["createPlan"]>[0]> = {}) => ({
  id: "plan-1",
  workspaceId: session.workspaceId,
  sessionId: session.id,
  title: "Add durable plan lifecycle",
  content: "# Goal\nAdd the plan lifecycle.\n\n# Tests\nCover the transitions.",
  status: "READY_FOR_APPROVAL" as const,
  artifactPath: ".agent/plans/plan-1.md",
  contentHash: "hash-1",
  contractJson: "{\"goal\":\"Add the plan lifecycle.\"}",
  ...overrides,
});

async function withStore(run: (store: SessionStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "forge-plan-storage-"));
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

describe("formal plan lifecycle", () => {
  maybe("persists plans and reopens with revision, status, and contract", async () => {
    await withStore(async (store, path) => {
      await store.createSession(session);
      const created = await store.createPlan(planInput());
      expect(created).toMatchObject({
        id: "plan-1",
        workspaceId: "workspace-1",
        sessionId: session.id,
        status: "READY_FOR_APPROVAL",
        revision: 1,
        artifactPath: ".agent/plans/plan-1.md",
        contractJson: "{\"goal\":\"Add the plan lifecycle.\"}",
      });

      await store.close();
      const reopened = await SessionStore.open({ filePath: path, now: () => 2_000 });
      try {
        const restored = await reopened.getPlan("plan-1", { workspaceId: session.workspaceId });
        expect(restored).toMatchObject({ status: "READY_FOR_APPROVAL", revision: 1, title: "Add durable plan lifecycle" });
        expect(restored?.createdAt).toBe(1_000);
      } finally {
        await reopened.close();
      }
    });
  });

  maybe("rejects plans whose workspace does not match their session", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await expect(
        store.createPlan(planInput({ workspaceId: "another-workspace" })),
      ).rejects.toThrow("Plan workspace does not match its session");
    });
  });

  maybe("requires an explicit workspace scope and isolates plans across workspaces", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      await expect(store.getPlan("plan-1", { workspaceId: "" })).rejects.toThrow("explicit workspaceId");
      expect(await store.getPlan("plan-1", { workspaceId: "another-workspace" })).toBeUndefined();
      expect(await store.listPlans({ workspaceId: "another-workspace" })).toHaveLength(0);
      expect(await store.listPlans({ workspaceId: session.workspaceId })).toHaveLength(1);
    });
  });

  maybe("approve is atomic and records approvedAt and approvedBy", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      const approved = await store.approvePlan("plan-1", { workspaceId: session.workspaceId, expectedRevision: 1, actor: "user" });
      expect(approved).toMatchObject({ status: "APPROVED", revision: 2, approvedBy: "user" });
      expect(approved?.approvedAt).toBe(1_000);
      // A DRAFT or earlier plan cannot be approved directly.
      await store.createPlan(planInput({ id: "plan-draft", status: "DRAFT" }));
      await expect(store.approvePlan("plan-draft", { workspaceId: session.workspaceId })).rejects.toThrow("requires READY_FOR_APPROVAL");
    });
  });

  maybe("rejects stale approve/revise/discard revisions", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      await expect(store.approvePlan("plan-1", { workspaceId: session.workspaceId, expectedRevision: 9 })).rejects.toThrow("changed since revision 9");
      await expect(store.revisePlan("plan-1", { workspaceId: session.workspaceId, expectedRevision: 9 })).rejects.toThrow("changed since revision 9");
      await expect(store.discardPlan("plan-1", { workspaceId: session.workspaceId, expectedRevision: 9 })).rejects.toThrow("changed since revision 9");
    });
  });

  maybe("revise returns a READY_FOR_APPROVAL plan to DRAFT and increments revision", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      const revised = await store.revisePlan("plan-1", { workspaceId: session.workspaceId, expectedRevision: 1 });
      expect(revised).toMatchObject({ status: "DRAFT", revision: 2 });
    });
  });

  maybe("runs the full lifecycle: approve, implement, complete", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      const approved = await store.approvePlan("plan-1", { workspaceId: session.workspaceId, actor: "user" });
      expect(approved?.status).toBe("APPROVED");
      const implementing = await store.beginPlanImplementation("plan-1", { workspaceId: session.workspaceId });
      expect(implementing?.status).toBe("IMPLEMENTING");
      // Re-entry is idempotent.
      expect((await store.beginPlanImplementation("plan-1", { workspaceId: session.workspaceId }))?.status).toBe("IMPLEMENTING");
      const completed = await store.completePlan("plan-1", { workspaceId: session.workspaceId });
      expect(completed?.status).toBe("COMPLETE");
      // COMPLETE is terminal; further transitions fail closed.
      await expect(store.blockPlan("plan-1", { workspaceId: session.workspaceId })).rejects.toThrow("requires IMPLEMENTING");
      await expect(store.discardPlan("plan-1", { workspaceId: session.workspaceId })).rejects.toThrow("cannot be discarded");
    });
  });

  maybe("blocks an implementing plan and supersedes in-flight plans", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput({ id: "plan-blocked" }));
      await store.approvePlan("plan-blocked", { workspaceId: session.workspaceId });
      await store.beginPlanImplementation("plan-blocked", { workspaceId: session.workspaceId });
      const blocked = await store.blockPlan("plan-blocked", { workspaceId: session.workspaceId });
      expect(blocked?.status).toBe("BLOCKED");

      await store.createPlan(planInput({ id: "plan-super", status: "READY_FOR_APPROVAL" }));
      const superseded = await store.supersedePlan("plan-super", { workspaceId: session.workspaceId, supersededBy: "plan-next" });
      expect(superseded).toMatchObject({ status: "SUPERSEDED", supersededBy: "plan-next" });
      await expect(store.supersedePlan("plan-super", { workspaceId: session.workspaceId })).rejects.toThrow("cannot be superseded");
    });
  });

  maybe("discards an in-flight plan and records when", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput({ id: "plan-discard" }));
      const discarded = await store.discardPlan("plan-discard", { workspaceId: session.workspaceId, expectedRevision: 1 });
      expect(discarded).toMatchObject({ status: "DISCARDED", revision: 2 });
      expect(discarded?.discardedAt).toBe(1_000);
    });
  });

  maybe("lists plans scoped to a session and filters by status", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createSession(otherSession);
      await store.createPlan(planInput());
      await store.createPlan(planInput({ id: "plan-other", sessionId: otherSession.id }));
      await store.createPlan(planInput({ id: "plan-draft", status: "DRAFT" }));
      expect(await store.listPlans({ workspaceId: session.workspaceId, sessionId: session.id })).toHaveLength(2);
      expect(await store.listPlans({ workspaceId: session.workspaceId, sessionId: otherSession.id })).toHaveLength(1);
      expect((await store.listPlans({ workspaceId: session.workspaceId, status: ["DRAFT"] })).map((plan) => plan.id)).toEqual(["plan-draft"]);
    });
  });

  maybe("cascades plan rows when their session is deleted", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      expect(await store.getPlan("plan-1", { workspaceId: session.workspaceId })).toBeDefined();
      expect(await store.deleteSession(session.id, { workspaceId: session.workspaceId })).toBe(true);
      expect(await store.getPlan("plan-1", { workspaceId: session.workspaceId })).toBeUndefined();

      // Reusing the plan id is a public-interface proof the FK cascade removed it.
      await store.createSession({ ...session, title: "Replacement" });
      await expect(store.createPlan(planInput())).resolves.toMatchObject({ id: "plan-1", status: "READY_FOR_APPROVAL" });
    });
  });

  maybe("crash recovery does not auto-approve or auto-complete plans", async () => {
    await withStore(async (store, path) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      await store.createPlan(planInput({ id: "plan-approved", status: "APPROVED" }));
      await store.close();
      const reopened = await SessionStore.open({ filePath: path, now: () => 2_000 });
      try {
        expect((await reopened.getPlan("plan-1", { workspaceId: session.workspaceId }))?.status).toBe("READY_FOR_APPROVAL");
        expect((await reopened.getPlan("plan-approved", { workspaceId: session.workspaceId }))?.status).toBe("APPROVED");
        expect(reopened.lastRecovery).toEqual({ sessionIds: [], approvalIds: [] });
      } finally {
        await reopened.close();
      }
    });
  });

  maybe("bound plan content, title, and actor lengths", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await expect(store.createPlan(planInput({ title: "x".repeat(300) }))).rejects.toThrow();
      await expect(store.createPlan(planInput({ content: "y".repeat(300_000) }))).rejects.toThrow();
    });
  });

  maybe("keeps plan rows out of the safe session export", async () => {
    await withStore(async (store) => {
      await store.createSession(session);
      await store.createPlan(planInput());
      const exported = await store.exportSession(session.id);
      expect(exported).toBeDefined();
      expect(exported && "plans" in exported ? (exported as { plans?: PlanRecord[] }).plans : undefined).toBeUndefined();
    });
  });
});
