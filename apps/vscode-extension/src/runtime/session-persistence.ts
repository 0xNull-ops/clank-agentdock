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
  type SessionListOptions,
  type SessionSnapshot,
  type SessionStoreOptions,
  type SqlJsInitializer,
  type ProviderTranscriptEntry,
  type StoredMessage,
} from "@freebuff/agent-storage";

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
  public async list(options: SessionListOptions & { allWorkspaces?: boolean } = {}): Promise<AgentSession[]> {
    const store = await this.requireStore();
    const workspaceId = options.allWorkspaces ? undefined : options.workspaceId ?? this.workspaceId();
    const { allWorkspaces: _allWorkspaces, ...storeOptions } = options;
    return store.listSessions({ ...storeOptions, workspaceId });
  }

  public listSessions(options: SessionListOptions & { allWorkspaces?: boolean } = {}): Promise<AgentSession[]> {
    return this.list(options);
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
    const snapshot = await store.openSession(sessionId, { includeProviderMessages: true });
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

  /** Persist header selection changes even when no provider run follows. */
  public async updateSessionSelection(
    sessionId: string,
    patch: { activeMode?: string; modelId?: string },
  ): Promise<AgentSession | undefined> {
    const store = await this.requireStore();
    const current = this.sessions.get(sessionId) ?? await store.getSession(sessionId);
    if (!current) return undefined;
    if (patch.activeMode && patch.activeMode !== current.activeMode) {
      await store.recordModeTransition(sessionId, {
        from: current.activeMode,
        to: patch.activeMode,
        timestamp: this.clock(),
        reason: "user",
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
    await this.saveSession({ ...session, status, updatedAt: this.clock() });
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
      case "tool_approval_required":
        {
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
    if (!session) session = await (await this.requireStore()).getSession(sessionId);
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
