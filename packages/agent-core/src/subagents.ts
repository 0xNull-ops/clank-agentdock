import { BUILT_IN_MODES } from "./modes";
import { DelegationEffects, ModeDefinition, ModelPolicy } from "./types";

/** The provider-neutral agents available to an orchestrator. */
export type BuiltInSubagentType =
  | "explore"
  | "general"
  | "test"
  | "review"
  | "research"
  | "implementer";

/** Canonical built-in or host-injected subagent slug. */
export type SubagentType = string;

/** Backwards-compatible name for callers that call an implementer `implement`. */
export type AgentType = string;

export type SubagentAuthority = DelegationEffects;

export interface SubagentDefinition {
  readonly agent: SubagentType;
  readonly slug: SubagentType;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Maximum mutation authority this agent can receive. */
  readonly maxAuthority: DelegationEffects;
  /** Alias useful to adapters that call this field `authority`. */
  readonly authority: DelegationEffects;
  readonly delegationAllowed: boolean;
  readonly allowedAgents: readonly string[];
  readonly type: "subagent";
  readonly model?: string;
  readonly modelPolicy?: ModelPolicy;
  readonly routeOverrides?: boolean;
}

export type AgentDefinition = SubagentDefinition;

const readOnly = (definition: Omit<SubagentDefinition, "type" | "slug" | "authority">): SubagentDefinition => ({
  ...definition,
  slug: definition.agent,
  authority: definition.maxAuthority,
  type: "subagent",
});

/** Built-in subagent definitions from spec §8.7. */
export const BUILT_IN_SUBAGENTS: readonly SubagentDefinition[] = [
  readOnly({
    agent: "explore",
    name: "Explore",
    description: "Read-only codebase investigator.",
    instructions: "Map the relevant repository area, establish facts, and report evidence without modifying files.",
    maxAuthority: "read-only",
    delegationAllowed: false,
    allowedAgents: [],
  }),
  readOnly({
    agent: "general",
    name: "General",
    description: "Broad autonomous worker with ordinary task tools.",
    instructions: "Complete the bounded task with the available tools, validate the result, and report concrete outcomes.",
    maxAuthority: "write",
    delegationAllowed: false,
    allowedAgents: [],
  }),
  readOnly({
    agent: "test",
    name: "Test",
    description: "Focused test and validation worker.",
    instructions: "Design or run focused validation, explain failures, and report reproducible evidence.",
    maxAuthority: "read-only",
    delegationAllowed: false,
    allowedAgents: [],
  }),
  readOnly({
    agent: "review",
    name: "Review",
    description: "Read-only reviewer producing prioritized findings.",
    instructions: "Inspect the requested scope and return prioritized findings with precise file and line references.",
    maxAuthority: "read-only",
    delegationAllowed: false,
    allowedAgents: [],
  }),
  readOnly({
    agent: "research",
    name: "Research",
    description: "Research and documentation worker.",
    instructions: "Gather relevant documentation or repository evidence and distinguish observations from inferences.",
    maxAuthority: "read-only",
    delegationAllowed: false,
    allowedAgents: [],
  }),
  readOnly({
    agent: "implementer",
    name: "Implementer",
    description: "Implementation worker that may modify code when explicitly authorized.",
    instructions: "Inspect first, make focused changes within the delegated scope, validate them, and summarize actual changes.",
    maxAuthority: "write",
    delegationAllowed: false,
    allowedAgents: [],
  }),
];

export const AGENT_DEFINITIONS = BUILT_IN_SUBAGENTS;

export function normalizeAgentType(agent: AgentType | string): SubagentType {
  const normalized = agent.trim().toLowerCase();
  return normalized === "implement" ? "implementer" : normalized as SubagentType;
}

export function getSubagentDefinition(agent: AgentType | string): SubagentDefinition | undefined {
  const normalized = normalizeAgentType(agent);
  return BUILT_IN_SUBAGENTS.find((item) => item.agent === normalized);
}

export interface SubagentContext {
  /** Workspace identity is carried explicitly so adapters cannot accidentally cross workspaces. */
  readonly workspaceId?: string;
  /** Only these selected references are made available to the child. */
  readonly contextRefs?: readonly string[];
  readonly workspaceRules?: readonly string[];
  readonly modePrompt?: string;
  /** Compact, selected notes; never the parent conversation transcript. */
  readonly notes?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SubagentParentContext {
  readonly taskId?: string;
  readonly agent?: AgentType;
  readonly mode?: ModeDefinition | string;
  readonly authority?: DelegationEffects;
  /** Parent depth is zero for a primary/root agent. */
  readonly depth?: number;
  readonly workspaceId?: string;
}

export interface SubagentTaskRequest {
  readonly id?: string;
  readonly agent: AgentType;
  readonly prompt: string;
  readonly contextRefs?: readonly string[];
  readonly context?: SubagentContext;
  readonly parent?: SubagentParentContext;
  readonly parentContext?: SubagentParentContext;
  readonly parentTaskId?: string;
  /** Requested authority. `same-as-parent` resolves to the parent effective authority. */
  readonly authority?: DelegationEffects;
  readonly delegationEffects?: DelegationEffects;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export type SubagentRequest = SubagentTaskRequest;
export type TaskRequest = SubagentTaskRequest;

export interface SubagentTask {
  readonly id: string;
  readonly agent: SubagentType;
  readonly prompt: string;
  readonly context: SubagentContext;
  readonly parentTaskId?: string;
  readonly authority: DelegationEffects;
  readonly requestedAuthority: DelegationEffects;
  readonly depth: number;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SubagentExecutionContext {
  readonly task: SubagentTask;
  readonly signal: AbortSignal;
  readonly depth: number;
  readonly parentTaskId?: string;
  readonly context: SubagentContext;
  /** Child spawns inherit this task's authority, depth, workspace, and cancellation. */
  readonly spawn: (request: SubagentTaskRequest) => Promise<SubagentResult>;
  readonly emit: (event: SubagentEvent) => void;
}

/** Flattened request keeps the contract convenient for VS Code executors. */
export interface SubagentExecutionRequest extends SubagentTask {
  readonly signal: AbortSignal;
}

export interface SubagentFinding {
  readonly severity?: "critical" | "high" | "medium" | "low" | "info" | string;
  readonly category?: string;
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly title?: string;
  readonly explanation?: string;
  readonly suggestedFix?: string;
  readonly confidence?: number;
  readonly [key: string]: unknown;
}

export interface SubagentCommandResult {
  readonly command: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export type SubagentResultStatus = "completed" | "failed" | "cancelled" | "rejected";

export interface SubagentError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Summarized result returned across the parent/child context boundary. */
export interface SubagentResult {
  readonly taskId: string;
  readonly agent: SubagentType;
  readonly status: SubagentResultStatus;
  readonly summary: string;
  readonly findings?: readonly SubagentFinding[];
  readonly filesInspected?: readonly string[];
  readonly filesChanged?: readonly string[];
  readonly commandsRun?: readonly SubagentCommandResult[];
  readonly artifacts?: readonly string[];
  readonly followups?: readonly string[];
  readonly error?: SubagentError;
  readonly startedAt?: number;
  readonly endedAt: number;
}

export type TaskResult = SubagentResult;

export type SubagentEvent =
  | { readonly type: "subagent_queued"; readonly task: SubagentTask }
  | { readonly type: "subagent_approval_required"; readonly task: SubagentTask; readonly parent?: SubagentParentContext }
  | { readonly type: "subagent_started"; readonly task: SubagentTask; readonly active: number }
  | { readonly type: "subagent_completed"; readonly result: SubagentResult }
  | { readonly type: "subagent_failed"; readonly result: SubagentResult }
  | { readonly type: "subagent_cancelled"; readonly result: SubagentResult }
  | { readonly type: "subagent_rejected"; readonly task: SubagentTask; readonly error: SubagentError };

export type TaskEvent = SubagentEvent;

export type WriteSpawnApproval =
  | boolean
  | "allow"
  | "deny"
  | { readonly allowed: boolean; readonly reason?: string; readonly scope?: Readonly<Record<string, unknown>> }
  | { readonly effect: "allow" | "deny"; readonly reason?: string; readonly scope?: Readonly<Record<string, unknown>> };

export type WriteSpawnApprovalHook = (
  task: SubagentTask,
  parent: SubagentParentContext,
  signal: AbortSignal,
) => WriteSpawnApproval | Promise<WriteSpawnApproval>;

export interface SubagentExecutor {
  /** Preferred method for VS Code adapters. */
  execute?(request: SubagentExecutionRequest, context: SubagentExecutionContext): Promise<unknown> | unknown;
  /** Alias for hosts that use the verb `run`. */
  run?(request: SubagentExecutionRequest, context: SubagentExecutionContext): Promise<unknown> | unknown;
}

export interface SubagentRuntimeOptions {
  readonly executor: SubagentExecutor;
  readonly mode?: ModeDefinition | string;
  readonly parentMode?: ModeDefinition | string;
  readonly rootMode?: ModeDefinition | string;
  readonly rootParent?: SubagentParentContext;
  readonly authority?: DelegationEffects;
  readonly parentAuthority?: DelegationEffects;
  readonly workspaceId?: string;
  readonly maxConcurrent?: number;
  readonly maxConcurrentSubagents?: number;
  readonly maxTotal?: number;
  readonly maxTotalSubagents?: number;
  readonly maxDepth?: number;
  readonly maxNestingDepth?: number;
  readonly approveWriteSpawn?: WriteSpawnApprovalHook;
  readonly writeSpawnApproval?: WriteSpawnApprovalHook;
  readonly onEvent?: (event: SubagentEvent) => void;
  /** Immutable host-resolved custom definitions available for this turn. */
  readonly definitions?: readonly SubagentDefinition[];
}

export type SubagentSchedulerOptions = SubagentRuntimeOptions;
export type SubagentOrchestratorOptions = SubagentRuntimeOptions;

export interface SubagentRuntimeStats {
  readonly active: number;
  readonly queued: number;
  readonly totalAccepted: number;
  readonly maxConcurrent: number;
  readonly maxTotal: number;
  readonly maxDepth: number;
}

export const DEFAULT_SUBAGENT_LIMITS = {
  maxConcurrent: 3,
  maxTotal: 8,
  maxDepth: 1,
} as const;

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = DEFAULT_SUBAGENT_LIMITS.maxConcurrent;
export const DEFAULT_MAX_TOTAL_SUBAGENTS = DEFAULT_SUBAGENT_LIMITS.maxTotal;
export const DEFAULT_MAX_NESTING_DEPTH = DEFAULT_SUBAGENT_LIMITS.maxDepth;

const AUTHORITY_RANK: Record<DelegationEffects, number> = {
  "read-only": 0,
  "same-as-parent": 1,
  write: 2,
};

const CANONICAL_AGENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isDelegationEffect(value: unknown): value is DelegationEffects {
  return value === "read-only" || value === "same-as-parent" || value === "write";
}

function authorityRank(value: DelegationEffects): number {
  return AUTHORITY_RANK[value];
}

function normalizeAuthority(value: DelegationEffects | undefined, fallback: DelegationEffects): DelegationEffects {
  return value && isDelegationEffect(value) ? value : fallback;
}

function modeSlug(mode: ModeDefinition | string | undefined): string | undefined {
  if (!mode) return undefined;
  return typeof mode === "string" ? mode.trim().toLowerCase() : mode.slug.trim().toLowerCase();
}

function resolveMode(mode: ModeDefinition | string | undefined): ModeDefinition | undefined {
  if (!mode) return undefined;
  if (typeof mode === "object") return mode;
  const slug = modeSlug(mode);
  return BUILT_IN_MODES.find((item) => item.slug === slug);
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function asError(error: unknown, fallbackCode = "SUBAGENT_EXECUTION_FAILED"): SubagentError {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : fallbackCode,
      message: typeof value.message === "string" ? value.message : String(error),
      ...(value.details && typeof value.details === "object" ? { details: clone(value.details) as Record<string, unknown> } : {}),
    };
  }
  return { code: fallbackCode, message: String(error) };
}

function clone<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // Fall back to a cycle-safe structural copy for host-specific values.
  }
  const seen = new WeakMap<object, unknown>();
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    const existing = seen.get(input);
    if (existing) return existing;
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      seen.set(input, result);
      for (const item of input) result.push(copy(item));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(input, result);
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) result[key] = copy(item);
    return result;
  };
  return copy(value) as T;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 100).filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 4_096));
}

function normalizeFinding(value: unknown): SubagentFinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const finding: Record<string, unknown> = {};
  for (const key of ["severity", "category", "file", "title", "explanation", "suggestedFix"] as const) {
    if (typeof source[key] === "string") finding[key] = source[key].slice(0, 4_096);
  }
  for (const key of ["lineStart", "lineEnd"] as const) {
    if (Number.isSafeInteger(source[key]) && Number(source[key]) >= 0) finding[key] = Number(source[key]);
  }
  if (typeof source.confidence === "number" && Number.isFinite(source.confidence)) finding.confidence = Math.max(0, Math.min(1, source.confidence));
  return finding as SubagentFinding;
}

function normalizeCommand(value: unknown): SubagentCommandResult | undefined {
  if (typeof value === "string") return { command: value };
  if (!value || typeof value !== "object") return undefined;
  const command = (value as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  const source = value as Record<string, unknown>;
  return {
    command: command.slice(0, 4_096),
    ...(Number.isSafeInteger(source.exitCode) ? { exitCode: Number(source.exitCode) } : {}),
    ...(typeof source.output === "string" ? { output: source.output.slice(0, 8_192) } : {}),
    ...(typeof source.error === "string" ? { error: source.error.slice(0, 8_192) } : {}),
  };
}

function normalizeResult(value: unknown, task: SubagentTask, status: SubagentResultStatus = "completed", error?: SubagentError, startedAt?: number): SubagentResult {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const summaryValue = object?.summary ?? object?.message ?? object?.content ?? (typeof value === "string" ? value : undefined);
  const serializedSummary = summaryValue === undefined ? "" : JSON.stringify(summaryValue);
  const summary = (typeof summaryValue === "string" ? summaryValue : serializedSummary ?? String(summaryValue)).slice(0, 8_192);
  const findings = Array.isArray(object?.findings) ? object!.findings.slice(0, 50).map(normalizeFinding).filter((item): item is SubagentFinding => Boolean(item)) : undefined;
  const commandsRun = Array.isArray(object?.commandsRun) ? object!.commandsRun.slice(0, 25).map(normalizeCommand).filter((item): item is SubagentCommandResult => Boolean(item)) : undefined;
  return {
    taskId: task.id,
    agent: task.agent,
    status,
    summary,
    ...(findings ? { findings } : {}),
    ...(stringArray(object?.filesInspected) ? { filesInspected: stringArray(object?.filesInspected) } : {}),
    ...(stringArray(object?.filesChanged) ? { filesChanged: stringArray(object?.filesChanged) } : {}),
    ...(commandsRun ? { commandsRun } : {}),
    ...(stringArray(object?.artifacts) ? { artifacts: stringArray(object?.artifacts) } : {}),
    ...(stringArray(object?.followups) ? { followups: stringArray(object?.followups) } : {}),
    ...(error ? { error } : object?.error && typeof object.error === "object" ? { error: asError(object.error) } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    endedAt: Date.now(),
  };
}

function resultStatus(value: unknown): SubagentResultStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown }).status;
  return status === "completed" || status === "failed" || status === "cancelled" || status === "rejected" ? status : undefined;
}

function approvalAllowed(value: WriteSpawnApproval): boolean {
  if (value === true || value === "allow") return true;
  if (value === false || value === "deny") return false;
  if ("allowed" in value) return value.allowed;
  return value.effect === "allow";
}

function approvalReason(value: WriteSpawnApproval): string | undefined {
  if (value && typeof value === "object" && "reason" in value) return value.reason;
  return undefined;
}

function approvalScopeCoversTask(value: WriteSpawnApproval, task: SubagentTask): boolean {
  if (!value || typeof value !== "object" || !("scope" in value) || !value.scope) return true;
  const scope = value.scope;
  const workspaceId = scope.workspaceId;
  if (typeof workspaceId === "string" && workspaceId !== task.context.workspaceId) return false;
  const agent = scope.agent;
  if (typeof agent === "string" && normalizeAgentType(agent) !== task.agent) return false;
  const agents = scope.agents;
  if (Array.isArray(agents) && !agents.some((item) => typeof item === "string" && normalizeAgentType(item) === task.agent)) return false;
  const taskId = scope.taskId;
  if (typeof taskId === "string" && taskId !== task.id) return false;
  const taskIds = scope.taskIds;
  if (Array.isArray(taskIds) && !taskIds.includes(task.id)) return false;
  const refs = scope.contextRefs;
  if (Array.isArray(refs) && !task.context.contextRefs?.every((item) => refs.includes(item))) return false;
  return true;
}

interface TaskState {
  readonly task: SubagentTask;
  readonly parent: SubagentParentContext;
  readonly controller: AbortController;
  readonly children: Set<string>;
  resolve: (result: SubagentResult) => void;
  reject: (error: unknown) => void;
  startedAt?: number;
  started: boolean;
  settled: boolean;
  detachAbort?: () => void;
}

/**
 * Bounded, provider-neutral subagent scheduler. It owns policy and lifecycle;
 * an injected executor owns VS Code/provider integration.
 */
export class SubagentOrchestrator {
  private readonly executor: SubagentExecutor;
  private readonly rootParent: SubagentParentContext;
  private readonly maxConcurrent: number;
  private readonly maxTotal: number;
  private readonly maxDepth: number;
  private readonly approveWriteSpawn?: WriteSpawnApprovalHook;
  private readonly eventHandler?: (event: SubagentEvent) => void;
  private readonly definitions = new Map<string, SubagentDefinition>();
  private readonly queue: TaskState[] = [];
  private readonly states = new Map<string, TaskState>();
  private readonly pendingIds = new Set<string>();
  private active = 0;
  private totalAccepted = 0;
  private disposed = false;

  constructor(options: SubagentRuntimeOptions) {
    if (!options.executor || (!options.executor.execute && !options.executor.run)) {
      throw new Error("A subagent executor with execute or run is required");
    }
    this.executor = options.executor;
    for (const definition of BUILT_IN_SUBAGENTS) this.definitions.set(definition.slug, definition);
    for (const definition of options.definitions ?? []) {
      const slug = normalizeAgentType(definition.slug || definition.agent);
      if (!CANONICAL_AGENT.test(slug) || this.definitions.has(slug)) continue;
      this.definitions.set(slug, { ...definition, agent: slug, slug });
    }
    this.eventHandler = options.onEvent;
    this.approveWriteSpawn = options.approveWriteSpawn ?? options.writeSpawnApproval;
    const configuredConcurrent = options.maxConcurrent ?? options.maxConcurrentSubagents ?? 3;
    const configuredTotal = options.maxTotal ?? options.maxTotalSubagents ?? 8;
    const validTotal = validateBound("maxTotal", configuredTotal);
    // A lower total budget is a valid per-turn configuration; in that case
    // the scheduler simply cannot have more live workers than total slots.
    this.maxConcurrent = Math.min(validateBound("maxConcurrent", configuredConcurrent), validTotal);
    this.maxTotal = validTotal;
    const explicitlyConfiguredRootMode = options.rootParent?.mode ?? options.parentMode ?? options.rootMode ?? options.mode;
    const rootMode = explicitlyConfiguredRootMode ?? "orchestrate";
    const rootModeDefinition = resolveMode(rootMode);
    const configuredDepth = options.maxDepth ?? options.maxNestingDepth;
    if (configuredDepth !== undefined && (!Number.isInteger(configuredDepth) || configuredDepth < 0 || configuredDepth > 2)) {
      throw new RangeError("maxDepth must be an integer between 0 and 2");
    }
    this.maxDepth = configuredDepth ?? (explicitlyConfiguredRootMode && modeSlug(rootMode) === "orchestrate" ? 2 : 1);
    this.rootParent = {
      ...options.rootParent,
      mode: rootMode,
      authority: options.rootParent?.authority ?? options.parentAuthority ?? options.authority ?? rootModeDefinition?.delegationEffects ?? "write",
      depth: options.rootParent?.depth ?? 0,
      ...(options.rootParent?.workspaceId ?? options.workspaceId ? { workspaceId: options.rootParent?.workspaceId ?? options.workspaceId } : {}),
    };
  }

  get stats(): SubagentRuntimeStats {
    return {
      active: this.active,
      queued: this.queue.length,
      totalAccepted: this.totalAccepted,
      maxConcurrent: this.maxConcurrent,
      maxTotal: this.maxTotal,
      maxDepth: this.maxDepth,
    };
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.queue.length; }
  get totalCount(): number { return this.totalAccepted; }

  /** Validate a request without enqueueing it. Useful for a VS Code task preview. */
  validate(request: SubagentTaskRequest, parent?: SubagentParentContext): SubagentError | undefined {
    if (typeof request.prompt !== "string" || !request.prompt.trim()) return { code: "INVALID_TASK_PROMPT", message: "A subagent prompt is required." };
    const normalizedAgent = normalizeAgentType(request.agent);
    if (!CANONICAL_AGENT.test(normalizedAgent)) return { code: "UNKNOWN_AGENT", message: `Unknown subagent: ${String(request.agent)}` };
    if (request.id && (this.states.has(request.id) || this.pendingIds.has(request.id))) return { code: "DUPLICATE_TASK_ID", message: `A subagent task already uses id ${request.id}.` };
    const definition = this.definitions.get(normalizedAgent);
    if (!definition) return { code: "UNKNOWN_AGENT", message: `Unknown subagent: ${String(request.agent)}` };
    if (request.model && !definition.routeOverrides) return { code: "ROUTE_OVERRIDE_FORBIDDEN", message: `${definition.name} does not allow task-level model overrides.` };
    const resolvedParent = this.resolveParent(request, parent);
    if (resolvedParent.authority !== undefined && !isDelegationEffect(resolvedParent.authority)) {
      return { code: "INVALID_PARENT_AUTHORITY", message: "Parent authority is invalid." };
    }
    if (resolvedParent.depth !== undefined && (!Number.isInteger(resolvedParent.depth) || resolvedParent.depth < 0 || resolvedParent.depth > this.maxDepth)) {
      return { code: "INVALID_PARENT_DEPTH", message: "Parent depth is outside the configured delegation boundary." };
    }
    const parentMode = resolveMode(resolvedParent.mode);
    if (parentMode && !parentMode.delegationAllowed) {
      return { code: "DELEGATION_NOT_ALLOWED", message: `Mode ${parentMode.name} cannot spawn subagents.` };
    }
    if (resolvedParent.agent) {
      const parentDefinition = this.definitions.get(normalizeAgentType(resolvedParent.agent));
      if (parentDefinition && !parentDefinition.delegationAllowed) {
        return { code: "DELEGATION_NOT_ALLOWED", message: `Agent ${parentDefinition.name} cannot spawn subagents.` };
      }
    }
    // Orchestrate is the explicit coordinator mode. Its built-in contract is
    // intentionally broader than older mode files that predate all six
    // subagent definitions, so it can route review/general work too.
    const allowed = parentMode?.slug === "orchestrate"
      ? [...this.definitions.keys()]
      : parentMode?.allowedAgents ?? (resolvedParent.agent ? this.definitions.get(normalizeAgentType(resolvedParent.agent))?.allowedAgents : undefined);
    if (allowed && allowed.length > 0 && !allowed.some((item) => normalizeAgentType(item) === normalizedAgent)) {
      return { code: "AGENT_NOT_ALLOWED", message: `Parent cannot spawn ${normalizedAgent}.`, details: { allowedAgents: clone(allowed) as unknown as Record<string, unknown> } };
    }
    if (allowed && allowed.length === 0) {
      return { code: "AGENT_NOT_ALLOWED", message: "Parent mode does not allow any subagents." };
    }
    const depth = (resolvedParent.depth ?? 0) + 1;
    if (depth > this.maxDepth) return { code: "NESTING_LIMIT", message: `Maximum subagent nesting depth ${this.maxDepth} exceeded.`, details: { depth, maxDepth: this.maxDepth } };
    const parentAuthority = resolvedParent.authority ?? parentMode?.delegationEffects ?? "read-only";
    const requested = normalizeAuthority(request.authority ?? request.delegationEffects, definition.maxAuthority === "write" ? "write" : "read-only");
    const effective = requested === "same-as-parent" ? parentAuthority === "same-as-parent" ? "read-only" : parentAuthority : requested;
    if (authorityRank(effective) > authorityRank(parentAuthority === "same-as-parent" ? "read-only" : parentAuthority)) {
      return { code: "AUTHORITY_ESCALATION", message: `Cannot delegate ${effective} authority from a ${parentAuthority} parent.`, details: { requested: effective, parentAuthority } };
    }
    if (authorityRank(effective) > authorityRank(definition.maxAuthority)) {
      return { code: "AGENT_AUTHORITY_UNSUPPORTED", message: `${definition.name} cannot receive ${effective} authority.` };
    }
    if (effective === "write" && parentMode && parentMode.slug !== "implement" && parentMode.slug !== "orchestrate") {
      return { code: "WRITE_DELEGATION_FORBIDDEN", message: `Mode ${parentMode.name} cannot spawn write-capable agents.` };
    }
    if (this.disposed) return { code: "RUNTIME_DISPOSED", message: "Subagent runtime has been disposed." };
    if (this.totalAccepted >= this.maxTotal) return { code: "TOTAL_LIMIT", message: `Maximum total subagents (${this.maxTotal}) reached.` };
    return undefined;
  }

  /** Enqueue and execute a task, returning a structured result for all policy outcomes. */
  async spawn(request: SubagentTaskRequest, parent?: SubagentParentContext): Promise<SubagentResult> {
    const resolvedParent = this.resolveParent(request, parent);
    const normalizedAgent = normalizeAgentType(request.agent);
    const definition = this.definitions.get(normalizedAgent);
    const validation = this.validate(request, resolvedParent);
    const task = this.createTask(request, resolvedParent, definition);
    if (validation) {
      const result = normalizeResult(undefined, task, "rejected", validation);
      this.emit({ type: "subagent_rejected", task, error: validation });
      return result;
    }
    if (request.signal?.aborted) return this.cancelledBeforeStart(task);

    if (task.authority === "write") {
      this.pendingIds.add(task.id);
      this.emit({ type: "subagent_approval_required", task, parent: resolvedParent });
      if (!this.approveWriteSpawn) {
        const error: SubagentError = { code: "WRITE_APPROVAL_REQUIRED", message: "Write-capable subagent spawns require explicit approval." };
        const result = normalizeResult(undefined, task, "rejected", error);
        this.emit({ type: "subagent_rejected", task, error });
        this.pendingIds.delete(task.id);
        return result;
      }
      let approval: WriteSpawnApproval;
      try {
        approval = await awaitWithAbort(Promise.resolve(this.approveWriteSpawn(task, resolvedParent, request.signal ?? NEVER_ABORT)), request.signal);
      } catch (error) {
        const normalized = request.signal?.aborted ? { code: "CANCELLED", message: "Write-capable spawn cancelled while awaiting approval." } : asError(error, "WRITE_APPROVAL_FAILED");
        const result = normalizeResult(undefined, task, "cancelled" === normalized.code ? "cancelled" : "rejected", normalized);
        this.emit({ type: result.status === "cancelled" ? "subagent_cancelled" : "subagent_rejected", ...(result.status === "cancelled" ? { result } : { task, error: normalized }) } as SubagentEvent);
        this.pendingIds.delete(task.id);
        return result;
      }
      if (!approvalAllowed(approval)) {
        const error: SubagentError = { code: "WRITE_APPROVAL_DENIED", message: approvalReason(approval) ?? "Write-capable subagent spawn was not approved." };
        const result = normalizeResult(undefined, task, "rejected", error);
        this.emit({ type: "subagent_rejected", task, error });
        this.pendingIds.delete(task.id);
        return result;
      }
      if (!approvalScopeCoversTask(approval, task)) {
        const error: SubagentError = { code: "WRITE_APPROVAL_SCOPE_MISMATCH", message: "Write-spawn approval scope does not cover the delegated task." };
        const result = normalizeResult(undefined, task, "rejected", error);
        this.emit({ type: "subagent_rejected", task, error });
        this.pendingIds.delete(task.id);
        return result;
      }
    }

    // Approval is intentionally complete before consuming the total budget.
    if (this.totalAccepted >= this.maxTotal) {
      const error: SubagentError = { code: "TOTAL_LIMIT", message: `Maximum total subagents (${this.maxTotal}) reached.` };
      const result = normalizeResult(undefined, task, "rejected", error);
      this.emit({ type: "subagent_rejected", task, error });
      this.pendingIds.delete(task.id);
      return result;
    }
    const controller = new AbortController();
    const state = this.makeState(task, resolvedParent, controller, request.signal);
    this.totalAccepted += 1;
    this.pendingIds.delete(task.id);
    this.states.set(task.id, state);
    if (resolvedParent.taskId) this.states.get(resolvedParent.taskId)?.children.add(task.id);
    const resultPromise = new Promise<SubagentResult>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    this.queue.push(state);
    this.attachSignal(state, request.signal);
    if (state.settled) return resultPromise;
    this.emit({ type: "subagent_queued", task });
    this.pump();
    return resultPromise;
  }

  runTask(request: SubagentTaskRequest, parent?: SubagentParentContext): Promise<SubagentResult> { return this.spawn(request, parent); }
  schedule(request: SubagentTaskRequest, parent?: SubagentParentContext): Promise<SubagentResult> { return this.spawn(request, parent); }
  task(request: SubagentTaskRequest, parent?: SubagentParentContext): Promise<SubagentResult> { return this.spawn(request, parent); }

  cancel(taskId: string): boolean {
    const state = this.states.get(taskId);
    if (!state || state.settled) return false;
    state.controller.abort();
    if (!state.started) {
      const index = this.queue.indexOf(state);
      if (index >= 0) this.queue.splice(index, 1);
      const result = normalizeResult(undefined, state.task, "cancelled", { code: "CANCELLED", message: "Subagent task cancelled before execution." });
      this.settle(state, result);
      this.emit({ type: "subagent_cancelled", result });
      this.pump();
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) if (!state.settled) this.cancel(state.task.id);
  }

  private resolveParent(request: SubagentTaskRequest, explicit?: SubagentParentContext): SubagentParentContext {
    if (explicit?.taskId && this.states.has(explicit.taskId)) return stateToParent(this.states.get(explicit.taskId)!);
    if (explicit) return explicit;
    const requestedParent = request.parent ?? request.parentContext;
    if (requestedParent?.taskId && this.states.has(requestedParent.taskId)) return stateToParent(this.states.get(requestedParent.taskId)!);
    if (requestedParent) return requestedParent;
    if (request.parentTaskId) {
      const state = this.states.get(request.parentTaskId);
      if (state) return stateToParent(state);
      return { taskId: request.parentTaskId, mode: this.rootParent.mode, authority: this.rootParent.authority, depth: this.rootParent.depth, workspaceId: this.rootParent.workspaceId };
    }
    return this.rootParent;
  }

  private createTask(request: SubagentTaskRequest, parent: SubagentParentContext, definition?: SubagentDefinition): SubagentTask {
    const agent = definition?.agent ?? normalizeAgentType(request.agent);
    const fallbackAuthority = definition?.maxAuthority === "write" ? "write" : "read-only";
    const requestedAuthority = normalizeAuthority(request.authority ?? request.delegationEffects, fallbackAuthority);
    const parentAuthority = parent.authority ?? resolveMode(parent.mode)?.delegationEffects ?? "read-only";
    const authority = requestedAuthority === "same-as-parent" ? parentAuthority === "same-as-parent" ? "read-only" : parentAuthority : requestedAuthority;
    const context: SubagentContext = clone({
      ...(request.context ?? {}),
      ...(request.contextRefs ? { contextRefs: [...request.contextRefs] } : {}),
      ...(parent.workspaceId && !(request.context?.workspaceId) ? { workspaceId: parent.workspaceId } : {}),
      ...(definition && !(request.context?.modePrompt) ? { modePrompt: definition.instructions } : {}),
      ...(request.metadata ? { metadata: clone(request.metadata) } : {}),
    });
    return {
      id: request.id ?? id("subagent"),
      agent,
      prompt: request.prompt,
      context,
      ...(parent.taskId ? { parentTaskId: parent.taskId } : {}),
      authority,
      requestedAuthority,
      depth: (parent.depth ?? 0) + 1,
      ...(request.model ? { model: request.model } : {}),
      ...(request.metadata ? { metadata: clone(request.metadata) } : {}),
    };
  }

  private makeState(task: SubagentTask, parent: SubagentParentContext, controller: AbortController, _signal?: AbortSignal): TaskState {
    let resolve!: (result: SubagentResult) => void;
    let reject!: (error: unknown) => void;
    return { task, parent, controller, children: new Set(), resolve, reject, started: false, settled: false };
  }

  private attachSignal(state: TaskState, signal?: AbortSignal): void {
    if (!signal) return;
    const abort = () => {
      state.controller.abort();
      if (state.started || state.settled) return;
      const index = this.queue.indexOf(state);
      if (index >= 0) this.queue.splice(index, 1);
      const result = normalizeResult(undefined, state.task, "cancelled", { code: "CANCELLED", message: "Subagent task cancelled before execution." });
      this.settle(state, result);
      this.emit({ type: "subagent_cancelled", result });
      this.pump();
    };
    state.detachAbort = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const state = this.queue.shift()!;
      if (state.settled || state.controller.signal.aborted) {
        this.settle(state, normalizeResult(undefined, state.task, "cancelled", { code: "CANCELLED", message: "Subagent task cancelled before execution." }));
        continue;
      }
      state.started = true;
      state.startedAt = Date.now();
      this.active += 1;
      this.emit({ type: "subagent_started", task: state.task, active: this.active });
      void this.executeState(state);
    }
  }

  private async executeState(state: TaskState): Promise<void> {
    const executionRequest: SubagentExecutionRequest = {
      ...state.task,
      context: clone(state.task.context),
      signal: state.controller.signal,
    };
    const executionContext: SubagentExecutionContext = {
      task: clone(state.task),
      signal: state.controller.signal,
      depth: state.task.depth,
      ...(state.task.parentTaskId ? { parentTaskId: state.task.parentTaskId } : {}),
      context: clone(state.task.context),
      spawn: (request) => this.spawn({ ...request, signal: request.signal ?? state.controller.signal }, { taskId: state.task.id, agent: state.task.agent, mode: state.parent.mode, authority: state.task.authority, depth: state.task.depth, workspaceId: state.task.context.workspaceId }),
      emit: (event) => this.emit(event),
    };
    let result: SubagentResult;
    try {
      const execute = this.executor.execute ?? this.executor.run;
      const value = await execute!(executionRequest, executionContext);
      result = state.controller.signal.aborted
        ? normalizeResult(value, state.task, "cancelled", { code: "CANCELLED", message: "Subagent task cancelled." }, state.startedAt)
        : normalizeResult(value, state.task, resultStatus(value) ?? "completed", undefined, state.startedAt);
    } catch (error) {
      const cancelled = state.controller.signal.aborted || isAbortError(error);
      result = normalizeResult(undefined, state.task, cancelled ? "cancelled" : "failed", asError(error, cancelled ? "CANCELLED" : "SUBAGENT_EXECUTION_FAILED"), state.startedAt);
    }
    this.settle(state, result);
    this.active -= 1;
    this.emit({ type: result.status === "completed" ? "subagent_completed" : result.status === "cancelled" ? "subagent_cancelled" : "subagent_failed", result });
    this.pump();
  }

  private settle(state: TaskState, result: SubagentResult): void {
    if (state.settled) return;
    state.settled = true;
    state.detachAbort?.();
    state.resolve(result);
  }

  private emit(event: SubagentEvent): void {
    this.eventHandler?.(event);
  }

  private cancelledBeforeStart(task: SubagentTask): Promise<SubagentResult> {
    const result = normalizeResult(undefined, task, "cancelled", { code: "CANCELLED", message: "Subagent task was already cancelled." });
    this.emit({ type: "subagent_cancelled", result });
    return Promise.resolve(result);
  }
}

export class SubagentScheduler extends SubagentOrchestrator {}
export class AgentOrchestrator extends SubagentOrchestrator {}
export class SubagentRuntime extends SubagentOrchestrator {}

export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
  return new SubagentRuntime(options);
}

function stateToParent(state: TaskState): SubagentParentContext {
  return {
    taskId: state.task.id,
    agent: state.task.agent,
    mode: state.parent.mode,
    authority: state.task.authority,
    depth: state.task.depth,
    workspaceId: state.task.context.workspaceId,
  };
}

function validateBound(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError(`${name} must be an integer between 1 and 8`);
  return value;
}

const NEVER_ABORT = new AbortController().signal;

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
