import { describe, expect, test } from "bun:test";
import { parseSse } from "../src/sse";
import { OpenAICompatibleProvider } from "../src/provider";

async function* chunks(parts: string[]): AsyncIterable<string> { for (const part of parts) yield part; }

function streamResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

describe("SSE parser", () => {
  test("joins data lines across arbitrary chunk boundaries", async () => {
    const result: string[] = [];
    for await (const value of parseSse(chunks(["data: {\"a\":", "1}\n\ndata: [DONE]", "\n"]))) result.push(value);
    expect(result).toEqual(['{"a":1}', "[DONE]"]);
  });

  test("handles CR-only event delimiters and a split CRLF boundary", async () => {
    const result: string[] = [];
    for await (const value of parseSse(chunks(["\uFEFFdata: one\r\rdata: two\r", "\n\r\n"]))) result.push(value);
    expect(result).toEqual(["one", "two"]);
  });
});

describe("OpenAI-compatible provider", () => {
  test("rejects a successful but protocol-incompatible model catalog", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "bad-models",
      baseURL: "http://127.0.0.1:8317/v1",
      fetch: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(provider.listModels()).rejects.toMatchObject({ code: "INVALID_MODELS_RESPONSE" });
  });

  test("normalizes text, reasoning, fragmented tool calls, usage and finish events", async () => {
    const body = [
      'data: {"id":"x","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".ts\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].join("");
    const provider = new OpenAICompatibleProvider({ id: "local", baseURL: "http://localhost/v1", apiKey: "secret", fetch: async () => streamResponse(body) });
    const events = [];
    for await (const event of provider.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(events.some((event) => event.type === "text_delta" && event.text === "Hel")).toBe(true);
    expect(events.some((event) => event.type === "reasoning_delta" && event.text === "think")).toBe(true);
    expect(events.some((event) => event.type === "tool_call_start" && event.id === "c1")).toBe(true);
    expect(events.filter((event) => event.type === "tool_call_delta").map((event: any) => event.argumentsDelta).join("")).toBe('{"path":"a.ts"}');
    expect(events.some((event) => event.type === "usage" && event.inputTokens === 4)).toBe(true);
    expect(events.some((event) => event.type === "message_end" && event.finishReason === "tool_calls")).toBe(true);
  });

  test("sends OpenAI wire shape and preserves assistant reasoning metadata", async () => {
    let captured: any;
    const provider = new OpenAICompatibleProvider({
      id: "minimax",
      baseURL: "http://localhost/v1",
      compatibility: { supportsDeveloperRole: false, requiresAssistantReasoningReplay: true, sendMaxTokensAs: "max_completion_tokens", supportsParallelToolCalls: false },
      fetch: async (_input, init) => { captured = JSON.parse(String(init?.body)); return streamResponse("data: [DONE]\n\n"); },
    });
    for await (const _event of provider.streamChat({
      model: "MiniMax-M2.7",
      messages: [
        { role: "developer", content: "rules" },
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }], providerMetadata: { reasoning_content: "keep me" } },
      ],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      parallelToolCalls: true,
      maxOutputTokens: 100,
    })) { /* consume */ }
    expect(captured.messages[0].role).toBe("system");
    expect(captured.messages[1].tool_calls[0].function.name).toBe("read_file");
    expect(captured.messages[1].reasoning_content).toBe("keep me");
    expect(captured.max_completion_tokens).toBe(100);
    expect(captured.parallel_tool_calls).toBeUndefined();
    expect(captured.authorization).toBeUndefined();
  });

  test("replays restored assistant frames into one assistant message alongside tool history", async () => {
    let captured: any;
    const provider = new OpenAICompatibleProvider({
      id: "minimax",
      baseURL: "http://localhost/v1",
      compatibility: { requiresAssistantFrameReplay: true },
      fetch: async (_input, init) => { captured = JSON.parse(String(init?.body)); return streamResponse("data: [DONE]\n\n"); },
    });
    for await (const _event of provider.streamChat({
      model: "MiniMax-M2.7",
      messages: [
        { role: "user", content: "read this" },
        {
          role: "assistant",
          content: "I will read it.",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }],
          providerFrames: [
            { providerId: "minimax", modelId: "MiniMax-M2.7", sequence: 0, payload: { choices: [{ delta: { role: "assistant", content: "do not duplicate", opaque_before: "first" } }] } },
            { providerId: "minimax", modelId: "MiniMax-M2.7", sequence: 1, payload: { choices: [{ delta: { content: "or leak", opaque_after: { trace: "second" } } }] } },
            { providerId: "other", modelId: "MiniMax-M2.7", sequence: 2, payload: { choices: [{ delta: { unsafe: "foreign" } }] } },
          ],
        },
        { role: "tool", toolCallId: "call-1", content: "file contents" },
      ],
    })) { /* consume */ }

    expect(captured.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(captured.messages.filter((message: any) => message.role === "assistant")).toHaveLength(1);
    expect(captured.messages[1]).toMatchObject({
      role: "assistant",
      content: "I will read it.",
      opaque_before: "first",
      opaque_after: { trace: "second" },
    });
    expect(captured.messages[1].content).not.toContain("do not duplicate");
    expect(captured.messages[1].unsafe).toBeUndefined();
    expect(captured.messages[1].tool_calls[0].function.arguments).toBe('{"path":"a.ts"}');
  });

  test("normalizes retryability for rate limits and server failures", async () => {
    const provider = new OpenAICompatibleProvider({ id: "x", baseURL: "http://localhost/v1", fetch: async () => new Response(JSON.stringify({ error: { message: "slow down", code: "rate_limit" } }), { status: 429 }) });
    await expect(async () => { for await (const _event of provider.streamChat({ model: "m", messages: [] })) { /* consume */ } }).toThrow();
    const validation = await provider.validateConfig();
    expect(validation.ok).toBe(false);
    expect(validation.status).toBe(429);
  });
});
