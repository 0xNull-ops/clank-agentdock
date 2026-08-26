import { mkdir, mkdtemp, readFile, readdir, rename, rm, lstat, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { captureExecFile, classifyCommand, DEFAULT_TOOL_LIMITS, runCommand } from "./commands";
import { WorkspacePathGuard, WorkspaceToolError, workspaceGlobMatches } from "./paths";
import type {
  ApplyPatchResult, DirectoryEntry, EditFileInput, EditFileResult, GitBlameInput, GitBlameLine, GitBlameResult,
  GitBranchInput, GitBranchResult, GitCommitSummary, GitDiffInput, GitDiffResult, GitInput, GitLogInput, GitLogResult,
  GitShowInput, GitShowResult, GitStatusEntry, GitStatusInput, GitStatusResult, GlobInput, GlobResult, GrepInput,
  GrepMatch, GrepResult, ListDirectoryInput, ListDirectoryResult, ReadFileInput, ReadFileResult, RunCommandInput,
  RunCommandResult, WorkspaceToolDefinition, WorkspaceToolsLimits, WorkspaceToolsOptions,
  WriteFileInput, WriteFileResult,
} from "./types";

function clipText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new WorkspaceToolError("INVALID_INPUT", `${name} must be a positive integer.`);
}

function relativePath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

async function ensureRegularFile(guard: WorkspacePathGuard, filePath: string, mustExist = true, rejectSymlink = false): Promise<{ absolute: string; relative: string; exists: boolean; isSymlink: boolean }> {
  const resolved = await guard.resolve(filePath, "read", { mustExist });
  if (resolved.exists) {
    const info = await lstat(resolved.absolute);
    if (info.isSymbolicLink() && rejectSymlink) throw new WorkspaceToolError("SYMLINK_TARGET", `Symlink targets are not accepted for file mutation: ${resolved.relative}`);
    const targetInfo = info.isSymbolicLink() ? await stat(resolved.absolute) : info;
    if (!targetInfo.isFile()) throw new WorkspaceToolError("NOT_FILE", `Expected a regular file: ${resolved.relative}`);
  }
  return resolved;
}

async function atomicReplace(
  guard: WorkspacePathGuard,
  target: string,
  content: string,
  maxFileBytes: number,
  createDirectories = false,
  expectedContent?: string | null,
): Promise<WriteFileResult> {
  const resolved = await guard.resolve(target, "write", { rejectProtected: true });
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxFileBytes) throw new WorkspaceToolError("FILE_TOO_LARGE", `File exceeds the ${maxFileBytes}-byte limit: ${resolved.relative}`);
  if (resolved.exists) {
    const info = await lstat(resolved.absolute);
    if (info.isSymbolicLink()) throw new WorkspaceToolError("SYMLINK_TARGET", `Cannot replace a symlink: ${resolved.relative}`);
    if (!info.isFile()) throw new WorkspaceToolError("NOT_FILE", `Expected a regular file: ${resolved.relative}`);
  } else if (createDirectories) {
    await mkdir(path.dirname(resolved.absolute), { recursive: true });
    // Re-resolve after creating directories to catch a symlink race.
    const checked = await guard.resolve(resolved.relative, "write", { rejectProtected: true });
    if (checked.exists) {
      const info = await lstat(checked.absolute);
      if (info.isSymbolicLink()) throw new WorkspaceToolError("SYMLINK_TARGET", `Cannot replace a symlink: ${checked.relative}`);
    }
  } else {
    const parent = await guard.resolve(relativePath(path.dirname(resolved.relative)), "list", { mustExist: true });
    const parentInfo = await lstat(parent.absolute);
    if (!parentInfo.isDirectory()) throw new WorkspaceToolError("NOT_DIRECTORY", `Parent is not a directory: ${parent.relative}`);
  }
  const parent = path.dirname(resolved.absolute);
  let tempDirectory: string | undefined;
  try {
    tempDirectory = await mkdtemp(path.join(parent, ".agentdock-write-"));
    const tempFile = path.join(tempDirectory, "content");
    await writeFile(tempFile, content, { encoding: "utf8", mode: resolved.exists ? (await stat(resolved.absolute)).mode : 0o644 });
    const commitTarget = await guard.resolve(resolved.relative, "write", { rejectProtected: true });
    if (expectedContent === null && commitTarget.exists) {
      throw new WorkspaceToolError("PRECONDITION_FAILED", `File appeared before the atomic write committed: ${resolved.relative}`);
    }
    if (typeof expectedContent === "string") {
      if (!commitTarget.exists) throw new WorkspaceToolError("PRECONDITION_FAILED", `File disappeared before the atomic write committed: ${resolved.relative}`);
      const currentInfo = await lstat(commitTarget.absolute);
      if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) throw new WorkspaceToolError("PRECONDITION_FAILED", `File type changed before commit: ${resolved.relative}`);
      if (await readFile(commitTarget.absolute, "utf8") !== expectedContent) {
        throw new WorkspaceToolError("PRECONDITION_FAILED", `File changed before the atomic write committed: ${resolved.relative}`);
      }
    }
    await rename(tempFile, commitTarget.absolute);
  } catch (error: unknown) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError("WRITE_FAILED", `Unable to atomically write ${resolved.relative}: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  return { path: resolved.relative, bytes, created: !resolved.exists };
}

async function walkFiles(root: string, includeHidden: boolean, output: string[], max = 10000): Promise<void> {
  if (output.length >= max) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    if (entry.name === ".git") continue;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkFiles(absolute, includeHidden, output, max);
    else if (entry.isFile()) output.push(absolute);
    if (output.length >= max) return;
  }
}

function validatePattern(pattern: string): string {
  if (!pattern || pattern.includes("\0")) throw new WorkspaceToolError("INVALID_PATTERN", "A non-empty, NUL-free relative pattern is required.");
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.startsWith("/") || path.win32.isAbsolute(pattern) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new WorkspaceToolError("PATH_TRAVERSAL", `Search pattern escapes the workspace: ${pattern}`);
  }
  return normalized;
}

function parseRgError(result: { exitCode: number | null; stderr: string }, label: string): never {
  throw new WorkspaceToolError("SEARCH_FAILED", `${label} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function validateRevision(revision: string | undefined, required = false): string | undefined {
  if (revision === undefined) {
    if (required) throw new WorkspaceToolError("INVALID_INPUT", "A Git revision is required.");
    return undefined;
  }
  // Revisions are passed as one argv element, but options such as
  // --output=<file> can make an otherwise read operation write to disk.
  if (!revision || revision.startsWith("-") || /[\0\r\n\t\s]/.test(revision) || revision.length > 512) throw new WorkspaceToolError("INVALID_INPUT", "Invalid Git revision.");
  return revision;
}

export class WorkspaceTools {
  public readonly guard: WorkspacePathGuard;
  public readonly limits: WorkspaceToolsLimits;
  private readonly rgPath: string;
  private readonly gitExecutable: string;

  public constructor(options: WorkspaceToolsOptions) {
    this.guard = new WorkspacePathGuard(options.root, options.protectedPatterns);
    this.limits = { ...DEFAULT_TOOL_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value <= 0) throw new WorkspaceToolError("INVALID_LIMIT", `${name} must be a positive integer.`);
    }
    this.rgPath = options.rgPath ?? "rg";
    this.gitExecutable = options.gitPath ?? "git";
  }

  public async readFile(input: ReadFileInput, signal?: AbortSignal): Promise<ReadFileResult> {
    assertPositiveInteger(input.startLine, "startLine");
    assertPositiveInteger(input.endLine, "endLine");
    if (input.startLine !== undefined && input.endLine !== undefined && input.endLine < input.startLine) throw new WorkspaceToolError("INVALID_INPUT", "endLine must be >= startLine.");
    const resolved = await ensureRegularFile(this.guard, input.path);
    if (signal?.aborted) throw new WorkspaceToolError("ABORTED", "File read was cancelled.");
    const info = await stat(resolved.absolute);
    if (info.size > this.limits.maxFileBytes) throw new WorkspaceToolError("FILE_TOO_LARGE", `File exceeds the ${this.limits.maxFileBytes}-byte limit: ${resolved.relative}`);
    const source = await readFile(resolved.absolute, "utf8");
    if (signal?.aborted) throw new WorkspaceToolError("ABORTED", "File read was cancelled.");
    const lines = source.length === 0 ? [] : source.replace(/\r\n/g, "\n").split("\n");
    const startLine = input.startLine ?? 1;
    const endLine = Math.min(input.endLine ?? Math.max(1, lines.length), Math.max(1, lines.length));
    const selected = lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
    const clipped = clipText(selected, Math.min(input.maxBytes ?? this.limits.maxOutputBytes, this.limits.maxOutputBytes));
    return { path: resolved.relative, content: clipped.value, startLine, endLine, totalLines: lines.length, bytes: Buffer.byteLength(clipped.value, "utf8"), truncated: clipped.truncated || endLine < (input.endLine ?? endLine) };
  }

  public async listDirectory(input: ListDirectoryInput = {}, signal?: AbortSignal): Promise<ListDirectoryResult> {
    const resolved = await this.guard.resolveDirectory(input.path ?? "");
    if (signal?.aborted) throw new WorkspaceToolError("ABORTED", "Directory listing was cancelled.");
    const maxResults = Math.min(input.maxResults ?? this.limits.maxResults, this.limits.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new WorkspaceToolError("INVALID_INPUT", "maxResults must be a positive integer.");
    const entries = await readdir(resolved.absolute, { withFileTypes: true });
    const result: DirectoryEntry[] = entries.slice(0, maxResults).map((entry) => ({
      path: relativePath(path.join(resolved.relative, entry.name)), name: entry.name,
      type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }));
    return { path: resolved.relative, entries: result, truncated: entries.length > maxResults };
  }

  public async glob(input: GlobInput, signal?: AbortSignal): Promise<GlobResult> {
    const pattern = validatePattern(input.pattern);
    const cwd = await this.guard.resolveDirectory(input.cwd ?? "");
    const maxResults = Math.min(input.maxResults ?? this.limits.maxResults, this.limits.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new WorkspaceToolError("INVALID_INPUT", "maxResults must be a positive integer.");
    const args = ["--files", "--color=never"];
    if (input.hidden) args.push("--hidden");
    args.push("--glob", pattern);
    const rg = await captureExecFile(this.rgPath, args, cwd.absolute, signal, this.limits.maxCommandTimeoutMs, Math.max(this.limits.maxOutputBytes, maxResults * 1024));
    let matches: string[];
    let truncated = rg.truncated;
    if (rg.exitCode === 0 || rg.exitCode === 1) {
      matches = rg.stdout.split(/\r?\n/).filter(Boolean).map((item) => relativePath(path.join(cwd.relative, item)));
    } else if (rg.exitCode === null && signal?.aborted) throw new WorkspaceToolError("ABORTED", "Glob search was cancelled.");
    else if (rg.exitCode === 127 || rg.stderr.includes("not found")) {
      const files: string[] = [];
      await walkFiles(cwd.absolute, Boolean(input.hidden), files, maxResults + 1);
      matches = files.map((item) => relativePath(path.relative(this.guard.root, item))).filter((item) => workspaceGlobMatches(pattern, relativePath(path.relative(cwd.absolute, path.join(this.guard.root, item)))));
    } else parseRgError(rg, "rg");
    if (matches.length > maxResults) { matches = matches.slice(0, maxResults); truncated = true; }
    return { pattern: input.pattern, matches, truncated };
  }

  public async grep(input: GrepInput, signal?: AbortSignal): Promise<GrepResult> {
    if (!input.pattern || input.pattern.includes("\0")) throw new WorkspaceToolError("INVALID_PATTERN", "A non-empty, NUL-free search pattern is required.");
    const cwd = await this.guard.resolveDirectory(input.cwd ?? "");
    const maxResults = Math.min(input.maxResults ?? this.limits.maxResults, this.limits.maxResults);
    const maxBytes = Math.min(input.maxBytes ?? this.limits.maxOutputBytes, this.limits.maxOutputBytes);
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new WorkspaceToolError("INVALID_INPUT", "maxResults must be a positive integer.");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new WorkspaceToolError("INVALID_INPUT", "maxBytes must be a positive integer.");
    const args = ["--json", "--color=never", "--line-number", "--column"];
    if (!input.caseSensitive) args.push("--ignore-case");
    if (!input.regex) args.push("--fixed-strings");
    if (input.glob) args.push("--glob", validatePattern(input.glob));
    // A workspace-wide search has no concrete path for the permission engine
    // to approve. Exclude every protected path at the search boundary so its
    // contents can never be returned incidentally.
    if (!input.path) {
      for (const pattern of this.guard.protectedGlobs()) args.push("--glob", `!${pattern}`);
    }
    args.push("--", input.pattern);
    if (input.path) {
      const target = await this.guard.resolve(input.path, "search", { mustExist: true });
      args.push(path.relative(cwd.absolute, target.absolute) || ".");
    } else args.push(".");
    const rg = await captureExecFile(this.rgPath, args, cwd.absolute, signal, this.limits.maxCommandTimeoutMs, maxBytes);
    let matches: GrepMatch[] = [];
    let truncated = rg.truncated;
    if (rg.exitCode === 0 || rg.exitCode === 1) {
      for (const line of rg.stdout.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: Array<{ start?: number }> } };
          if (parsed.type !== "match" || !parsed.data?.path?.text || !parsed.data.line_number) continue;
          const text = (parsed.data.lines?.text ?? "").replace(/\r?\n$/, "");
          const matchedPath = relativePath(path.join(cwd.relative, parsed.data.path.text));
          if (!input.path && this.guard.isProtected(matchedPath)) continue;
          matches.push({ path: matchedPath, line: parsed.data.line_number, column: (parsed.data.submatches?.[0]?.start ?? 0) + 1, text });
          if (matches.length > maxResults) { truncated = true; break; }
        } catch { throw new WorkspaceToolError("SEARCH_FAILED", "ripgrep returned malformed JSON output."); }
      }
    } else if (rg.exitCode === 127 || rg.stderr.includes("not found")) {
      const files: string[] = [];
      await walkFiles(cwd.absolute, false, files, maxResults * 100 + 1);
      let expression: RegExp | undefined;
      try { expression = input.regex ? new RegExp(input.pattern, input.caseSensitive ? "" : "i") : undefined; }
      catch (error) { throw new WorkspaceToolError("INVALID_PATTERN", `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
      for (const file of files) {
        const workspaceRelative = relativePath(path.relative(this.guard.root, file));
        if (!input.path && this.guard.isProtected(workspaceRelative)) continue;
        const rel = relativePath(path.relative(cwd.absolute, file));
        if (input.glob && !workspaceGlobMatches(input.glob, rel)) continue;
        const content = await readFile(file, "utf8");
        const lines = content.split(/\r?\n/);
        lines.forEach((text, index) => {
          const found = expression ? expression.exec(text) : (input.caseSensitive ? text.indexOf(input.pattern) : text.toLowerCase().indexOf(input.pattern.toLowerCase()));
          if (found !== null && found !== -1 && matches.length < maxResults) matches.push({ path: workspaceRelative, line: index + 1, column: (typeof found === "number" ? found : found.index) + 1, text });
        });
      }
      truncated = matches.length > maxResults;
      if (matches.length > maxResults) matches = matches.slice(0, maxResults);
    } else parseRgError(rg, "rg");
    if (matches.length > maxResults) { matches = matches.slice(0, maxResults); truncated = true; }
    return { matches, truncated };
  }

  public async writeFile(input: WriteFileInput, signal?: AbortSignal): Promise<WriteFileResult> {
    if (signal?.aborted) throw new WorkspaceToolError("ABORTED", "File write was cancelled.");
    return atomicReplace(this.guard, input.path, input.content, this.limits.maxFileBytes, input.createDirectories ?? false);
  }

  public async editFile(input: EditFileInput, signal?: AbortSignal): Promise<EditFileResult> {
    if (typeof input.oldText !== "string" || typeof input.newText !== "string" || !input.oldText) throw new WorkspaceToolError("INVALID_INPUT", "oldText must be a non-empty string.");
    const expected = input.expectedReplacements ?? 1;
    if (!Number.isInteger(expected) || expected < 1) throw new WorkspaceToolError("INVALID_INPUT", "expectedReplacements must be a positive integer.");
    const resolved = await ensureRegularFile(this.guard, input.path, true, true);
    const source = await readFile(resolved.absolute, "utf8");
    const count = source.split(input.oldText).length - 1;
    const actual = input.occurrence === "all" ? count : Math.min(count, 1);
    if (count === 0 || (input.occurrence !== "all" && count !== expected) || (input.occurrence === "all" && count !== expected)) {
      throw new WorkspaceToolError("PRECONDITION_FAILED", `Expected ${expected} replacement${expected === 1 ? "" : "s"}, found ${count}.`);
    }
    const content = input.occurrence === "all" ? source.split(input.oldText).join(input.newText) : source.replace(input.oldText, input.newText);
    const result = await atomicReplace(this.guard, resolved.relative, content, this.limits.maxFileBytes, false, source);
    return { ...result, replacements: actual };
  }

  public async applyPatch(input: { patch: string }, signal?: AbortSignal): Promise<ApplyPatchResult> {
    const files = parsePatch(input.patch);
    if (!files.length) throw new WorkspaceToolError("INVALID_PATCH", "Patch contains no file changes.");
    const prepared: Array<{ path: string; content: string; source: string; additions: number; deletions: number; created: boolean }> = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.path)) throw new WorkspaceToolError("INVALID_PATCH", `Patch contains duplicate file: ${file.path}`);
      seen.add(file.path);
      const resolved = await this.guard.resolve(file.path, "write", { rejectProtected: true });
      if (file.kind === "update" && !resolved.exists) throw new WorkspaceToolError("PRECONDITION_FAILED", `Patch target does not exist: ${file.path}`);
      if (file.kind === "add" && resolved.exists) throw new WorkspaceToolError("PRECONDITION_FAILED", `Patch add target already exists: ${file.path}`);
      let source = "";
      if (resolved.exists) {
        const info = await lstat(resolved.absolute);
        if (info.isSymbolicLink()) throw new WorkspaceToolError("SYMLINK_TARGET", `Cannot patch a symlink: ${file.path}`);
        if (!info.isFile()) throw new WorkspaceToolError("NOT_FILE", `Patch target is not a file: ${file.path}`);
        if ((await stat(resolved.absolute)).size > this.limits.maxFileBytes) throw new WorkspaceToolError("FILE_TOO_LARGE", `Patch target is too large: ${file.path}`);
        source = await readFile(resolved.absolute, "utf8");
      }
      const applied = applyHunks(source, file.hunks, file.kind === "add");
      if (Buffer.byteLength(applied.content, "utf8") > this.limits.maxFileBytes) throw new WorkspaceToolError("FILE_TOO_LARGE", `Patched file is too large: ${file.path}`);
      prepared.push({ path: file.path, content: applied.content, source, additions: applied.additions, deletions: applied.deletions, created: file.kind === "add" });
    }
    if (signal?.aborted) throw new WorkspaceToolError("ABORTED", "Patch application was cancelled.");
    for (const file of prepared) {
      if (signal?.aborted) throw new WorkspaceToolError("ABORTED", "Patch application was cancelled.");
      await atomicReplace(this.guard, file.path, file.content, this.limits.maxFileBytes, file.created, file.created ? null : file.source);
    }
    return { files: prepared.map(({ path: filePath, additions, deletions, created }) => ({ path: filePath, additions, deletions, created })) };
  }

  public runCommand(input: RunCommandInput, signal?: AbortSignal): Promise<RunCommandResult> { return runCommand(input, this.guard, this.limits, signal); }

  private async git(args: string[], cwdInput: string | undefined, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const cwd = await this.guard.resolveDirectory(cwdInput ?? "");
    const result = await captureExecFile(this.gitExecutable, args, cwd.absolute, signal, this.limits.maxCommandTimeoutMs, this.limits.maxOutputBytes);
    if (result.exitCode !== 0) throw new WorkspaceToolError("GIT_FAILED", `git ${args[0]} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
    return result;
  }

  private async gitPath(pathInput: string, cwdInput: string | undefined): Promise<string> {
    const cwd = await this.guard.resolveDirectory(cwdInput ?? "");
    const target = await this.guard.resolve(pathInput, "read", { mustExist: true });
    return relativePath(path.relative(cwd.absolute, target.absolute)) || ".";
  }

  public async gitStatus(input: GitStatusInput = {}, signal?: AbortSignal): Promise<GitStatusResult> {
    const result = await this.git(["status", "--porcelain=v1", "--branch", ...(input.includeUntracked === false ? ["-uno"] : ["--untracked-files=all"])], input.cwd, signal);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith("## "));
    const entries: GitStatusEntry[] = lines.filter((line) => !line.startsWith("## ")).map((line) => {
      const index = line[0] ?? " "; const worktree = line[1] ?? " "; const raw = line.slice(3);
      const rename = raw.split(" -> ");
      return { index, worktree, path: relativePath(rename.at(-1) ?? raw), ...(rename.length > 1 ? { originalPath: relativePath(rename[0]) } : {}) };
    });
    return { branch: branchLine?.slice(3) ?? null, entries, raw: result.stdout };
  }

  public async gitDiff(input: GitDiffInput = {}, signal?: AbortSignal): Promise<GitDiffResult> {
    const args = ["diff"]; const revision = validateRevision(input.revision); if (revision) args.push(revision); if (input.path) args.push("--", await this.gitPath(input.path, input.cwd)); return { diff: (await this.git(args, input.cwd, signal)).stdout };
  }
  public async gitDiffStaged(input: GitDiffInput = {}, signal?: AbortSignal): Promise<GitDiffResult> {
    const args = ["diff", "--cached"]; const revision = validateRevision(input.revision); if (revision) args.push(revision); if (input.path) args.push("--", await this.gitPath(input.path, input.cwd)); return { diff: (await this.git(args, input.cwd, signal)).stdout };
  }
  public async gitLog(input: GitLogInput = {}, signal?: AbortSignal): Promise<GitLogResult> {
    const maxCount = Math.max(1, Math.min(input.maxCount ?? 20, 200));
    const args = ["log", `-${maxCount}`, "--date=iso-strict", "--pretty=format:%H%x00%P%x00%an%x00%ad%x00%s"]; const revision = validateRevision(input.revision); if (revision) args.push(revision); if (input.path) args.push("--", await this.gitPath(input.path, input.cwd));
    const raw = (await this.git(args, input.cwd, signal)).stdout;
    const commits: GitCommitSummary[] = raw.split("\n").filter(Boolean).map((line) => { const [hash, parents, author, date, ...subject] = line.split("\0"); return { hash, parents: parents ? parents.split(" ") : [], author, date, subject: subject.join("\0") }; });
    return { commits, raw };
  }
  public async gitShow(input: GitShowInput, signal?: AbortSignal): Promise<GitShowResult> { const revision = validateRevision(input.revision, true)!; const args = ["show", revision]; if (input.path) args.push("--", (await this.guard.resolve(input.path, "read", { mustExist: true })).relative); return { content: (await this.git(args, input.cwd, signal)).stdout }; }
  public async gitBranch(input: GitBranchInput = {}, signal?: AbortSignal): Promise<GitBranchResult> { const result = await this.git(["branch", ...(input.all ? ["--all"] : ["--list"]), "--format=%(refname:short)"], input.cwd, signal); return { branches: result.stdout.split(/\r?\n/).filter(Boolean) }; }
  public async gitBlame(input: GitBlameInput, signal?: AbortSignal): Promise<GitBlameResult> {
    const resolved = await this.guard.resolve(input.path, "read", { mustExist: true }); const args = ["blame", "--line-porcelain"]; const revision = validateRevision(input.revision); if (revision) args.push(revision); args.push("--", await this.gitPath(input.path, input.cwd)); const raw = (await this.git(args, input.cwd, signal)).stdout; const lines: GitBlameLine[] = []; let commit = "", author = "", line = 0;
    for (const item of raw.split(/\r?\n/)) { if (/^[0-9a-f]{7,40} /.test(item)) { commit = item.split(" ")[0]; line = Number(item.split(" ")[2] ?? 0); } else if (item.startsWith("author ")) author = item.slice(7); else if (item.startsWith("\t")) lines.push({ commit, author, line, text: item.slice(1) }); }
    return { lines, raw };
  }

  public definitions(): WorkspaceToolDefinition[] {
    const bind = <I, O>(name: string, description: string, category: WorkspaceToolDefinition["category"], risk: WorkspaceToolDefinition["risk"], inputSchema: Record<string, unknown>, fn: (input: I, signal?: AbortSignal) => Promise<O>): WorkspaceToolDefinition => ({ name, description, category, risk, inputSchema, execute: (input, ctx) => fn(input as I, ctx?.signal) });
    return [
      bind("read_file", "Read a UTF-8 workspace file, optionally selecting an inclusive line range.", "filesystem", "low", { type: "object", required: ["path"] }, (input: ReadFileInput, signal) => this.readFile(input, signal)),
      bind("list_directory", "List bounded entries in a workspace directory.", "filesystem", "low", { type: "object" }, (input: ListDirectoryInput, signal) => this.listDirectory(input, signal)),
      bind("glob", "Find workspace files using a bounded glob.", "search", "low", { type: "object", required: ["pattern"] }, (input: GlobInput, signal) => this.glob(input, signal)),
      bind("grep", "Search workspace text, preferring ripgrep.", "search", "low", { type: "object", required: ["pattern"] }, (input: GrepInput, signal) => this.grep(input, signal)),
      bind("write_file", "Atomically create or replace a workspace file.", "filesystem", "high", { type: "object", required: ["path", "content"] }, (input: WriteFileInput, signal) => this.writeFile(input, signal)),
      bind("edit_file", "Atomically replace an exact, preconditioned text occurrence.", "filesystem", "high", { type: "object", required: ["path", "oldText", "newText"] }, (input: EditFileInput, signal) => this.editFile(input, signal)),
      bind("apply_patch", "Apply strict unified patches with exact context and atomic writes.", "filesystem", "high", { type: "object", required: ["patch"] }, (input: { patch: string }, signal) => this.applyPatch(input, signal)),
      bind("run_command", "Run a bounded workspace command after classifying its risk.", "shell", "high", { type: "object", required: ["command"] }, (input: RunCommandInput, signal) => this.runCommand(input, signal)),
      bind("git_status", "Read Git status and branch state.", "git", "low", { type: "object" }, (input: GitStatusInput, signal) => this.gitStatus(input, signal)),
      bind("git_diff", "Read the unstaged Git diff.", "git", "low", { type: "object" }, (input: GitDiffInput, signal) => this.gitDiff(input, signal)),
      bind("git_diff_staged", "Read the staged Git diff.", "git", "low", { type: "object" }, (input: GitDiffInput, signal) => this.gitDiffStaged(input, signal)),
      bind("git_log", "Read bounded Git history.", "git", "low", { type: "object" }, (input: GitLogInput, signal) => this.gitLog(input, signal)),
      bind("git_show", "Read a Git object or revision.", "git", "low", { type: "object", required: ["revision"] }, (input: GitShowInput, signal) => this.gitShow(input, signal)),
      bind("git_branch", "Read local or all Git branch names.", "git", "low", { type: "object" }, (input: GitBranchInput, signal) => this.gitBranch(input, signal)),
      bind("git_blame", "Read line-level Git blame data.", "git", "low", { type: "object", required: ["path"] }, (input: GitBlameInput, signal) => this.gitBlame(input, signal)),
    ];
  }

  public asAgentTools(): WorkspaceToolDefinition[] { return this.definitions(); }
}

export function createWorkspaceTools(options: WorkspaceToolsOptions): WorkspaceTools { return new WorkspaceTools(options); }

interface ParsedHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }
interface ParsedFile { path: string; kind: "update" | "add"; hunks: ParsedHunk[] }

function parsePatch(patch: string): ParsedFile[] {
  if (typeof patch !== "string" || !patch.trim() || patch.includes("\0")) throw new WorkspaceToolError("INVALID_PATCH", "Patch must be a non-empty NUL-free string.");
  const lines = patch.replace(/\r\n/g, "\n").split("\n"); if (lines.at(-1) === "") lines.pop();
  const files: ParsedFile[] = []; let index = 0; let custom = false;
  if (lines[0] === "*** Begin Patch") { custom = true; index = 1; }
  while (index < lines.length) {
    if (custom && lines[index] === "*** End Patch") break;
    let pathName = ""; let kind: "update" | "add" = "update";
    if (custom && lines[index].startsWith("*** Update File: ")) { pathName = lines[index].slice(16).trim(); index += 1; }
    else if (custom && lines[index].startsWith("*** Add File: ")) { pathName = lines[index].slice(14).trim(); kind = "add"; index += 1; }
    else if (!custom) {
      // Accept the metadata preamble emitted by `git diff` while keeping the
      // actual file headers and hunks strict.
      while (index < lines.length && !lines[index].startsWith("--- ")) {
        if (/^(diff --git |index |new file mode |old mode |new mode |deleted file mode |similarity index |rename from |rename to )/.test(lines[index])) index += 1;
        else throw new WorkspaceToolError("INVALID_PATCH", `Unexpected patch line: ${lines[index]}`);
      }
      if (index >= lines.length) break;
      const oldPath = lines[index].slice(4).split("\t")[0]; index += 1;
      if (index >= lines.length || !lines[index].startsWith("+++ ")) throw new WorkspaceToolError("INVALID_PATCH", "Unified patch is missing its +++ header.");
      const newPath = lines[index].slice(4).split("\t")[0]; index += 1;
      if (newPath === "/dev/null") throw new WorkspaceToolError("INVALID_PATCH", "File deletion patches are not supported by apply_patch.");
      pathName = newPath.replace(/^b\//, ""); kind = oldPath === "/dev/null" ? "add" : "update";
    } else { throw new WorkspaceToolError("INVALID_PATCH", `Unexpected patch line: ${lines[index]}`); }
    if (!pathName || pathName.startsWith("/") || pathName.includes("\\") || pathName === "." || pathName.split("/").includes("..")) throw new WorkspaceToolError("PATH_TRAVERSAL", `Invalid patch path: ${pathName}`);
    const hunks: ParsedHunk[] = [];
    while (index < lines.length && lines[index].startsWith("@@")) {
      const header = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(lines[index]);
      const bareHeader = custom && /^@@(?:\s+.*)?$/.test(lines[index]);
      if (!header && !bareHeader) throw new WorkspaceToolError("INVALID_PATCH", `Malformed hunk header: ${lines[index]}`);
      // The compact apply-patch dialect permits a bare @@. In that dialect
      // location is inferred from a unique exact context block below; no fuzz
      // or approximate matching is performed.
      const hunk: ParsedHunk = { oldStart: header ? Number(header[1]) : 0, oldCount: header ? Number(header[2] ?? 1) : 0, newStart: header ? Number(header[3]) : 0, newCount: header ? Number(header[4] ?? 1) : 0, lines: [] }; index += 1;
      while (index < lines.length && !lines[index].startsWith("@@") && !(custom && lines[index].startsWith("*** "))) {
        const oldObserved = hunk.lines.filter((line) => line[0] === " " || line[0] === "-").length;
        const newObserved = hunk.lines.filter((line) => line[0] === " " || line[0] === "+").length;
        if (header && oldObserved === hunk.oldCount && newObserved === hunk.newCount) break;
        if (!/^[ +\\-]/.test(lines[index])) throw new WorkspaceToolError("INVALID_PATCH", `Malformed hunk context: ${lines[index]}`);
        if (!lines[index].startsWith("\\ No newline")) hunk.lines.push(lines[index]); index += 1;
      }
      const oldObserved = hunk.lines.filter((line) => line[0] === " " || line[0] === "-").length;
      const newObserved = hunk.lines.filter((line) => line[0] === " " || line[0] === "+").length;
      if (!header) { hunk.oldCount = oldObserved; hunk.newCount = newObserved; }
      else if (oldObserved !== hunk.oldCount || newObserved !== hunk.newCount) throw new WorkspaceToolError("INVALID_PATCH", "Hunk line counts do not match its header.");
      hunks.push(hunk);
    }
    if (!hunks.length) throw new WorkspaceToolError("INVALID_PATCH", `Patch has no hunks for ${pathName}.`);
    files.push({ path: pathName, kind, hunks });
  }
  if (custom && lines[index] !== "*** End Patch") throw new WorkspaceToolError("INVALID_PATCH", "Patch is missing *** End Patch.");
  return files;
}

function applyHunks(source: string, hunks: ParsedHunk[], adding: boolean): { content: string; additions: number; deletions: number } {
  const hadTrailingNewline = source.endsWith("\n");
  let sourceLines = source.replace(/\r\n/g, "\n").split("\n"); if (hadTrailingNewline) sourceLines.pop(); if (!source && adding) sourceLines = [];
  let offset = 0; let additions = 0; let deletions = 0;
  for (const hunk of hunks) {
    let position = Math.max(0, hunk.oldStart - 1 + offset);
    if (hunk.oldStart === 0) {
      const expected = hunk.lines.filter((line) => line[0] === " " || line[0] === "-").map((line) => line.slice(1));
      const candidates: number[] = [];
      if (expected.length === 0) candidates.push(sourceLines.length);
      else for (let candidate = 0; candidate <= sourceLines.length - expected.length; candidate += 1) {
        if (expected.every((value, index) => sourceLines[candidate + index] === value)) candidates.push(candidate);
      }
      if (candidates.length !== 1) throw new WorkspaceToolError("PRECONDITION_FAILED", candidates.length === 0 ? "Patch context was not found." : "Bare patch context is ambiguous.");
      position = candidates[0];
    }
    if (position > sourceLines.length) throw new WorkspaceToolError("PRECONDITION_FAILED", "Patch hunk starts beyond the end of the file.");
    let cursor = position; const replacement: string[] = [];
    for (const line of hunk.lines) {
      const marker = line[0]; const value = line.slice(1);
      if (marker === " ") { if (sourceLines[cursor] !== value) throw new WorkspaceToolError("PRECONDITION_FAILED", `Patch context mismatch at line ${cursor + 1}.`); replacement.push(value); cursor += 1; }
      else if (marker === "-") { if (sourceLines[cursor] !== value) throw new WorkspaceToolError("PRECONDITION_FAILED", `Patch deletion mismatch at line ${cursor + 1}.`); cursor += 1; deletions += 1; }
      else { replacement.push(value); additions += 1; }
    }
    sourceLines.splice(position, cursor - position, ...replacement); offset += replacement.length - (cursor - position);
  }
  const content = sourceLines.join("\n") + (hadTrailingNewline || additions > 0 ? "\n" : "");
  return { content, additions, deletions };
}

export { classifyCommand };
