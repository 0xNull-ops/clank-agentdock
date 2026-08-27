import { ModeDefinition, ModeTransition, PermissionPolicy } from "./types";

export const READ_TOOLS = [
  "read*",
  "list_directory",
  "glob",
  "grep",
  "tree",
  "git_*",
  "get_diagnostics",
  "lsp",
  "semantic_search",
  "task",
];
export const IMPLEMENT_TOOLS = [...READ_TOOLS, "write_file", "edit_file", "apply_patch", "run_command"];
/**
 * Plan may write only dedicated `.agent/plans` artifacts; the pattern-level
 * tool list is still required so the registry advertises the write tools the
 * mode's path-scoped permission policy already governs.
 */
export const PLAN_TOOLS = [...READ_TOOLS, "write_file", "edit_file", "apply_patch"];
/** Architect writes only architecture/ADR documents via its path-scoped policy. */
export const ARCHITECT_TOOLS = PLAN_TOOLS;
const SAFE_READ_COMMANDS = {
  "*": "deny" as const,
  "git status*": "allow" as const,
  "git diff*": "allow" as const,
  "git log*": "allow" as const,
  "pwd": "allow" as const,
  "ls*": "allow" as const,
  "find *": "allow" as const,
  "rg *": "allow" as const,
  "grep *": "allow" as const,
};

const READ_PERMISSION: PermissionPolicy = {
  read: "allow",
  read_file: "allow",
  read_files: "allow",
  list_directory: "allow",
  glob: "allow",
  grep: "allow",
  tree: "allow",
  semantic_search: "allow",
  lsp: "allow",
  get_diagnostics: "allow",
  git_read: "allow",
  git_status: "allow",
  git_diff: "allow",
  git_diff_staged: "allow",
  git_log: "allow",
  git_show: "allow",
  git_branch: "allow",
  git_blame: "allow",
  run_command: SAFE_READ_COMMANDS,
  bash: SAFE_READ_COMMANDS,
  shell: SAFE_READ_COMMANDS,
  webfetch: "ask",
  websearch: "ask",
  mcp: "ask",
};

const NO_WRITE: PermissionPolicy = {
  ...READ_PERMISSION,
  edit: "deny",
  edit_file: "deny",
  write: "deny",
  write_file: "deny",
  apply_patch: "deny",
  delete: "deny",
  delete_file: "deny",
  move_file: "deny",
  task: "deny",
};

/**
 * Write baseline for modes that may mutate only dedicated artifacts. The
 * `edit`/`write`/`apply_patch` entries are path-scoped pattern maps instead of
 * plain denies, so the pattern evaluation wins over any tool-name string rule:
 * permissionKeysForTool() lists the tool name first, which means a direct
 * "write_file": "deny" would shadow the pattern map and make the mode unable
 * to write its own artifacts.
 */
const SCOPED_WRITE_BASE: PermissionPolicy = {
  ...READ_PERMISSION,
  delete: "deny",
  delete_file: "deny",
  move_file: "deny",
  task: "allow",
};

function mode(partial: Pick<ModeDefinition, "name" | "slug" | "instructions" | "steps" | "permission"> & Partial<ModeDefinition>): ModeDefinition {
  return {
    ...partial,
    type: partial.type ?? "primary",
    modelPolicy: partial.modelPolicy ?? "user-selectable",
    skills: partial.skills ?? [],
    delegationAllowed: partial.delegationAllowed ?? false,
    allowedAgents: partial.allowedAgents ?? [],
    delegationEffects: partial.delegationEffects ?? "read-only",
    tools: partial.tools ?? READ_TOOLS,
  };
}

export const BUILT_IN_MODES: readonly ModeDefinition[] = [
  mode({
    name: "Ask",
    slug: "ask",
    description: "Understand and explain without changing the project.",
    type: "primary",
    colorToken: "color.semantic.mode.ask",
    instructions: "Answer precisely, inspect the repository as needed, cite files and symbols, and never modify project files.",
    steps: 12,
    tools: READ_TOOLS,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test"],
    delegationEffects: "read-only",
    permission: { ...NO_WRITE, task: "allow" },
  }),
  mode({
    name: "Plan",
    slug: "plan",
    description: "Produce an actionable implementation plan.",
    type: "primary",
    colorToken: "color.semantic.mode.plan",
    instructions: "Investigate deeply and produce a concrete plan. Only write dedicated .agent/plans artifacts; do not implement production code.",
    steps: 20,
    tools: PLAN_TOOLS,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test"],
    delegationEffects: "read-only",
    permission: {
      ...SCOPED_WRITE_BASE,
      edit: { ".agent/plans/**": "allow", "*": "deny" },
      write: { ".agent/plans/**": "allow", "*": "deny" },
      apply_patch: { ".agent/plans/**": "allow", "*": "deny" },
    },
  }),
  mode({
    name: "Architect",
    slug: "architect",
    description: "Design boundaries, contracts, and system decisions.",
    type: "primary",
    colorToken: "color.semantic.mode.architect",
    instructions: "Focus on interfaces, invariants, data flow, security, concurrency, and migration tradeoffs. Do not implement app code.",
    steps: 24,
    reasoningEffort: "high",
    tools: ARCHITECT_TOOLS,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test"],
    delegationEffects: "read-only",
    permission: {
      ...SCOPED_WRITE_BASE,
      edit: { ".agent/architecture/**": "allow", "docs/architecture/**": "allow", "docs/adr/**": "allow", "*": "deny" },
      write: { ".agent/architecture/**": "allow", "docs/architecture/**": "allow", "docs/adr/**": "allow", "*": "deny" },
      apply_patch: { ".agent/architecture/**": "allow", "docs/architecture/**": "allow", "docs/adr/**": "allow", "*": "deny" },
    },
  }),
  mode({
    name: "Implement",
    slug: "implement",
    description: "Make code changes and finish the task.",
    type: "primary",
    colorToken: "color.semantic.mode.implement",
    instructions: "Inspect first, make the smallest coherent edits, run targeted validation, fix failures, and summarize actual repository state.",
    steps: 40,
    tools: IMPLEMENT_TOOLS,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test", "review", "general", "implementer"],
    delegationEffects: "write",
    permission: {
      ...READ_PERMISSION,
      edit: "ask",
      edit_file: "ask",
      write: "ask",
      write_file: "ask",
      apply_patch: "ask",
      delete: "ask",
      move_file: "ask",
      run_command: { ...SAFE_READ_COMMANDS, "npm test*": "allow", "npm run test*": "allow", "npm run lint*": "allow", "npm run build*": "allow", "*": "ask" },
      bash: { ...SAFE_READ_COMMANDS, "npm test*": "allow", "npm run test*": "allow", "npm run lint*": "allow", "npm run build*": "allow", "*": "ask" },
      task: "allow",
    },
  }),
  mode({
    name: "Debug",
    slug: "debug",
    description: "Diagnose and fix a defect using evidence.",
    type: "primary",
    colorToken: "color.semantic.mode.debug",
    instructions: "Follow Observe, Reproduce, Gather evidence, Hypothesize, Discriminate, Fix, Regression test, Explain.",
    steps: 50,
    reasoningEffort: "high",
    tools: IMPLEMENT_TOOLS,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test"],
    delegationEffects: "read-only",
    permission: {
      ...READ_PERMISSION,
      edit: "ask",
      edit_file: "ask",
      write: "ask",
      write_file: "ask",
      apply_patch: "ask",
      delete: "ask",
      move_file: "ask",
      run_command: { ...SAFE_READ_COMMANDS, "npm test*": "allow", "npm run test*": "allow", "npm run lint*": "allow", "*": "ask" },
      task: "allow",
    },
  }),
  mode({
    name: "Review",
    slug: "review",
    description: "Review code without unrequested modifications.",
    type: "primary",
    colorToken: "color.semantic.mode.review",
    instructions: "Inspect diffs and surrounding code, then report prioritized findings with file and line references. Do not edit.",
    steps: 24,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test"],
    delegationEffects: "read-only",
    permission: { ...NO_WRITE, task: "allow" },
  }),
  mode({
    name: "Orchestrate",
    slug: "orchestrate",
    description: "Coordinate complex work using isolated subagents.",
    type: "primary",
    colorToken: "color.semantic.mode.orchestrate",
    instructions: "Prefer delegation. Break work into bounded tasks, synthesize subagent results, and keep write work serialized unless isolation is explicit.",
    steps: 60,
    tools: READ_TOOLS,
    delegationAllowed: true,
    allowedAgents: ["explore", "research", "test", "review", "general", "implementer"],
    delegationEffects: "write",
    permission: { ...NO_WRITE, task: "allow" },
  }),
  mode({
    name: "Custom",
    slug: "custom",
    description: "A safe starting point for a user-defined executable mode.",
    type: "primary",
    colorToken: "color.semantic.mode.custom",
    instructions: "Follow the user request within this read-only baseline. Create a named custom mode to define broader tools and policy.",
    steps: 20,
    tools: READ_TOOLS,
    permission: NO_WRITE,
  }),
];

export const CUSTOM_MODE_DEFAULTS: ModeDefinition = {
  ...BUILT_IN_MODES.find((candidate) => candidate.slug === "custom")!,
  type: "all",
  instructions: "Follow the custom mode instructions and its explicit policy.",
  tools: [],
  permission: {},
};

export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
}

export function mergeMode(base: ModeDefinition, override: Partial<ModeDefinition>): ModeDefinition {
  const merged: ModeDefinition = {
    ...base,
    ...override,
    permission: mergeObject(base.permission, override.permission ?? {}),
    tools: mergeList(base.tools, override.tools, override.toolsMode),
    skills: mergeList(base.skills, override.skills, override.skillsMode),
  };
  return merged;
}

function mergeList(base: readonly string[], override: readonly string[] | undefined, mode: "merge" | "replace" | undefined): string[] {
  if (!override) return [...base];
  if (mode === "replace") return [...override];
  return [...new Set([...base, ...override])];
}

function mergeObject<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergeObject(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export class ModeManager {
  private readonly modes = new Map<string, ModeDefinition>(BUILT_IN_MODES.map((item) => [item.slug, item]));
  private readonly transitions: ModeTransition[] = [];

  add(modeDefinition: ModeDefinition): void {
    if (!modeDefinition.slug) throw new Error("Mode slug is required");
    this.modes.set(modeDefinition.slug, modeDefinition);
  }

  addCustom(frontmatter: string): ModeDefinition {
    const parsed = parseModeMarkdown(frontmatter);
    this.add(parsed);
    return parsed;
  }

  get(slug: string): ModeDefinition | undefined { return this.modes.get(slug); }
  list(): ModeDefinition[] { return [...this.modes.values()]; }
  transition(from: string, to: string, reason: ModeTransition["reason"], timestamp = Date.now()): ModeTransition {
    if (!this.modes.has(to)) throw new Error(`Unknown mode: ${to}`);
    const transition = { from, to, reason, timestamp };
    this.transitions.push(transition);
    return transition;
  }
  getTransitions(): ModeTransition[] { return [...this.transitions]; }
}

/** Parse the deliberately small Markdown + YAML mode format without coupling core to a parser package. */
export function parseModeMarkdown(markdown: string): ModeDefinition {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("Mode definition must start with YAML frontmatter (---)");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("Mode definition frontmatter is not closed");
  const raw = parseYamlSubset(lines.slice(1, end));
  const name = String(raw.name ?? "Custom");
  const base = { ...CUSTOM_MODE_DEFAULTS, slug: slugify(String(raw.slug ?? name)), name, instructions: lines.slice(end + 1).join("\n").trim() || CUSTOM_MODE_DEFAULTS.instructions };
  const parsed = raw as Partial<ModeDefinition>;
  return mergeMode(base, {
    ...parsed,
    type: (parsed.type ?? "all") as ModeDefinition["type"],
    steps: Number(parsed.steps ?? base.steps),
    tools: Array.isArray(parsed.tools) ? parsed.tools.map(String) : base.tools,
    skills: Array.isArray(parsed.skills) ? parsed.skills.map(String) : base.skills,
    permission: (parsed.permission ?? {}) as PermissionPolicy,
    delegationAllowed: Boolean(parsed.delegationAllowed ?? base.delegationAllowed),
  });
}

function parseYamlSubset(lines: string[]): Record<string, any> {
  const root: Record<string, any> = {};
  const stack: Array<{ indent: number; value: any }> = [{ indent: -1, value: root }];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const content = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (content.startsWith("- ")) {
      if (!Array.isArray(parent)) throw new Error(`Invalid list indentation near: ${line}`);
      parent.push(parseScalar(content.slice(2).trim()));
      continue;
    }
    const separator = content.indexOf(":");
    if (separator < 0) throw new Error(`Invalid YAML line: ${line}`);
    const key = stripQuotes(content.slice(0, separator).trim());
    const valueText = content.slice(separator + 1).trim();
    if (valueText) {
      parent[key] = parseScalar(valueText);
    } else {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim());
      const nextIsList = next ? next.trim().startsWith("-") && (next.match(/^\s*/)?.[0].length ?? 0) > indent : false;
      parent[key] = nextIsList ? [] : {};
      stack.push({ indent, value: parent[key] });
    }
  }
  return root;
}

function parseScalar(value: string): unknown {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => parseScalar(item.trim())).filter((item) => item !== "");
  return value;
}

function stripQuotes(value: string): string {
  return (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;
}
