/**
 * The explicit UI boundary described in the product spec. Keep these types
 * independent from VS Code and provider SDK types so a future CLI can reuse
 * the same contract.
 */

export type AgentMode =
  | "ask"
  | "plan"
  | "architect"
  | "implement"
  | "debug"
  | "review"
  | "orchestrate"
  | "custom";

export type RunState = "idle" | "running" | "awaiting_approval" | "cancelled" | "complete" | "error";

export type UiToExtensionMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string; mode: AgentMode; modelId: string; context: ContextRef[] }
  | { type: "cancelRun" }
  | { type: "newSession" }
  | { type: "listSessions" }
  | { type: "openSession"; sessionId: string }
  | { type: "changeMode"; mode: AgentMode }
  | { type: "changeModel"; modelId: string }
  | { type: "approveTool"; approvalId: string }
  | { type: "denyTool"; approvalId: string }
  | { type: "openCheckpointDiff"; checkpointId: string; path?: string }
  | { type: "revertCheckpoint"; checkpointId: string }
  | { type: "addContext"; ref: ContextRef }
  | { type: "removeContext"; refId: string }
  | { type: "openSettings" };

export interface ContextRef {
  id: string;
  label: string;
  kind: "file" | "selection" | "folder" | "diagnostics";
  uri?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
}

/** UI-safe metadata for a recent workspace session. */
export interface SessionHistoryItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeMode: AgentMode;
  modelId: string;
  status: "idle" | "running" | "waiting_for_approval" | "cancelled" | "error";
}

export type ExtensionToUiMessage =
  | { type: "initialize"; sessionId: string; mode: AgentMode; modelId: string; models: ModelOption[]; messages: ChatMessage[]; tools: ToolActivity[]; workspaceName?: string }
  | { type: "sessionList"; sessions: SessionHistoryItem[]; activeSessionId: string }
  | { type: "sessionOpened"; session: SessionHistoryItem; messages: ChatMessage[]; tools: ToolActivity[] }
  | { type: "modeChanged"; mode: AgentMode }
  | { type: "modelChanged"; modelId: string }
  | { type: "modelsChanged"; models: ModelOption[] }
  | { type: "runState"; state: RunState; runId?: string }
  | { type: "textDelta"; runId: string; text: string }
  | { type: "assistantMessage"; message: ChatMessage }
  | { type: "toolCall"; tool: ToolActivity }
  | { type: "approvalRequired"; approval: ToolApproval }
  | { type: "checkpointSummary"; checkpoint: CheckpointSummaryCard }
  | { type: "checkpointReverted"; checkpointId: string; summary: CheckpointSummaryCard }
  | { type: "checkpointRevertConflict"; checkpointId: string; paths: string[]; message: string }
  | { type: "usageUpdated"; usage: UsageSnapshot }
  | { type: "error"; message: string; kind: "provider" | "tool" | "permission" | "workspace" | "unknown" };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
}

export interface ToolActivity {
  id: string;
  name: string;
  summary: string;
  state: "running" | "complete" | "error";
  detail?: string;
}

export interface ToolApproval {
  id: string;
  toolName: string;
  summary: string;
  reason: string;
  risk: "low" | "medium" | "high";
}

export interface UsageSnapshot {
  usedTokens: number;
  availableTokens: number;
  reservedOutputTokens: number;
}

export interface CheckpointSummaryFile {
  path: string;
  status: "added" | "removed" | "modified";
  binary: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface CheckpointSummaryCard {
  id: string;
  label: string;
  createdAt: number;
  filesChanged: number;
  additions: number;
  removals: number;
  files: CheckpointSummaryFile[];
}

export const BUILT_IN_MODES: ReadonlyArray<{ id: AgentMode; label: string; description: string }> = [
  { id: "ask", label: "Ask", description: "Understand and explain without editing" },
  { id: "plan", label: "Plan", description: "Explore and shape an implementation plan" },
  { id: "architect", label: "Architect", description: "Decide boundaries, interfaces, and tradeoffs" },
  { id: "implement", label: "Implement", description: "Edit, run, test, and iterate" },
  { id: "debug", label: "Debug", description: "Investigate a failure with a hypothesis loop" },
  { id: "review", label: "Review", description: "Inspect changes and report findings" },
  { id: "orchestrate", label: "Orchestrate", description: "Coordinate focused subagents" },
  { id: "custom", label: "Custom", description: "Use a personalized mode definition" }
];

export const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  { id: "openai-compatible", label: "Configure model…", hint: "OpenAI-compatible endpoint" }
];
