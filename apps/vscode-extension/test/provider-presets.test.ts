import { describe, expect, test } from "bun:test";
import { providerPreset, providerPresets } from "../src/runtime/provider-presets";
import { validateProviderProfile } from "../src/runtime/provider-profiles";

describe("provider presets", () => {
  test("ships editable VibeProxy and Freebuff2API loopback templates", () => {
    const vibe = providerPreset("vibeproxy");
    const freebuff = providerPreset("freebuff2api");

    expect(vibe?.baseUrl).toBe("http://127.0.0.1:8317/v1");
    expect(vibe?.defaultModel).toBeUndefined();
    expect(freebuff?.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(providerPresets().map((preset) => preset.id)).toContain("vibeproxy");
  });

  test("templates pass the ordinary profile validator and contain no credentials", () => {
    for (const preset of providerPresets()) {
      const profile = validateProviderProfile({
        id: preset.id,
        name: preset.name,
        type: preset.type,
        baseUrl: preset.baseUrl,
        headers: preset.headers,
        manualModels: preset.defaultModel ? [{ id: preset.defaultModel }] : [],
        defaultModel: preset.defaultModel,
        modeDefaults: {},
        compatibility: preset.compatibility,
      });
      expect(profile.baseUrl).toBe(preset.baseUrl);
      expect(JSON.stringify(preset).toLowerCase()).not.toContain("api_key");
      expect(JSON.stringify(preset).toLowerCase()).not.toContain("authorization");
    }
  });
});
