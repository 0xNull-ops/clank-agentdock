import { describe, expect, test } from "bun:test";
import {
  ACTIVE_PROVIDER_PROFILE_STATE_KEY,
  LEGACY_PROVIDER_API_KEY_SECRET_KEY,
  PROVIDER_PROFILES_STATE_KEY,
  ProviderProfileStore,
  ProviderProfileValidationError,
  providerApiKeySecretKey,
  resolveProfileModel,
  validateProviderProfile,
  type ProviderProfile,
} from "../src/runtime/provider-profiles";

function memoryStorage(initial: Record<string, unknown> = {}, initialSecrets: Record<string, string> = {}) {
  const state = new Map(Object.entries(initial));
  const secretMap = new Map(Object.entries(initialSecrets));
  return {
    globalState: {
      get<T>(key: string, defaultValue?: T): T | undefined {
        return (state.has(key) ? state.get(key) : defaultValue) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
    secrets: {
      async get(key: string): Promise<string | undefined> { return secretMap.get(key); },
      async store(key: string, value: string): Promise<void> { secretMap.set(key, value); },
      async delete(key: string): Promise<void> { secretMap.delete(key); },
    },
    state,
    secretValues: secretMap,
  };
}

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "local",
    name: "Local endpoint",
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    headers: { "X-Client": "forge" },
    manualModels: [{ id: "local-model", capabilities: { tools: true, reasoning: false } }],
    defaultModel: "local-model",
    modeDefaults: { architect: "strong-model" },
    compatibility: {
      supportsDeveloperRole: false,
      supportsParallelToolCalls: true,
      requiresAssistantReasoningReplay: false,
      requiresAssistantFrameReplay: false,
      sendMaxTokensAs: "max_tokens",
    },
    ...overrides,
  };
}

describe("provider profile validation", () => {
  test("normalizes a profile and keeps compatibility metadata non-secret", () => {
    expect(validateProviderProfile({
      id: " local ",
      name: " Local endpoint ",
      baseUrl: "https://api.example.test/v1/",
      headers: { "X-Client": "forge" },
      manualModels: [{ id: " model-a ", displayName: "Model A" }],
      defaultModel: "model-a",
      modeDefaults: { implement: "model-a" },
      compatibility: { supportsDeveloperRole: false },
    })).toEqual({
      id: "local",
      name: "Local endpoint",
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      headers: { "X-Client": "forge" },
      manualModels: [{ id: "model-a", displayName: "Model A" }],
      defaultModel: "model-a",
      modeDefaults: { implement: "model-a" },
      compatibility: {
        supportsDeveloperRole: false,
        supportsParallelToolCalls: true,
        requiresAssistantReasoningReplay: false,
        requiresAssistantFrameReplay: false,
        sendMaxTokensAs: "max_tokens",
      },
    });
  });

  test("rejects unsafe URLs and secret-like headers", () => {
    expect(() => validateProviderProfile({ ...profile(), baseUrl: "ftp://example.test", headers: { authorization: "Bearer secret" } })).toThrow(ProviderProfileValidationError);
    try {
      validateProviderProfile({ ...profile(), headers: { "X-Api-Key": "secret", "X-Name": "ok\nnope" } });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderProfileValidationError);
      expect((error as ProviderProfileValidationError).issues.map((issue) => issue.field)).toEqual(["headers.X-Api-Key", "headers.X-Name"]);
    }
  });

  test("resolves one-turn, mode, then profile defaults", () => {
    const value = profile();
    expect(resolveProfileModel(value, { modelId: "turn-model", mode: "architect" })).toBe("turn-model");
    expect(resolveProfileModel(value, { mode: "architect" })).toBe("strong-model");
    expect(resolveProfileModel(value, { mode: "ask" })).toBe("local-model");
  });
});

describe("provider profile store", () => {
  test("performs CRUD and persists active selection without credential leakage", async () => {
    const memory = memoryStorage();
    const store = new ProviderProfileStore(memory);
    const created = await store.createProfile(profile());
    expect(created).toEqual(profile());
    expect(memory.state.get(PROVIDER_PROFILES_STATE_KEY)).toEqual([profile()]);
    expect(await store.getActiveProfileId()).toBe("local");
    await store.setApiKey("local", "  secret-value  ");
    expect(memory.secretValues.get(providerApiKeySecretKey("local"))).toBe("secret-value");
    expect(memory.state.get(PROVIDER_PROFILES_STATE_KEY)).not.toContain("secret-value");
    expect(await store.updateProfile("local", { name: "Updated", defaultModel: "new-model" })).toMatchObject({ name: "Updated", defaultModel: "new-model" });
    expect(await store.deleteProfile("local")).toBe(true);
    expect(await store.listProfiles()).toEqual([]);
    expect(memory.secretValues.has(providerApiKeySecretKey("local"))).toBe(false);
    expect(memory.state.has(ACTIVE_PROVIDER_PROFILE_STATE_KEY)).toBe(false);
  });

  test("migrates legacy non-secret settings and copies, but never deletes, the old key", async () => {
    const memory = memoryStorage({}, { [LEGACY_PROVIDER_API_KEY_SECRET_KEY]: "legacy-secret" });
    const settings = new Map<string, unknown>([
      ["provider.id", "minimax"],
      ["provider.name", "MiniMax"],
      ["provider.baseUrl", "https://api.minimax.test/v1/"],
      ["provider.model", "MiniMax-M2.7"],
      ["provider.headers", { "X-Client": "forge" }],
      ["provider.supportsDeveloperRole", false],
      ["provider.sendMaxTokensAs", "max_completion_tokens"],
    ]);
    const configuration = { get<T>(key: string, fallback?: T): T | undefined { return (settings.has(key) ? settings.get(key) : fallback) as T | undefined; } };
    const store = new ProviderProfileStore(memory, { legacyConfiguration: configuration });
    const first = await store.migrateFromLegacySettings();
    const second = await store.migrateFromLegacySettings();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.profile).toMatchObject({ id: "minimax", name: "MiniMax", defaultModel: "MiniMax-M2.7", manualModels: [{ id: "MiniMax-M2.7" }] });
    expect(await store.getApiKey("minimax")).toBe("legacy-secret");
    expect(memory.secretValues.get(LEGACY_PROVIDER_API_KEY_SECRET_KEY)).toBe("legacy-secret");
    expect(settings.get("provider.baseUrl")).toBe("https://api.minimax.test/v1/");
  });

  test("does not migrate an empty legacy endpoint", async () => {
    const memory = memoryStorage();
    const store = new ProviderProfileStore(memory, { legacyConfiguration: { get: () => "" } });
    expect(await store.migrateFromLegacySettings()).toEqual({ created: false, copiedApiKey: false });
    expect(await store.listProfiles()).toEqual([]);
  });
});
