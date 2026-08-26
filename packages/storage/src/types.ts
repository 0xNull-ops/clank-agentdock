import type {
  AgentSession,
  ModeTransition,
  NormalizedMessage,
  PermissionDecision,
  PermissionRequest,
  ToolCallRecord,
  ToolExecutionResult,
} from "@freebuff/agent-core";

export type StepStatus = "running" | "completed" | "cancelled" | "waiting_for_approval" | "error" | "max_steps";

export interface SessionStoreOptions {
  /** Absolute path to the SQLite database. Use :memory: only for tests. */
  filePath: string;
  /** Injected initializer is useful for browser/WASM hosts and deterministic tests. */
  sqlJs?: SqlJsInitializer;
  /** Override sql.js asset resolution for bundled hosts such as a VSIX. */
  locateFile?: (file: string) => string;
  now?: () => number;
}

export type SqlJsInitializer = (config?: { locateFile?: (file: string) => string }) => Promise<{
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}>;

export interface SqlJsStatement {
  bind(values?: unknown[] | Record<string, unknown>): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

export interface SqlJsDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void;
  exec(sql: string, params?: unknown[] | Record<string, unknown>): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string, params?: unknown[] | Record<string, unknown>): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  sequence: number;
  message: NormalizedMessage;
  createdAt: number;
}

export interface ProviderTranscriptEntry {
  id: string;
  sessionId: string;
  sequence: number;
  providerId: string;
  modelId: string;
  payload: unknown;
  createdAt: number;
}

export interface StepRecord {
  id: string;
  sessionId: string;
  sequence: number;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
  finishReason?: string;
  error?: unknown;
}

export interface StoredToolCall extends ToolCallRecord {
  parsedArguments?: unknown;
}

export interface StoredToolResult {
  id: string;
  sessionId: string;
  stepId: string;
  callId: string;
  result: ToolExecutionResult;
  createdAt: number;
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  callId: string;
  request: PermissionRequest;
  decision?: PermissionDecision | "allow" | "deny";
  mode?: string;
  normalizedTarget?: string;
  policyRevision?: string;
  scope?: unknown;
  expiresAt?: number;
  workspaceTrusted?: boolean;
  createdAt: number;
  decidedAt?: number;
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  stepId?: string;
  providerId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  createdAt: number;
}

export interface SessionSnapshot {
  session: AgentSession;
  messages: StoredMessage[];
  providerMessages: ProviderTranscriptEntry[];
  steps: StepRecord[];
  toolCalls: StoredToolCall[];
  toolResults: StoredToolResult[];
  approvals: ApprovalRecord[];
  modeTransitions: ModeTransition[];
  usage: UsageRecord[];
}

export interface SessionListOptions {
  workspaceId?: string;
  limit?: number;
  beforeUpdatedAt?: number;
}

/** Optional workspace guard for a session operation.
 *
 * Session ids are globally unique, but callers that operate on behalf of a
 * workspace should pass this guard so a stale or misrouted id cannot mutate or
 * export a session belonging to another workspace.
 */
export interface SessionScopeOptions {
  workspaceId?: string;
}

export interface TranscriptOptions extends SessionScopeOptions {
  /** Upper bound per collection. Defaults to 500 and is capped at 2,000. */
  limit?: number;
  /** Include opaque provider transcript rows only when explicitly requested. */
  includeProviderMessages?: boolean;
  /** Include opaque provider frames only for an explicit host-side export. */
  includeProviderFrames?: boolean;
}

export interface SessionExport extends Omit<SessionSnapshot, "providerMessages"> {
  providerMessages?: ProviderTranscriptEntry[];
  exportedAt: number;
  truncated: boolean;
}

export interface RecoveryResult {
  sessionIds: string[];
  approvalIds: string[];
}
