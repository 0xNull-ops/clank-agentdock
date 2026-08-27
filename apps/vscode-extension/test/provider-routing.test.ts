import { describe, expect, test } from "bun:test";
import { parseModeMarkdown } from "@freebuff/agent-core";
import { resolveProviderRoute } from "../src/runtime/provider-routing";
import { validateProviderProfile } from "../src/runtime/provider-profiles";

describe("provider execution routing", () => {
  test("resolves a custom subagent against its own profile catalog", () => {
    const profile = validateProviderProfile({
      id: "research-proxy",
      name: "Research proxy",
      baseUrl: "http://127.0.0.1:8317/v1",
      manualModels: [],
      defaultModel: "research-model",
    });
    const mode = parseModeMarkdown(`---
name: Research specialist
slug: research-specialist
type: subagent
provider: research-proxy
model: research-model
modelPolicy: fixed
---
Research the delegated question.`);

    const route = resolveProviderRoute({ profile, mode, discoveredModelIds: ["research-model"], selectedModel: "parent-model" });
    expect(route).toEqual({ ok: true, providerId: "research-proxy", model: "research-model" });
  });

  test("rejects a fixed child route whose model is absent from that profile", () => {
    const profile = validateProviderProfile({ id: "child", baseUrl: "http://127.0.0.1:8080/v1" });
    const mode = { ...parseModeMarkdown("---\nname: Child\nslug: child\ntype: subagent\n---\nWork."), model: "missing", modelPolicy: "fixed" as const };
    const route = resolveProviderRoute({ profile, mode, discoveredModelIds: ["available"], selectedModel: "" });
    expect(route.ok).toBe(false);
  });

  test("uses profile default model when custom subagent has no fixed model", () => {
    const profile = validateProviderProfile({
      id: "general-proxy",
      name: "General proxy",
      baseUrl: "http://127.0.0.1:8317/v1",
      defaultModel: "default-model",
    });
    const mode = parseModeMarkdown(`---
name: Open Subagent
slug: open-subagent
type: subagent
---
Work.`);
    const route = resolveProviderRoute({ profile, mode, discoveredModelIds: ["default-model"], selectedModel: "" });
    expect(route).toEqual({ ok: true, providerId: "general-proxy", model: "default-model" });
  });
});

