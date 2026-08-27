import {
  PermissionDecision,
  PermissionEffect,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
  PermissionValue,
} from "./types";

export interface PermissionEngineOptions {
  /** Workspace root used to identify external paths. */
  workspaceRoot?: string;
  global?: PermissionPolicy;
  mode?: PermissionPolicy;
  project?: PermissionPolicy;
  session?: PermissionPolicy;
  workspaceTrusted?: boolean;
  autoMode?: "conservative" | "coding" | "full-auto";
}

const MUTATING_TOOLS = new Set([
  "edit",
  "edit_file",
  "write",
  "write_file",
  "apply_patch",
  "delete",
  "delete_file",
  "move_file",
  "run_command",
  "bash",
  "shell",
]);

const READ_TOOLS = new Set([
  "read",
  "read_file",
  "read_files",
  "list_directory",
  "glob",
  "grep",
  "tree",
  "git_read",
  "git_status",
  "git_diff",
  "git_diff_staged",
  "git_log",
  "git_show",
  "git_branch",
  "git_blame",
  "get_diagnostics",
  "lsp",
  "semantic_search",
]);

const PROTECTED = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/credentials*",
  "**/secrets*",
];

const DESTRUCTIVE_COMMAND = /(^|\s)(rm\s+-rf?|rmdir|git\s+(push|reset\s+--hard|clean\s+-fd)|mkfs|shutdown|reboot|:\(\)\s*\{)/i;
const PACKAGE_INSTALL = /(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/i;

export function normalizePath(value: string): string {
  // Policies match canonical, workspace-relative paths. Keep this lexical so
  // the core remains runtime agnostic; the filesystem layer must still verify
  // symlinks immediately before a mutation.
  const input = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const absolute = input.startsWith("/");
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : "");
}

/** Small dependency-free glob matcher suitable for policy paths and commands. */
export function globMatches(pattern: string, value: string): boolean {
  const source = normalizePath(pattern);
  const target = normalizePath(value);
  let regex = "^";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "*") {
      if (source[i + 1] === "*") {
        i += 1;
        if (source[i + 1] === "/") {
          i += 1;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${regex}$`).test(target);
}

function asEffect(rule: PermissionValue | undefined): { effect: PermissionEffect; reason?: string } | undefined {
  if (!rule) return undefined;
  if (typeof rule === "string") return { effect: rule as PermissionEffect };
  if ("effect" in rule && (rule as { effect?: unknown }).effect && typeof (rule as { effect: unknown }).effect === "string") {
    const resolved = rule as { effect: PermissionEffect; reason?: string };
    return { effect: resolved.effect, reason: resolved.reason };
  }
  return undefined;
}

function directRule(policy: PermissionPolicy, key: string, target: string): { effect: PermissionEffect; reason?: string } | undefined {
  const rule = policy[key];
  if (!rule || typeof rule === "string" || typeof rule !== "object" || Array.isArray(rule)) return asEffect(rule);
  if ("pattern" in rule) {
    const patterned = rule as { pattern?: unknown; effect?: PermissionEffect; reason?: string };
    return typeof patterned.pattern === "string" && patterned.effect && policyPatternMatches(patterned.pattern, target)
      ? { effect: patterned.effect!, reason: patterned.reason }
      : undefined;
  }
  return asEffect(rule);
}

/** Ordered policy aliases bridge provider-facing tool names and spec vocabulary. */
export function permissionKeysForTool(toolName: string): string[] {
  const normalized = toolName.toLowerCase();
  const keys = [normalized];
  if (["write_file", "edit_file", "apply_patch", "delete_file", "move_file"].includes(normalized)) keys.push("edit", "write");
  else if (["read_file", "read_files", "list_directory", "glob", "grep", "tree", "get_diagnostics", "lsp", "semantic_search"].includes(normalized)) keys.push("read");
  else if (normalized === "run_command") keys.push("bash", "shell");
  else if (normalized.startsWith("git_")) keys.push("git_read", "git");
  else if (normalized.startsWith("mcp_")) keys.push("mcp");
  const lexical = normalized.split("_")[0];
  if (!keys.includes(lexical)) keys.push(lexical);
  return keys;
}

function policyPatternMatches(pattern: string, target: string): boolean {
  return pattern.trim() === "*" || globMatches(pattern, target);
}

function ruleSpecificity(pattern: string): number {
  // Literal path/command characters carry the signal; segment boundaries make
  // `src/*` more specific than a same-length single-segment wildcard.
  const normalized = normalizePath(pattern);
  const literals = normalized.replace(/[?*]/g, "").length;
  const segments = normalized.split("/").filter(Boolean).length;
  return literals * 100 + segments;
}

function isProtected(path: string): boolean {
  const normalized = normalizePath(path).replace(/^.*?\/(?:workspace\/)?/, "");
  return PROTECTED.some((pattern) => globMatches(pattern, normalized) || globMatches(pattern, `**/${normalized}`));
}

function isMutation(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return MUTATING_TOOLS.has(normalized) || /(^|_)(edit|write|delete|move|patch|shell|bash|command)(_|$)/.test(normalized);
}

function isReadOnly(toolName: string): boolean {
  return READ_TOOLS.has(toolName.toLowerCase());
}

function findPolicyRule(policy: PermissionPolicy | undefined, request: PermissionRequest): { effect: PermissionEffect; reason?: string } | undefined {
  if (!policy) return undefined;
  const target = request.command ?? request.path ?? request.toolName;
  for (const key of permissionKeysForTool(request.toolName)) {
    const direct = directRule(policy, key, target);
    if (direct) return direct;
    const value = policy[key];
    if (!value || typeof value === "string" || (typeof value === "object" && "effect" in value)) continue;
    const candidates = Object.entries(value)
      .filter(([pattern, rule]) => policyPatternMatches(pattern, target) && asEffect(rule))
      .map(([pattern, rule], index) => ({ pattern, index, specificity: ruleSpecificity(pattern), ...asEffect(rule)! }))
      .sort((a, b) => b.specificity - a.specificity || (a.effect === "deny" ? -1 : b.effect === "deny" ? 1 : b.index - a.index));
    if (candidates[0]) return { effect: candidates[0].effect, reason: candidates[0].reason };
  }
  return undefined;
}

/**
 * Deterministic permission resolver. A model can only request an action; it
 * never gets access to this policy or the ability to mutate it.
 */
export class PermissionEngine {
  private readonly options: PermissionEngineOptions;

  constructor(options: PermissionEngineOptions = {}) {
    this.options = options;
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    const hard = this.hardSafety(request);
    if (hard) return hard;

    // Session policy is a user safety override: only explicit denies apply at
    // this precedence. Allows are evaluated below the project/mode/global
    // layers so a stale session allow cannot bypass a stricter project rule.
    const sessionDeny = findPolicyRule(this.options.session, request);
    if (sessionDeny?.effect === "deny") return { effect: "deny", source: "session", reason: sessionDeny.reason };

    const layers: Array<[PermissionDecision["source"], PermissionPolicy | undefined]> = [
      ["project", this.options.project],
      ["mode", this.options.mode],
      ["global", this.options.global],
    ];
    for (const [source, policy] of layers) {
      const resolved = findPolicyRule(policy, request);
      if (resolved) {
        return {
          effect: this.applyAutoMode(resolved.effect, request),
          source,
          reason: resolved.reason,
        };
      }
    }

    const defaultEffect: PermissionEffect = isReadOnly(request.toolName) ? "allow" : isMutation(request.toolName) ? "ask" : "ask";
    return { effect: this.applyAutoMode(defaultEffect, request), source: "tool-default" };
  }

  private hardSafety(request: PermissionRequest): PermissionDecision | undefined {
    if (this.options.workspaceTrusted === false && (isMutation(request.toolName) || request.toolName.startsWith("mcp_"))) {
      return { effect: "deny", source: "hard-safety", reason: "Workspace is untrusted." };
    }
    if (request.command && DESTRUCTIVE_COMMAND.test(request.command)) {
      return { effect: "deny", source: "hard-safety", reason: "Destructive commands are always denied." };
    }
    if (request.path && isProtected(request.path)) {
      if (isMutation(request.toolName)) {
        return { effect: "deny", source: "hard-safety", reason: "Protected files cannot be modified by default." };
      }
      return { effect: "ask", source: "hard-safety", reason: "Protected file access requires approval." };
    }
    if (request.path && this.options.workspaceRoot && isAbsoluteOutside(request.path, this.options.workspaceRoot)) {
      return { effect: "ask", source: "hard-safety", reason: "External paths require approval." };
    }
    return undefined;
  }

  private applyAutoMode(effect: PermissionEffect, request: PermissionRequest): PermissionEffect {
    if (effect !== "ask") return effect;
    if (this.options.autoMode === "full-auto") return "allow";
    if (this.options.autoMode === "coding" && request.command && !PACKAGE_INSTALL.test(request.command)) return "allow";
    return effect;
  }
}

function isAbsoluteOutside(path: string, root: string): boolean {
  if (!path.startsWith("/")) return false;
  const normalizedPath = normalizePath(path).replace(/\/$/, "");
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  return normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`);
}

export { isProtected, isMutation };
