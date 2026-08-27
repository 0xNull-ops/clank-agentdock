/** Provider-independent contracts shared by the harness and its adapters. */

import type { ModelResolutionInput } from "./model-resolution";

export type PermissionEffect = "allow" | "ask" | "deny";

export type ModeType = "primary" | "subagent" | "all";

export type DelegationEffects = "read-only" | "same-as-parent" | "write";

export type ModelPolicy = "fixed" | "preferred" | "user-selectable";

export type BuiltInMode =
  | "ask"
  | "plan"
  | "architect"
  | "implement"
  | "debug"
  | "review"
  | "orchestrate"
  | "custom";

export interface ModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  streaming: boolean;
  tools: boolean;
  parallelTools: boolean;
  reasoning: boolean;
  vision: boolean;
  jsonSchema: boolean;
  temperature: boolean;
}

export interface ModelInfo extends ModelCapabilities {
  id: string;
  displayName?: string;
  providerId?: string;
}

export interface ProviderValidation {
  ok: boolean;
  message?: string;
  status?: number;
}

export type ToolChoice = "auto" | "none" | "required" | Record<string, unknown>;

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type NormalizedContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: NormalizedContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: NormalizedToolCall[];
  /** The provider's terminal reason for this assistant response. */
  finishReason?: string;
  /** Provider-specific fields needed for lossless replay (for example reasoning_content). */
  providerMetadata?: Record<string, unknown>;
  /** Opaque response frames retained for providers that require exact replay. */
  providerFrames?: ProviderFrame[];
}

export interface ProviderFrame {
  providerId: string;
  modelId: string;
  sequence: number;
  payload: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category?: string;
  risk?: "low" | "medium" | "high" | "destructive";
}

export interface NormalizedChatRequest {
  model: string;
  messages: NormalizedMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  metadata?: Record<string, unknown>;
}

export interface NormalizedProviderError {
  code?: string;
  message: string;
  status?: number;
  retryable: boolean;
  raw?: unknown;
}

export type ProviderEvent =
  | { type: "message_start"; id?: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name?: string; index?: number }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string; index?: number; name?: string }
  | { type: "tool_call_end"; id: string; index?: number }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "message_end"; finishReason?: string; providerMetadata?: Record<string, unknown>; providerFrames?: ProviderFrame[] }
  | { type: "provider_frame"; frame: ProviderFrame }
  | { type: "error"; error: NormalizedProviderError };

export interface LLMProvider {
  readonly id: string;
  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(request: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  validateConfig(): Promise<ProviderValidation>;
  capabilities(model: string): Promise<ModelCapabilities>;
}

export interface AgentTool<I = unknown, O = unknown> extends ToolDefinition {
  execute(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolContext {
  sessionId: string;
  stepId: string;
  signal: AbortSignal;
  emit(output: string): void;
}

export interface PermissionRequest {
  toolName: string;
  input?: unknown;
  /** Workspace-relative path for file rules. */
  path?: string;
  /** Shell command for command rules. */
  command?: string;
  reason?: string;
}

export interface PermissionDecision {
  effect: PermissionEffect;
  source: "hard-safety" | "session" | "project" | "mode" | "global" | "tool-default";
  reason?: string;
}

export type PermissionRule =
  | PermissionEffect
  | { effect: PermissionEffect; reason?: string }
  | { pattern: string; effect: PermissionEffect; reason?: string };

export type PermissionValue = PermissionRule | Record<string, PermissionRule>;

export interface PermissionPolicy {
  [toolOrCategory: string]: PermissionValue | undefined;
}

export interface ModeDefinition {
  name: string;
  slug: string;
  description?: string;
  type: ModeType;
  icon?: string;
  colorToken?: string;
  instructions: string;
  model?: string;
  modelPolicy?: ModelPolicy;
  provider?: string;
  temperature?: number;
  topP?: number;
  reasoningEffort?: NormalizedChatRequest["reasoningEffort"];
  maxOutputTokens?: number;
  steps: number;
  tools: string[];
  permission: PermissionPolicy;
  /** Optional declarative scopes used by hosts to derive path/command/MCP policy editors. */
  filePatterns?: string[];
  commandPatterns?: string[];
  mcpToolPatterns?: string[];
  skills: string[];
  skillsMode?: "merge" | "replace";
  toolsMode?: "merge" | "replace";
  delegationAllowed: boolean;
  allowedAgents: string[];
  delegationEffects: DelegationEffects;
  defaultContextSources?: string[];
  responseTemplate?: string;
}

/** Durable lifecycle for a formal Plan artifact. */
export type PlanStatus =
  | "DRAFT"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "IMPLEMENTING"
  | "COMPLETE"
  | "BLOCKED"
  | "SUPERSEDED";

/**
 * Structured, provider-independent sections extracted from a formal Plan
 * artifact. Keeping these fields separate lets Implement consume a compact
 * contract without copying the full Markdown artifact into every request.
 */
export interface PlanContract {
  goal: string;
  currentState: string;
  scope: string;
  nonGoals: string;
  proposedChanges: string;
  filesComponents: string;
  dataApiChanges: string;
  stepByStepImplementation: string;
  tests: string;
  validation: string;
  risksEdgeCases: string;
  rollback: string;
  acceptanceCriteria: string;
}

/** Host-owned durable metadata for one revision of a formal Plan artifact. */
export interface PlanRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  status: PlanStatus;
  revision: number;
  markdown: string;
  contract: PlanContract;
  artifactPath?: string;
  contentHash?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  approvedBy?: "user";
}

export interface ModeTransition {
  from: string;
  to: string;
  timestamp: number;
  reason: "user" | "agent-request" | "plan-approved" | "workflow";
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeMode: string;
  providerId: string;
  modelId: string;
  status: "idle" | "running" | "waiting_for_approval" | "cancelled" | "error";
}

export type ToolCallStatus =
  | "streaming"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled";

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  stepId: string;
  toolName: string;
  rawArguments: string;
  parsedArguments?: unknown;
  permissionDecision?: PermissionEffect;
  status: ToolCallStatus;
  startedAt?: number;
  endedAt?: number;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning_summary"; text: string }
  | { type: "context_ref"; ref: string }
  | { type: "tool_call"; callId: string }
  | { type: "tool_result"; resultId: string }
  | { type: "diff"; diffId: string }
  | { type: "plan"; planId: string }
  | { type: "approval"; approvalId: string };

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  createdAt: number;
  mode?: string;
  providerId?: string;
  modelId?: string;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  resultId?: string;
}

export interface ApprovalRequest {
  call: ToolCallRecord;
  request: PermissionRequest;
  decision: PermissionDecision;
}

export type AgentEvent =
  | { type: "session_started"; session: AgentSession }
  | { type: "mode_changed"; transition: ModeTransition }
  | { type: "model_override_rejected"; sessionId: string; requestedModel: string; activeModel: string; reason: string }
  | { type: "step_started"; sessionId: string; stepId: string; step: number }
  | { type: "text_delta"; sessionId: string; stepId: string; text: string }
  | { type: "reasoning_delta"; sessionId: string; stepId: string; text: string }
  | { type: "tool_call_started"; call: ToolCallRecord }
  | { type: "tool_approval_required"; approval: ApprovalRequest }
  | { type: "tool_started"; call: ToolCallRecord }
  | { type: "tool_output_delta"; sessionId: string; stepId: string; callId: string; text: string }
  | { type: "tool_completed"; call: ToolCallRecord; result: ToolExecutionResult }
  | { type: "usage_updated"; sessionId: string; inputTokens?: number; outputTokens?: number }
  | { type: "step_completed"; sessionId: string; stepId: string; finishReason?: string }
  | { type: "session_completed"; sessionId: string; status: AgentSession["status"] }
  | { type: "agent_error"; sessionId: string; error: NormalizedProviderError };

export type ApprovalHandler = (request: ApprovalRequest) => Promise<"allow" | "deny">;

export interface AgentLoopOptions {
  session: AgentSession;
  provider: LLMProvider;
  mode: ModeDefinition;
  systemPrompt?: string;
  tools?: AgentTool[];
  permissionEngine?: { evaluate(request: PermissionRequest): PermissionDecision };
  approve?: ApprovalHandler;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  initialMessages?: NormalizedMessage[];
  maxSteps?: number;
  /** Optional profile/fallback availability inputs for the pure model resolver. */
  modelResolution?: Omit<ModelResolutionInput, "mode" | "turnOverride" | "sessionSelection"> & {
    turnOverride?: string | null;
    sessionSelection?: string | null;
  };
  model?: string;
}

export interface AgentRunResult {
  status: "completed" | "max_steps" | "cancelled" | "waiting_for_approval" | "error";
  messages: NormalizedMessage[];
  steps: number;
  finishReason?: string;
  error?: NormalizedProviderError;
}
