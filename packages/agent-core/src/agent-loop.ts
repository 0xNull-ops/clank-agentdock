import {
  AgentEvent,
  AgentLoopOptions,
  AgentRunResult,
  AgentTool,
  NormalizedMessage,
  NormalizedProviderError,
  PermissionRequest,
  ProviderFrame,
  ToolCallRecord,
  ToolExecutionResult,
} from "./types";
import { globMatches, PermissionEngine } from "./permissions";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (!tool.name || !tool.execute) throw new Error("A tool must have a name and execute function");
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: AgentTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  definitions(): AgentTool[] {
    return this.list();
  }
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function errorResult(message: string, code: string, extra: Record<string, unknown> = {}): ToolExecutionResult {
  return { isError: true, content: JSON.stringify({ error: code, message, ...extra }) };
}

function toError(error: unknown): NormalizedProviderError {
  if (error && typeof error === "object" && "message" in error) {
    const value = error as { message: string; code?: string; status?: number; retryable?: boolean };
    return { message: value.message, code: value.code, status: value.status, retryable: value.retryable ?? false, raw: error };
  }
  return { message: String(error), retryable: false, raw: error };
}

/**
 * Provider-independent multi-step tool loop. The provider is only responsible
 * for streaming normalized events; all tool policy and execution happens here.
 */
export async function runAgent(options: AgentLoopOptions): Promise<AgentRunResult> {
  const {
    session,
    provider,
    mode,
    systemPrompt,
    signal,
    onEvent,
    approve,
    permissionEngine,
  } = options;
  const abort = signal ?? new AbortController().signal;
  const maxSteps = options.maxSteps ?? mode.steps;
  const tools = new ToolRegistry();
  tools.registerMany((options.tools ?? []).filter((tool) =>
    mode.tools.some((pattern) => globMatches(pattern, tool.name)),
  ));
  const messages: NormalizedMessage[] = [...(options.initialMessages ?? [])];
  if (systemPrompt) messages.unshift({ role: "system", content: systemPrompt });
  const effectivePermissionEngine = permissionEngine ?? new PermissionEngine({ mode: mode.permission });
  const emit = (event: AgentEvent): void => onEvent?.(event);
  const fixedModel = mode.modelPolicy === "fixed";
  const model = fixedModel ? mode.model : options.model ?? mode.model ?? session.modelId;
  if (!model) {
    const error = { message: `Mode ${mode.slug} has a fixed model policy but no model is configured.`, code: "FIXED_MODEL_MISSING", retryable: false };
    emit({ type: "agent_error", sessionId: session.id, error });
    emit({ type: "session_completed", sessionId: session.id, status: "error" });
    return { status: "error", messages, steps: 0, error };
  }
  if (fixedModel && options.model && options.model !== model) {
    emit({ type: "model_override_rejected", sessionId: session.id, requestedModel: options.model, activeModel: model, reason: `Mode ${mode.name} requires the fixed model ${model}.` });
  }

  emit({ type: "session_started", session: { ...session, status: "running", updatedAt: Date.now() } });

  let capabilities;
  try {
    capabilities = await provider.capabilities(model);
  } catch (error) {
    const normalized = toError(error);
    emit({ type: "agent_error", sessionId: session.id, error: normalized });
    emit({ type: "session_completed", sessionId: session.id, status: "error" });
    return { status: "error", messages, steps: 0, error: normalized };
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    if (abort.aborted) {
      emit({ type: "session_completed", sessionId: session.id, status: "cancelled" });
      return { status: "cancelled", messages, steps: step - 1 };
    }
    const stepId = id("step");
    emit({ type: "step_started", sessionId: session.id, stepId, step });
    let finishReason: string | undefined;
    let providerMetadata: Record<string, unknown> = {};
    let providerFrames: ProviderFrame[] = [];
    const request = {
      model,
      messages: [...messages],
      ...(capabilities.tools ? { tools: tools.definitions().map(({ execute: _execute, ...definition }) => definition), toolChoice: "auto" as const } : {}),
      ...(capabilities.tools && capabilities.parallelTools ? { parallelToolCalls: true } : {}),
      ...(capabilities.temperature ? { temperature: mode.temperature } : {}),
      topP: mode.topP,
      maxOutputTokens: mode.maxOutputTokens,
      ...(capabilities.reasoning ? { reasoningEffort: mode.reasoningEffort } : {}),
    };

    let assistantText = "";
    let reasoningText = "";
    let providerError: NormalizedProviderError | undefined;
    const calls = new Map<string, { id: string; name: string; arguments: string; index?: number }>();
    const callOrder: string[] = [];
    try {
      for await (const event of provider.streamChat(request, abort)) {
        if (abort.aborted) {
          emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: "cancelled" });
          emit({ type: "session_completed", sessionId: session.id, status: "cancelled" });
          return { status: "cancelled", messages, steps: step - 1 };
        }
        switch (event.type) {
          case "message_start":
            break;
          case "text_delta":
            assistantText += event.text;
            emit({ type: "text_delta", sessionId: session.id, stepId, text: event.text });
            break;
          case "reasoning_delta":
            reasoningText += event.text;
            emit({ type: "reasoning_delta", sessionId: session.id, stepId, text: event.text });
            break;
          case "tool_call_start": {
            const existing = calls.get(event.id);
            if (!existing) {
              callOrder.push(event.id);
              calls.set(event.id, { id: event.id, name: event.name ?? "", arguments: "", index: event.index });
            } else if (event.name) {
              existing.name = event.name;
            }
            const record: ToolCallRecord = {
              id: event.id,
              sessionId: session.id,
              stepId,
              toolName: event.name ?? "",
              rawArguments: "",
              status: "streaming",
            };
            emit({ type: "tool_call_started", call: record });
            break;
          }
          case "tool_call_delta": {
            const existing = calls.get(event.id);
            if (!existing) callOrder.push(event.id);
            const call = existing ?? { id: event.id, name: "", arguments: "", index: event.index };
            if (event.name) call.name = event.name;
            call.arguments += event.argumentsDelta;
            calls.set(event.id, call);
            break;
          }
          case "tool_call_end":
            break;
          case "usage":
            emit({ type: "usage_updated", sessionId: session.id, inputTokens: event.inputTokens, outputTokens: event.outputTokens });
            break;
          case "message_end":
            finishReason = event.finishReason;
            if (event.providerMetadata) Object.assign(providerMetadata, event.providerMetadata);
            if (event.providerFrames?.length) providerFrames.push(...event.providerFrames);
            break;
          case "provider_frame":
            providerFrames.push(event.frame);
            break;
          case "error":
            providerError = event.error;
            break;
        }
        if (providerError) break;
      }
    } catch (error) {
      if (abort.aborted) {
        emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: "cancelled" });
        emit({ type: "session_completed", sessionId: session.id, status: "cancelled" });
        return { status: "cancelled", messages, steps: step - 1 };
      }
      providerError = toError(error);
    }
    if (providerError) {
      emit({ type: "agent_error", sessionId: session.id, error: providerError });
      emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: "error" });
      emit({ type: "session_completed", sessionId: session.id, status: "error" });
      return { status: "error", messages, steps: step, error: providerError };
    }

    const orderedCalls = callOrder.map((callId) => calls.get(callId)!).filter(Boolean);
    const assistant: NormalizedMessage = {
      role: "assistant",
      content: assistantText,
      ...(orderedCalls.length ? { toolCalls: orderedCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })) } : {}),
      ...(reasoningText ? { providerMetadata: { ...providerMetadata, reasoningSummary: reasoningText } } : Object.keys(providerMetadata).length ? { providerMetadata } : {}),
      ...(providerFrames.length ? { providerFrames } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
    // Keep exactly one assistant transcript entry for every successful provider
    // response, including an empty response with only opaque metadata.
    messages.push(assistant);

    if (!orderedCalls.length) {
      emit({ type: "step_completed", sessionId: session.id, stepId, finishReason });
      emit({ type: "session_completed", sessionId: session.id, status: "idle" });
      return { status: "completed", messages, steps: step, finishReason };
    }

    for (const call of orderedCalls) {
      if (abort.aborted) {
        emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: "cancelled" });
        emit({ type: "session_completed", sessionId: session.id, status: "cancelled" });
        return { status: "cancelled", messages, steps: step - 1 };
      }
      const record: ToolCallRecord = {
        id: call.id,
        sessionId: session.id,
        stepId,
        toolName: call.name,
        rawArguments: call.arguments,
        status: "streaming",
      };
      const tool = tools.get(call.name);
      if (!tool || !capabilities.tools) {
        const result = errorResult(
          tool ? `Tool is unsupported by model ${model}: ${call.name}` : `Unknown tool: ${call.name}`,
          tool ? "UNSUPPORTED_TOOL" : "UNKNOWN_TOOL",
          { availableTools: capabilities.tools ? tools.list().map((item) => item.name) : [] },
        );
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
        emit({ type: "tool_completed", call: { ...record, status: "failed", endedAt: Date.now() }, result });
        continue;
      }

      let input: unknown;
      try {
        input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      } catch {
        const result = errorResult("Tool arguments are not valid JSON. Return a corrected JSON object and retry once.", "INVALID_ARGUMENTS", { tool: call.name });
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
        emit({ type: "tool_completed", call: { ...record, status: "failed", endedAt: Date.now() }, result });
        continue;
      }

      const permissionRequest: PermissionRequest = {
        toolName: call.name,
        input,
        path: extractString(input, ["path", "file", "filePath"]),
        command: extractString(input, ["command", "cmd"]),
      };
      const decision = effectivePermissionEngine.evaluate(permissionRequest);
      const permittedRecord = { ...record, parsedArguments: input, permissionDecision: decision.effect };
      if (decision.effect === "deny") {
        const result = errorResult(decision.reason ?? "Permission denied.", "PERMISSION_DENIED");
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
        emit({ type: "tool_completed", call: { ...permittedRecord, status: "denied", endedAt: Date.now() }, result });
        continue;
      }
      if (decision.effect === "ask") {
        const approval = { call: { ...permittedRecord, status: "awaiting_approval" as const }, request: permissionRequest, decision };
        emit({ type: "tool_approval_required", approval });
        if (!approve) {
          emit({ type: "session_completed", sessionId: session.id, status: "waiting_for_approval" });
          return { status: "waiting_for_approval", messages, steps: step, finishReason: "approval_required" };
        }
        const approvalResult = await awaitWithAbort(approve(approval), abort);
        if (approvalResult.aborted) {
          const result = errorResult("Tool call cancelled while awaiting approval.", "CANCELLED");
          messages.push({ role: "tool", toolCallId: call.id, content: result.content });
          emit({ type: "tool_completed", call: { ...permittedRecord, status: "cancelled", endedAt: Date.now() }, result });
          emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: "cancelled" });
          emit({ type: "session_completed", sessionId: session.id, status: "cancelled" });
          return { status: "cancelled", messages, steps: step - 1 };
        }
        if (approvalResult.value !== "allow") {
          const result = errorResult("User denied this tool call.", "PERMISSION_DENIED");
          messages.push({ role: "tool", toolCallId: call.id, content: result.content });
          emit({ type: "tool_completed", call: { ...permittedRecord, status: "denied", endedAt: Date.now() }, result });
          continue;
        }
        const revalidated = effectivePermissionEngine.evaluate(permissionRequest);
        if (revalidated.effect === "deny") {
          const result = errorResult(revalidated.reason ?? "Permission changed while approval was pending.", "PERMISSION_REVOKED");
          messages.push({ role: "tool", toolCallId: call.id, content: result.content });
          emit({ type: "tool_completed", call: { ...permittedRecord, status: "denied", endedAt: Date.now() }, result });
          continue;
        }
      }

      const running = { ...permittedRecord, status: "running" as const, startedAt: Date.now() };
      emit({ type: "tool_started", call: running });
      let result: ToolExecutionResult;
      try {
        const execution = await awaitWithAbort(tool.execute(input, {
          sessionId: session.id,
          stepId,
          signal: abort,
          emit: (text) => emit({ type: "tool_output_delta", sessionId: session.id, stepId, callId: call.id, text }),
        }), abort);
        if (execution.aborted) {
          result = errorResult("Tool call cancelled.", "CANCELLED");
          messages.push({ role: "tool", toolCallId: call.id, content: result.content });
          emit({ type: "tool_completed", call: { ...running, status: "cancelled", endedAt: Date.now() }, result });
          emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: "cancelled" });
          emit({ type: "session_completed", sessionId: session.id, status: "cancelled" });
          return { status: "cancelled", messages, steps: step - 1 };
        }
        const output = execution.value;
        result = typeof output === "string" ? { content: output } : { content: JSON.stringify(output) ?? String(output) };
      } catch (error) {
        result = errorResult(toError(error).message, "TOOL_EXECUTION_ERROR");
      }
      messages.push({ role: "tool", toolCallId: call.id, content: result.content });
      emit({ type: "tool_completed", call: { ...running, status: result.isError ? "failed" : "completed", endedAt: Date.now() }, result });
    }
    emit({ type: "step_completed", sessionId: session.id, stepId, finishReason: finishReason ?? "tool_calls" });
  }

  emit({ type: "session_completed", sessionId: session.id, status: "idle" });
  return { status: "max_steps", messages, steps: maxSteps, finishReason: "max_steps" };
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve({ aborted: false, value }); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function extractString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}
