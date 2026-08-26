import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { promises as fs } from "node:fs";
import initSqlJs from "sql.js";
import type {
  AgentSession,
  ModeTransition,
  NormalizedMessage,
  PermissionDecision,
  PermissionRequest,
  ToolCallRecord,
  ToolExecutionResult,
} from "@freebuff/agent-core";
import type {
  ApprovalRecord,
  ProviderTranscriptEntry,
  RecoveryResult,
  SessionExport,
  SessionListOptions,
  SessionScopeOptions,
  SessionSnapshot,
  SessionStoreOptions,
  SqlJsDatabase,
  SqlJsInitializer,
  StepRecord,
  StoredMessage,
  StoredToolCall,
  StoredToolResult,
  TranscriptOptions,
  UsageRecord,
} from "./types";

export const SCHEMA_VERSION = 1;
/** Maximum number of Unicode code points permitted in a session title. */
export const MAX_SESSION_TITLE_LENGTH = 200;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2_000;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active_mode TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_workspace_updated_idx
        ON sessions(workspace_id, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        mode TEXT,
        provider_id TEXT,
        model_id TEXT,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, sequence);

      CREATE TABLE IF NOT EXISTS provider_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS provider_messages_session_idx
        ON provider_messages(session_id, sequence);

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        finish_reason TEXT,
        error_json TEXT,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS steps_session_idx ON steps(session_id, sequence);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        raw_arguments TEXT NOT NULL,
        parsed_arguments_json TEXT,
        permission_decision TEXT,
        status TEXT NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tool_calls_session_idx ON tool_calls(session_id, id);
      CREATE INDEX IF NOT EXISTS tool_calls_step_idx ON tool_calls(step_id);

      CREATE TABLE IF NOT EXISTS tool_results (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tool_results_session_idx ON tool_results(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS tool_results_call_idx ON tool_results(call_id);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
        request_json TEXT NOT NULL,
        decision_json TEXT,
        mode TEXT,
        normalized_target TEXT,
        policy_revision TEXT,
        scope_json TEXT,
        expires_at INTEGER,
        workspace_trusted INTEGER,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS approvals_session_idx ON approvals(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals(session_id) WHERE decision_json IS NULL;

      CREATE TABLE IF NOT EXISTS mode_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_mode TEXT NOT NULL,
        to_mode TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mode_transitions_session_idx
        ON mode_transitions(session_id, timestamp, id);

      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        step_id TEXT REFERENCES steps(id) ON DELETE SET NULL,
        provider_id TEXT,
        model_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_session_idx ON usage(session_id, created_at, id);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `,
  },
];

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return JSON.parse(String(value)) as T;
}

function value<T>(row: Record<string, unknown>, key: string): T {
  return row[key] as T;
}

function integer(valueToParse: unknown): number {
  return Number(valueToParse);
}

function bool(valueToParse: unknown): boolean | undefined {
  if (valueToParse === null || valueToParse === undefined) return undefined;
  return Boolean(Number(valueToParse));
}

function limitOf(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit!)));
}

function defaultId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

function stripProviderFrames(message: NormalizedMessage): NormalizedMessage {
  const copy = { ...message };
  delete copy.providerFrames;
  return copy;
}

/**
 * A small, serialized SQLite repository. sql.js keeps the SQLite database in
 * memory and this class atomically writes its exported bytes after mutations,
 * which works in the VS Code extension host without native Node add-ons.
 */
export class SessionStore {
  private readonly filePath: string;
  private readonly clock: () => number;
  private db: SqlJsDatabase;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private recovery: RecoveryResult = { sessionIds: [], approvalIds: [] };

  private constructor(db: SqlJsDatabase, options: SessionStoreOptions) {
    // sql.js deliberately rejects JavaScript `undefined` as a bind value;
    // SQL NULL is the correct representation for optional fields.
    this.db = {
      run: (sql, params) => db.run(sql, normalizeParams(params)),
      exec: (sql, params) => db.exec(sql, normalizeParams(params)),
      prepare: (sql, params) => db.prepare(sql, normalizeParams(params)),
      export: () => db.export(),
      close: () => db.close(),
    };
    this.filePath = options.filePath;
    this.clock = options.now ?? Date.now;
  }

  public static async open(options: SessionStoreOptions): Promise<SessionStore> {
    if (!options.filePath) throw new Error("SessionStore requires a filePath.");
    const initializer = options.sqlJs ?? (initSqlJs as unknown as SqlJsInitializer);
    const bytes = options.filePath === ":memory:" ? undefined : await readDatabase(options.filePath);
    const module = await initializer({ locateFile: options.locateFile ?? locateSqlWasm });
    const store = new SessionStore(new module.Database(bytes), options);
    store.db.run("PRAGMA foreign_keys = ON");
    const migrated = store.migrate();
    // Keep the invariant true after migrations as well. SQLite ignores a
    // foreign_keys pragma issued while a transaction is active, and existing
    // databases may have been opened with it disabled by another client.
    store.db.run("PRAGMA foreign_keys = ON");
    store.recovery = store.recoverInterruptedSessionsSync();
    if (migrated || store.recovery.sessionIds.length > 0 || store.recovery.approvalIds.length > 0) {
      await store.persist();
    }
    return store;
  }

  public get lastRecovery(): RecoveryResult {
    return {
      sessionIds: [...this.recovery.sessionIds],
      approvalIds: [...this.recovery.approvalIds],
    };
  }

  public async flush(): Promise<void> {
    await this.enqueue(async () => this.persist());
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.db.close();
  }

  public async createSession(session: AgentSession): Promise<AgentSession> {
    return this.saveSession(session);
  }

  public async saveSession(session: AgentSession): Promise<AgentSession> {
    this.assertSession(session);
    return this.mutate(() => {
      this.db.run(
        `INSERT INTO sessions
          (id, workspace_id, title, created_at, updated_at, active_mode, provider_id, model_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          workspace_id=excluded.workspace_id, title=excluded.title,
          updated_at=excluded.updated_at, active_mode=excluded.active_mode,
          provider_id=excluded.provider_id, model_id=excluded.model_id, status=excluded.status`,
        [session.id, session.workspaceId, session.title, session.createdAt, session.updatedAt, session.activeMode, session.providerId, session.modelId, session.status],
      );
      return session;
    });
  }

  public async getSession(sessionId: string, options: SessionScopeOptions = {}): Promise<AgentSession | undefined> {
    return this.enqueue(() => this.getSessionSync(sessionId, options.workspaceId));
  }

  /**
   * Rename a session and update its recency timestamp.
   *
   * A workspace guard is optional for compatibility with globally unique
   * session ids, but callers operating in a workspace should always provide
   * it. A mismatched guard is treated like a missing session and does not
   * reveal or mutate the other workspace's session.
   */
  public async renameSession(
    sessionId: string,
    title: string,
    options: SessionScopeOptions = {},
  ): Promise<AgentSession | undefined> {
    const normalizedTitle = normalizeSessionTitle(title);
    return this.mutate(() => {
      const existing = this.getSessionSync(sessionId, options.workspaceId);
      if (!existing) return undefined;
      const updated = { ...existing, title: normalizedTitle, updatedAt: this.clock() };
      this.db.run("UPDATE sessions SET title=?, updated_at=? WHERE id=?", [normalizedTitle, updated.updatedAt, sessionId]);
      return updated;
    });
  }

  /**
   * Delete a session and all of its transcript, run, tool, approval, and usage
   * rows in one durable transaction. Foreign-key cascades are enabled when
   * the database opens; the workspace guard prevents deleting a same-id
   * session routed from a different workspace.
   */
  public async deleteSession(
    sessionId: string,
    options: SessionScopeOptions = {},
  ): Promise<boolean> {
    return this.mutate(() => {
      const existing = this.getSessionSync(sessionId, options.workspaceId);
      if (!existing) return false;
      this.db.run("DELETE FROM sessions WHERE id=?", [sessionId]);
      return true;
    });
  }

  public async listSessions(options: SessionListOptions = {}): Promise<AgentSession[]> {
    return this.enqueue(() => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (options.workspaceId) {
        clauses.push("workspace_id = ?");
        params.push(options.workspaceId);
      }
      if (options.beforeUpdatedAt !== undefined) {
        clauses.push("updated_at < ?");
        params.push(options.beforeUpdatedAt);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return this.rows<AgentSession>(
        `SELECT id, workspace_id, title, created_at, updated_at, active_mode, provider_id, model_id, status
           FROM sessions ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
        [...params, limitOf(options.limit)],
        (row) => this.sessionFromRow(row),
      );
    });
  }

  public async appendMessage(
    sessionId: string,
    message: NormalizedMessage,
    options: { id?: string; sequence?: number; createdAt?: number; mode?: string; providerId?: string; modelId?: string } = {},
  ): Promise<StoredMessage> {
    const stored: StoredMessage = {
      id: options.id ?? defaultId("msg"),
      sessionId,
      sequence: options.sequence ?? 0,
      message,
      createdAt: options.createdAt ?? this.clock(),
    };
    return this.mutate(() => {
      this.requireSession(sessionId);
      if (options.sequence === undefined) stored.sequence = this.nextSequence("messages", sessionId);
      this.db.run(
        `INSERT INTO messages
          (id, session_id, sequence, role, content_json, message_json, created_at, mode, provider_id, model_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stored.id, sessionId, stored.sequence, message.role, JSON.stringify(message.content), JSON.stringify(message), stored.createdAt, options.mode, options.providerId, options.modelId],
      );
      return stored;
    });
  }

  public async appendProviderMessage(
    sessionId: string,
    entry: Omit<ProviderTranscriptEntry, "id" | "sessionId" | "sequence" | "createdAt"> & Partial<Pick<ProviderTranscriptEntry, "id" | "sequence" | "createdAt">>,
  ): Promise<ProviderTranscriptEntry> {
    const stored: ProviderTranscriptEntry = {
      id: entry.id ?? defaultId("provider"),
      sessionId,
      sequence: entry.sequence ?? 0,
      providerId: entry.providerId,
      modelId: entry.modelId,
      payload: entry.payload,
      createdAt: entry.createdAt ?? this.clock(),
    };
    return this.mutate(() => {
      this.requireSession(sessionId);
      if (entry.sequence === undefined) stored.sequence = this.nextSequence("provider_messages", sessionId);
      this.db.run(
        `INSERT INTO provider_messages
          (id, session_id, sequence, provider_id, model_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [stored.id, sessionId, stored.sequence, stored.providerId, stored.modelId, JSON.stringify(stored.payload ?? null), stored.createdAt],
      );
      return stored;
    });
  }

  public async appendStep(step: StepRecord): Promise<StepRecord> {
    return this.mutate(() => {
      this.requireSession(step.sessionId);
      const stored = { ...step, sequence: step.sequence ?? this.nextSequence("steps", step.sessionId) };
      this.db.run(
        `INSERT INTO steps (id, session_id, sequence, status, started_at, ended_at, finish_reason, error_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [stored.id, stored.sessionId, stored.sequence, stored.status, stored.startedAt, stored.endedAt, stored.finishReason, json(stored.error)],
      );
      return stored;
    });
  }

  public async updateStep(stepId: string, patch: Partial<Omit<StepRecord, "id" | "sessionId">>): Promise<StepRecord> {
    return this.mutate(() => {
      const existing = this.stepById(stepId);
      if (!existing) throw new Error(`Step not found: ${stepId}`);
      const updated = { ...existing, ...patch };
      this.db.run(
        `UPDATE steps SET status=?, ended_at=?, finish_reason=?, error_json=? WHERE id=?`,
        [updated.status, updated.endedAt, updated.finishReason, json(updated.error), stepId],
      );
      return updated;
    });
  }

  public async recordToolCall(call: ToolCallRecord): Promise<StoredToolCall> {
    return this.mutate(() => {
      this.requireSession(call.sessionId);
      const stored = call as StoredToolCall;
      this.db.run(
        `INSERT INTO tool_calls
          (id, session_id, step_id, tool_name, raw_arguments, parsed_arguments_json, permission_decision, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          tool_name=excluded.tool_name, raw_arguments=excluded.raw_arguments,
          parsed_arguments_json=excluded.parsed_arguments_json,
          permission_decision=excluded.permission_decision, status=excluded.status,
          started_at=excluded.started_at, ended_at=excluded.ended_at`,
        [stored.id, stored.sessionId, stored.stepId, stored.toolName, stored.rawArguments, json(stored.parsedArguments), stored.permissionDecision, stored.status, stored.startedAt, stored.endedAt],
      );
      return stored;
    });
  }

  public async updateToolCall(callId: string, patch: Partial<Omit<ToolCallRecord, "id" | "sessionId" | "stepId">>): Promise<StoredToolCall> {
    return this.mutate(() => {
      const existing = this.toolCallById(callId);
      if (!existing) throw new Error(`Tool call not found: ${callId}`);
      const updated = { ...existing, ...patch } as StoredToolCall;
      this.db.run(
        `UPDATE tool_calls SET tool_name=?, raw_arguments=?, parsed_arguments_json=?, permission_decision=?, status=?, started_at=?, ended_at=? WHERE id=?`,
        [updated.toolName, updated.rawArguments, json(updated.parsedArguments), updated.permissionDecision, updated.status, updated.startedAt, updated.endedAt, callId],
      );
      return updated;
    });
  }

  public async recordToolResult(
    result: StoredToolResult | { id?: string; sessionId: string; stepId: string; callId: string; result: ToolExecutionResult; createdAt?: number },
  ): Promise<StoredToolResult> {
    return this.mutate(() => {
      this.requireSession(result.sessionId);
      const stored: StoredToolResult = { ...result, id: result.id ?? defaultId("result"), createdAt: result.createdAt ?? this.clock() };
      this.db.run(
        `INSERT INTO tool_results (id, session_id, step_id, call_id, content, is_error, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [stored.id, stored.sessionId, stored.stepId, stored.callId, stored.result.content, stored.result.isError ? 1 : 0, JSON.stringify(stored.result), stored.createdAt],
      );
      return stored;
    });
  }

  public async recordApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    return this.mutate(() => {
      this.requireSession(approval.sessionId);
      this.db.run(
        `INSERT INTO approvals
          (id, session_id, call_id, request_json, decision_json, mode, normalized_target, policy_revision, scope_json, expires_at, workspace_trusted, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          decision_json=excluded.decision_json, decided_at=excluded.decided_at`,
        [approval.id, approval.sessionId, approval.callId, JSON.stringify(approval.request), json(approval.decision), approval.mode, approval.normalizedTarget, approval.policyRevision, json(approval.scope), approval.expiresAt, approval.workspaceTrusted === undefined ? undefined : approval.workspaceTrusted ? 1 : 0, approval.createdAt, approval.decidedAt],
      );
      return approval;
    });
  }

  public async decideApproval(id: string, decision: PermissionDecision | "allow" | "deny", decidedAt = this.clock()): Promise<ApprovalRecord> {
    return this.mutate(() => {
      const existing = this.approvalById(id);
      if (!existing) throw new Error(`Approval not found: ${id}`);
      const updated = { ...existing, decision, decidedAt };
      this.db.run(`UPDATE approvals SET decision_json=?, decided_at=? WHERE id=?`, [JSON.stringify(decision), decidedAt, id]);
      return updated;
    });
  }

  public async recordModeTransition(sessionId: string, transition: ModeTransition): Promise<ModeTransition> {
    return this.mutate(() => {
      this.requireSession(sessionId);
      this.db.run(
        `INSERT INTO mode_transitions (session_id, from_mode, to_mode, timestamp, reason) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, transition.from, transition.to, transition.timestamp, transition.reason],
      );
      return transition;
    });
  }

  public async recordUsage(usage: UsageRecord): Promise<UsageRecord> {
    return this.mutate(() => {
      this.requireSession(usage.sessionId);
      const stored = { ...usage, id: usage.id ?? defaultId("usage"), createdAt: usage.createdAt ?? this.clock() };
      this.db.run(
        `INSERT INTO usage (id, session_id, step_id, provider_id, model_id, input_tokens, output_tokens, total_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stored.id, stored.sessionId, stored.stepId, stored.providerId, stored.modelId, stored.inputTokens, stored.outputTokens, stored.totalTokens ?? sumTokens(stored.inputTokens, stored.outputTokens), stored.createdAt],
      );
      return stored;
    });
  }

  public async openSession(sessionId: string, options: TranscriptOptions = {}): Promise<SessionSnapshot | undefined> {
    return this.enqueue(() => this.snapshotSync(sessionId, options));
  }

  public async exportSession(sessionId: string, options: TranscriptOptions = {}): Promise<SessionExport | undefined> {
    return this.enqueue(() => {
      const snapshot = this.snapshotSync(sessionId, options);
      if (!snapshot) return undefined;
      const includeProvider = options.includeProviderMessages === true;
      const messages = snapshot.messages.map((stored) => ({
        ...stored,
        message: options.includeProviderFrames === true ? stored.message : stripProviderFrames(stored.message),
      }));
      const { providerMessages: _providerMessages, ...withoutProviderMessages } = snapshot;
      return {
        ...withoutProviderMessages,
        messages,
        ...(includeProvider ? { providerMessages: snapshot.providerMessages } : {}),
        exportedAt: this.clock(),
        truncated: this.collectionWasTruncated(sessionId, limitOf(options.limit)),
      };
    });
  }

  /** Mark host-interrupted runs as cancelled and deny orphaned approvals. */
  public async recoverInterruptedSessions(): Promise<RecoveryResult> {
    return this.mutate(() => this.recoverInterruptedSessionsSync());
  }

  private recoverInterruptedSessionsSync(): RecoveryResult {
    const now = this.clock();
    const sessionIds = this.rows<{ id: string }>(
      `SELECT id FROM sessions WHERE status IN ('running', 'waiting_for_approval')`,
      [],
      (row) => ({ id: String(value(row, "id")) }),
    ).map((item) => item.id);
    const approvalIds = this.rows<{ id: string }>(
      `SELECT id FROM approvals WHERE decision_json IS NULL AND session_id IN (SELECT id FROM sessions WHERE status IN ('running', 'waiting_for_approval'))`,
      [],
      (row) => ({ id: String(value(row, "id")) }),
    ).map((item) => item.id);
    if (sessionIds.length) {
      this.db.run(`UPDATE sessions SET status='cancelled', updated_at=? WHERE status IN ('running', 'waiting_for_approval')`, [now]);
    }
    if (approvalIds.length) {
      this.db.run(
        `UPDATE approvals SET decision_json=?, decided_at=? WHERE decision_json IS NULL AND id IN (${approvalIds.map(() => "?").join(", ")})`,
        [JSON.stringify({ effect: "deny", source: "hard-safety", reason: "Approval expired when the host restarted." }), now, ...approvalIds],
      );
    }
    return { sessionIds, approvalIds };
  }

  private migrate(): boolean {
    const current = this.currentSchemaVersion();
    if (current > SCHEMA_VERSION) throw new Error(`Session database schema ${current} is newer than supported schema ${SCHEMA_VERSION}.`);
    let changed = false;
    this.db.run("BEGIN");
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue;
        this.db.run(migration.sql);
        this.db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [migration.version, this.clock()]);
        this.db.run(`PRAGMA user_version = ${migration.version}`);
        changed = true;
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    return changed;
  }

  private currentSchemaVersion(): number {
    const result = this.db.exec("PRAGMA user_version");
    return result[0]?.values[0]?.[0] ? Number(result[0].values[0][0]) : 0;
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    return this.enqueue(async () => {
      this.db.run("BEGIN");
      try {
        const result = operation();
        this.db.run("COMMIT");
        await this.persist();
        return result;
      } catch (error) {
        try { this.db.run("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    this.assertOpen();
    if (this.filePath === ":memory:") return;
    const bytes = this.db.export();
    // sql.js resets connection pragmas while materializing an exported
    // database. Restore foreign-key enforcement before the next mutation so
    // session deletion keeps its ON DELETE CASCADE contract.
    this.db.run("PRAGMA foreign_keys = ON");
    await atomicWrite(this.filePath, bytes);
  }

  private getSessionSync(sessionId: string, workspaceId?: string): AgentSession | undefined {
    const workspaceClause = workspaceId === undefined ? "" : " AND workspace_id=?";
    return this.rows<AgentSession>(
      `SELECT id, workspace_id, title, created_at, updated_at, active_mode, provider_id, model_id, status
         FROM sessions WHERE id=?${workspaceClause}`,
      workspaceId === undefined ? [sessionId] : [sessionId, workspaceId],
      (row) => this.sessionFromRow(row),
    )[0];
  }

  private sessionFromRow(row: Record<string, unknown>): AgentSession {
    return {
      id: String(value(row, "id")),
      workspaceId: String(value(row, "workspace_id")),
      title: String(value(row, "title")),
      createdAt: integer(value(row, "created_at")),
      updatedAt: integer(value(row, "updated_at")),
      activeMode: String(value(row, "active_mode")),
      providerId: String(value(row, "provider_id")),
      modelId: String(value(row, "model_id")),
      status: value(row, "status") as AgentSession["status"],
    };
  }

  private snapshotSync(sessionId: string, options: TranscriptOptions): SessionSnapshot | undefined {
    const session = this.getSessionSync(sessionId, options.workspaceId);
    if (!session) return undefined;
    const limit = limitOf(options.limit);
    const messages = this.rows<StoredMessage>(
      "SELECT id, session_id, sequence, message_json, created_at FROM messages WHERE session_id=? ORDER BY sequence LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), sequence: integer(value(row, "sequence")), message: JSON.parse(String(value(row, "message_json"))) as NormalizedMessage, createdAt: integer(value(row, "created_at")) }),
    );
    const providerMessages = this.rows<ProviderTranscriptEntry>(
      "SELECT id, session_id, sequence, provider_id, model_id, payload_json, created_at FROM provider_messages WHERE session_id=? ORDER BY sequence LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), sequence: integer(value(row, "sequence")), providerId: String(value(row, "provider_id")), modelId: String(value(row, "model_id")), payload: JSON.parse(String(value(row, "payload_json"))), createdAt: integer(value(row, "created_at")) }),
    );
    const steps = this.rows<StepRecord>(
      "SELECT id, session_id, sequence, status, started_at, ended_at, finish_reason, error_json FROM steps WHERE session_id=? ORDER BY sequence LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), sequence: integer(value(row, "sequence")), status: value(row, "status") as StepRecord["status"], startedAt: integer(value(row, "started_at")), endedAt: value(row, "ended_at") == null ? undefined : integer(value(row, "ended_at")), finishReason: value(row, "finish_reason") == null ? undefined : String(value(row, "finish_reason")), error: parseJson(value(row, "error_json")) }),
    );
    const toolCalls = this.rows<StoredToolCall>(
      "SELECT id, session_id, step_id, tool_name, raw_arguments, parsed_arguments_json, permission_decision, status, started_at, ended_at FROM tool_calls WHERE session_id=? ORDER BY rowid LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), stepId: String(value(row, "step_id")), toolName: String(value(row, "tool_name")), rawArguments: String(value(row, "raw_arguments")), parsedArguments: parseJson(value(row, "parsed_arguments_json")), permissionDecision: value(row, "permission_decision") == null ? undefined : value(row, "permission_decision") as ToolCallRecord["permissionDecision"], status: value(row, "status") as ToolCallRecord["status"], startedAt: value(row, "started_at") == null ? undefined : integer(value(row, "started_at")), endedAt: value(row, "ended_at") == null ? undefined : integer(value(row, "ended_at")) }),
    );
    const toolResults = this.rows<StoredToolResult>(
      "SELECT id, session_id, step_id, call_id, result_json, created_at FROM tool_results WHERE session_id=? ORDER BY created_at, id LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), stepId: String(value(row, "step_id")), callId: String(value(row, "call_id")), result: JSON.parse(String(value(row, "result_json"))) as ToolExecutionResult, createdAt: integer(value(row, "created_at")) }),
    );
    const approvals = this.rows<ApprovalRecord>(
      "SELECT id, session_id, call_id, request_json, decision_json, mode, normalized_target, policy_revision, scope_json, expires_at, workspace_trusted, created_at, decided_at FROM approvals WHERE session_id=? ORDER BY created_at, id LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), callId: String(value(row, "call_id")), request: JSON.parse(String(value(row, "request_json"))) as PermissionRequest, decision: parseJson<ApprovalRecord["decision"]>(value(row, "decision_json")), mode: nullableString(value(row, "mode")), normalizedTarget: nullableString(value(row, "normalized_target")), policyRevision: nullableString(value(row, "policy_revision")), scope: parseJson(value(row, "scope_json")), expiresAt: nullableInteger(value(row, "expires_at")), workspaceTrusted: bool(value(row, "workspace_trusted")), createdAt: integer(value(row, "created_at")), decidedAt: nullableInteger(value(row, "decided_at")) }),
    );
    const modeTransitions = this.rows<ModeTransition>(
      "SELECT from_mode, to_mode, timestamp, reason FROM mode_transitions WHERE session_id=? ORDER BY timestamp, id LIMIT ?",
      [sessionId, limit],
      (row) => ({ from: String(value(row, "from_mode")), to: String(value(row, "to_mode")), timestamp: integer(value(row, "timestamp")), reason: value(row, "reason") as ModeTransition["reason"] }),
    );
    const usage = this.rows<UsageRecord>(
      "SELECT id, session_id, step_id, provider_id, model_id, input_tokens, output_tokens, total_tokens, created_at FROM usage WHERE session_id=? ORDER BY created_at, id LIMIT ?",
      [sessionId, limit],
      (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), stepId: nullableString(value(row, "step_id")), providerId: nullableString(value(row, "provider_id")), modelId: nullableString(value(row, "model_id")), inputTokens: nullableInteger(value(row, "input_tokens")), outputTokens: nullableInteger(value(row, "output_tokens")), totalTokens: nullableInteger(value(row, "total_tokens")), createdAt: integer(value(row, "created_at")) }),
    );
    return { session, messages, providerMessages, steps, toolCalls, toolResults, approvals, modeTransitions, usage };
  }

  private collectionWasTruncated(sessionId: string, limit: number): boolean {
    const row = this.db.exec(`SELECT
      (SELECT COUNT(*) FROM messages WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM provider_messages WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM steps WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM tool_calls WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM tool_results WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM approvals WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM mode_transitions WHERE session_id='${escapeSql(sessionId)}') > ${limit} OR
      (SELECT COUNT(*) FROM usage WHERE session_id='${escapeSql(sessionId)}') > ${limit} AS truncated`);
    return Boolean(Number(row[0]?.values[0]?.[0] ?? 0));
  }

  private nextSequence(table: "messages" | "provider_messages" | "steps", sessionId: string): number {
    const result = this.db.exec(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ${table} WHERE session_id='${escapeSql(sessionId)}'`);
    return Number(result[0]?.values[0]?.[0] ?? 1);
  }

  private stepById(id: string): StepRecord | undefined {
    return this.rows<StepRecord>("SELECT id, session_id, sequence, status, started_at, ended_at, finish_reason, error_json FROM steps WHERE id=?", [id], (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), sequence: integer(value(row, "sequence")), status: value(row, "status") as StepRecord["status"], startedAt: integer(value(row, "started_at")), endedAt: nullableInteger(value(row, "ended_at")), finishReason: nullableString(value(row, "finish_reason")), error: parseJson(value(row, "error_json")) }))[0];
  }

  private toolCallById(id: string): StoredToolCall | undefined {
    return this.rows<StoredToolCall>("SELECT id, session_id, step_id, tool_name, raw_arguments, parsed_arguments_json, permission_decision, status, started_at, ended_at FROM tool_calls WHERE id=?", [id], (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), stepId: String(value(row, "step_id")), toolName: String(value(row, "tool_name")), rawArguments: String(value(row, "raw_arguments")), parsedArguments: parseJson(value(row, "parsed_arguments_json")), permissionDecision: value(row, "permission_decision") as ToolCallRecord["permissionDecision"], status: value(row, "status") as ToolCallRecord["status"], startedAt: nullableInteger(value(row, "started_at")), endedAt: nullableInteger(value(row, "ended_at")) }))[0];
  }

  private approvalById(id: string): ApprovalRecord | undefined {
    const snapshot = this.rows<ApprovalRecord>("SELECT id, session_id, call_id, request_json, decision_json, mode, normalized_target, policy_revision, scope_json, expires_at, workspace_trusted, created_at, decided_at FROM approvals WHERE id=?", [id], (row) => ({ id: String(value(row, "id")), sessionId: String(value(row, "session_id")), callId: String(value(row, "call_id")), request: JSON.parse(String(value(row, "request_json"))) as PermissionRequest, decision: parseJson(value(row, "decision_json")), mode: nullableString(value(row, "mode")), normalizedTarget: nullableString(value(row, "normalized_target")), policyRevision: nullableString(value(row, "policy_revision")), scope: parseJson(value(row, "scope_json")), expiresAt: nullableInteger(value(row, "expires_at")), workspaceTrusted: bool(value(row, "workspace_trusted")), createdAt: integer(value(row, "created_at")), decidedAt: nullableInteger(value(row, "decided_at")) }));
    return snapshot[0];
  }

  private requireSession(sessionId: string): void {
    if (!this.getSessionSync(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  }

  private rows<T>(sql: string, params: unknown[], map: (row: Record<string, unknown>) => T): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const output: T[] = [];
      while (statement.step()) output.push(map(statement.getAsObject()));
      return output;
    } finally {
      statement.free();
    }
  }

  private assertSession(session: AgentSession): void {
    if (!session.id || !session.workspaceId) throw new Error("A session id and workspaceId are required.");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SessionStore is closed.");
  }
}

async function readDatabase(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(filePath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(Buffer.from(bytes));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function locateSqlWasm(file: string): string {
  try {
    return require.resolve(`sql.js/dist/${file}`);
  } catch {
    return file;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function nullableString(input: unknown): string | undefined {
  return input == null ? undefined : String(input);
}

function nullableInteger(input: unknown): number | undefined {
  return input == null ? undefined : integer(input);
}

function sumTokens(input?: number, output?: number): number | undefined {
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

function normalizeParams(params?: unknown[] | Record<string, unknown>): unknown[] | Record<string, unknown> | undefined {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params.map((item) => item === undefined ? null : item);
  return Object.fromEntries(Object.entries(params).map(([key, item]) => [key, item === undefined ? null : item]));
}

function normalizeSessionTitle(title: string): string {
  const normalized = typeof title === "string" ? title.trim() : "";
  if (normalized.length === 0) throw new Error("Session title must be non-empty.");
  if ([...normalized].length > MAX_SESSION_TITLE_LENGTH) {
    throw new Error(`Session title must be at most ${MAX_SESSION_TITLE_LENGTH} characters.`);
  }
  return normalized;
}

function escapeSql(input: string): string {
  return input.replace(/'/g, "''");
}
