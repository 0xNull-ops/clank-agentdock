import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  normalizePath,
  type AgentEvent,
  type AgentSession,
  type AgentRunResult,
  type NormalizedMessage,
  type PermissionDecision,
  type ProviderFrame,
} from "@freebuff/agent-core";
import {
  SessionStore,
  type ApprovalRecord,
  type CreatePlanInput,
  type PlanMutationOptions,
  type PlanRecord,
  type SessionListOptions,
  type SessionExport,
  type SessionSnapshot,
  type SessionStoreOptions,
  type SqlJsInitializer,
  type ProviderTranscriptEntry,
  type StoredMessage,
  type SubagentRunPatch,
  type SubagentRunRecord,
} from "@freebuff/agent-storage";
import { validatePlanMarkdown, type PlanContract } from "@freebuff/agent-core";
import {
  contentHashOf,
  decideArtifactPlanAction,
  planContractOf,
  planTitleFromMarkdown,
  type PlanArtifactCandidate,
} from "./plan-lifecycle";

const DEFAULT_DATABASE_NAME = "sessions.sqlite";
const DEFAULT_TITLE = "New Agent session";
const DEFAULT_MODE = "ask";
const DEFAULT_PROVIDER = "openai-compatible";
const DEFAULT_MODEL = "openai-compatible";

/** Options for the extension-host persistence adapter. */
export interface SessionPersistenceOptions {
  /** Filename below `ExtensionContext.globalStorageUri`. */
  databaseName?: string;
  /** Override the workspace identity used to scope the session list. */
  workspaceId?: string;
  /** Inject sql.js in tests or hosts that need an explicit WASM locator. */
  sqlJs?: SqlJsInitializer;
  /** Override bundled sql.js asset lookup. Defaults to the extension dist directory. */
  locateFile?: (file: string) => string;
  /** Clock injection keeps session creation and event tests deterministic. */
  now?: () => number;
}

export interface NewSessionOptions {
  id?: string;
  workspaceId?: string;
  title?: string;
  activeMode?: string;
  providerId?: string;
  modelId?: string;
}

/**
 * The UI-safe shape returned from restore/open. Provider frames and opaque
 * provider transcript rows stay inside this extension-host coordinator and
 * are available only through `replayMessages` for a provider adapter.
 */
export interface RestoredSession {
  session: AgentSession;
  messages: NormalizedMessage[];
}

export interface SessionPersistenceHost {
  globalStorageUri: vscode.Uri;
  extensionUri: vscode.Uri;
}

/**
 * Serializes the VS Code-facing lifecycle around `@freebuff/agent-storage`.
 *
 * The coordinator is deliberately independent of the bridge and webview. The
 * bridge can pass `eventSink` to the agent loop, call `recordRun` when a run
 * returns its complete normalized transcript, and use `restore`/`newSession`
 * for UI commands. All writes are ordered here before reaching SessionStore.
 */
export class SessionPersistenceCoordinator {
  private readonly initialization: Promise<SessionStore>;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly replay = new Map<string, NormalizedMessage[]>();
  private readonly providerTranscripts = new Map<string, ProviderTranscriptEntry[]>();
  private closed = false;
  private closing = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly host: SessionPersistenceHost,
    private readonly options: SessionPersistenceOptions = {},
  ) {
    // Start exactly one initialization promise. Every public operation awaits
    // this same promise, so concurrent restore/list/new-session calls cannot
    // race two sql.js databases or two migrations.
    this.initialization = this.initialize();
  }

  /** Open the database below `context.globalStorageUri` and await migrations. */
  public static async open(
    context: vscode.ExtensionContext,
    options: SessionPersistenceOptions = {},
  ): Promise<SessionPersistenceCoordinator> {
    const coordinator = new SessionPersistenceCoordinator(context, options);
    await coordinator.initialization;
    return coordinator;
  }

  /** A promise that resolves after the one-time database initialization. */
  public get ready(): Promise<void> {
    return this.initialization.then(() => undefined);
  }

  /** Function-shaped sink suitable for `AgentLoopOptions.onEvent`. */
  public readonly eventSink = (event: AgentEvent): void => {
    void this.persistEvent(event).catch(() => undefined);
  };

  /** Persist an event in order; callers that need error visibility may await it. */
  public persistEvent(event: AgentEvent): Promise<void> {
    if (this.closed || this.closing) return Promise.reject(new Error("Session persistence is closed."));
    return this.enqueue(() => this.applyEvent(event));
  }

  /** Alias that reads naturally when used by a bridge event callback. */
  public handleEvent(event: AgentEvent): Promise<void> {
    return this.persistEvent(event);
  }

  /** Wait until all event-sink writes submitted so far have settled. */
  public async flush(): Promise<void> {
    await this.initialization;
    await this.eventQueue;
    await (await this.requireStore()).flush();
  }

  /** List sessions, scoped to the current workspace by default. */
  public async list(options: SessionListOptions = {}): Promise<AgentSession[]> {
    const store = await this.requireStore();
    return store.listSessions({ ...options, workspaceId: this.workspaceId() });
  }

  public listSessions(options: SessionListOptions = {}): Promise<AgentSession[]> {
    return this.list(options);
  }

  public async getSession(sessionId: string): Promise<AgentSession | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached?.workspaceId === this.workspaceId()) return cached;
    return (await this.requireStore()).getSession(sessionId, { workspaceId: this.workspaceId() });
  }

  public async renameSession(sessionId: string, title: string): Promise<AgentSession | undefined> {
    const renamed = await (await this.requireStore()).renameSession(sessionId, title, { workspaceId: this.workspaceId() });
    if (renamed) this.sessions.set(renamed.id, renamed);
    return renamed;
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    await this.eventQueue;
    const deleted = await (await this.requireStore()).deleteSession(sessionId, { workspaceId: this.workspaceId() });
    if (deleted) {
      this.sessions.delete(sessionId);
      this.replay.delete(sessionId);
      this.providerTranscripts.delete(sessionId);
    }
    return deleted;
  }

  /** Export only UI-safe normalized data; opaque provider continuation data stays host-only. */
  public async exportSession(sessionId: string): Promise<SessionExport | undefined> {
    await this.eventQueue;
    return (await this.requireStore()).exportSession(sessionId, { workspaceId: this.workspaceId() });
  }

  public async duplicateSession(sessionId: string): Promise<AgentSession | undefined> {
    await this.eventQueue;
    const source = await (await this.requireStore()).exportSession(sessionId, {
      workspaceId: this.workspaceId(),
      includeProviderFrames: true,
      limit: 2_000,
    });
    if (!source) return undefined;
    if (source.truncated) throw new Error("This session is too large to duplicate safely. Export it instead.");
    const copyTitle = [...`Copy of ${source.session.title}`].slice(0, 200).join("");
    const duplicate = await this.newSession({
      title: copyTitle,
      activeMode: source.session.activeMode,
      providerId: source.session.providerId,
      modelId: source.session.modelId,
    });
    for (const stored of source.messages) await this.appendMessage(duplicate.id, stored.message);
    return duplicate;
  }

  /**
   * Open a session for UI display. This intentionally strips provider frames
   * and does not return the provider transcript table.
   */
  public async open(sessionId: string): Promise<RestoredSession | undefined> {
    const snapshot = await this.openSnapshot(sessionId);
    if (!snapshot) return undefined;
    this.cacheSnapshot(snapshot);
    return {
      session: snapshot.session,
      messages: snapshot.messages.map(({ message }) => withoutProviderFrames(message)),
    };
  }

  public restore(sessionId: string): Promise<RestoredSession | undefined> {
    return this.open(sessionId);
  }

  /** Open the full host-only snapshot when storage records are needed. */
  public async openSnapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    const store = await this.requireStore();
    const snapshot = await store.openSession(sessionId, {
      workspaceId: this.workspaceId(),
      includeProviderMessages: true,
      includeProviderFrames: true,
    });
    if (snapshot) this.cacheSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Return a copy of the complete normalized transcript for provider replay.
   * Never forward this result to the webview: it may contain opaque frames or
   * provider-specific reasoning metadata.
   */
  public async replayMessages(sessionId: string): Promise<NormalizedMessage[]> {
    if (!this.replay.has(sessionId)) await this.openSnapshot(sessionId);
    return (this.replay.get(sessionId) ?? []).map(copyMessage);
  }

  /** Return opaque provider rows only to host-side provider continuation code. */
  public async replayProviderTranscript(sessionId: string): Promise<ProviderTranscriptEntry[]> {
    if (!this.providerTranscripts.has(sessionId)) await this.openSnapshot(sessionId);
    return (this.providerTranscripts.get(sessionId) ?? []).map(copyProviderTranscript);
  }

  /** Create and persist an idle session in the global SQLite database. */
  public async newSession(options: NewSessionOptions = {}): Promise<AgentSession> {
    const store = await this.requireStore();
    const now = this.clock();
    const session: AgentSession = {
      id: options.id ?? `session-${randomUUID()}`,
      workspaceId: options.workspaceId ?? this.workspaceId(),
      title: options.title?.trim() || DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      activeMode: options.activeMode ?? DEFAULT_MODE,
      providerId: options.providerId ?? DEFAULT_PROVIDER,
      modelId: options.modelId ?? DEFAULT_MODEL,
      status: "idle",
    };
    await store.createSession(session);
    this.sessions.set(session.id, session);
    this.replay.set(session.id, []);
    return session;
  }

  /** Register the run session before passing `eventSink` to `runAgent`. */
  public async startSession(session: AgentSession): Promise<AgentSession> {
    return this.saveSession(session);
  }

  public ensureSession(session: AgentSession): Promise<AgentSession> {
    return this.startSession(session);
  }

  /**
   * Persist a delegated run through the same ordered queue as session events.
   * The workspace check is intentionally performed here as well as in the
   * storage layer so callers cannot accidentally create a UI-visible record
   * for another workspace.
   */
  public async createSubagentRun(run: SubagentRunRecord): Promise<SubagentRunRecord> {
    const workspaceId = this.workspaceId();
    if (run.workspaceId !== workspaceId) {
      throw new Error("Subagent run workspace does not match the current workspace.");
    }
    return this.enqueue(() => this.requireStore().then((store) => store.createSubagentRun(run)));
  }

  /** Update a delegated run while retaining its immutable workspace/session scope. */
  public updateSubagentRun(
    id: string,
    patch: SubagentRunPatch,
  ): Promise<SubagentRunRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.updateSubagentRun(id, patch, {
      workspaceId: this.workspaceId(),
    })));
  }

  /** Read one delegated run without crossing the current workspace boundary. */
  public getSubagentRun(id: string): Promise<SubagentRunRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.getSubagentRun(id, {
      workspaceId: this.workspaceId(),
    })));
  }

  /** List all delegated runs for one session, including completed history. */
  public listSubagentRuns(sessionId: string): Promise<SubagentRunRecord[]> {
    return this.enqueue(() => this.requireStore().then((store) => store.listSubagentRuns({
      workspaceId: this.workspaceId(),
      sessionId,
    })));
  }

  // ---- Formal plan lifecycle (host-owned, workspace/session scoped) ----

  private planScope(sessionId?: string): { workspaceId: string; sessionId?: string } {
    return { workspaceId: this.workspaceId(), ...(sessionId ? { sessionId } : {}) };
  }

  private planMutationOptions(options: { sessionId?: string; expectedRevision?: number; actor?: string; supersededBy?: string }): PlanMutationOptions {
    return {
      workspaceId: this.workspaceId(),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.supersededBy ? { supersededBy: options.supersededBy } : {}),
    };
  }

  /** Create a durable plan row for a session after validating its workspace scope. */
  public async createPlanRecord(
    sessionId: string,
    input: { title?: string; content: string; artifactPath?: string; status?: PlanRecord["status"] },
  ): Promise<PlanRecord> {
    const store = await this.requireStore();
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const validation = validatePlanMarkdown(input.content);
    const contractJson = validation.ok && validation.contract ? JSON.stringify(validation.contract) : undefined;
    const create: CreatePlanInput = {
      workspaceId: session.workspaceId,
      sessionId,
      title: input.title ?? planTitleFromMarkdown(input.content, input.artifactPath ?? "plan"),
      content: input.content,
      status: input.status ?? "DRAFT",
      ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
      contentHash: contentHashOf(input.content),
      ...(contractJson ? { contractJson } : {}),
    };
    return this.enqueue(() => store.createPlan(create));
  }

  /** Read one plan without crossing the current workspace boundary. */
  public getPlan(planId: string, sessionId?: string): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.getPlan(planId, this.planScope(sessionId))));
  }

  /** List plans for the workspace, optionally narrowed to one session. */
  public listPlans(sessionId?: string): Promise<PlanRecord[]> {
    return this.enqueue(() => this.requireStore().then((store) => store.listPlans(this.planScope(sessionId))));
  }

  /** Atomically approve a READY_FOR_APPROVAL plan and record who and when. */
  public approvePlan(planId: string, options: { sessionId?: string; expectedRevision?: number; actor?: string } = {}): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.approvePlan(planId, this.planMutationOptions(options))));
  }

  /** Send a plan back to DRAFT for revisions. */
  public revisePlan(planId: string, options: { sessionId?: string; expectedRevision?: number } = {}): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.revisePlan(planId, this.planMutationOptions(options))));
  }

  /** Discard an in-flight plan. */
  public discardPlan(planId: string, options: { sessionId?: string; expectedRevision?: number } = {}): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.discardPlan(planId, this.planMutationOptions(options))));
  }

  /** Supersede a plan (used when an approved artifact is rewritten). */
  public supersedePlan(planId: string, options: { expectedRevision?: number; supersededBy?: string } = {}): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.supersedePlan(planId, this.planMutationOptions(options))));
  }

  /** Transition an APPROVED plan to IMPLEMENTING at the start of an Implement turn. */
  public beginPlanImplementation(planId: string): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.beginPlanImplementation(planId, this.planMutationOptions({}))));
  }

  /** Mark an IMPLEMENTING plan COMPLETE after a successful implement run. */
  public completePlan(planId: string): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.completePlan(planId, this.planMutationOptions({}))));
  }

  /** Park an IMPLEMENTING plan that surfaced a material deviation. */
  public blockPlan(planId: string): Promise<PlanRecord | undefined> {
    return this.enqueue(() => this.requireStore().then((store) => store.blockPlan(planId, this.planMutationOptions({}))));
  }

  /**
   * Reconcile a freshly scanned `.agent/plans` artifact with the durable plan
   * rows for its session. The host owns identity, status, and revisions; an
   * approved plan is never mutated in place — a changed artifact supersedes it
   * and starts a new DRAFT/READY_FOR_APPROVAL row.
   */
  public async upsertPlanArtifact(sessionId: string, candidate: PlanArtifactCandidate): Promise<PlanRecord | undefined> {
    const store = await this.requireStore();
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const existing = (await this.listPlans(sessionId)).find((plan) => plan.artifactPath === candidate.artifactPath);
    const validation = validatePlanMarkdown(candidate.content);
    const decision = decideArtifactPlanAction(existing, candidate, validation.ok);
    if (decision.action === "skip") return existing;
    const contractJson = validation.ok && validation.contract ? JSON.stringify(validation.contract) : undefined;
    const title = planTitleFromMarkdown(candidate.content, candidate.artifactPath);
    const contentHash = contentHashOf(candidate.content);
    if (decision.action === "create") {
      return this.enqueue(() => store.createPlan({
        workspaceId: session.workspaceId,
        sessionId,
        title,
        content: candidate.content,
        status: decision.status,
        artifactPath: candidate.artifactPath,
        contentHash,
        ...(contractJson ? { contractJson } : {}),
      }));
    }
    if (decision.action === "update" && existing) {
      return this.enqueue(() => store.updatePlan(existing.id, {
        title,
        content: candidate.content,
        status: decision.status,
        contentHash,
        ...(contractJson ? { contractJson } : {}),
      }, this.planMutationOptions({})));
    }
    if (decision.action === "supersede" && existing) {
      // Supersede points at the replacement plan, so mint its id host-side.
      const replacementId = `plan-${randomUUID()}`;
      const superseded = await this.enqueue(() => store.supersedePlan(existing.id, this.planMutationOptions({ supersededBy: replacementId })));
      const replacement = await this.enqueue(() => store.createPlan({
        id: replacementId,
        workspaceId: session.workspaceId,
        sessionId,
        title,
        content: candidate.content,
        status: decision.status,
        artifactPath: candidate.artifactPath,
        contentHash,
        ...(contractJson ? { contractJson } : {}),
      }));
      return replacement ?? superseded;
    }
    return existing;
  }

  /**
   * The approved (or in-implementation) compact contract for a session, for
   * prompt composition only. Returns undefined unless a validated contract
   * exists for the current workspace/session.
   */
  public async approvedPlanContract(
    sessionId: string,
  ): Promise<{ id: string; revision: number; status: "APPROVED" | "IMPLEMENTING"; contract: PlanContract } | undefined> {
    const plans = await this.listPlans(sessionId);
    const active = plans.find((plan) => plan.status === "APPROVED" || plan.status === "IMPLEMENTING");
    if (!active) return undefined;
    const contract = planContractOf(active);
    if (!contract) return undefined;
    return { id: active.id, revision: active.revision, status: active.status as "APPROVED" | "IMPLEMENTING", contract };
  }

  /** Persist header selection changes even when no provider run follows. */
  public async updateSessionSelection(
    sessionId: string,
    patch: { activeMode?: string; modelId?: string },
    options: { reason?: "user" | "plan-approved" | "workflow" } = {},
  ): Promise<AgentSession | undefined> {
    const store = await this.requireStore();
    const current = this.sessions.get(sessionId) ?? await store.getSession(sessionId, { workspaceId: this.workspaceId() });
    if (!current) return undefined;
    if (patch.activeMode && patch.activeMode !== current.activeMode) {
      await store.recordModeTransition(sessionId, {
        from: current.activeMode,
        to: patch.activeMode,
        timestamp: this.clock(),
        reason: options.reason ?? "user",
      });
    }
    return this.saveSession({ ...current, ...patch, updatedAt: this.clock() });
  }

  /** Save a session and keep the coordinator's in-process index current. */
  public async saveSession(session: AgentSession): Promise<AgentSession> {
    const saved = await (await this.requireStore()).saveSession(session);
    this.sessions.set(saved.id, saved);
    return saved;
  }

  /**
   * Persist complete normalized messages returned by `runAgent`.
   * Provider frames are retained in SQLite for exact replay but are omitted by
   * `open` and `exportSession`-style UI paths.
   */
  public async appendMessage(
    sessionId: string,
    message: NormalizedMessage,
    options: Parameters<SessionStore["appendMessage"]>[2] = {},
  ): Promise<StoredMessage> {
    const store = await this.requireStore();
    const stored = await store.appendMessage(sessionId, message, options);
    for (const frame of message.providerFrames ?? []) {
      const providerEntry = await store.appendProviderMessage(sessionId, {
        providerId: frame.providerId,
        modelId: frame.modelId,
        payload: frame.payload,
      });
      const entries = this.providerTranscripts.get(sessionId) ?? [];
      entries.push(copyProviderTranscript(providerEntry));
      this.providerTranscripts.set(sessionId, entries);
    }
    this.rememberMessage(sessionId, message);
    return stored;
  }

  /** Persist the session and every normalized message from a completed run. */
  public async recordRun(session: AgentSession, result: Pick<AgentRunResult, "messages" | "status"> | NormalizedMessage[]): Promise<void> {
    await this.eventQueue;
    // System prompts are rebuilt from the current mode, workspace instructions,
    // and harness version on every run. Persisting them would replay stale
    // instructions and make the cumulative transcript prefix diverge.
    const messages = (Array.isArray(result) ? result : result.messages).filter((message) => message.role !== "system");
    // `runAgent` returns the complete transcript, including prior turns. Only
    // append the suffix when the returned transcript has the cached prefix;
    // this makes repeated bridge calls restart-safe and avoids duplicate turns.
    const existing = await this.replayMessages(session.id);
    const hasPrefix = existing.every((message, index) => sameMessage(message, messages[index]));
    const toAppend = hasPrefix ? messages.slice(existing.length) : messages;
    for (const message of toAppend) await this.appendMessage(session.id, message);
    const status = Array.isArray(result)
      ? this.sessions.get(session.id)?.status ?? session.status
      : statusFromRun(result.status);
    const latest = this.sessions.get(session.id) ?? session;
    await this.saveSession({ ...latest, status, updatedAt: this.clock() });
  }

  /** Resolve a persisted approval after the user acts in the UI. */
  public async decideApproval(
    approvalId: string,
    decision: PermissionDecision | "allow" | "deny",
    decidedAt?: number,
  ): Promise<ApprovalRecord> {
    if (this.closed || this.closing) throw new Error("Session persistence is closed.");
    return this.enqueue(() => this.requireStore().then((store) => store.decideApproval(approvalId, decision, decidedAt)));
  }

  /** Close after event writes and SQLite's final fsync have completed. */
  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    try {
      await this.eventQueue;
      const store = await this.initialization;
      await store.close();
      this.closed = true;
    this.sessions.clear();
    this.replay.clear();
    this.providerTranscripts.clear();
    } finally {
      this.closing = false;
    }
  }

  private async initialize(): Promise<SessionStore> {
    const databaseName = this.options.databaseName ?? DEFAULT_DATABASE_NAME;
    if (!isSafeDatabaseName(databaseName)) {
      throw new Error("Session persistence databaseName must be a single filename below globalStorageUri.");
    }
    await vscode.workspace.fs.createDirectory(this.host.globalStorageUri);
    const filePath = vscode.Uri.joinPath(
      this.host.globalStorageUri,
      databaseName,
    ).fsPath;
    const storeOptions: SessionStoreOptions = {
      filePath,
      ...(this.options.sqlJs ? { sqlJs: this.options.sqlJs } : {}),
      locateFile: this.options.locateFile
        ?? ((file) => vscode.Uri.joinPath(this.host.extensionUri, "dist", file).fsPath),
      ...(this.options.now ? { now: this.options.now } : {}),
    };
    return SessionStore.open(storeOptions);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.eventQueue.then(operation);
    this.eventQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyEvent(event: AgentEvent): Promise<void> {
    const store = await this.requireStore();
    switch (event.type) {
      case "session_started":
        await store.createSession(event.session);
        this.sessions.set(event.session.id, event.session);
        if (!this.replay.has(event.session.id)) this.replay.set(event.session.id, []);
        if (!this.providerTranscripts.has(event.session.id)) this.providerTranscripts.set(event.session.id, []);
        return;
      case "mode_changed": {
        const session = this.sessionForModeTransition();
        if (!session) return;
        await store.recordModeTransition(session.id, event.transition);
        await this.saveSession({ ...session, activeMode: event.transition.to, updatedAt: this.clock() });
        return;
      }
      case "step_started":
        await store.appendStep({
          id: event.stepId,
          sessionId: event.sessionId,
          sequence: event.step,
          status: "running",
          startedAt: this.clock(),
        });
        return;
      case "tool_call_started":
        await store.recordToolCall(event.call);
        return;
      case "tool_approval_required": {
        const session = this.sessions.get(event.approval.call.sessionId);
        const target = event.approval.request.path
          ? normalizePath(event.approval.request.path)
          : event.approval.request.command?.trim().replace(/\s+/g, " ");
        await store.recordToolCall(event.approval.call);
        await store.recordApproval({
          id: event.approval.call.id,
          sessionId: event.approval.call.sessionId,
          callId: event.approval.call.id,
          request: event.approval.request,
          mode: session?.activeMode,
          normalizedTarget: target,
          policyRevision: "forge-permissions-v1",
          scope: { kind: "call", callId: event.approval.call.id },
          workspaceTrusted: vscode.workspace.isTrusted,
          createdAt: this.clock(),
        });
        await this.updateSessionStatus(event.approval.call.sessionId, "waiting_for_approval");
        return;
      }
      case "tool_started":
        await store.recordToolCall(event.call);
        return;
      case "tool_completed":
        await store.updateToolCall(event.call.id, event.call);
        await store.recordToolResult({
          sessionId: event.call.sessionId,
          stepId: event.call.stepId,
          callId: event.call.id,
          result: event.result,
          createdAt: this.clock(),
        });
        return;
      case "usage_updated":
        await store.recordUsage({
          id: `usage-${event.sessionId}-${this.clock()}-${randomUUID()}`,
          sessionId: event.sessionId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          createdAt: this.clock(),
        });
        return;
      case "step_completed":
        await this.updateStep(store, event.sessionId, event.stepId, event.finishReason);
        return;
      case "session_completed":
        await this.updateSessionStatus(event.sessionId, event.status);
        return;
      case "agent_error":
        await this.updateSessionStatus(event.sessionId, "error");
        return;
      case "model_override_rejected":
      case "text_delta":
      case "reasoning_delta":
      case "tool_output_delta":
        // Deltas are intentionally not persisted as separate records. The
        // complete normalized result is written by recordRun, avoiding partial
        // messages and duplicate assistant transcripts during streaming.
        return;
      default:
        return assertNever(event);
    }
  }

  private async updateStep(store: SessionStore, sessionId: string, stepId: string, finishReason?: string): Promise<void> {
    try {
      await store.updateStep(stepId, { status: "completed", endedAt: this.clock(), finishReason });
    } catch (error) {
      // A host may receive a restored/replayed event without its start event;
      // retain the session event stream rather than making that run fatal.
      if (!(error instanceof Error) || !error.message.startsWith("Step not found:")) throw error;
      await store.appendStep({ id: stepId, sessionId, sequence: 0, status: "completed", startedAt: this.clock(), endedAt: this.clock(), finishReason });
    }
  }

  private async updateSessionStatus(sessionId: string, status: AgentSession["status"]): Promise<void> {
    let session = this.sessions.get(sessionId);
    if (!session) session = await (await this.requireStore()).getSession(sessionId, { workspaceId: this.workspaceId() });
    if (!session) return;
    await this.saveSession({ ...session, status, updatedAt: this.clock() });
  }

  private sessionForModeTransition(): AgentSession | undefined {
    if (this.sessions.size === 1) return [...this.sessions.values()][0];
    return [...this.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  private cacheSnapshot(snapshot: SessionSnapshot): void {
    this.sessions.set(snapshot.session.id, snapshot.session);
    this.replay.set(snapshot.session.id, snapshot.messages.map(({ message }) => copyMessage(message)));
    this.providerTranscripts.set(snapshot.session.id, snapshot.providerMessages.map(copyProviderTranscript));
  }

  private rememberMessage(sessionId: string, message: NormalizedMessage): void {
    const messages = this.replay.get(sessionId) ?? [];
    messages.push(copyMessage(message));
    this.replay.set(sessionId, messages);
  }

  private async requireStore(): Promise<SessionStore> {
    if (this.closed) throw new Error("Session persistence is closed.");
    return this.initialization;
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  private workspaceId(): string {
    if (this.options.workspaceId) return this.options.workspaceId;
    const workspaceFile = vscode.workspace.workspaceFile?.toString(true);
    if (workspaceFile) return workspaceFile;
    const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString(true));
    return folders?.join("|") || "global";
  }
}

function withoutProviderFrames(message: NormalizedMessage): NormalizedMessage {
  const { providerFrames: _providerFrames, ...safe } = message;
  return safe;
}

function isSafeDatabaseName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function copyMessage(message: NormalizedMessage): NormalizedMessage {
  return cloneValue(message);
}

function copyProviderFrame(frame: ProviderFrame): ProviderFrame {
  return cloneValue(frame);
}

function copyProviderTranscript(entry: ProviderTranscriptEntry): ProviderTranscriptEntry {
  return { ...entry, payload: cloneValue(entry.payload) };
}

function cloneValue<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function sameMessage(left: NormalizedMessage | undefined, right: NormalizedMessage | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function statusFromRun(status: AgentRunResult["status"]): AgentSession["status"] {
  switch (status) {
    case "completed":
    case "max_steps":
      return "idle";
    case "cancelled":
      return "cancelled";
    case "waiting_for_approval":
      return "waiting_for_approval";
    case "error":
      return "error";
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled agent event: ${JSON.stringify(value)}`);
}
