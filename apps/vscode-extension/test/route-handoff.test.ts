import { describe, expect, test } from "bun:test";
import type { NormalizedMessage } from "@freebuff/agent-core";
import { planRouteHandoff } from "../src/runtime/route-handoff";

const route = (providerId: string, modelId: string) => ({ providerId, modelId });

describe("mid-conversation route handoff", () => {
  test("does nothing when the route is unchanged", () => {
    const history: NormalizedMessage[] = [{ role: "user", content: "hi" }];
    expect(planRouteHandoff(route("p", "m"), route("p", "m"), history)).toBeUndefined();
  });

  test("does nothing on the first turn of a session", () => {
    expect(planRouteHandoff(undefined, route("p", "m"), [{ role: "user", content: "hi" }])).toBeUndefined();
    expect(planRouteHandoff(route("p", "m"), route("p", "other"), [])).toBeUndefined();
  });

  test("drops provider reasoning metadata on a model swap but keeps tool pairs", () => {
    const history: NormalizedMessage[] = [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
        providerMetadata: { reasoning_content: "chain of thought" },
        providerFrames: [{ providerId: "p", modelId: "m1", sequence: 0, payload: {} }],
      },
      { role: "tool", content: "file body", toolCallId: "call-1", name: "read_file" },
    ];

    const handoff = planRouteHandoff(route("p", "m1"), route("p", "m2"), history);
    expect(handoff).toBeDefined();
    expect(handoff!.providerChanged).toBe(false);
    expect(handoff!.messages).toHaveLength(3);
    expect(handoff!.messages[1].providerMetadata).toBeUndefined();
    expect(handoff!.messages[1].providerFrames).toBeUndefined();
    // Same provider: correlation ids still line up, so the pair survives intact.
    expect(handoff!.messages[1].toolCalls).toEqual([{ id: "call-1", name: "read_file", arguments: "{}" }]);
    expect(handoff!.messages[2].role).toBe("tool");
  });

  test("folds an unanswered tool call into text when the provider changes", () => {
    const history: NormalizedMessage[] = [
      { role: "user", content: "run the tests" },
      {
        role: "assistant",
        content: "Running them now.",
        toolCalls: [{ id: "call-9", name: "run_command", arguments: "{}" }],
      },
    ];

    const handoff = planRouteHandoff(route("old", "m"), route("new", "m"), history);
    expect(handoff).toBeDefined();
    expect(handoff!.providerChanged).toBe(true);
    expect(handoff!.messages[1].toolCalls).toBeUndefined();
    expect(handoff!.messages[1].content).toContain("Running them now.");
    expect(handoff!.messages[1].content).toContain("run_command");
    expect(handoff!.notice).toContain("old/m");
    expect(handoff!.notice).toContain("new/m");
    expect(handoff!.continuityNote).toContain("handoff");
  });

  test("keeps a partially answered assistant turn's resolved calls only", () => {
    const history: NormalizedMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "done", name: "read_file", arguments: "{}" },
          { id: "pending", name: "run_command", arguments: "{}" },
        ],
      },
      { role: "tool", content: "body", toolCallId: "done", name: "read_file" },
    ];

    const handoff = planRouteHandoff(route("old", "m"), route("new", "m"), history)!;
    expect(handoff.messages[0].toolCalls).toEqual([{ id: "done", name: "read_file", arguments: "{}" }]);
    expect(handoff.messages[0].content).toContain("run_command");
    expect(handoff.messages[1].role).toBe("tool");
  });

  test("rewrites an orphaned tool result as narration on a provider change", () => {
    const history: NormalizedMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", content: "stale output", toolCallId: "vanished", name: "grep" },
    ];

    const handoff = planRouteHandoff(route("old", "m"), route("new", "m"), history)!;
    expect(handoff.messages[1].role).toBe("user");
    expect(handoff.messages[1].toolCallId).toBeUndefined();
    expect(handoff.messages[1].content).toContain("stale output");
    expect(handoff.messages[1].content).toContain("grep");
  });

  test("does not mutate the history it was given", () => {
    const history: NormalizedMessage[] = [
      { role: "assistant", content: "text", providerMetadata: { reasoning: "keep" } },
    ];
    planRouteHandoff(route("old", "m"), route("new", "m"), history);
    expect(history[0].providerMetadata).toEqual({ reasoning: "keep" });
  });
});
