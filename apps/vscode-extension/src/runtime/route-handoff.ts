import type { NormalizedMessage } from "@freebuff/agent-core";

/**
 * Pure helpers for carrying a conversation across a mid-session model or
 * provider change. Kept free of vscode imports so they are directly testable.
 */
export interface RouteHandoff {
  /** History rewritten so the incoming endpoint can accept it. */
  messages: NormalizedMessage[];
  /** Developer-role note appended before the new user turn. */
  continuityNote: string;
  /** Warning surfaced in the transcript. */
  notice: string;
  /** True when the endpoint itself changed, not just the model. */
  providerChanged: boolean;
}

/**
 * Decide whether a route change needs a handoff and, if so, produce a history
 * the new endpoint will accept.
 *
 * A model swap invalidates provider reasoning metadata and opaque frames, which
 * are keyed to the exact model that emitted them. A provider swap additionally
 * invalidates tool-call correlation ids, so any assistant tool call whose result
 * is missing — and any orphaned tool result — is folded into plain text rather
 * than replayed as a dangling call that strict endpoints reject with a 400.
 */
export function planRouteHandoff(
  priorRoute: { providerId: string; modelId: string } | undefined,
  currentRoute: { providerId: string; modelId: string },
  history: readonly NormalizedMessage[],
): RouteHandoff | undefined {
  if (!priorRoute || history.length === 0) return undefined;
  const providerChanged = priorRoute.providerId !== currentRoute.providerId;
  const modelChanged = priorRoute.modelId !== currentRoute.modelId;
  if (!providerChanged && !modelChanged) return undefined;

  const messages = sanitizeHistoryForRoute(history, providerChanged);
  const from = `${priorRoute.providerId}/${priorRoute.modelId}`;
  const to = `${currentRoute.providerId}/${currentRoute.modelId}`;
  const what = providerChanged ? "Provider" : "Model";
  return {
    messages,
    providerChanged,
    notice: `${what} changed mid-conversation (${from} → ${to}). The transcript was carried over, but provider reasoning traces${providerChanged ? " and unfinished tool calls" : ""} were dropped because they are not portable. Start a new session if you want a clean context.`,
    continuityNote: [
      `Conversation handoff: earlier turns in this session were produced by ${from}; you are ${to} continuing the same conversation.`,
      "Reasoning traces from the previous endpoint are unavailable, so rely on the visible transcript above.",
      ...(providerChanged ? ["Tool calls that had not returned before the switch were summarized as text; re-run any tool whose result you still need."] : []),
    ].join(" "),
  };
}

/** Strip endpoint-specific replay state, optionally repairing tool pairing. */
function sanitizeHistoryForRoute(history: readonly NormalizedMessage[], providerChanged: boolean): NormalizedMessage[] {
  const portable = history.map((message) => {
    const { providerMetadata: _metadata, providerFrames: _frames, ...rest } = message;
    return { ...rest } as NormalizedMessage;
  });
  if (!providerChanged) return portable;

  const answeredCallIds = new Set(
    portable.filter((message) => message.role === "tool" && message.toolCallId).map((message) => message.toolCallId as string),
  );
  const issuedCallIds = new Set(
    portable.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []),
  );

  const repaired: NormalizedMessage[] = [];
  for (const message of portable) {
    // An orphaned tool result has no assistant call to attach to on the new
    // endpoint; keep its content as narration instead of a dangling tool turn.
    if (message.role === "tool") {
      if (message.toolCallId && issuedCallIds.has(message.toolCallId)) repaired.push(message);
      else repaired.push({ role: "user", content: `Earlier tool result (${message.name ?? "tool"}): ${flattenContent(message.content)}` });
      continue;
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      repaired.push(message);
      continue;
    }
    const resolved = message.toolCalls.filter((call) => answeredCallIds.has(call.id));
    if (resolved.length === message.toolCalls.length) {
      repaired.push(message);
      continue;
    }
    const dropped = message.toolCalls.filter((call) => !answeredCallIds.has(call.id));
    const narration = `Requested ${dropped.map((call) => call.name).join(", ")} before the endpoint changed; the result was not received.`;
    const text = [flattenContent(message.content), narration].filter(Boolean).join("\n\n");
    if (resolved.length > 0) repaired.push({ ...message, content: text, toolCalls: resolved });
    else {
      const { toolCalls: _calls, ...rest } = message;
      repaired.push({ ...rest, content: text });
    }
  }
  return repaired;
}

function flattenContent(content: NormalizedMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
