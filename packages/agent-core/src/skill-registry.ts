export type SkillScope = "project" | "user" | "installed";
export type SkillSourceKind = "native" | "compatibility" | "installed";

export interface SkillSource {
  content: string;
  source: string;
  scope: SkillScope;
  sourceKind?: SkillSourceKind;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: SkillScope;
  sourceKind: SkillSourceKind;
  source: string;
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
  return {
    id: name.toLowerCase(),
    name,
    description,
    content: match[2].trim(),
    scope: source.scope,
    sourceKind: source.sourceKind ?? (source.scope === "installed" ? "installed" : "native"),
    source: source.source,
  };
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
