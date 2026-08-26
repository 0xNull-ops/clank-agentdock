import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SnapshotEntryKind = "file";

export interface SnapshotFile {
  path: string;
  hash: string;
  size: number;
  mode: number;
  kind: SnapshotEntryKind;
  binary: boolean;
  blobPath: string;
}

export interface ExcludedPath {
  path: string;
  reason: "gitignore" | "agentignore" | "protected" | "configured" | "symlink" | "internal";
}

export interface SnapshotManifest {
  id: string;
  label: string;
  workspaceRoot: string;
  capturedAt: number;
  files: SnapshotFile[];
  excluded: ExcludedPath[];
}

export interface Snapshot {
  manifest: SnapshotManifest;
  storagePath: string;
}

export interface CheckpointPair {
  id: string;
  label: string;
  before: Snapshot;
  after: Snapshot;
  createdAt: number;
}

export interface DiffFile {
  path: string;
  status: "added" | "removed" | "modified";
  beforeHash?: string;
  afterHash?: string;
  beforeMode?: number;
  afterMode?: number;
  binary: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface DiffSummary {
  files: DiffFile[];
  filesChanged: number;
  additions: number;
  removals: number;
}

export interface CheckpointStoreOptions {
  workspaceRoot: string;
  /** A location outside .git. Defaults to ~/.freebuff-agent-harness/checkpoints/<workspace-hash>. */
  storeRoot?: string;
  agentIgnoreFile?: string;
  protectedPaths?: string[];
  excludePaths?: string[];
  /** Secrets are excluded by default; set false only for an explicit, deliberate export. */
  excludeSecrets?: boolean;
  /** Optional diagnostics hook, primarily useful for fault-injection tests. */
  restoreHook?: (step: RestoreStep, path: string) => Promise<void> | void;
}

export type RestoreStep = "before-backup" | "after-backup" | "before-install" | "after-install";

interface RestoreJournalEntry {
  path: string;
  backup: "pending" | "moved";
  installed: boolean;
}

interface RestoreJournal {
  version: 1;
  transactionId: string;
  workspaceRoot: string;
  changedPaths: string[];
  entries: RestoreJournalEntry[];
  phase: "prepared" | "backing-up" | "installing" | "rolling-back";
}

export interface CaptureOptions {
  label?: string;
  /** Keep the manifest in memory only. Useful for current-state guards. */
  ephemeral?: boolean;
}

export class CheckpointConflictError extends Error {
  public readonly paths: string[];

  public constructor(paths: string[]) {
    super(`Workspace changed since checkpoint capture: ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? "…" : ""}`);
    this.name = "CheckpointConflictError";
    this.paths = paths;
  }
}

export class CheckpointStore {
  private readonly workspaceRoot: string;
  private readonly storeRoot: string;
  private readonly options: Required<Pick<CheckpointStoreOptions, "excludeSecrets">> & CheckpointStoreOptions;
  private readonly protectedPaths: string[];

  public constructor(options: CheckpointStoreOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.options = { ...options, excludeSecrets: options.excludeSecrets ?? true };
    const workspaceKey = sha256(this.workspaceRoot).slice(0, 20);
    this.storeRoot = resolve(options.storeRoot ?? join(homedir(), ".freebuff-agent-harness", "checkpoints", workspaceKey));
    const gitRoot = resolve(this.workspaceRoot, ".git");
    if (isWithin(gitRoot, this.storeRoot)) {
      throw new Error("Checkpoint store must not be inside the workspace .git directory");
    }
    if (isWithin(this.workspaceRoot, this.storeRoot)) {
      throw new Error("Checkpoint store must live outside the workspace");
    }
    this.protectedPaths = options.protectedPaths ?? [
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/id_rsa",
      "**/id_ed25519",
      "**/credentials*",
      "**/secrets*",
    ];
  }

  public get root(): string {
    return this.storeRoot;
  }

  /** Capture a durable pre/post state. The mutator runs between two snapshots. */
  public async create(label: string, mutator: () => Promise<void> | void): Promise<CheckpointPair> {
    await this.recoverPendingRestores();
    const id = randomUUID();
    // Each side gets its own durable snapshot id; the pair id ties them
    // together while keeping the manifests independently loadable.
    const before = await this.capture(`${label} · before`);
    await mutator();
    const after = await this.capture(`${label} · after`);
    return { id, label, before, after, createdAt: Date.now() };
  }

  /** Alias that reads naturally at agent-turn call sites. */
  public async createTurn(label: string, mutator: () => Promise<void> | void): Promise<CheckpointPair> {
    return this.create(label, mutator);
  }

  public async capture(label = "snapshot", options: CaptureOptions & { id?: string } = {}): Promise<Snapshot> {
    await this.recoverPendingRestores();
    const manifest = await this.scan(options.id ?? randomUUID(), label);
    if (options.ephemeral) return { manifest, storagePath: "" };
    const checkpointPath = join(this.storeRoot, manifest.id);
    const temporaryPath = `${checkpointPath}.tmp-${randomUUID()}`;
    await fs.mkdir(join(temporaryPath, "blobs"), { recursive: true });
    try {
      for (const entry of manifest.files) {
        const destination = join(temporaryPath, "blobs", basenameFor(entry.path, entry.hash));
        await copyFileAtomic(join(this.workspaceRoot, entry.path), destination, entry.mode);
        // Store a path relative to the checkpoint directory. The temporary
        // staging directory is renamed after capture and must never leak into
        // the durable manifest.
        entry.blobPath = join("blobs", basenameFor(entry.path, entry.hash));
      }
      await writeJsonAtomic(join(temporaryPath, "manifest.json"), manifest);
      await fs.mkdir(this.storeRoot, { recursive: true });
      await fs.rename(temporaryPath, checkpointPath);
    } catch (error) {
      await removeIfExists(temporaryPath);
      throw error;
    }
    return { manifest, storagePath: checkpointPath };
  }

  /** Read a durable snapshot by id, useful when reopening a VS Code session. */
  public async load(id: string): Promise<Snapshot> {
    await this.recoverPendingRestores();
    assertSafeId(id);
    const storagePath = join(this.storeRoot, id);
    const manifest = JSON.parse(await fs.readFile(join(storagePath, "manifest.json"), "utf8")) as SnapshotManifest;
    validateManifest(manifest, this.workspaceRoot);
    return { manifest, storagePath };
  }

  public summarize(before: Snapshot | SnapshotManifest, after: Snapshot | SnapshotManifest): DiffSummary {
    const beforeManifest = "manifest" in before ? before.manifest : before;
    const afterManifest = "manifest" in after ? after.manifest : after;
    const previous = new Map(beforeManifest.files.map((entry) => [entry.path, entry]));
    const next = new Map(afterManifest.files.map((entry) => [entry.path, entry]));
    const files: DiffFile[] = [];
    for (const path of new Set([...previous.keys(), ...next.keys()])) {
      const oldEntry = previous.get(path);
      const newEntry = next.get(path);
      if (!oldEntry && newEntry) {
        const lines = newEntry.binary ? { added: 0, removed: 0 } : { added: countLinesFromBlob(newEntry, after), removed: 0 };
        files.push({ path, status: "added", afterHash: newEntry.hash, afterMode: newEntry.mode, binary: newEntry.binary, linesAdded: lines.added, linesRemoved: lines.removed });
      } else if (oldEntry && !newEntry) {
        const lines = oldEntry.binary ? { added: 0, removed: 0 } : { added: 0, removed: countLinesFromBlob(oldEntry, before) };
        files.push({ path, status: "removed", beforeHash: oldEntry.hash, beforeMode: oldEntry.mode, binary: oldEntry.binary, linesAdded: lines.added, linesRemoved: lines.removed });
      } else if (oldEntry && newEntry && (oldEntry.hash !== newEntry.hash || oldEntry.mode !== newEntry.mode)) {
        const lineDiff = oldEntry.binary || newEntry.binary ? { added: 0, removed: 0 } : lineDelta(readBlob(oldEntry, before), readBlob(newEntry, after));
        files.push({ path, status: "modified", beforeHash: oldEntry.hash, afterHash: newEntry.hash, beforeMode: oldEntry.mode, afterMode: newEntry.mode, binary: oldEntry.binary || newEntry.binary, linesAdded: lineDiff.added, linesRemoved: lineDiff.removed });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, filesChanged: files.length, additions: files.reduce((sum, item) => sum + item.linesAdded, 0), removals: files.reduce((sum, item) => sum + item.linesRemoved, 0) };
  }

  public async diffWorkspace(snapshot: Snapshot): Promise<DiffSummary> {
    await this.recoverPendingRestores();
    const current = await this.capture("current workspace", { ephemeral: true });
    return this.summarize(snapshot, current);
  }

  /**
   * Restore the pre-turn state only when the workspace still equals the
   * recorded post-turn state. This protects user edits made after the run.
   */
  public async revert(pair: CheckpointPair): Promise<DiffSummary> {
    await this.recoverPendingRestores();
    const current = await this.capture("revert guard", { ephemeral: true });
    const drift = compareManifests(pair.after.manifest, current.manifest);
    if (drift.length) throw new CheckpointConflictError(drift);
    const summary = this.summarize(pair.before, pair.after);
    await this.restore(pair.before, pair.after);
    return summary;
  }

  private async restore(target: Snapshot, recordedCurrent: Snapshot): Promise<void> {
    const transaction = join(this.storeRoot, `.restore-${randomUUID()}`);
    const backupRoot = join(transaction, "backup");
    const stagedRoot = join(transaction, "staged");
    const targetMap = new Map(target.manifest.files.map((entry) => [entry.path, entry]));
    const currentMap = new Map(recordedCurrent.manifest.files.map((entry) => [entry.path, entry]));
    const changedPaths = new Set([...targetMap.keys(), ...currentMap.keys()]);
    const journal: RestoreJournal = {
      version: 1,
      transactionId: basenameForTransaction(transaction),
      workspaceRoot: this.workspaceRoot,
      changedPaths: [...changedPaths].sort(),
      entries: [...changedPaths].sort().map((path) => ({ path, backup: "pending", installed: false })),
      phase: "prepared",
    };
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.mkdir(stagedRoot, { recursive: true });
    await writeJsonAtomic(join(transaction, "journal.json"), journal);
    try {
      journal.phase = "backing-up";
      await writeJsonAtomic(join(transaction, "journal.json"), journal);
      for (const entry of journal.entries) {
        const path = entry.path;
        const absolute = safeWorkspacePath(this.workspaceRoot, path);
        await this.options.restoreHook?.("before-backup", path);
        await assertNoSymlinkPath(this.workspaceRoot, path);
        if (await exists(absolute)) {
          const backup = join(backupRoot, path);
          await fs.mkdir(dirname(backup), { recursive: true });
          await fs.rename(absolute, backup);
        }
        entry.backup = "moved";
        await writeJsonAtomic(join(transaction, "journal.json"), journal);
        await this.options.restoreHook?.("after-backup", path);
      }
      journal.phase = "installing";
      await writeJsonAtomic(join(transaction, "journal.json"), journal);
      for (const [path, entry] of targetMap) {
        const source = entry.blobPath ? join(target.storagePath, entry.blobPath) : "";
        if (!source || !isWithin(target.storagePath, source)) throw new Error(`Invalid checkpoint blob path for ${path}`);
        await this.options.restoreHook?.("before-install", path);
        const staged = join(stagedRoot, path);
        await fs.mkdir(dirname(staged), { recursive: true });
        await fs.copyFile(source, staged);
        const destination = safeWorkspacePath(this.workspaceRoot, path);
        await assertNoSymlinkPath(this.workspaceRoot, path);
        await fs.mkdir(dirname(destination), { recursive: true });
        await assertNoSymlinkPath(this.workspaceRoot, path);
        await fs.rename(staged, destination);
        await fs.chmod(destination, entry.mode);
        const journalEntry = journal.entries.find((item) => item.path === path);
        if (journalEntry) journalEntry.installed = true;
        await writeJsonAtomic(join(transaction, "journal.json"), journal);
        await this.options.restoreHook?.("after-install", path);
      }
      await removeIfExists(transaction);
    } catch (error) {
      // Roll back immediately when possible. If rollback itself is interrupted,
      // the durable journal is replayed by the next store operation.
      try {
        await this.recoverTransaction(transaction);
      } catch {
        // Preserve the original failure; the journal remains for recovery.
      }
      throw error;
    }
  }

  private async recoverPendingRestores(): Promise<void> {
    if (!(await exists(this.storeRoot))) return;
    const entries = await fs.readdir(this.storeRoot, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith(".restore-")).sort((a, b) => a.name.localeCompare(b.name))) {
      await this.recoverTransaction(join(this.storeRoot, entry.name));
    }
  }

  private async recoverTransaction(transaction: string): Promise<void> {
    if (!isWithin(this.storeRoot, transaction) || resolve(transaction) === resolve(this.storeRoot)) throw new Error("Invalid restore transaction path");
    const journalPath = join(transaction, "journal.json");
    if (!(await exists(journalPath))) {
      await removeIfExists(transaction);
      return;
    }
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as RestoreJournal;
    validateRestoreJournal(journal, this.workspaceRoot);
    const interruptedPhase = journal.phase;
    journal.phase = "rolling-back";
    await writeJsonAtomic(journalPath, journal);
    const backupRoot = join(transaction, "backup");
    // Remove every path that the transaction could have touched. This also
    // handles a crash between an install rename and its journal update.
    for (const path of [...journal.changedPaths].sort((a, b) => b.length - a.length || b.localeCompare(a))) {
      const item = journal.entries.find((entry) => entry.path === path);
      const backupExists = await exists(join(backupRoot, path));
      // During the backup phase, a pending entry whose backup does not exist
      // was never moved and must remain untouched. Once installation began,
      // every entry was prepared, so an absent backup means the pre-state was
      // absent and any workspace file at that path is transaction-owned.
      if (backupExists || item?.backup === "moved" || interruptedPhase === "installing" || interruptedPhase === "rolling-back") {
        await assertNoSymlinkPath(this.workspaceRoot, path);
        await removeWorkspaceFile(safeWorkspacePath(this.workspaceRoot, path));
      }
    }
    for (const path of [...journal.changedPaths].sort()) {
      const backup = join(backupRoot, path);
      if (!(await exists(backup))) continue;
      const destination = safeWorkspacePath(this.workspaceRoot, path);
      await assertNoSymlinkPath(this.workspaceRoot, path);
      await fs.mkdir(dirname(destination), { recursive: true });
      await assertNoSymlinkPath(this.workspaceRoot, path);
      await fs.rename(backup, destination);
    }
    await removeIfExists(transaction);
  }

  private async scan(id: string, label: string): Promise<SnapshotManifest> {
    const excluded: ExcludedPath[] = [];
    const files: SnapshotFile[] = [];
    const gitignore = await readIgnoreFile(join(this.workspaceRoot, ".gitignore"));
    const agentignore = await readIgnoreFile(join(this.workspaceRoot, this.options.agentIgnoreFile ?? ".agentignore"));
    const configured = this.options.excludePaths ?? [];
    const walk = async (directory: string): Promise<void> => {
      let entries: Dirent[];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const item of entries) {
        const absolute = join(directory, item.name);
        const path = relative(this.workspaceRoot, absolute).split(sep).join("/");
        const reason = exclusionReason(path, item.isDirectory(), gitignore, agentignore, configured, this.protectedPaths, this.options.excludeSecrets);
        if (reason) { excluded.push({ path, reason }); continue; }
        if (item.isSymbolicLink()) { excluded.push({ path, reason: "symlink" }); continue; }
        if (item.isDirectory()) { await walk(absolute); continue; }
        if (!item.isFile()) continue;
        const data = await fs.readFile(absolute);
        const stat = await fs.stat(absolute);
        const hash = sha256(data);
        files.push({ path, hash, size: data.byteLength, mode: stat.mode & 0o7777, kind: "file", binary: isBinary(data), blobPath: "" });
      }
    };
    await walk(this.workspaceRoot);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { id, label, workspaceRoot: this.workspaceRoot, capturedAt: Date.now(), files, excluded };
  }
}

function exclusionReason(path: string, directory: boolean, gitignore: string[], agentignore: string[], configured: string[], protectedPaths: string[], excludeSecrets: boolean): ExcludedPath["reason"] | undefined {
  if (path === ".git" || path.startsWith(".git/")) return "internal";
  if (path === ".freebuff-agent-harness" || path.startsWith(".freebuff-agent-harness/")) return "internal";
  if (matchesIgnore(path, gitignore, directory)) return "gitignore";
  if (matchesIgnore(path, agentignore, directory)) return "agentignore";
  if (matchesIgnore(path, configured, directory)) return "configured";
  if (excludeSecrets && matchesIgnore(path, protectedPaths, directory)) return "protected";
  return undefined;
}

function matchesIgnore(path: string, patterns: string[], directory: boolean): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    const value = negated ? pattern.slice(1) : pattern;
    const normalized = value.replace(/^\//, "").replace(/\/$/, "");
    const match = normalized.includes("/") ? glob(normalized, path) : glob(normalized, path.split("/").at(-1) ?? path);
    if (match && (!directory || value.endsWith("/") || normalized === path || normalized.includes("**"))) ignored = !negated;
  }
  return ignored;
}

function glob(pattern: string, value: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") { index += 1; expression += pattern[index + 1] === "/" ? "(?:.*/)?" : ".*"; if (pattern[index + 1] === "/") index += 1; }
    else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(value);
}

function compareManifests(expected: SnapshotManifest, actual: SnapshotManifest): string[] {
  const expectedMap = new Map(expected.files.map((entry) => [entry.path, `${entry.hash}:${entry.mode}`]));
  const actualMap = new Map(actual.files.map((entry) => [entry.path, `${entry.hash}:${entry.mode}`]));
  return [...new Set([...expectedMap.keys(), ...actualMap.keys()])].filter((path) => expectedMap.get(path) !== actualMap.get(path)).sort();
}

function readBlob(entry: SnapshotFile, snapshot: Snapshot | SnapshotManifest): string {
  if (!("storagePath" in snapshot) || !snapshot.storagePath || !entry.blobPath) return "";
  // This function is used only for small text diff summaries. Durable blobs
  // are loaded synchronously from the already-captured local store by callers.
  try { return require("node:fs").readFileSync(join(snapshot.storagePath, entry.blobPath), "utf8") as string; } catch { return ""; }
}

function countLinesFromBlob(entry: SnapshotFile, snapshot: Snapshot | SnapshotManifest): number {
  const value = readBlob(entry, snapshot);
  return value ? value.split(/\r?\n/).filter((line) => line.length > 0).length : 0;
}

function lineDelta(before: string, after: string): { added: number; removed: number } {
  if (!before && !after) return { added: 0, removed: 0 };
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const common = lcsLength(oldLines, newLines);
  return { added: newLines.length - common, removed: oldLines.length - common };
}

function lcsLength(left: string[], right: string[]): number {
  const row = new Array<number>(right.length + 1).fill(0);
  for (const item of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const above = row[index];
      row[index] = item === right[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function basenameFor(path: string, hash: string): string { return `${sha256(path).slice(0, 16)}-${hash}.blob`; }
function basenameForTransaction(path: string): string { return path.split(sep).at(-1) ?? path; }
function assertSafeId(id: string): void { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid checkpoint id"); }
function safeWorkspacePath(root: string, path: string): string { const value = resolve(root, path); if (!isWithin(root, value)) throw new Error(`Path escapes workspace: ${path}`); return value; }
function isWithin(parent: string, child: string): boolean { const rel = relative(resolve(parent), resolve(child)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
async function exists(path: string): Promise<boolean> { try { await fs.lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function removeIfExists(path: string): Promise<void> { await fs.rm(path, { recursive: true, force: true }); }
async function removeWorkspaceFile(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isDirectory()) throw new Error(`Refusing to remove directory during checkpoint recovery: ${path}`);
    await fs.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function assertNoSymlinkPath(root: string, path: string): Promise<void> {
  safeWorkspacePath(root, path);
  const segments = path.split(/[\\/]+/).filter(Boolean);
  let current = resolve(root);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing checkpoint restore through symlink: ${path}`);
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`Invalid checkpoint restore parent: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
async function writeJsonAtomic(path: string, value: unknown): Promise<void> { const temporary = `${path}.tmp-${randomUUID()}`; await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8"); await fs.rename(temporary, path); }
async function copyFileAtomic(source: string, destination: string, mode: number): Promise<void> { const temporary = `${destination}.tmp-${randomUUID()}`; await fs.copyFile(source, temporary); await fs.chmod(temporary, mode); await fs.rename(temporary, destination); }
async function readIgnoreFile(path: string): Promise<string[]> { try { return (await fs.readFile(path, "utf8")).split(/\r?\n/); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
function isBinary(data: Uint8Array): boolean { const limit = Math.min(data.byteLength, 8192); for (let index = 0; index < limit; index += 1) if (data[index] === 0) return true; return false; }
function validateManifest(manifest: SnapshotManifest, workspaceRoot: string): void { if (resolve(manifest.workspaceRoot) !== resolve(workspaceRoot)) throw new Error("Checkpoint belongs to another workspace"); for (const entry of manifest.files) safeWorkspacePath(workspaceRoot, entry.path); }
function validateRestoreJournal(journal: RestoreJournal, workspaceRoot: string): void {
  if (journal.version !== 1 || resolve(journal.workspaceRoot) !== resolve(workspaceRoot)) throw new Error("Invalid checkpoint restore journal");
  const paths = new Set(journal.changedPaths);
  if (paths.size !== journal.changedPaths.length || journal.entries.length !== journal.changedPaths.length) throw new Error("Invalid checkpoint restore journal paths");
  for (const path of journal.changedPaths) safeWorkspacePath(workspaceRoot, path);
  for (const entry of journal.entries) {
    if (!paths.has(entry.path) || (entry.backup !== "pending" && entry.backup !== "moved") || typeof entry.installed !== "boolean") throw new Error("Invalid checkpoint restore journal entry");
  }
}
