/**
 * The explicit UI boundary described in the product spec. Keep these types
 * independent from VS Code and provider SDK types so a future CLI can reuse
 * the same contract.
 */

export type BuiltInAgentMode =
  | "ask"
  | "plan"
  | "architect"
  | "implement"
  | "debug"
  | "review"
  | "orchestrate"
  | "custom";

/** Built-ins plus validated project/global Markdown mode slugs. */
export type AgentMode = BuiltInAgentMode | (string & {});

export type RunState = "idle" | "running" | "awaiting_approval" | "cancelled" | "complete" | "error";

export type UiToExtensionMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string; mode: AgentMode; modelId: string; context: ContextRef[]; skillIds: string[]; images?: Array<{ id: string; name: string; dataUrl: string }> }
  | { type: "changeSkills"; skillIds: string[] }
  | { type: "cancelRun" }
  | { type: "newSession" }
  | { type: "listSessions" }
  | { type: "openSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string }
  | { type: "duplicateSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "exportSession"; sessionId: string }
  | { type: "pickContext" }
  | { type: "changeMode"; mode: AgentMode }
  | { type: "changeModel"; modelId: string }
  | { type: "approveTool"; approvalId: string }
  | { type: "denyTool"; approvalId: string }
  | { type: "approvePlan"; planId: string; revision: number }
  | { type: "revisePlan"; planId: string; revision: number }
  | { type: "savePlan"; planId: string; revision: number }
  | { type: "discardPlan"; planId: string; revision: number }
  | { type: "openCheckpointDiff"; checkpointId: string; path?: string }
  | { type: "revertCheckpoint"; checkpointId: string }
  | { type: "removeContext"; refId: string }
  | { type: "openSettings" }
  | { type: "requestSettings" }
  | { type: "activateProvider"; profileId: string }
  | { type: "setProviderApiKey"; profileId: string }
  | { type: "clearProviderApiKey"; profileId: string }
  | { type: "testProviderConnection"; profileId: string }
  | { type: "fetchProviderModels"; profileId: string }
  | { type: "addProvider" }
  | { type: "editProvider"; profileId: string }
  | { type: "deleteProvider"; profileId: string }
  | { type: "createMode" }
  | { type: "importMode" }
  | { type: "reloadModes" }
  | { type: "openModeSource"; slug: string }
  | { type: "duplicateMode"; slug: string }
  | { type: "deleteMode"; slug: string }
  | { type: "openModeDiagnostic"; source: string; line?: number }
  | { type: "openAdvancedSettings" }
  | { type: "saveDefaultMode"; mode: string }
  | { type: "saveMaxSteps"; steps: number }
  | { type: "saveProviderProfile"; profile: SaveProviderProfileInput }
  | { type: "saveCustomMode"; mode: SaveCustomModeInput }
  | { type: "setupFreebuff"; authToken: string }
  | { type: "setupVibeProxy" }
  | { type: "openExternalUrl"; url: string }
  | { type: "toggleFreebuffSidecar" };

export interface SaveProviderProfileInput {
  id?: string;
  presetId?: string;
  name: string;
  type?: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

export interface SaveCustomModeInput {
  name: string;
  slug: string;
  scope: "project" | "global";
  type: "all" | "primary" | "subagent";
  model?: string;
  provider?: string;
  modelPolicy?: "user-selectable" | "preferred" | "fixed";
  routeOverrides?: boolean;
  delegationAllowed?: boolean;
  allowedAgents?: string[];
  skills?: string[];
  steps: number;
  instructions: string;
  authority: "read" | "write";
}

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

export interface ModelPolicyView {
  policy: "fixed" | "preferred" | "user-selectable";
  modelId?: string;
  reason?: string;
}

export interface SkillOptionView {
  id: string;
  name: string;
  description: string;
  scope: "project" | "global" | "installed";
  sourceKind: "native" | "compatibility" | "installed";
  source?: string;
}

export interface ModeOption {
  id: AgentMode;
  label: string;
  description: string;
  colorToken?: string;
  source?: "built-in" | "global" | "project";
}

export interface ProviderProfileView {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  defaultModel?: string;
  models: { id: string; displayName?: string }[];
  isActive: boolean;
  hasApiKey: boolean;
}

export interface ProviderPresetView {
  id: string;
  name: string;
  description: string;
  category: "cloud" | "local" | "proxy";
  baseUrl: string;
  defaultModel?: string;
  helpUrl?: string;
  helpText?: string;
}

export interface ModeDetailView {
  id: string;
  slug: string;
  name: string;
  description?: string;
  scope: "built-in" | "project" | "global";
  type: "primary" | "subagent" | "all";
  model?: string;
  provider?: string;
  modelPolicy?: "fixed" | "preferred" | "user-selectable";
  steps?: number;
  tools?: string[];
  canManage: boolean;
  colorToken?: string;
}

export interface CustomModeDiagnosticView {
  message: string;
  severity: "error" | "warning";
  source?: string;
  line?: number;
}

export type FreebuffSidecarStatus = "stopped" | "starting" | "running" | "error";

export interface HarnessSettingsState {
  activeProfile?: ProviderProfileView;
  profiles: ProviderProfileView[];
  providerPresets: ProviderPresetView[];
  modes: ModeDetailView[];
  diagnostics: CustomModeDiagnosticView[];
  defaultMode: string;
  defaultModel: string;
  maxSteps: number;
  workspaceName?: string;
  freebuffSidecarStatus?: FreebuffSidecarStatus;
  freebuffSidecarError?: string;
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

export type PlanStatus = "DRAFT" | "READY_FOR_APPROVAL" | "APPROVED" | "IMPLEMENTING" | "BLOCKED" | "COMPLETE" | "SUPERSEDED" | "DISCARDED";

/** Sanitized plan metadata. Markdown and absolute artifact paths stay host-side. */
export interface PlanView {
  id: string;
  title: string;
  status: PlanStatus;
  revision: number;
  artifactLabel: string;
  updatedAt: number;
}

export type ExtensionToUiMessage =
  | { type: "initialize"; sessionId: string; mode: AgentMode; modeOptions: ModeOption[]; modelId: string; modelPolicy: ModelPolicyView; models: ModelOption[]; skills: SkillOptionView[]; selectedSkillIds: string[]; mandatorySkillIds: string[]; messages: ChatMessage[]; tools: ToolActivity[]; subagents: SubagentActivity[]; plan?: PlanView; workspaceName?: string }
  | { type: "sessionList"; sessions: SessionHistoryItem[]; activeSessionId: string }
  | { type: "sessionOpened"; session: SessionHistoryItem; modeOptions: ModeOption[]; modelPolicy: ModelPolicyView; skills: SkillOptionView[]; selectedSkillIds: string[]; mandatorySkillIds: string[]; messages: ChatMessage[]; tools: ToolActivity[]; subagents: SubagentActivity[]; plan?: PlanView }
  | { type: "contextAdded"; ref: ContextRef }
  | { type: "modeChanged"; mode: AgentMode }
  | { type: "modesChanged"; modes: ModeOption[] }
  | { type: "modelChanged"; modelId: string }
  | { type: "modelPolicyChanged"; modelPolicy: ModelPolicyView }
  | { type: "modelsChanged"; models: ModelOption[] }
  | { type: "skillsChanged"; skills: SkillOptionView[]; selectedSkillIds: string[]; mandatorySkillIds: string[] }
  | { type: "runState"; state: RunState; runId?: string }
  | { type: "textDelta"; runId: string; text: string }
  | { type: "assistantMessage"; message: ChatMessage }
  | { type: "toolCall"; tool: ToolActivity }
  | { type: "subagentUpdate"; subagent: SubagentActivity }
  | { type: "approvalRequired"; approval: ToolApproval }
  | { type: "planChanged"; plan?: PlanView }
  | { type: "checkpointSummary"; checkpoint: CheckpointSummaryCard }
  | { type: "checkpointReverted"; checkpointId: string; summary: CheckpointSummaryCard }
  | { type: "checkpointRevertConflict"; checkpointId: string; paths: string[]; message: string }
  | { type: "usageUpdated"; usage: UsageSnapshot }
  | { type: "settingsState"; state: HarnessSettingsState }
  | { type: "providerTestResult"; profileId: string; success: boolean; message: string }
  | { type: "error"; message: string; kind: "provider" | "tool" | "permission" | "workspace" | "unknown" };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  images?: string[];
}

export interface ToolActivity {
  id: string;
  name: string;
  summary: string;
  state: "running" | "complete" | "error";
  detail?: string;
}

export interface SubagentActivity {
  id: string;
  agent: string;
  task: string;
  state: "queued" | "running" | "complete" | "error" | "cancelled";
  depth: number;
  modelId?: string;
  providerId?: string;
  providerName?: string;
  parentRunId?: string;
  summary?: string;
  filesInspected?: string[];
  filesChanged?: string[];
  followups?: string[];
  activities?: Array<{ state: "running" | "complete" | "error"; summary: string; detail?: string }>;
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

export const BUILT_IN_MODES: ReadonlyArray<ModeOption> = [
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
