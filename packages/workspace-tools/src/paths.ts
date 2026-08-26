import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

export type PathOperation = "read" | "list" | "search" | "write";

export class WorkspaceToolError extends Error {
  public constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "WorkspaceToolError";
  }
}

const DEFAULT_PROTECTED_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/credentials*",
  "**/secrets*",
  ".git",
  ".git/**",
];

export interface ResolvedWorkspacePath {
  input: string;
  relative: string;
  absolute: string;
  canonical: string;
  exists: boolean;
  isSymlink: boolean;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function workspaceGlobMatches(pattern: string, value: string): boolean {
  return globRegex(pattern.replaceAll("\\", "/")).test(value.replaceAll("\\", "/").replace(/^\.\//, ""));
}

export class WorkspacePathGuard {
  public readonly root: string;
  private canonicalRootPromise?: Promise<string>;
  private readonly protectedPatterns: string[];

  public constructor(root: string, protectedPatterns = DEFAULT_PROTECTED_PATTERNS) {
    if (!root || !path.isAbsolute(root)) {
      throw new WorkspaceToolError("INVALID_WORKSPACE", "Workspace root must be an absolute path.");
    }
    this.root = path.resolve(root);
    this.protectedPatterns = [...DEFAULT_PROTECTED_PATTERNS, ...protectedPatterns];
  }

  public isProtected(relative: string): boolean {
    const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
    return this.protectedPatterns.some((pattern) => workspaceGlobMatches(pattern, normalized));
  }

  public protectedGlobs(): readonly string[] {
    return [...this.protectedPatterns];
  }

  public async canonicalRoot(): Promise<string> {
    this.canonicalRootPromise ??= realpath(this.root).catch((error: unknown) => {
      throw new WorkspaceToolError("INVALID_WORKSPACE", `Workspace root is not accessible: ${this.root}`, error);
    });
    return this.canonicalRootPromise;
  }

  /**
   * Resolve and canonicalize a workspace-relative path. The real path of the
   * nearest existing ancestor is checked too, so a new file cannot be placed
   * through a symlinked directory that escapes the workspace.
   */
  public async resolve(input: string, operation: PathOperation, options: { mustExist?: boolean; rejectProtected?: boolean } = {}): Promise<ResolvedWorkspacePath> {
    if (typeof input !== "string" || input.includes("\0")) {
      throw new WorkspaceToolError("INVALID_PATH", "A NUL-free workspace-relative path is required.");
    }
    const normalizedInput = input.replaceAll("\\", "/");
    if (path.posix.isAbsolute(normalizedInput) || path.win32.isAbsolute(input) || normalizedInput.startsWith("//")) {
      throw new WorkspaceToolError("PATH_OUTSIDE_WORKSPACE", `Absolute paths are not allowed: ${input}`);
    }
    const lexical = path.posix.normalize(normalizedInput);
    if (lexical === ".." || lexical.startsWith("../") || lexical.includes("/../")) {
      throw new WorkspaceToolError("PATH_TRAVERSAL", `Path escapes the workspace: ${input}`);
    }
    const relative = lexical === "." ? "" : lexical.replace(/^\.\//, "");
    if (options.rejectProtected && this.isProtected(relative)) {
      throw new WorkspaceToolError("PROTECTED_PATH", `Protected path cannot be modified: ${relative}`);
    }
    const root = await this.canonicalRoot();
    const segments = relative ? relative.split("/") : [];
    const absolute = path.resolve(this.root, ...segments);
    if (!inside(this.root, absolute)) {
      throw new WorkspaceToolError("PATH_OUTSIDE_WORKSPACE", `Path escapes the workspace: ${input}`);
    }

    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorkspaceToolError("PATH_UNREADABLE", `Cannot inspect workspace path: ${relative}`, error);
      }
    }
    if (!stat && options.mustExist) {
      throw new WorkspaceToolError("NOT_FOUND", `Workspace path does not exist: ${relative}`);
    }

    let nearest = absolute;
    while (nearest !== this.root) {
      try {
        await lstat(nearest);
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        nearest = path.dirname(nearest);
      }
    }
    const canonicalNearest = await realpath(nearest).catch((error: unknown) => {
      throw new WorkspaceToolError("PATH_UNREADABLE", `Cannot canonicalize workspace path: ${relative}`, error);
    });
    if (!inside(root, canonicalNearest)) {
      throw new WorkspaceToolError("SYMLINK_ESCAPE", `Path resolves outside the workspace: ${relative}`);
    }

    let canonical = absolute;
    if (stat) {
      canonical = await realpath(absolute).catch((error: unknown) => {
        throw new WorkspaceToolError("PATH_UNREADABLE", `Cannot canonicalize workspace path: ${relative}`, error);
      });
      if (!inside(root, canonical)) throw new WorkspaceToolError("SYMLINK_ESCAPE", `Path resolves outside the workspace: ${relative}`);
    } else if (canonicalNearest !== nearest) {
      canonical = path.join(canonicalNearest, path.relative(nearest, absolute));
    }
    return { input, relative, absolute, canonical, exists: Boolean(stat), isSymlink: Boolean(stat?.isSymbolicLink()) };
  }

  public async resolveDirectory(input = "", options: { mustExist?: boolean } = {}): Promise<ResolvedWorkspacePath> {
    const result = await this.resolve(input, "list", { mustExist: options.mustExist ?? true });
    if (result.exists) {
      const stat = await lstat(result.absolute);
      if (!stat.isDirectory()) throw new WorkspaceToolError("NOT_DIRECTORY", `Expected a directory: ${result.relative || "."}`);
    }
    return result;
  }
}

export const DEFAULT_WORKSPACE_PROTECTED_PATTERNS = [...DEFAULT_PROTECTED_PATTERNS];
