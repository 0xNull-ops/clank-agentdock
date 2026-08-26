/** Public, provider-neutral contracts for the workspace tool package. */

export type ToolRisk = "low" | "medium" | "high" | "destructive";
export type ToolCategory = "filesystem" | "search" | "shell" | "git";

export interface WorkspaceToolsLimits {
  /** Maximum file size accepted by a read or mutation. Defaults to 2 MiB. */
  maxFileBytes: number;
  /** Maximum bytes returned by a single textual operation. Defaults to 128 KiB. */
  maxOutputBytes: number;
  /** Maximum result rows returned by listing/search operations. */
  maxResults: number;
  /** Maximum runtime of a command. Defaults to two minutes. */
  maxCommandTimeoutMs: number;
}

export interface WorkspaceToolsOptions {
  /** Absolute workspace root. It is canonicalized once at construction. */
  root: string;
  limits?: Partial<WorkspaceToolsLimits>;
  /** Additional file basenames/globs that are immutable. */
  protectedPatterns?: string[];
  /** Name or path of the rg executable. Defaults to `rg`. */
  rgPath?: string;
  /** Name or path of git. Defaults to `git`. */
  gitPath?: string;
}

export interface ToolContext {
  signal?: AbortSignal;
  emit?: (output: string) => void;
}

export interface WorkspaceToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: ToolCategory;
  risk: ToolRisk;
  execute(input: unknown, ctx?: ToolContext): Promise<unknown>;
}

/** Alias used by registry adapters that call their executable entries AgentTools. */
export type WorkspaceAgentTool = WorkspaceToolDefinition;

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  bytes: number;
  truncated: boolean;
}

export interface ListDirectoryInput {
  path?: string;
  maxResults?: number;
}

export interface DirectoryEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface ListDirectoryResult {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface GlobInput {
  pattern: string;
  cwd?: string;
  maxResults?: number;
  hidden?: boolean;
}

export interface GlobResult {
  pattern: string;
  matches: string[];
  truncated: boolean;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  cwd?: string;
  glob?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
  maxBytes?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export interface WriteFileInput {
  path: string;
  content: string;
  /** Create missing parent directories. Defaults to false. */
  createDirectories?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
  created: boolean;
}

export interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
  /** Defaults to one, preventing an accidental broad replacement. */
  expectedReplacements?: number;
  occurrence?: "first" | "all";
}

export interface EditFileResult extends WriteFileResult {
  replacements: number;
}

export interface ApplyPatchInput {
  patch: string;
}

export interface PatchedFile {
  path: string;
  additions: number;
  deletions: number;
  created: boolean;
}

export interface ApplyPatchResult {
  files: PatchedFile[];
}

export interface RunCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  purpose?: string;
  maxOutputBytes?: number;
}

export type CommandClass =
  | "READ_ONLY"
  | "BUILD"
  | "TEST"
  | "LINT"
  | "FORMAT"
  | "PACKAGE_INSTALL"
  | "FILE_MUTATION"
  | "GIT_WRITE"
  | "NETWORK"
  | "PRIVILEGED"
  | "DESTRUCTIVE"
  | "UNKNOWN";

export interface RunCommandResult {
  command: string;
  cwd: string;
  classification: CommandClass;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface GitInput {
  cwd?: string;
}

export interface GitStatusInput extends GitInput {
  includeUntracked?: boolean;
}

export interface GitDiffInput extends GitInput {
  path?: string;
  revision?: string;
}

export interface GitLogInput extends GitInput {
  path?: string;
  maxCount?: number;
  revision?: string;
}

export interface GitShowInput extends GitInput {
  revision: string;
  path?: string;
}

export interface GitBranchInput extends GitInput {
  all?: boolean;
}

export interface GitBlameInput extends GitInput {
  path: string;
  revision?: string;
}

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

export interface GitStatusResult {
  branch: string | null;
  entries: GitStatusEntry[];
  raw: string;
}

export interface GitDiffResult {
  diff: string;
}

export interface GitCommitSummary {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}

export interface GitLogResult {
  commits: GitCommitSummary[];
  raw: string;
}

export interface GitShowResult {
  content: string;
}

export interface GitBranchResult {
  branches: string[];
}

export interface GitBlameLine {
  commit: string;
  author: string;
  line: number;
  text: string;
}

export interface GitBlameResult {
  lines: GitBlameLine[];
  raw: string;
}
