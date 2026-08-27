import { describe, expect, test } from "bun:test";
import { resolveModel, type ModelResolutionInput } from "../src/model-resolution";

describe("model resolution", () => {
  test("uses normal user-selectable precedence", () => {
    const input: ModelResolutionInput = {
      turnOverride: "turn",
      sessionSelection: "session",
      mode: { model: "mode", modelPolicy: "user-selectable" },
      profileDefault: "profile",
      globalFallback: "global",
    };

    expect(resolveModel(input)).toMatchObject({
      selectedModel: "turn",
      source: "turn",
      policy: "user-selectable",
      available: true,
    });
  });

  test("fixed mode selects its model and rejects lower-priority overrides", () => {
    const result = resolveModel({
      turnOverride: "turn",
      sessionSelection: "session",
      mode: { model: "luna", modelPolicy: "fixed" },
      profileDefault: "profile",
      globalFallback: "global",
    });

    expect(result).toMatchObject({ selectedModel: "luna", source: "mode", policy: "fixed", available: true });
    expect(result.rejections).toHaveLength(2);
    expect(result.rejections[0]).toMatchObject({ source: "turn", model: "turn" });
    expect(result.rejections[0].reason).toContain("fixes");
    expect(result.rejections[1]).toMatchObject({ source: "session", model: "session" });
    expect(result.rejections[1].reason).toContain("fixes");

    expect(resolveModel({ sessionSelection: "luna", mode: { model: "luna", modelPolicy: "fixed" } }).rejections).toEqual([]);
  });

  test("preferred mode wins while available, then falls back when unavailable", () => {
    const preferred = resolveModel({
      turnOverride: "turn",
      sessionSelection: "session",
      mode: { model: "preferred", modelPolicy: "preferred" },
      profileDefault: "profile",
      globalFallback: "global",
      availableModels: ["preferred", "turn", "session", "profile", "global"],
    });
    expect(preferred).toMatchObject({ selectedModel: "preferred", source: "mode", available: true });

    const fallback = resolveModel({
      turnOverride: "turn",
      sessionSelection: "session",
      mode: { model: "preferred", modelPolicy: "preferred" },
      profileDefault: "profile",
      globalFallback: "global",
      availableModels: ["session", "profile", "global"],
    });
    expect(fallback).toMatchObject({ selectedModel: "session", source: "session", available: true });
    expect(fallback.fallback).toMatchObject({ model: "preferred", source: "mode" });
  });

  test("skips unavailable candidates and reports the fallback", () => {
    const result = resolveModel({
      turnOverride: "unavailable-turn",
      sessionSelection: "session",
      profileDefault: "profile",
      globalFallback: "global",
      availableModels: ["session", "profile", "global"],
    });

    expect(result).toMatchObject({ selectedModel: "session", source: "session", available: true });
    expect(result.fallback).toMatchObject({ source: "turn", model: "unavailable-turn" });
  });

  test("returns a structured result when fixed mode has no configured model", () => {
    const result = resolveModel({ mode: { modelPolicy: "fixed" }, globalFallback: "global" });
    expect(result.selectedModel).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(result.rejection?.reason).toContain("fixed model");
  });

  test("uses the profile and global branches when higher-priority values are absent", () => {
    expect(resolveModel({ profileDefault: "profile", globalFallback: "global" })).toMatchObject({
      selectedModel: "profile",
      source: "profile",
    });
    expect(resolveModel({ globalFallback: "global" })).toMatchObject({
      selectedModel: "global",
      source: "global",
    });
  });

  test("fails closed when every configured candidate is unavailable", () => {
    const result = resolveModel({
      turnOverride: "turn",
      profileDefault: "profile",
      globalFallback: "global",
      availableModels: [],
    });
    expect(result).toMatchObject({ selectedModel: "turn", source: "turn", available: false });
    expect(result.considered.every((candidate) => !candidate.available)).toBe(true);
  });

  test("normalizes whitespace and evaluates an availability predicate once per model", () => {
    const calls = new Map<string, number>();
    const result = resolveModel({
      turnOverride: "  missing ",
      sessionSelection: " session ",
      availableModels: (model) => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        return model === "session";
      },
    });
    expect(result.selectedModel).toBe("session");
    expect(calls.get("missing")).toBe(1);
    expect(calls.get("session")).toBe(1);
  });
});
