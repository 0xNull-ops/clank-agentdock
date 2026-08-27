import {
  globMatches,
  normalizePath,
  type InstructionSource,
  type ModeDefinition,
  type PermissionDecision,
  type PermissionRequest,
} from "@freebuff/agent-core";

export type RuntimePermissionEngine = { evaluate(request: PermissionRequest): PermissionDecision };

/** Extract every target path the runtime apply_patch dialect can mutate. */
export function permissionRequestPaths(request: PermissionRequest): string[] {
  const paths = request.path ? [request.path] : [];
  if (request.toolName !== "apply_patch" || !request.input || typeof request.input !== "object") return paths;
  const patch = (request.input as { patch?: unknown }).patch;
  if (typeof patch !== "string") return paths;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const custom = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    const unified = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
    const path = custom?.[1]?.trim() ?? move?.[1]?.trim() ?? unified?.[1]?.trim();
    if (path && path !== "/dev/null") paths.push(path);
  }
  return [...new Set(paths)];
}

/** Apply a mode's file scope to every path in a permission request. */
export function requestPathsWithinPatterns(request: PermissionRequest, patterns: readonly string[]): boolean {
  const paths = permissionRequestPaths(request);
  if (request.toolName === "apply_patch" && paths.length === 0) return false;
  return paths.every((path) => patterns.some((pattern) => globMatches(pattern, normalizePath(path))));
}

export function withPermissionAliases(policy: ModeDefinition["permission"]): ModeDefinition["permission"] {
  return {
    ...policy,
    ...(policy.run_command === undefined && (policy.bash ?? policy.shell) !== undefined ? { run_command: policy.bash ?? policy.shell } : {}),
  };
}

export function withRuntimeToolAliases(mode: ModeDefinition): ModeDefinition {
  const aliases = mode.tools.some((tool) => tool === "bash" || tool === "shell") && !mode.tools.includes("run_command") ? ["run_command"] : [];
  return aliases.length ? { ...mode, tools: [...mode.tools, ...aliases] } : mode;
}

export function intersectPermissionEngines(...engines: RuntimePermissionEngine[]): RuntimePermissionEngine {
  return {
    evaluate: (request) => {
      const decisions = engines.map((engine) => engine.evaluate(request));
      return decisions.find((decision) => decision.effect === "deny")
        ?? decisions.find((decision) => decision.effect === "ask")
        ?? decisions[0];
    },
  };
}

/** Bound source content across all prompt layers in deterministic group order. */
export function boundSourceGroups(groups: InstructionSource[][], limit = 128_000): InstructionSource[][] {
  let remaining = limit;
  return groups.map((group) => group.flatMap((source) => {
    if (remaining <= 0) return [];
    const content = source.content.slice(0, remaining);
    remaining -= content.length;
    return content ? [{ ...source, content }] : [];
  }));
}
