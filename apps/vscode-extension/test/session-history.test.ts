import { describe, expect, test } from "bun:test";
import { chatMessagesFromNormalized, sessionHistoryItemFromSession, toolActivitiesFromSnapshot } from "../src/shared/session-history";

describe("session history UI mapping", () => {
  test("projects session metadata without exposing storage internals", () => {
    expect(sessionHistoryItemFromSession({
      id: "session-1",
      workspaceId: "workspace-a",
      title: "Investigate auth",
      createdAt: 10,
      updatedAt: 20,
      activeMode: "unknown-mode",
      providerId: "secret-provider",
      modelId: "model-a",
      status: "idle",
    })).toEqual({
      id: "session-1",
      title: "Investigate auth",
      createdAt: 10,
      updatedAt: 20,
      activeMode: "ask",
      modelId: "model-a",
      status: "idle",
    });
  });

  test("keeps only text from user and assistant replay messages", () => {
    const providerFrame = { providerId: "secret", modelId: "secret", sequence: 1, payload: { hidden: true } };
    expect(chatMessagesFromNormalized([
      { role: "system", content: "hidden system" },
      { role: "user", content: "hello", providerFrames: [providerFrame] },
      { role: "tool", content: "hidden tool" },
      { role: "assistant", content: [{ type: "image_url", image_url: { url: "secret" } }, { type: "text", text: "visible answer" }], providerMetadata: { hidden: true } },
    ])).toEqual([
      { id: "restored-1", role: "user", text: "hello", createdAt: 0 },
      { id: "restored-3", role: "assistant", text: "visible answer", createdAt: 0 },
    ]);
  });

  test("recreates bounded tool cards from durable call results", () => {
    const snapshot = {
      toolCalls: [{ id: "call-1", toolName: "read_file", status: "completed" }],
      toolResults: [{ callId: "call-1", result: { content: "done" } }],
    } as Parameters<typeof toolActivitiesFromSnapshot>[0];
    expect(toolActivitiesFromSnapshot(snapshot)).toEqual([{
      id: "call-1",
      name: "read_file",
      summary: "Finished",
      state: "complete",
      detail: "done",
    }]);
  });
});
