import { describe, expect, test } from "bun:test";
import { curateDiscoveredModels } from "../src/runtime/model-catalog";
import { FREEBUFF_REAL_MODELS } from "../src/runtime/freebuff-sidecar";

const option = (id: string) => ({ id, label: id, hint: "tools · standard" });

describe("provider model catalogue curation", () => {
  test("passes non-Freebuff providers through untouched", () => {
    const models = [option("gpt-4o"), option("google/gemini-2.5-flash-lite")];
    expect(curateDiscoveredModels("openai-compatible", models)).toEqual(models);
  });

  test("drops the Freebuff sidecar's internal helper-agent models", () => {
    const curated = curateDiscoveredModels("freebuff", [
      option("deepseek/deepseek-v4-flash"),
      option("google/gemini-2.5-flash-lite"),
      option("google/gemini-3.1-flash-lite-preview"),
      option("openai/gpt-5.6-luna"),
      option("minimax/minimax-m3"),
    ]);
    expect(curated.map((model) => model.id)).toEqual(["deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna"]);
  });

  test("labels surviving Freebuff models from the curated table", () => {
    const [curated] = curateDiscoveredModels("freebuff", [option("mimo/mimo-v2.5")]);
    const definition = FREEBUFF_REAL_MODELS.find((model) => model.id === "mimo/mimo-v2.5")!;
    expect(curated.label).toBe(definition.displayName);
    expect(curated.hint).toBe(definition.hint);
  });

  test("falls back to the raw list when no known chat model is advertised", () => {
    const models = [option("something/unknown")];
    expect(curateDiscoveredModels("freebuff2api", models)).toEqual(models);
  });
});
