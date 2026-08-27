import {
  BUILT_IN_MODES,
  CUSTOM_MODE_DEFAULTS,
  mergeMode,
  parseModeMarkdown,
  slugify,
} from "./modes";
import type {
  ModeDefinition,
  PermissionEffect,
} from "./types";

/** The two persisted custom-mode scopes. Project definitions have precedence. */
export type ModeScope = "user" | "project";

/** A markdown mode together with an optional stable display/source identifier. */
export interface ModeSource {
  /** Markdown document containing YAML frontmatter and an instruction body. */
  content?: string;
  /** Alias accepted for callers that name the document field `markdown`. */
  markdown?: string;
  /** Optional path, URI, or other identifier used in diagnostics. */
  source?: string;
  /** Alias accepted for filesystem-backed callers. */
  path?: string;
  /** Required when using the flat `sources` option. */
  scope?: ModeScope;
}

export type ModeSourceInput = string | ModeSource;
export type ModeSourceCollection = ModeSourceInput | readonly ModeSourceInput[];

/** Inputs are strings for the simple case, or ordered sources for persistence layers. */
export interface ModeRegistrySources {
  user?: ModeSourceCollection;
  project?: ModeSourceCollection;
  sources?: readonly ModeSource[];
}

export type BuiltInCollisionPolicy = "reject" | "ignore" | "override" | "error" | "warn" | "allow";

export interface ModeRegistryOptions extends ModeRegistrySources {
  /** Built-ins are protected by default; `override` is explicit and opt-in. */
  builtInCollision?: BuiltInCollisionPolicy;
  /** Allows callers to provide a stable built-in set in tests or future products. */
  builtIns?: readonly ModeDefinition[];
}

export type ModeDiagnosticSeverity = "error" | "warning";

export interface ModeDiagnostic {
  readonly severity: ModeDiagnosticSeverity;
  readonly code:
    | "invalid-source"
    | "parse-error"
    | "validation-error"
    | "duplicate-mode"
    | "built-in-collision"
    | "shadowed-mode";
  readonly message: string;
  readonly scope?: ModeScope;
  readonly source?: string;
  readonly line?: number;
  readonly slug?: string;
  readonly field?: string;
}

export interface ModeRegistryEntry {
  readonly mode: ModeDefinition;
  readonly scope: "built-in" | ModeScope;
  readonly source?: string;
}

const PERMISSION_EFFECTS: readonly PermissionEffect[] = ["allow", "ask", "deny"];
const MODE_FIELDS = new Set([
  "name", "slug", "description", "type", "icon", "colorToken", "model", "modelPolicy", "provider",
  "temperature", "topP", "reasoningEffort", "maxOutputTokens", "steps", "tools", "permission", "skills",
  "skillsMode", "toolsMode", "delegationAllowed", "allowedAgents", "delegationEffects", "filePatterns",
  "commandPatterns", "mcpToolPatterns", "defaultContextSources", "responseTemplate",
]);

/** Immutable, provider-neutral result of loading all available custom modes. */
export interface ModeRegistryResult {
  readonly ok: boolean;
  readonly modes: readonly ModeDefinition[];
  readonly diagnostics: readonly ModeDiagnostic[];
  readonly entries: readonly ModeRegistryEntry[];
  get(slug: string): ModeDefinition | undefined;
}

interface Candidate {
  mode: ModeDefinition;
  scope: ModeScope;
  source?: string;
  order: number;
  fields: ReadonlySet<string>;
}

/**
 * Loads user and project custom modes without knowing how a provider or host
 * stores them. A new snapshot is produced for every call; callers can safely
 * retain it while another load is in progress.
 */
export class ModeRegistry {
  private readonly options: ModeRegistryOptions;

  public constructor(options: ModeRegistryOptions = {}) {
    this.options = options;
  }

  public load(): ModeRegistryResult {
    const diagnostics: ModeDiagnostic[] = [];
    const builtIns = (this.options.builtIns ?? BUILT_IN_MODES).map(cloneMode);
    const builtInSlugs = new Set(builtIns.map((item) => item.slug));
    const candidates: Candidate[] = [];
    let order = 0;

    for (const source of this.options.sources ?? []) {
      if (source.scope !== "user" && source.scope !== "project") {
        diagnostics.push({
          severity: "error",
          code: "invalid-source",
          message: "A flat mode source must declare scope as user or project.",
          source: source.source ?? source.path,
        });
      }
    }

    for (const scope of ["user", "project"] as const) {
      const inputs = scopeSources(this.options[scope], this.options.sources, scope);
      for (const input of inputs) {
        const candidate = parseSource(input, scope, order, diagnostics);
        order += 1;
        if (!candidate) continue;

        const collision = builtInSlugs.has(candidate.mode.slug);
        if (collision) {
          const policy = this.options.builtInCollision ?? "reject";
          const message = `Custom mode "${candidate.mode.slug}" from ${describeSource(candidate.source)} collides with a built-in mode.`;
          if (policy === "override" || policy === "allow") {
            const builtIn = builtIns.find((item) => item.slug === candidate.mode.slug);
            if (builtIn) candidate.mode = mergeSourcedMode(builtIn, candidate);
            diagnostics.push({ severity: "warning", code: "built-in-collision", message: `${message} The explicit override policy was applied.`, scope, source: candidate.source, slug: candidate.mode.slug });
          } else {
            diagnostics.push({ severity: policy === "ignore" || policy === "warn" ? "warning" : "error", code: "built-in-collision", message: `${message} The custom definition was ignored.`, scope, source: candidate.source, slug: candidate.mode.slug });
            continue;
          }
        }
        candidates.push(candidate);
      }
    }

    const selected = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const prior = selected.get(candidate.mode.slug);
      if (!prior) {
        selected.set(candidate.mode.slug, candidate);
        continue;
      }
      const replaces = precedence(candidate.scope) >= precedence(prior.scope);
      if (!replaces) {
        diagnostics.push({
          severity: "warning",
          code: "shadowed-mode",
          message: `Mode "${candidate.mode.slug}" from ${describeSource(candidate.source)} was ignored because ${prior.scope} scope has precedence.`,
          scope: candidate.scope,
          source: candidate.source,
          slug: candidate.mode.slug,
        });
        continue;
      }
      diagnostics.push({
        severity: "warning",
        code: prior.scope === candidate.scope ? "duplicate-mode" : "shadowed-mode",
        message: prior.scope === candidate.scope
          ? `Mode "${candidate.mode.slug}" replaces an earlier definition in ${candidate.scope} scope.`
          : `Project mode "${candidate.mode.slug}" replaces the user definition with the same slug.`,
        scope: candidate.scope,
        source: candidate.source,
        slug: candidate.mode.slug,
      });
      selected.set(candidate.mode.slug, { ...candidate, mode: mergeSourcedMode(prior.mode, candidate) });
    }

    // Built-ins retain their documented order. Custom modes are sorted by slug
    // so output does not depend on filesystem enumeration order.
    const custom = [...selected.values()].sort((left, right) => left.mode.slug.localeCompare(right.mode.slug));
    const overriddenBuiltIns = new Set(
      custom
        .filter((candidate) => builtInSlugs.has(candidate.mode.slug))
        .map((candidate) => candidate.mode.slug),
    );
    const entries: ModeRegistryEntry[] = [
      ...builtIns.filter((mode) => !overriddenBuiltIns.has(mode.slug)).map((mode) => ({ mode, scope: "built-in" as const })),
      ...custom.map((candidate) => ({ mode: candidate.mode, scope: candidate.scope, ...(candidate.source ? { source: candidate.source } : {}) })),
    ].map((entry) => freeze(entry));
    const modes = entries.map((entry) => entry.mode);
    const frozenDiagnostics = diagnostics.map((diagnostic) => freeze({ ...diagnostic }));
    const result: ModeRegistryResult = {
      ok: frozenDiagnostics.every((diagnostic) => diagnostic.severity !== "error"),
      modes,
      diagnostics: frozenDiagnostics,
      entries,
      get: (slug: string) => modes.find((mode) => mode.slug === slug),
    };
    return freeze(result);
  }
}

/** Functional form for hosts that do not need to retain a registry instance. */
export function loadModeRegistry(options: ModeRegistryOptions = {}): ModeRegistryResult {
  return new ModeRegistry(options).load();
}

/** Alias emphasizing that only custom sources are being loaded around built-ins. */
export const loadCustomModeRegistry = loadModeRegistry;

/** Short alias for consumers that treat the registry as a one-shot custom-mode loader. */
export const loadCustomModes = loadModeRegistry;

/** Compatibility alias for callers that model loading as a service. */
export class ModeLoader extends ModeRegistry {}

function scopeSources(
  scoped: ModeSourceCollection | undefined,
  flat: readonly ModeSource[] | undefined,
  scope: ModeScope,
): ModeSourceInput[] {
  const result = normalizeCollection(scoped);
  for (const source of flat ?? []) {
    if (source.scope === scope) result.push(source);
  }
  return result;
}

function normalizeCollection(value: ModeSourceCollection | undefined): ModeSourceInput[] {
  if (value === undefined) return [];
  return typeof value === "string" || isModeSource(value) ? [value] : [...value];
}

function isModeSource(value: unknown): value is ModeSource {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSource(
  input: ModeSourceInput,
  scope: ModeScope,
  order: number,
  diagnostics: ModeDiagnostic[],
): Candidate | undefined {
  const source = typeof input === "string" ? undefined : input.source ?? input.path;
  const markdown = typeof input === "string" ? input : input.content ?? input.markdown;
  if (typeof markdown !== "string" || !markdown.trim()) {
    diagnostics.push({ severity: "error", code: "invalid-source", message: "Mode source must contain a non-empty Markdown string.", scope, source });
    return undefined;
  }
  let mode: ModeDefinition;
  try {
    mode = parseModeMarkdown(markdown);
  } catch (error) {
    diagnostics.push({ severity: "error", code: "parse-error", message: errorMessage(error), scope, source });
    return undefined;
  }
  let errors: ModeDiagnostic[];
  try {
    errors = validateMode(mode, markdown);
  } catch (error) {
    diagnostics.push({ severity: "error", code: "validation-error", message: `Mode validation failed: ${errorMessage(error)}`, scope, source, slug: mode.slug });
    return undefined;
  }
  for (const diagnostic of errors) diagnostics.push({ ...diagnostic, scope, source, slug: mode.slug, ...(diagnostic.field ? { line: frontmatterLine(markdown, diagnostic.field) } : {}) });
  if (errors.some((diagnostic) => diagnostic.severity === "error")) return undefined;
  return { mode: cloneMode(mode), scope, source, order, fields: new Set(topLevelFrontmatterKeys(markdown).map((item) => item.key)) };
}

function mergeSourcedMode(base: ModeDefinition, candidate: Candidate): ModeDefinition {
  const source = candidate.mode as unknown as Record<string, unknown>;
  const partial: Record<string, unknown> = { instructions: candidate.mode.instructions };
  for (const field of candidate.fields) if (MODE_FIELDS.has(field)) partial[field] = source[field];
  return mergeMode(base, partial as Partial<ModeDefinition>);
}

function validateMode(mode: ModeDefinition, markdown: string): ModeDiagnostic[] {
  const diagnostics: ModeDiagnostic[] = [];
  const add = (field: string, message: string): void => {
    diagnostics.push({ severity: "error", code: "validation-error", field, message });
  };
  if (!hasFrontmatterKey(markdown, "name") || !mode.name.trim()) add("name", "Mode name is required.");
  if (!mode.slug || mode.slug !== slugify(mode.slug) || mode.slug.length > 64) add("slug", "Mode slug must be a canonical slug no longer than 64 characters.");
  if (mode.name.length > 200) add("name", "Mode name must not exceed 200 characters.");
  if (!["primary", "subagent", "all"].includes(mode.type)) add("type", `Unknown mode type "${String(mode.type)}".`);
  if (!Number.isInteger(mode.steps) || mode.steps < 1 || mode.steps > 200) add("steps", "Mode steps must be an integer between 1 and 200.");
  if (!Array.isArray(mode.tools) || mode.tools.some((value) => typeof value !== "string" || !value.trim())) add("tools", "Tools must be a list of non-empty strings.");
  if (!Array.isArray(mode.skills) || mode.skills.some((value) => typeof value !== "string" || !value.trim())) add("skills", "Skills must be a list of non-empty strings.");
  for (const field of ["filePatterns", "commandPatterns", "mcpToolPatterns", "defaultContextSources"] as const) {
    const value = mode[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))) add(field, `${field} must be a list of non-empty strings.`);
  }
  if (mode.responseTemplate !== undefined && (typeof mode.responseTemplate !== "string" || !mode.responseTemplate.trim())) add("responseTemplate", "Response template must be a non-empty string when configured.");
  if (!frontmatterBody(markdown).trim()) add("instructions", "A non-empty Markdown instruction body is required.");
  if (typeof mode.instructions !== "string" || !mode.instructions.trim()) add("instructions", "System instructions are required.");
  for (const field of ["name", "slug", "description", "icon", "colorToken", "model", "provider", "responseTemplate"] as const) {
    const value = mode[field];
    if (value !== undefined && typeof value !== "string") add(field, `${field} must be a string.`);
  }
  if (mode.modelPolicy !== undefined && !["fixed", "preferred", "user-selectable"].includes(mode.modelPolicy)) add("modelPolicy", `Unknown model policy "${String(mode.modelPolicy)}".`);
  if (mode.modelPolicy === "fixed" && (typeof mode.model !== "string" || !mode.model.trim())) add("model", "A fixed mode must declare a model.");
  if (mode.toolsMode !== undefined && !["merge", "replace"].includes(mode.toolsMode)) add("toolsMode", `Unknown tools merge mode "${String(mode.toolsMode)}".`);
  if (mode.skillsMode !== undefined && !["merge", "replace"].includes(mode.skillsMode)) add("skillsMode", `Unknown skills merge mode "${String(mode.skillsMode)}".`);
  if (mode.delegationEffects !== undefined && !["read-only", "same-as-parent", "write"].includes(mode.delegationEffects)) add("delegationEffects", `Unknown delegation effect "${String(mode.delegationEffects)}".`);
  if (mode.reasoningEffort !== undefined && !["none", "low", "medium", "high", "xhigh"].includes(mode.reasoningEffort)) add("reasoningEffort", `Unknown reasoning effort "${String(mode.reasoningEffort)}".`);
  if (mode.temperature !== undefined && (!Number.isFinite(mode.temperature) || mode.temperature < 0 || mode.temperature > 2)) add("temperature", "Temperature must be between 0 and 2.");
  if (mode.topP !== undefined && (!Number.isFinite(mode.topP) || mode.topP < 0 || mode.topP > 1)) add("topP", "Top-p must be between 0 and 1.");
  if (mode.maxOutputTokens !== undefined && (!Number.isInteger(mode.maxOutputTokens) || mode.maxOutputTokens < 1 || mode.maxOutputTokens > 1_000_000)) add("maxOutputTokens", "Max output tokens must be an integer between 1 and 1000000.");
  if (typeof mode.delegationAllowed !== "boolean") add("delegationAllowed", "Delegation allowed must be a boolean.");
  if (!Array.isArray(mode.allowedAgents) || mode.allowedAgents.some((value) => typeof value !== "string" || !value.trim())) add("allowedAgents", "Allowed agents must be a list of non-empty strings.");
  validatePermission(mode.permission, add);
  for (const { key, line } of topLevelFrontmatterKeys(markdown)) {
    if (!MODE_FIELDS.has(key)) diagnostics.push({ severity: "warning", code: "validation-error", field: key, line, message: `Unknown mode field "${key}" is ignored by the runtime.` });
  }
  return diagnostics;
}

function frontmatterBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end < 0 ? "" : lines.slice(end + 1).join("\n");
}

function validatePermission(permission: unknown, add: (field: string, message: string) => void): void {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    add("permission", "Permission must be a mapping of tools or categories to rules.");
    return;
  }
  for (const [tool, value] of Object.entries(permission)) {
    if (!tool.trim()) add("permission", "Permission keys must be non-empty strings.");
    validatePermissionValue(value, `permission.${tool}`, add);
  }
}

function validatePermissionValue(value: unknown, field: string, add: (field: string, message: string) => void): void {
  if (typeof value === "string") {
    if (!PERMISSION_EFFECTS.includes(value as PermissionEffect)) add(field, `Unknown permission effect "${value}".`);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add(field, "Permission rules must be allow, ask, deny, or a pattern mapping.");
    return;
  }
  if ("effect" in value) {
    const effect = (value as { effect?: unknown }).effect;
    if (!PERMISSION_EFFECTS.includes(effect as PermissionEffect)) add(field, `Unknown permission effect "${String(effect)}".`);
    return;
  }
  for (const [pattern, rule] of Object.entries(value)) validatePermissionValue(rule, `${field}.${pattern}`, add);
}

function hasFrontmatterKey(markdown: string, key: string): boolean {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return lines.slice(1, end < 0 ? lines.length : end).some((line) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`).test(line));
}

function frontmatterLine(markdown: string, field: string): number | undefined {
  const root = field.split(".")[0];
  const lines = markdown.split(/\r?\n/);
  const index = lines.findIndex((line, lineIndex) => lineIndex > 0 && new RegExp(`^\\s*${escapeRegExp(root)}\\s*:`).test(line));
  return index >= 0 ? index + 1 : undefined;
}

function topLevelFrontmatterKeys(markdown: string): Array<{ key: string; line: number }> {
  const lines = markdown.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return lines.slice(1, end < 0 ? lines.length : end).flatMap((line, index) => {
    const match = /^([^\s][^:]*):/.exec(line);
    return match ? [{ key: match[1].trim().replace(/^['"]|['"]$/g, ""), line: index + 2 }] : [];
  });
}

function precedence(scope: ModeScope): number {
  return scope === "project" ? 1 : 0;
}

function describeSource(source: string | undefined): string {
  return source ? `source ${JSON.stringify(source)}` : "an inline source";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cloneMode(mode: ModeDefinition): ModeDefinition {
  return mergeMode(CUSTOM_MODE_DEFAULTS, cloneValue(mode));
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
  return Object.freeze(value);
}
