import type { AgentSession, NormalizedContent, NormalizedMessage } from "@freebuff/agent-core";
import type { SessionSnapshot, SubagentRunRecord } from "@freebuff/agent-storage";
import type { AgentMode, ChatMessage, SessionHistoryItem, SubagentActivity, ToolActivity } from "./protocol";

/** Project the storage/runtime session record into the webview-safe contract. */
export function sessionHistoryItemFromSession(session: AgentSession): SessionHistoryItem {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    activeMode: normalizeMode(session.activeMode),
    modelId: session.modelId,
    status: session.status,
  };
}

/**
 * Convert normalized replay messages into the deliberately small transcript
 * contract. Provider frames, metadata, tool/developer messages, and images
 * never cross the extension/webview boundary.
 */
export function chatMessagesFromNormalized(
  messages: ReadonlyArray<NormalizedMessage>,
  idPrefix = "restored",
): ChatMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textFromContent(message.content);
    if (!text) return [];
    return [{ id: `${idPrefix}-${index}`, role: message.role, text, createdAt: 0 }];
  });
}

/** Recreate compact, bounded tool cards from durable call/result records. */
export function toolActivitiesFromSnapshot(snapshot: SessionSnapshot): ToolActivity[] {
  const results = new Map(snapshot.toolResults.map((result) => [result.callId, result.result]));
  return snapshot.toolCalls.map((call) => {
    const result = results.get(call.id);
    const state: ToolActivity["state"] = result?.isError || ["failed", "denied", "cancelled"].includes(call.status)
      ? "error"
      : call.status === "completed"
        ? "complete"
        : "running";
    return {
      id: call.id,
      name: call.toolName,
      summary: state === "running" ? "Interrupted before completion" : state === "error" ? "Finished with an error" : "Finished",
      state,
      ...(result?.content ? { detail: result.content.slice(0, 32_000) } : {}),
    };
  });
}

/** Project durable, provider-neutral delegated-run metadata into a UI card. */
export function subagentActivityFromRecord(record: SubagentRunRecord): SubagentActivity {
  const agent = normalizeSubagentAgent(record.agent);
  const state: SubagentActivity["state"] = record.status === "completed"
    ? "complete"
    : record.status === "failed" || record.status === "rejected"
      ? "error"
      : record.status;
  const result = record.result;
  return {
    id: record.id,
    agent,
    task: record.taskSummary,
    state,
    depth: record.depth,
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(record.providerId ? { providerId: record.providerId } : {}),
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(result?.summary || result?.error?.message ? { summary: result.summary || result.error?.message } : {}),
    ...(result?.filesInspected?.length ? { filesInspected: [...result.filesInspected] } : {}),
    ...(result?.filesChanged?.length ? { filesChanged: [...result.filesChanged] } : {}),
    ...(result?.followups?.length ? { followups: [...result.followups] } : {}),
  };
}

function normalizeSubagentAgent(value: string): SubagentActivity["agent"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "implement") return "implementer";
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(normalized) ? normalized : "general";
}

function textFromContent(content: NormalizedContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function normalizeMode(value: string): AgentMode {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value) ? value : "ask";
}
