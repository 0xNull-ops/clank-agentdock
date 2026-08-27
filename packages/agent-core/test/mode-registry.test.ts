import { describe, expect, test } from "bun:test";
import { ModeRegistry, loadModeRegistry } from "../src/mode-registry";

const mode = (name: string, extra = "") => `---
name: ${name}
type: all
steps: 4
---
Instructions for ${name}.${extra}`;

describe("custom mode registry", () => {
  test("loads string and source inputs with project precedence", () => {
    const result = loadModeRegistry({
      user: mode("Shared", " user"),
      project: [{ content: mode("Shared", " project"), source: ".agent/modes/shared.md" }],
    });

    expect(result.ok).toBe(true);
    expect(result.get("shared")?.instructions).toContain("project");
    expect(result.modes.map((item) => item.slug)).toContain("shared");
    expect(result.diagnostics.some((item) => item.code === "shadowed-mode")).toBe(true);
  });

  test("reports malformed sources and invalid fields without aborting other sources", () => {
    const result = new ModeRegistry({
      user: ["not markdown", mode("Valid")],
      project: mode("Broken").replace("steps: 4", "steps: nope"),
    }).load();

    expect(result.ok).toBe(false);
    expect(result.get("valid")).toBeDefined();
    expect(result.diagnostics.some((item) => item.code === "parse-error")).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "validation-error" && item.field === "steps")).toBe(true);
  });

  test("protects built-ins by default and supports explicit override", () => {
    const source = mode("Implement", " custom");
    const rejected = loadModeRegistry({ user: source });
    expect(rejected.get("implement")?.instructions).toContain("smallest coherent edits");
    expect(rejected.diagnostics.find((item) => item.code === "built-in-collision")?.severity).toBe("error");

    const overridden = loadModeRegistry({ user: source, builtInCollision: "override" });
    expect(overridden.get("implement")?.instructions).toContain("custom");
    expect(overridden.modes.filter((item) => item.slug === "implement")).toHaveLength(1);
  });

  test("freezes the complete result snapshot", () => {
    const result = loadModeRegistry({ user: mode("Immutable") });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.modes)).toBe(true);
    expect(Object.isFrozen(result.get("immutable"))).toBe(true);
    expect(Object.isFrozen(result.get("immutable")?.permission)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  test("recursively merges higher-precedence source fields instead of resetting omitted policy", () => {
    const user = `---\nname: Shared\nslug: shared\nsteps: 17\ntools:\n  - read_file\npermission:\n  read_file: allow\n  edit_file: deny\n---\nGlobal instructions.`;
    const project = `---\nname: Shared\nslug: shared\npermission:\n  edit_file: ask\n---\nProject instructions.`;
    const result = loadModeRegistry({ user, project });
    const resolved = result.get("shared")!;
    expect(resolved.steps).toBe(17);
    expect(resolved.tools).toEqual(["read_file"]);
    expect(resolved.permission).toMatchObject({ read_file: "allow", edit_file: "ask" });
    expect(resolved.instructions).toBe("Project instructions.");
  });

  test("merges arrays by default and replaces them only when explicitly requested", () => {
    const user = `---\nname: Shared\nslug: shared\ntools:\n  - read_file\nskills:\n  - base\n---\nGlobal instructions.`;
    const merged = loadModeRegistry({ user, project: `---\nname: Shared\nslug: shared\ntools:\n  - grep\nskills:\n  - focused\n---\nProject instructions.` }).get("shared")!;
    expect(merged.tools).toEqual(["read_file", "grep"]);
    expect(merged.skills).toEqual(["base", "focused"]);

    const replaced = loadModeRegistry({ user, project: `---\nname: Shared\nslug: shared\ntoolsMode: replace\ntools:\n  - grep\nskillsMode: replace\nskills:\n  - focused\n---\nProject instructions.` }).get("shared")!;
    expect(replaced.tools).toEqual(["grep"]);
    expect(replaced.skills).toEqual(["focused"]);
  });

  test("rejects empty instruction bodies and non-string scalar fields", () => {
    const result = loadModeRegistry({ user: [
      `---\nname: Empty\ndescription: 42\n---\n`,
      `---\nname: Broken Fixed\nmodelPolicy: fixed\nmodel: 1\n---\nStay bounded.`,
    ] });
    expect(result.get("empty")).toBeUndefined();
    expect(result.get("broken-fixed")).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "instructions", severity: "error" }),
      expect.objectContaining({ field: "description", severity: "error" }),
      expect.objectContaining({ field: "model", severity: "error" }),
    ]));
  });

  test("reports bounded schema diagnostics with source lines", () => {
    const result = loadModeRegistry({ user: `---\nname: Fixed\nmodelPolicy: fixed\nsteps: 999\nmystery: value\n---\nDo fixed work.` });
    expect(result.get("fixed")).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "model", severity: "error" }),
      expect.objectContaining({ field: "steps", line: 4, severity: "error" }),
      expect.objectContaining({ field: "mystery", line: 5, severity: "warning" }),
    ]));
  });
});
