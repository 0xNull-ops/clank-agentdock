export type SkillScope = "project" | "user" | "installed";
export type SkillSourceKind = "native" | "compatibility" | "installed";

export interface SkillSource {
  content: string;
  source: string;
  scope: SkillScope;
  sourceKind?: SkillSourceKind;
}

/**
 * The run configuration a skill expects, declared from the skill's own side.
 *
 * Modes could already require skills; this is the inverse binding — a skill
 * that carries the job it belongs to, so selecting it can configure the run.
 * Every field is a request, never an grant: the active mode remains the
 * authority, and a job may only narrow what the mode already permits.
 */
export interface SkillJob {
  /** Mode slug this skill expects to run under. */
  mode?: string;
  /** Permission posture this skill expects. */
  posture?: string;
  /** Preferred model id. Never fixed; the mode's model policy still wins. */
  model?: string;
  /** Provider profile id this skill expects. */
  provider?: string;
  /** File scope for the job. Intersects with the mode's scope, never widens it. */
  filePatterns?: string[];
  /** Subagent slugs this job expects to delegate to. */
  subagents?: string[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: SkillScope;
  sourceKind: SkillSourceKind;
  source: string;
  /** Present when the skill declares a `job:` block. */
  job?: SkillJob;
}

export type SkillOption = Omit<SkillDefinition, "content" | "source">;

export interface SkillDiagnostic {
  readonly code: "parse-error" | "invalid-skill" | "duplicate-skill" | "shadowed-skill";
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly source?: string;
  readonly id?: string;
}

export interface SkillRegistryResult {
  readonly ok: boolean;
  readonly options: readonly SkillOption[];
  readonly diagnostics: readonly SkillDiagnostic[];
  resolve(id: string): SkillDefinition | undefined;
}

export interface SkillRegistryOptions {
  sources?: readonly SkillSource[];
}

export function loadSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistryResult {
  const selected = new Map<string, SkillDefinition>();
  const diagnostics: SkillDiagnostic[] = [];
  for (const source of options.sources ?? []) {
    let definition: SkillDefinition;
    try {
      definition = parseSkill(source);
    } catch (error) {
      diagnostics.push({
        code: "parse-error",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        source: source.source,
      });
      continue;
    }
    const previous = selected.get(definition.id);
    if (!previous) {
      selected.set(definition.id, definition);
      continue;
    }
    const replaces = precedence(definition) >= precedence(previous);
    diagnostics.push({
      code: replaces ? "shadowed-skill" : "duplicate-skill",
      severity: "warning",
      message: replaces
        ? `Skill '${definition.id}' from ${definition.scope} scope shadows ${previous.scope} scope.`
        : `Skill '${definition.id}' from ${definition.scope} scope was ignored because ${previous.scope} scope has precedence.`,
      source: replaces ? previous.source : definition.source,
      id: definition.id,
    });
    if (replaces) selected.set(definition.id, definition);
  }
  const definitions = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    ok: diagnostics.every((item) => item.severity !== "error"),
    options: definitions.map(({ content: _content, source: _source, ...option }) => option),
    diagnostics,
    resolve: (id) => definitions.find((definition) => definition.id === id.trim().toLowerCase()),
  };
}

function parseSkill(source: SkillSource): SkillDefinition {
  const normalized = source.content.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`Skill source '${source.source}' must contain YAML frontmatter.`);
  const metadata = parseMetadata(match[1]);
  const name = metadata.name?.trim();
  const description = metadata.description?.trim();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error(`Skill source '${source.source}' has an invalid name.`);
  if (!description) throw new Error(`Skill source '${source.source}' must contain a description.`);
  const job = parseJob(match[1]);
  return {
    id: name.toLowerCase(),
    name,
    description,
    content: match[2].trim(),
    scope: source.scope,
    sourceKind: source.sourceKind ?? (source.scope === "installed" ? "installed" : "native"),
    source: source.source,
    ...(job ? { job } : {}),
  };
}

/**
 * Read the optional `job:` block. Deliberately tolerant: an unparseable or
 * partial job is dropped rather than failing the whole skill, because a job is
 * an enhancement and a skill without one is still perfectly valid.
 */
function parseJob(frontmatter: string): SkillJob | undefined {
  const lines = frontmatter.split("\n");
  const startIndex = lines.findIndex((line) => /^job:\s*$/.test(line.trimEnd()));
  if (startIndex < 0) return undefined;

  const job: SkillJob = {};
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    // The block ends at the first line that is not indented under `job:`.
    if (!/^\s+\S/.test(line)) break;
    const match = /^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = unquote(match[2]);
    if (!raw) continue;
    if (key === "mode" || key === "posture" || key === "model" || key === "provider") {
      job[key] = raw;
    } else if (key === "filePatterns" || key === "subagents") {
      const list = parseInlineList(raw);
      if (list.length) job[key] = list;
    }
  }
  return Object.keys(job).length ? job : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** Inline YAML flow sequences only: `[a, b]` or a bare comma-separated list. */
function parseInlineList(value: string): string[] {
  const body = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return body.split(",").map((entry) => unquote(entry)).filter(Boolean);
}

function parseMetadata(frontmatter: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2];
    result[match[1]] = ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  }
  return result;
}

function precedence(definition: SkillDefinition): number {
  const scope = definition.scope === "project" ? 30 : definition.scope === "user" ? 20 : 10;
  const kind = definition.sourceKind === "native" ? 3 : definition.sourceKind === "compatibility" ? 2 : 1;
  return scope + kind;
}
