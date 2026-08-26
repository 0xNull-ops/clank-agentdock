import type { ExtensionContext, Memento, SecretStorage, WorkspaceConfiguration } from "vscode";
import type { ModelCapabilities } from "@freebuff/agent-core";
import type { OpenAICompatibility } from "@freebuff/provider-openai-compatible";

/** The provider transports supported by the first-party registry. */
export type ProviderType = "openai-compatible" | (string & {});

/** Modes may grow independently of the built-in mode list. */
export type ProviderMode =
  | "ask"
  | "plan"
  | "architect"
  | "implement"
  | "debug"
  | "review"
  | "orchestrate"
  | "custom"
  | (string & {});

/** A model entered by the user, before or instead of endpoint discovery. */
export interface ProviderManualModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
}

/**
 * Provider configuration safe to persist in VS Code globalState.
 *
 * Deliberately no API key/token field exists here. Credentials are accessed
 * with {@link ProviderProfileStore.getApiKey} and are scoped to this profile.
 */
export interface ProviderProfile {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  headers: Record<string, string>;
  manualModels: ProviderManualModel[];
  defaultModel?: string;
  modeDefaults: Partial<Record<ProviderMode, string>>;
  compatibility: OpenAICompatibility;
}

export type ProviderProfileInput = Omit<ProviderProfile, "name" | "type" | "headers" | "manualModels" | "modeDefaults" | "compatibility"> & {
  name?: string;
  type?: ProviderType;
  headers?: Record<string, string>;
  manualModels?: ProviderManualModel[];
  modeDefaults?: Partial<Record<ProviderMode, string>>;
  compatibility?: OpenAICompatibility;
};

export type ProviderProfilePatch = Partial<Omit<ProviderProfile, "id">>;

export interface ProviderProfileStorage {
  globalState: Pick<Memento, "get" | "update">;
  secrets: Pick<SecretStorage, "get" | "store" | "delete">;
}

export interface ProviderProfileStoreOptions {
  /** Existing `agentdock` configuration, supplied to run the one-time migration. */
  legacyConfiguration?: Pick<WorkspaceConfiguration, "get">;
  /** The legacy key is copied, never deleted. */
  legacyApiKeySecretKey?: string;
  now?: () => number;
}

export interface ProviderProfileMigrationResult {
  profile?: ProviderProfile;
  created: boolean;
  copiedApiKey: boolean;
}

export interface ResolvedProviderProfile {
  profile: ProviderProfile;
  apiKey?: string;
}

export const PROVIDER_PROFILES_STATE_KEY = "agentdock.provider.profiles";
export const ACTIVE_PROVIDER_PROFILE_STATE_KEY = "agentdock.provider.activeProfileId";
export const LEGACY_PROVIDER_MIGRATION_STATE_KEY = "agentdock.provider.legacyMigration.v1";
export const LEGACY_PROVIDER_API_KEY_SECRET_KEY = "agentdock.provider.apiKey";

const DEFAULT_PROFILE_ID = "openai-compatible";
const DEFAULT_PROFILE_NAME = "OpenAI Compatible";
const PROFILE_API_KEY_PREFIX = "agentdock.provider.profile.";
const MAX_PROFILE_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODE_KEY_LENGTH = 64;

const DEFAULT_COMPATIBILITY: OpenAICompatibility = {
  supportsDeveloperRole: true,
  supportsParallelToolCalls: true,
  requiresAssistantReasoningReplay: false,
  requiresAssistantFrameReplay: false,
  sendMaxTokensAs: "max_tokens",
};

/** Return the SecretStorage key for a profile's API key. */
export function providerApiKeySecretKey(profileId: string): string {
  const id = normalizeProfileId(profileId);
  return `${PROFILE_API_KEY_PREFIX}${encodeURIComponent(id)}.apiKey`;
}

/** Backwards-friendly alias for callers that use a verb-first name. */
export const apiKeySecretKeyForProfile = providerApiKeySecretKey;

/**
 * Validate and normalize a profile without touching VS Code storage.
 * Throws ProviderProfileValidationError with field-level issues on failure.
 */
export function validateProviderProfile(input: ProviderProfileInput | ProviderProfile): ProviderProfile {
  const issues: ProviderProfileValidationIssue[] = [];
  const id = normalizeProfileId(input.id, issues);
  const name = normalizeName(input.name, id, issues);
  const type = normalizeProviderType(input.type, issues);
  const baseUrl = normalizeBaseUrl(input.baseUrl, issues);
  const headers = normalizeHeaders(input.headers ?? {}, issues);
  const manualModels = normalizeManualModels(input.manualModels ?? [], issues);
  const defaultModel = normalizeOptionalModelId(input.defaultModel, "defaultModel", issues);
  const modeDefaults = normalizeModeDefaults(input.modeDefaults ?? {}, issues);
  const compatibility = normalizeCompatibility(input.compatibility ?? {}, issues);

  if (defaultModel && !manualModels.some((model) => model.id === defaultModel)) {
    // Endpoint-discovered models are intentionally allowed here. A manually
    // entered model is only required to be valid when present in this list.
  }

  if (issues.length) throw new ProviderProfileValidationError(issues);
  return {
    id,
    name,
    type,
    baseUrl,
    headers,
    manualModels,
    ...(defaultModel ? { defaultModel } : {}),
    modeDefaults,
    compatibility,
  };
}

export interface ProviderProfileValidationIssue {
  field: string;
  message: string;
}

export class ProviderProfileValidationError extends Error {
  public readonly name = "ProviderProfileValidationError";

  public constructor(public readonly issues: ProviderProfileValidationIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
  }
}

/**
 * Resolve the model precedence for a provider profile:
 * one-turn override, mode default, then profile default.
 */
export function resolveProfileModel(
  profile: ProviderProfile,
  options: { mode?: ProviderMode; modelId?: string } = {},
): string | undefined {
  const modelId = options.modelId?.trim();
  if (modelId) return modelId;
  const modeModel = options.mode ? profile.modeDefaults[options.mode]?.trim() : undefined;
  return modeModel || profile.defaultModel;
}

/**
 * Host-side provider registry. Every mutating operation is serialized so a
 * quick settings UI cannot lose an adjacent profile update.
 */
export class ProviderProfileStore {
  private operations: Promise<void> = Promise.resolve();

  public constructor(
    private readonly storage: ProviderProfileStorage,
    private readonly options: ProviderProfileStoreOptions = {},
  ) {}

  /** Construct from ExtensionContext and optionally migrate old settings. */
  public static async open(
    context: Pick<ExtensionContext, "globalState" | "secrets">,
    options: Omit<ProviderProfileStoreOptions, "legacyConfiguration"> & {
      legacyConfiguration?: Pick<WorkspaceConfiguration, "get">;
    } = {},
  ): Promise<ProviderProfileStore> {
    const store = new ProviderProfileStore(context, options);
    if (options.legacyConfiguration) await store.migrateFromLegacySettings(options.legacyConfiguration);
    return store;
  }

  public async listProfiles(): Promise<ProviderProfile[]> {
    await this.operations;
    return (await this.readProfiles()).map(copyProfile);
  }

  /** Alias useful to settings and command handlers. */
  public list(): Promise<ProviderProfile[]> {
    return this.listProfiles();
  }

  /** Explicit initialization hook for hosts that do not use {@link open}. */
  public initialize(): Promise<ProviderProfileMigrationResult> {
    return this.migrateFromLegacySettings();
  }

  public async getProfile(profileId: string): Promise<ProviderProfile | undefined> {
    const id = normalizeProfileId(profileId);
    await this.operations;
    const profile = (await this.readProfiles()).find((candidate) => candidate.id === id);
    return profile ? copyProfile(profile) : undefined;
  }

  public get(profileId: string): Promise<ProviderProfile | undefined> {
    return this.getProfile(profileId);
  }

  public async createProfile(input: ProviderProfileInput): Promise<ProviderProfile> {
    const profile = validateProviderProfile(input);
    return this.enqueue(async () => {
      const profiles = await this.readProfiles();
      if (profiles.some((candidate) => candidate.id === profile.id)) {
        throw new Error(`Provider profile '${profile.id}' already exists.`);
      }
      profiles.push(profile);
      await this.writeProfiles(profiles);
      if (!(await this.readActiveProfileId())) await this.writeActiveProfileId(profile.id);
      return copyProfile(profile);
    });
  }

  public create(input: ProviderProfileInput): Promise<ProviderProfile> {
    return this.createProfile(input);
  }

  public async updateProfile(profileId: string, patch: ProviderProfilePatch): Promise<ProviderProfile> {
    const id = normalizeProfileId(profileId);
    return this.enqueue(async () => {
      const profiles = await this.readProfiles();
      const index = profiles.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error(`Provider profile '${id}' was not found.`);
      const updated = validateProviderProfile({ ...profiles[index], ...patch, id });
      profiles[index] = updated;
      await this.writeProfiles(profiles);
      return copyProfile(updated);
    });
  }

  public update(profileId: string, patch: ProviderProfilePatch): Promise<ProviderProfile> {
    return this.updateProfile(profileId, patch);
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    const id = normalizeProfileId(profileId);
    return this.enqueue(async () => {
      const profiles = await this.readProfiles();
      const remaining = profiles.filter((candidate) => candidate.id !== id);
      if (remaining.length === profiles.length) return false;
      await this.writeProfiles(remaining);
      await this.storage.secrets.delete(providerApiKeySecretKey(id));
      if ((await this.readActiveProfileId()) === id) {
        await this.writeActiveProfileId(remaining[0]?.id);
      }
      return true;
    });
  }

  public delete(profileId: string): Promise<boolean> {
    return this.deleteProfile(profileId);
  }

  public async getActiveProfileId(): Promise<string | undefined> {
    await this.operations;
    const activeId = await this.readActiveProfileId();
    if (!activeId) return undefined;
    return (await this.readProfiles()).some((profile) => profile.id === activeId) ? activeId : undefined;
  }

  public async setActiveProfile(profileId: string | undefined): Promise<ProviderProfile | undefined> {
    return this.enqueue(async () => {
      if (profileId === undefined) {
        await this.writeActiveProfileId(undefined);
        return undefined;
      }
      const id = normalizeProfileId(profileId);
      const profile = (await this.readProfiles()).find((candidate) => candidate.id === id);
      if (!profile) throw new Error(`Provider profile '${id}' was not found.`);
      await this.writeActiveProfileId(id);
      return copyProfile(profile);
    });
  }

  public selectActiveProfile(profileId: string | undefined): Promise<ProviderProfile | undefined> {
    return this.setActiveProfile(profileId);
  }

  public async getActiveProfile(): Promise<ProviderProfile | undefined> {
    const id = await this.getActiveProfileId();
    return id ? this.getProfile(id) : undefined;
  }

  public async resolveProfile(profileId?: string): Promise<ResolvedProviderProfile | undefined> {
    const profile = profileId ? await this.getProfile(profileId) : await this.getActiveProfile();
    if (!profile) return undefined;
    return { profile, apiKey: await this.getApiKey(profile.id) };
  }

  public async getApiKey(profileId: string): Promise<string | undefined> {
    return this.storage.secrets.get(providerApiKeySecretKey(profileId));
  }

  /** Store only in SecretStorage; an empty key clears this profile's key. */
  public async setApiKey(profileId: string, apiKey: string | undefined): Promise<void> {
    const id = normalizeProfileId(profileId);
    return this.enqueue(async () => {
      if (!(await this.readProfiles()).some((profile) => profile.id === id)) throw new Error(`Provider profile '${id}' was not found.`);
      const key = providerApiKeySecretKey(id);
      if (apiKey === undefined || !apiKey.trim()) await this.storage.secrets.delete(key);
      else await this.storage.secrets.store(key, apiKey.trim());
    });
  }

  public clearApiKey(profileId: string): Promise<void> {
    return this.setApiKey(profileId, undefined);
  }

  /**
   * Import the old `agentdock.provider.*` configuration once it is available.
   * Existing settings and the old SecretStorage key are intentionally kept.
   */
  public async migrateFromLegacySettings(
    configuration = this.options.legacyConfiguration,
  ): Promise<ProviderProfileMigrationResult> {
    if (!configuration) return { created: false, copiedApiKey: false };
    return this.enqueue(async () => {
      if (this.storage.globalState.get<boolean>(LEGACY_PROVIDER_MIGRATION_STATE_KEY, false)) {
        return { created: false, copiedApiKey: false };
      }
      const baseUrl = readString(configuration, "provider.baseUrl");
      const existingId = readString(configuration, "provider.id") || DEFAULT_PROFILE_ID;
      if (!baseUrl) return { created: false, copiedApiKey: false };

      const profiles = await this.readProfiles();
      const existing = profiles.find((profile) => profile.id === existingId);
      if (existing) {
        // Migration is idempotent, but still copy a legacy key if a user has
        // not yet opened the profile in the new settings UI.
        const copiedApiKey = await this.copyLegacyApiKey(existing.id);
        await this.storage.globalState.update(LEGACY_PROVIDER_MIGRATION_STATE_KEY, true);
        return { profile: copyProfile(existing), created: false, copiedApiKey };
      }

      const model = readString(configuration, "provider.model");
      const input: ProviderProfileInput = {
        id: existingId,
        name: readString(configuration, "provider.name") || DEFAULT_PROFILE_NAME,
        type: readString(configuration, "provider.type") || "openai-compatible",
        baseUrl,
        headers: readRecord(configuration, "provider.headers"),
        manualModels: model ? [{ id: model, displayName: model }] : [],
        ...(model ? { defaultModel: model } : {}),
        modeDefaults: {},
        compatibility: {
          supportsDeveloperRole: readBoolean(configuration, "provider.supportsDeveloperRole", true),
          supportsParallelToolCalls: readBoolean(configuration, "provider.supportsParallelToolCalls", true),
          requiresAssistantReasoningReplay: readBoolean(configuration, "provider.requiresAssistantReasoningReplay", false),
          requiresAssistantFrameReplay: readBoolean(configuration, "provider.requiresAssistantFrameReplay", false),
          sendMaxTokensAs: readMaxTokensField(configuration),
          ...(readOptionalString(configuration, "provider.reasoningField") ? { reasoningField: readOptionalString(configuration, "provider.reasoningField") } : {}),
          streamUsage: readOptionalBoolean(configuration, "provider.streamUsage"),
          stripUnsupportedParams: readOptionalBoolean(configuration, "provider.stripUnsupportedParams"),
        },
      };
      const profile = validateProviderProfile(input);
      profiles.push(profile);
      await this.writeProfiles(profiles);
      if (!(await this.readActiveProfileId())) await this.writeActiveProfileId(profile.id);
      const copiedApiKey = await this.copyLegacyApiKey(profile.id);
      await this.storage.globalState.update(LEGACY_PROVIDER_MIGRATION_STATE_KEY, true);
      return { profile: copyProfile(profile), created: true, copiedApiKey };
    });
  }

  public migrateLegacyProvider(configuration = this.options.legacyConfiguration): Promise<ProviderProfileMigrationResult> {
    return this.migrateFromLegacySettings(configuration);
  }

  private async copyLegacyApiKey(profileId: string): Promise<boolean> {
    const oldKey = this.options.legacyApiKeySecretKey ?? LEGACY_PROVIDER_API_KEY_SECRET_KEY;
    const oldApiKey = await this.storage.secrets.get(oldKey);
    if (!oldApiKey) return false;
    const newKey = providerApiKeySecretKey(profileId);
    if (!(await this.storage.secrets.get(newKey))) await this.storage.secrets.store(newKey, oldApiKey);
    return true;
  }

  private async readProfiles(): Promise<ProviderProfile[]> {
    const raw = this.storage.globalState.get<unknown>(PROVIDER_PROFILES_STATE_KEY, []);
    if (!Array.isArray(raw)) throw new Error(`Stored provider profiles must be an array.`);
    return raw.map((candidate, index) => {
      try {
        return validateProviderProfile(candidate as ProviderProfile);
      } catch (error) {
        throw new Error(`Invalid stored provider profile at index ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async writeProfiles(profiles: ProviderProfile[]): Promise<void> {
    await this.storage.globalState.update(PROVIDER_PROFILES_STATE_KEY, profiles.map(copyProfile));
  }

  private async readActiveProfileId(): Promise<string | undefined> {
    const value = this.storage.globalState.get<unknown>(ACTIVE_PROVIDER_PROFILE_STATE_KEY);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private async writeActiveProfileId(profileId: string | undefined): Promise<void> {
    await this.storage.globalState.update(ACTIVE_PROVIDER_PROFILE_STATE_KEY, profileId);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation, operation);
    this.operations = next.then(() => undefined, () => undefined);
    return next;
  }
}

/** Name used by callers that think in terms of a manager rather than a store. */
export { ProviderProfileStore as ProviderProfileManager };

function normalizeProfileId(value: unknown, issues?: ProviderProfileValidationIssue[]): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) issues?.push({ field: "id", message: "is required" });
  else if (id.length > MAX_PROFILE_ID_LENGTH) issues?.push({ field: "id", message: `must be at most ${MAX_PROFILE_ID_LENGTH} characters` });
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) issues?.push({ field: "id", message: "may contain only letters, numbers, '.', '_' and '-'" });
  return id;
}

function normalizeName(value: unknown, id: string, issues: ProviderProfileValidationIssue[]): string {
  const name = typeof value === "string" ? value.trim() : id;
  if (!name) issues.push({ field: "name", message: "is required" });
  else if (name.length > MAX_NAME_LENGTH) issues.push({ field: "name", message: `must be at most ${MAX_NAME_LENGTH} characters` });
  return name;
}

function normalizeProviderType(value: unknown, issues: ProviderProfileValidationIssue[]): ProviderType {
  const type = value === undefined || value === null || value === ""
    ? "openai-compatible"
    : typeof value === "string" ? value.trim() : "";
  if (!type) {
    issues.push({ field: "type", message: "is required" });
    return "openai-compatible";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(type)) issues.push({ field: "type", message: "must be a provider type identifier" });
  return type;
}

function normalizeBaseUrl(value: unknown, issues: ProviderProfileValidationIssue[]): string {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) {
    issues.push({ field: "baseUrl", message: "is required" });
    return input;
  }
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("must use http:// or https://");
    if (!url.hostname) throw new Error("must include a hostname");
    if (url.username || url.password) throw new Error("must not contain credentials; use SecretStorage");
    if (url.hash) throw new Error("must not contain a URL fragment");
    return input.replace(/\/+$/, "");
  } catch (error) {
    issues.push({ field: "baseUrl", message: error instanceof Error ? error.message : "must be a valid URL" });
    return input;
  }
}

function normalizeHeaders(value: unknown, issues: ProviderProfileValidationIssue[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ field: "headers", message: "must be an object of string values" });
    return {};
  }
  const headers: Record<string, string> = {};
  const lowerNames = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    const lowerName = name.toLowerCase();
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      issues.push({ field: `headers.${rawName}`, message: "has an invalid HTTP header name" });
      continue;
    }
    if (lowerNames.has(lowerName)) {
      issues.push({ field: `headers.${name}`, message: "duplicates another header name (header names are case-insensitive)" });
      continue;
    }
    lowerNames.add(lowerName);
    if (isSecretLikeHeader(name)) {
      issues.push({ field: `headers.${name}`, message: "may contain a secret; store credentials in SecretStorage" });
      continue;
    }
    if (typeof rawValue !== "string") {
      issues.push({ field: `headers.${name}`, message: "must be a string" });
      continue;
    }
    if (rawValue.length > 4_096 || /[\r\n]/.test(rawValue)) {
      issues.push({ field: `headers.${name}`, message: "must be at most 4096 characters and contain no line breaks" });
      continue;
    }
    headers[name] = rawValue;
  }
  return headers;
}

function isSecretLikeHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return /(?:^|[-_])(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|auth(?:entication)?|token|secret|password|credential|key)(?:$|[-_])/.test(normalized);
}

function normalizeManualModels(value: unknown, issues: ProviderProfileValidationIssue[]): ProviderManualModel[] {
  if (!Array.isArray(value)) {
    issues.push({ field: "manualModels", message: "must be an array" });
    return [];
  }
  const ids = new Set<string>();
  const models: ProviderManualModel[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      issues.push({ field: `manualModels.${index}`, message: "must be an object" });
      continue;
    }
    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || id.length > MAX_MODEL_ID_LENGTH) {
      issues.push({ field: `manualModels.${index}.id`, message: `is required and must be at most ${MAX_MODEL_ID_LENGTH} characters` });
      continue;
    }
    if (ids.has(id)) {
      issues.push({ field: `manualModels.${index}.id`, message: "duplicates another model id" });
      continue;
    }
    ids.add(id);
    const model: ProviderManualModel = { id };
    if (typeof item.displayName === "string" && item.displayName.trim()) model.displayName = item.displayName.trim();
    model.contextWindow = normalizePositiveInteger(item.contextWindow, `manualModels.${index}.contextWindow`, issues);
    model.maxOutputTokens = normalizePositiveInteger(item.maxOutputTokens, `manualModels.${index}.maxOutputTokens`, issues);
    if (item.capabilities !== undefined) {
      if (!item.capabilities || typeof item.capabilities !== "object" || Array.isArray(item.capabilities)) {
        issues.push({ field: `manualModels.${index}.capabilities`, message: "must be an object" });
      } else {
        model.capabilities = normalizeCapabilities(item.capabilities as Record<string, unknown>, `manualModels.${index}.capabilities`, issues);
      }
    }
    if (model.contextWindow === undefined) delete model.contextWindow;
    if (model.maxOutputTokens === undefined) delete model.maxOutputTokens;
    models.push(model);
  }
  return models;
}

function normalizePositiveInteger(value: unknown, field: string, issues: ProviderProfileValidationIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push({ field, message: "must be a positive integer" });
    return undefined;
  }
  return value;
}

function normalizeCapabilities(value: Record<string, unknown>, field: string, issues: ProviderProfileValidationIssue[]): Partial<ModelCapabilities> {
  const allowed: (keyof ModelCapabilities)[] = ["contextWindow", "maxOutputTokens", "streaming", "tools", "parallelTools", "reasoning", "vision", "jsonSchema", "temperature"];
  const result: Partial<ModelCapabilities> = {};
  for (const key of allowed) {
    if (!(key in value)) continue;
    if (key === "contextWindow" || key === "maxOutputTokens") {
      const numberValue = normalizePositiveInteger(value[key], `${field}.${key}`, issues);
      if (numberValue !== undefined) result[key] = numberValue;
    } else if (typeof value[key] === "boolean") {
      result[key] = value[key] as never;
    } else {
      issues.push({ field: `${field}.${key}`, message: "must be a boolean" });
    }
  }
  return result;
}

function normalizeOptionalModelId(value: unknown, field: string, issues: ProviderProfileValidationIssue[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    issues.push({ field, message: "must be a string" });
    return undefined;
  }
  const result = value.trim();
  if (!result || result.length > MAX_MODEL_ID_LENGTH) {
    issues.push({ field, message: `must be at most ${MAX_MODEL_ID_LENGTH} characters` });
    return undefined;
  }
  return result;
}

function normalizeModeDefaults(value: unknown, issues: ProviderProfileValidationIssue[]): Partial<Record<ProviderMode, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ field: "modeDefaults", message: "must be an object" });
    return {};
  }
  const defaults: Partial<Record<ProviderMode, string>> = {};
  for (const [mode, model] of Object.entries(value)) {
    if (!mode || mode.length > MAX_MODE_KEY_LENGTH || !/^[A-Za-z0-9._-]+$/.test(mode)) {
      issues.push({ field: `modeDefaults.${mode}`, message: "must be a mode identifier" });
      continue;
    }
    const normalized = normalizeOptionalModelId(model, `modeDefaults.${mode}`, issues);
    if (normalized) defaults[mode] = normalized;
  }
  return defaults;
}

function normalizeCompatibility(value: unknown, issues: ProviderProfileValidationIssue[]): OpenAICompatibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ field: "compatibility", message: "must be an object" });
    return { ...DEFAULT_COMPATIBILITY };
  }
  const source = value as Record<string, unknown>;
  const compatibility: OpenAICompatibility = { ...DEFAULT_COMPATIBILITY };
  const booleanKeys: (keyof OpenAICompatibility)[] = [
    "stripUnsupportedParams",
    "supportsDeveloperRole",
    "requiresAssistantReasoningReplay",
    "requiresAssistantFrameReplay",
    "supportsParallelToolCalls",
    "streamUsage",
  ];
  for (const key of booleanKeys) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "boolean") issues.push({ field: `compatibility.${key}`, message: "must be a boolean" });
    else Object.assign(compatibility, { [key]: source[key] });
  }
  if (source.sendMaxTokensAs !== undefined) {
    if (source.sendMaxTokensAs !== "max_tokens" && source.sendMaxTokensAs !== "max_completion_tokens") {
      issues.push({ field: "compatibility.sendMaxTokensAs", message: "must be max_tokens or max_completion_tokens" });
    } else compatibility.sendMaxTokensAs = source.sendMaxTokensAs;
  }
  if (source.reasoningField !== undefined) {
    if (typeof source.reasoningField !== "string" || source.reasoningField.length > 128 || !/^[A-Za-z0-9._-]+$/.test(source.reasoningField)) {
      issues.push({ field: "compatibility.reasoningField", message: "must be a short wire-field identifier" });
    } else compatibility.reasoningField = source.reasoningField;
  }
  return compatibility;
}

function readString(configuration: Pick<WorkspaceConfiguration, "get">, key: string): string {
  const value = configuration.get<unknown>(key);
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(configuration: Pick<WorkspaceConfiguration, "get">, key: string): string | undefined {
  const value = readString(configuration, key);
  return value || undefined;
}

function readBoolean(configuration: Pick<WorkspaceConfiguration, "get">, key: string, fallback: boolean): boolean {
  const value = configuration.get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalBoolean(configuration: Pick<WorkspaceConfiguration, "get">, key: string): boolean | undefined {
  const value = configuration.get<unknown>(key);
  return typeof value === "boolean" ? value : undefined;
}

function readMaxTokensField(configuration: Pick<WorkspaceConfiguration, "get">): "max_tokens" | "max_completion_tokens" {
  const value = readString(configuration, "provider.sendMaxTokensAs");
  return value === "max_completion_tokens" ? value : "max_tokens";
}

function readRecord(configuration: Pick<WorkspaceConfiguration, "get">, key: string): Record<string, string> {
  const value = configuration.get<unknown>(key, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
}

function copyProfile(profile: ProviderProfile): ProviderProfile {
  return {
    ...profile,
    headers: { ...profile.headers },
    manualModels: profile.manualModels.map((model) => ({ ...model, ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}) })),
    modeDefaults: { ...profile.modeDefaults },
    compatibility: { ...profile.compatibility },
  };
}
