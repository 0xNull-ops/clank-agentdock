import {
  LLMProvider,
  ModelCapabilities,
  ModelInfo,
  NormalizedChatRequest,
  NormalizedMessage,
  NormalizedProviderError,
  ProviderFrame,
  ProviderEvent,
  ProviderValidation,
  ToolDefinition,
} from "@freebuff/agent-core";
import { parseSse } from "./sse";

export interface OpenAICompatibility {
  stripUnsupportedParams?: boolean;
  sendMaxTokensAs?: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole?: boolean;
  reasoningField?: string;
  requiresAssistantReasoningReplay?: boolean;
  /** Replay opaque assistant fields retained in ProviderFrame payloads. */
  requiresAssistantFrameReplay?: boolean;
  supportsParallelToolCalls?: boolean;
  streamUsage?: boolean;
}

export interface OpenAICompatibleConfig {
  id: string;
  name?: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Record<string, Partial<ModelInfo> & { displayName?: string }>;
  modelsFromEndpoint?: boolean;
  compatibility?: OpenAICompatibility;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  parallelTools: true,
  reasoning: false,
  vision: false,
  jsonSchema: false,
  temperature: true,
};

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private readonly config: OpenAICompatibleConfig;
  private readonly requestFetch: typeof globalThis.fetch;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.baseURL) throw new Error("OpenAI-compatible provider baseURL is required");
    this.id = config.id;
    this.config = { ...config, baseURL: config.baseURL.replace(/\/$/, "") };
    this.requestFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.requestFetch(`${this.config.baseURL}/models`, { method: "GET", headers: this.headers(), signal });
    if (!response.ok) throw await this.httpError(response);
    const body = await response.json() as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []).map((item) => {
      const configured = this.config.models?.[String(item.id)] ?? {};
      return {
        ...DEFAULT_CAPABILITIES,
        id: String(item.id),
        providerId: this.id,
        displayName: typeof configured.displayName === "string" ? configured.displayName : String(item.id),
        ...configured,
      } as ModelInfo;
    });
  }

  async validateConfig(): Promise<ProviderValidation> {
    try {
      const response = await this.requestFetch(`${this.config.baseURL}/models`, { method: "GET", headers: this.headers() });
      if (response.ok) return { ok: true, status: response.status };
      // /models is optional; a configured endpoint can still be used manually.
      if (response.status === 404 && Object.keys(this.config.models ?? {}).length > 0) return { ok: true, status: response.status, message: "Endpoint is reachable; model discovery is unavailable." };
      return { ok: false, status: response.status, message: (await response.text()).slice(0, 500) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async capabilities(model: string): Promise<ModelCapabilities> {
    const configured = this.config.models?.[model];
    return { ...DEFAULT_CAPABILITIES, ...(configured ?? {}) };
  }

  async *streamChat(request: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const response = await this.requestFetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(this.toWireRequest(request)),
      signal,
    });
    if (!response.ok) throw await this.httpError(response);
    if (!response.body) throw new Error("Provider returned an empty response body");

    yield { type: "message_start" };
    const chunks = responseChunks(response.body);
    let messageEnded = false;
    let sequence = 0;
    const providerMetadata: Record<string, unknown> = {};
    const calls = new Map<number, { id: string; ended: boolean }>();
    for await (const raw of parseSse(chunks)) {
      if (raw === "[DONE]") {
        if (!messageEnded) yield { type: "message_end" };
        messageEnded = true;
        continue;
      }
      let payload: any;
      try { payload = JSON.parse(raw); } catch {
        yield { type: "error", error: { code: "MALFORMED_SSE", message: "Provider sent malformed SSE JSON.", retryable: false, raw } };
        continue;
      }
      const frame: ProviderFrame = { providerId: this.id, modelId: request.model, sequence: sequence++, payload };
      // Keep opaque frames available to the core transcript without exposing
      // them as normalized text or making the adapter guess their semantics.
      yield { type: "provider_frame", frame };
      if (payload.error) {
        yield { type: "error", error: normalizeHttpError(payload.error, response.status) };
        continue;
      }
      if (payload.usage) yield { type: "usage", inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens };
      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const text = extractText(delta.content);
      if (text) yield { type: "text_delta", text };
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        const key = typeof delta.reasoning_content === "string" ? "reasoning_content" : "reasoning";
        providerMetadata[key] = typeof providerMetadata[key] === "string" ? `${providerMetadata[key]}${reasoning}` : reasoning;
        yield { type: "reasoning_delta", text: reasoning };
      }
      for (const toolCall of delta.tool_calls ?? []) {
        const index = Number(toolCall.index ?? 0);
        const current = calls.get(index);
        const id = String(toolCall.id ?? current?.id ?? `tool_call_${index}`);
        if (!current) {
          calls.set(index, { id, ended: false });
          yield { type: "tool_call_start", id, name: toolCall.function?.name, index };
        }
        const argumentDelta = toolCall.function?.arguments;
        if (typeof argumentDelta === "string" && argumentDelta) yield { type: "tool_call_delta", id, argumentsDelta: argumentDelta, index, name: toolCall.function?.name };
      }
      if (choice.finish_reason) {
        for (const [index, current] of calls) {
          if (!current.ended) {
            current.ended = true;
            yield { type: "tool_call_end", id: current.id, index };
          }
        }
        yield { type: "message_end", finishReason: choice.finish_reason, providerMetadata };
        messageEnded = true;
      }
    }
    if (!messageEnded) yield { type: "message_end", providerMetadata };
  }

  private headers(): Record<string, string> {
    const headers = { ...this.config.headers };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private toWireRequest(request: NormalizedChatRequest): Record<string, unknown> {
    const compatibility = this.config.compatibility ?? {};
    const messages = request.messages.map((message) => this.toWireMessage(message, compatibility, request.model));
    const body: Record<string, unknown> = { model: request.model, messages, stream: true };
    if (request.tools?.length) body.tools = request.tools.map(toWireTool);
    if (request.toolChoice) body.tool_choice = request.toolChoice;
    if (request.parallelToolCalls !== undefined && compatibility.supportsParallelToolCalls !== false) body.parallel_tool_calls = request.parallelToolCalls;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body[compatibility.sendMaxTokensAs ?? "max_tokens"] = request.maxOutputTokens;
    if (request.reasoningEffort && request.reasoningEffort !== "none") body.reasoning_effort = request.reasoningEffort;
    if (compatibility.streamUsage) body.stream_options = { include_usage: true };
    return body;
  }

  private toWireMessage(message: NormalizedMessage, compatibility: OpenAICompatibility, model: string): Record<string, unknown> {
    let role = message.role;
    if (role === "developer" && compatibility.supportsDeveloperRole === false) role = "system";
    const wire: Record<string, unknown> = { role, content: message.content };
    if (message.name) wire.name = message.name;
    if (message.toolCallId) wire.tool_call_id = message.toolCallId;
    if (message.toolCalls) wire.tool_calls = message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
    const replayReasoning = compatibility.requiresAssistantReasoningReplay === true;
    const replayFrames = compatibility.requiresAssistantFrameReplay === true;
    // Keep exact provider metadata available for MiniMax-style reasoning replay,
    // but never allow provider data to replace normalized transcript fields.
    const metadataKeys = new Set<string>();
    if (message.providerMetadata && replayReasoning) {
      for (const [key, value] of Object.entries(message.providerMetadata)) {
        if (REPLAY_RESERVED_FIELDS.has(key)) continue;
        wire[key] = value;
        metadataKeys.add(key);
      }
    }
    // A response can produce many opaque frames, but the normalized contract
    // deliberately stores one assistant message. Merge their provider-only
    // fields into that message instead of appending synthetic assistant turns.
    if (replayFrames && message.role === "assistant" && message.providerFrames?.length) {
      for (const frame of [...message.providerFrames]
        .filter((item) => item.providerId === this.id && item.modelId === model)
        .sort((left, right) => left.sequence - right.sequence)) {
        const fields = assistantFields(frame.payload);
        for (const [key, value] of Object.entries(fields)) {
          if (REPLAY_RESERVED_FIELDS.has(key) || metadataKeys.has(key)) continue;
          wire[key] = key in wire ? mergeReplayField(wire[key], value) : value;
        }
      }
    }
    return wire;
  }

  private async httpError(response: Response): Promise<NormalizedProviderError> {
    let raw: unknown;
    try { raw = await response.json(); } catch { raw = await response.text(); }
    return normalizeHttpError(raw, response.status);
  }
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
  return "";
}

// These fields describe the normalized message or the streaming envelope,
// rather than provider-only assistant state. Replaying them would either
// overwrite canonical text/tool calls or send a response object as a request.
const REPLAY_RESERVED_FIELDS = new Set([
  "role", "content", "tool_calls", "function_call", "name", "tool_call_id",
  "index", "finish_reason", "finish_details", "id", "object", "created",
  "model", "usage", "choices", "delta", "message", "error",
  "system_fingerprint", "service_tier",
]);

function assistantFields(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) return {};
  const choices = Array.isArray(root.choices) ? root.choices : undefined;
  const choice = choices?.length ? asRecord(choices[0]) : undefined;
  const message = choice && asRecord(choice.message);
  if (message) return message;
  const delta = choice && asRecord(choice.delta);
  if (delta) return delta;
  const assistant = asRecord(root.assistant);
  if (assistant) return assistant;
  return root;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mergeReplayField(existing: unknown, incoming: unknown): unknown {
  if (typeof existing === "string" && typeof incoming === "string") {
    if (existing === incoming || existing.endsWith(incoming)) return existing;
    if (incoming.endsWith(existing)) return incoming;
    return `${existing}${incoming}`;
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming].filter((value, index, values) =>
      values.findIndex((candidate) => sameReplayValue(candidate, value)) === index,
    );
  }
  if (asRecord(existing) && asRecord(incoming)) return { ...asRecord(existing), ...asRecord(incoming) };
  return incoming;
}

function sameReplayValue(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return left === right; }
}

function normalizeHttpError(raw: any, status?: number): NormalizedProviderError {
  const message = typeof raw === "string" ? raw : raw?.error?.message ?? raw?.message ?? `Provider request failed (${status ?? "unknown"})`;
  const code = typeof raw === "object" ? raw?.error?.code ?? raw?.code : undefined;
  return { message: String(message), code, status, retryable: status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500), raw };
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}
