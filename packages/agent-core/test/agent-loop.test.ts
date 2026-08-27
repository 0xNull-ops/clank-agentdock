import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent-loop";
import { BUILT_IN_MODES } from "../src/modes";
import { LLMProvider, ProviderEvent, AgentSession, AgentTool } from "../src/types";

const session: AgentSession = { id: "s1", workspaceId: "w1", title: "test", createdAt: 1, updatedAt: 1, activeMode: "implement", providerId: "fake", modelId: "fake-model", status: "idle" };
const implement = BUILT_IN_MODES.find((item) => item.slug === "implement")!;

function scriptedProvider(scripts: ProviderEvent[][]): LLMProvider {
  let run = 0;
  return {
    id: "fake",
    validateConfig: async () => ({ ok: true }),
    capabilities: async () => ({ streaming: true, tools: true, parallelTools: true, reasoning: false, vision: false, jsonSchema: true, temperature: true }),
    async *streamChat() { yield* scripts[run++] ?? [{ type: "message_end", finishReason: "stop" }]; },
  };
}

const readTool: AgentTool = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object" },
  async execute(input) { return { path: (input as any).path, value: "hello" }; },
};

describe("agent loop", () => {
  test("emits the durable session boundary before step events", async () => {
    const events: string[] = [];
    await runAgent({
      session,
      provider: scriptedProvider([[{ type: "message_end", finishReason: "stop" }]]),
      mode: implement,
      initialMessages: [{ role: "user", content: "hello" }],
      onEvent: (event) => events.push(event.type),
    });
    expect(events[0]).toBe("session_started");
    expect(events).toContain("step_started");
    expect(events.at(-1)).toBe("session_completed");
  });

  test("executes fragmented tool calls then sends tool result to the next step", async () => {
    const provider = scriptedProvider([
      [
        { type: "tool_call_start", id: "call_1", name: "read_file", index: 0 },
        { type: "tool_call_delta", id: "call_1", argumentsDelta: '{"path":"src/' },
        { type: "tool_call_delta", id: "call_1", argumentsDelta: 'index.ts"}', index: 0 },
        { type: "tool_call_end", id: "call_1", index: 0 },
        { type: "message_end", finishReason: "tool_calls" },
      ],
      [{ type: "text_delta", text: "Done." }, { type: "message_end", finishReason: "stop" }],
    ]);
    const result = await runAgent({ session, provider, mode: implement, tools: [readTool], initialMessages: [{ role: "user", content: "read it" }] });
    expect(result.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.messages.some((item) => item.role === "tool" && item.content.includes("hello"))).toBe(true);
  });

  test("returns structured unknown-tool and invalid-json results without executing mutations", async () => {
    const provider = scriptedProvider([
      [
        { type: "tool_call_start", id: "unknown", name: "not_registered" },
        { type: "tool_call_delta", id: "unknown", argumentsDelta: "{}" },
        { type: "tool_call_start", id: "bad", name: "read_file" },
        { type: "tool_call_delta", id: "bad", argumentsDelta: "not-json" },
        { type: "message_end", finishReason: "tool_calls" },
      ],
      [{ type: "text_delta", text: "Recovered" }, { type: "message_end", finishReason: "stop" }],
    ]);
    const result = await runAgent({ session, provider, mode: implement, tools: [readTool], initialMessages: [{ role: "user", content: "go" }] });
    const errors = result.messages.filter((item) => item.role === "tool").map((item) => item.content);
    expect(errors.some((item) => item.includes("UNKNOWN_TOOL"))).toBe(true);
    expect(errors.some((item) => item.includes("INVALID_ARGUMENTS"))).toBe(true);
  });

  test("stops at approval boundary when no approval handler is attached", async () => {
    const provider = scriptedProvider([[{ type: "tool_call_start", id: "write", name: "write_file" }, { type: "tool_call_delta", id: "write", argumentsDelta: '{"path":"src/a.ts"}' }, { type: "message_end", finishReason: "tool_calls" }]]);
    const result = await runAgent({ session, provider, mode: implement, tools: [{ ...readTool, name: "write_file" }], initialMessages: [{ role: "user", content: "write" }] });
    expect(result.status).toBe("waiting_for_approval");
  });

  test("revalidates permission after approval before executing", async () => {
    let revoked = false;
    let executions = 0;
    const provider = scriptedProvider([
      [{ type: "tool_call_start", id: "write", name: "write_file" }, { type: "tool_call_delta", id: "write", argumentsDelta: '{"path":"src/a.ts"}' }, { type: "message_end", finishReason: "tool_calls" }],
      [{ type: "message_end", finishReason: "stop" }],
    ]);
    const result = await runAgent({
      session,
      provider,
      mode: implement,
      tools: [{ ...readTool, name: "write_file", async execute() { executions += 1; return "written"; } }],
      initialMessages: [{ role: "user", content: "write" }],
      permissionEngine: { evaluate: () => ({ effect: revoked ? "deny" : "ask", source: "mode" }) },
      approve: async () => { revoked = true; return "allow"; },
    });
    expect(executions).toBe(0);
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("PERMISSION_REVOKED"))).toBe(true);
  });

  test("gates tools and unsupported reasoning by provider capabilities", async () => {
    let request: any;
    const provider = scriptedProvider([[{ type: "tool_call_start", id: "read", name: "read_file" }, { type: "tool_call_delta", id: "read", argumentsDelta: "{}" }, { type: "message_end", finishReason: "tool_calls" }]]);
    provider.capabilities = async () => ({ streaming: true, tools: false, parallelTools: false, reasoning: false, vision: false, jsonSchema: false, temperature: false });
    provider.streamChat = async function* (value) { request = value; yield* [{ type: "tool_call_start", id: "read", name: "read_file" }, { type: "tool_call_delta", id: "read", argumentsDelta: "{}" }, { type: "message_end", finishReason: "tool_calls" }] as ProviderEvent[]; };
    const result = await runAgent({ session, provider, mode: implement, tools: [readTool], initialMessages: [{ role: "user", content: "read it" }], maxSteps: 1 });
    expect(request.tools).toBeUndefined();
    expect(request.reasoningEffort).toBeUndefined();
    expect(result.messages.some((item) => item.role === "tool" && item.content.includes("UNSUPPORTED_TOOL"))).toBe(true);
  });

  test("retains finish reason, provider metadata, and opaque frames once per response", async () => {
    const provider = scriptedProvider([[{ type: "text_delta", text: "Done" }, { type: "message_end", finishReason: "stop", providerMetadata: { reasoning_content: "keep" }, providerFrames: [{ providerId: "fake", modelId: "fake-model", sequence: 1, payload: { raw: true } }] }]]);
    const result = await runAgent({ session, provider, mode: implement, initialMessages: [{ role: "user", content: "go" }] });
    const assistants = result.messages.filter((item) => item.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].finishReason).toBe("stop");
    expect(assistants[0].providerMetadata).toEqual({ reasoning_content: "keep" });
    expect(assistants[0].providerFrames).toHaveLength(1);
  });

  test("honors a preferred mode model before user overrides", async () => {
    let request: any;
    const provider = scriptedProvider([[{ type: "message_end", finishReason: "stop" }]]);
    provider.streamChat = async function* (value) {
      request = value;
      yield { type: "message_end", finishReason: "stop" };
    };
    const mode = { ...implement, model: "preferred-model", modelPolicy: "preferred" as const };
    await runAgent({ session, provider, mode, model: "turn-model", initialMessages: [{ role: "user", content: "go" }] });
    expect(request.model).toBe("preferred-model");
  });

  test("uses a fixed mode model and emits a structured override rejection", async () => {
    let request: any;
    const events: any[] = [];
    const provider = scriptedProvider([[{ type: "message_end", finishReason: "stop" }]]);
    provider.streamChat = async function* (value) {
      request = value;
      yield { type: "message_end", finishReason: "stop" };
    };
    const mode = { ...implement, model: "luna-model", modelPolicy: "fixed" as const };
    await runAgent({ session, provider, mode, model: "turn-model", onEvent: (event) => events.push(event) });
    expect(request.model).toBe("luna-model");
    expect(events.find((event) => event.type === "model_override_rejected")).toMatchObject({
      requestedModel: "turn-model",
      activeModel: "luna-model",
    });
  });
});
