import { describe, expect, test } from "bun:test";
import { BUILT_IN_MODES, ModeManager, mergeMode, parseModeMarkdown } from "../src/modes";
import { PermissionEngine, globMatches, normalizePath } from "../src/permissions";

describe("mode definitions", () => {
  test("ships all executable built-in modes with distinct budgets", () => {
    expect(BUILT_IN_MODES.map((item) => item.slug)).toEqual(["ask", "plan", "architect", "implement", "debug", "review", "orchestrate"]);
    expect(BUILT_IN_MODES.find((item) => item.slug === "debug")?.steps).toBe(50);
  });

  test("advertises only read tools in Ask and workspace mutations in Implement", () => {
    const ask = BUILT_IN_MODES.find((item) => item.slug === "ask")!;
    const implement = BUILT_IN_MODES.find((item) => item.slug === "implement")!;
    expect(ask.tools).toContain("git_*");
    expect(ask.tools).not.toContain("write_file");
    expect(ask.tools).not.toContain("edit_file");
    expect(ask.tools).not.toContain("apply_patch");
    expect(ask.tools).not.toContain("run_command");
    expect(implement.tools).toEqual(expect.arrayContaining(["write_file", "edit_file", "apply_patch", "run_command"]));
    for (const slug of ["plan", "architect", "review", "orchestrate"]) {
      const readOnlyMode = BUILT_IN_MODES.find((item) => item.slug === slug)!;
      expect(readOnlyMode.tools).not.toEqual(expect.arrayContaining(["write_file", "edit_file", "apply_patch", "run_command"]));
    }
  });

  test("parses custom Markdown/YAML modes and keeps body instructions", () => {
    const parsed = parseModeMarkdown(`---
name: Docs Writer
type: all
steps: 7
tools:
  - read_file
  - write_file
permission:
  write_file:
    "docs/**": allow
    "*": deny
---
Write only documentation files.`);
    expect(parsed.slug).toBe("docs-writer");
    expect(parsed.steps).toBe(7);
    expect(parsed.tools).toEqual(["read_file", "write_file"]);
    expect(parsed.permission.write_file).toEqual({ "docs/**": "allow", "*": "deny" });
    expect(parsed.instructions).toContain("documentation files");
  });

  test("merges policy objects while replacing arrays when requested", () => {
    const base = BUILT_IN_MODES.find((item) => item.slug === "implement")!;
    const result = mergeMode(base, { tools: ["read_file"], toolsMode: "replace", permission: { task: "deny" } });
    expect(result.tools).toEqual(["read_file"]);
    expect(result.permission.task).toBe("deny");
    expect(base.permission.task).toBe("allow");
  });

  test("records validated mode transitions", () => {
    const manager = new ModeManager();
    const transition = manager.transition("ask", "implement", "user", 10);
    expect(transition.to).toBe("implement");
    expect(() => manager.transition("ask", "missing", "user")).toThrow("Unknown mode");
  });
});

describe("permission engine", () => {
  test("glob matcher supports path stars and recursive stars", () => {
    expect(globMatches("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatches("src/*", "src/a/b.ts")).toBe(false);
    expect(globMatches("npm test*", "npm test -- --runInBand")).toBe(true);
  });

  test("session deny wins over lower-priority mode allow", () => {
    const engine = new PermissionEngine({ mode: { write_file: "allow" }, session: { write_file: "deny" } });
    expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("deny");
    expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).source).toBe("session");
  });

  test("project policy outranks a session allow, while session deny remains absolute", () => {
    const projectDeny = new PermissionEngine({ project: { write_file: "deny" }, mode: { write_file: "allow" }, session: { write_file: "allow" } });
    expect(projectDeny.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("deny");
    expect(projectDeny.evaluate({ toolName: "write_file", path: "src/a.ts" }).source).toBe("project");
    const sessionDeny = new PermissionEngine({ project: { write_file: "allow" }, session: { write_file: "deny" } });
    expect(sessionDeny.evaluate({ toolName: "write_file", path: "src/a.ts" }).source).toBe("session");
  });

  test("pattern ties are deterministic and deny wins", () => {
    const engine = new PermissionEngine({ mode: { run_command: { "npm t??": "allow", "npm ??st": "deny" } } });
    expect(engine.evaluate({ toolName: "run_command", command: "npm test" }).effect).toBe("deny");
  });

  test("canonicalizes relative traversal before matching", () => {
    expect(normalizePath("./src/one/../two.ts")).toBe("src/two.ts");
    const engine = new PermissionEngine({ mode: { write_file: { "src/**": "allow", "*": "deny" } } });
    expect(engine.evaluate({ toolName: "write_file", path: "src/one/../two.ts" }).effect).toBe("allow");
  });

  test("protected files cannot be mutated and destructive commands are hard denied", () => {
    const engine = new PermissionEngine({ mode: { write_file: "allow", run_command: "allow" }, autoMode: "full-auto" });
    expect(engine.evaluate({ toolName: "write_file", path: ".env" }).effect).toBe("deny");
    expect(engine.evaluate({ toolName: "run_command", command: "git push origin main" }).effect).toBe("deny");
  });

  test("coding auto mode allows test commands but keeps package installs asking", () => {
    const engine = new PermissionEngine({ mode: { run_command: "ask" }, autoMode: "coding" });
    expect(engine.evaluate({ toolName: "run_command", command: "npm test" }).effect).toBe("allow");
    expect(engine.evaluate({ toolName: "run_command", command: "npm install zod" }).effect).toBe("ask");
  });
});
