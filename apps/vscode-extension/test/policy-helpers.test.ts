import { describe, expect, test } from "bun:test";
import { PermissionEngine, type ModeDefinition } from "@freebuff/agent-core";
import {
  boundSourceGroups,
  intersectPermissionEngines,
  permissionRequestPaths,
  requestPathsWithinPatterns,
  withPermissionAliases,
  withRuntimeToolAliases,
} from "../src/runtime/policy-helpers";

const mode = (overrides: Partial<ModeDefinition> = {}): ModeDefinition => ({
  name: "Custom",
  slug: "custom",
  type: "all",
  instructions: "",
  steps: 10,
  tools: [],
  permission: {},
  skills: [],
  delegationAllowed: false,
  allowedAgents: [],
  delegationEffects: "read",
  ...overrides,
});

describe("custom-mode policy helpers", () => {
  test("extracts patch paths and rejects an out-of-scope patch", () => {
    const allowedPatch = {
      toolName: "apply_patch",
      input: { patch: "*** Begin Patch\n*** Update File: src/allowed.ts\n@@\n+ok\n*** End Patch" },
    };
    const outsidePatch = {
      toolName: "apply_patch",
      input: { patch: "*** Begin Patch\n*** Update File: secrets/outside.ts\n@@\n+nope\n*** End Patch" },
    };
    expect(permissionRequestPaths(allowedPatch)).toEqual(["src/allowed.ts"]);
    expect(requestPathsWithinPatterns(allowedPatch, ["src/**"])).toBe(true);
    expect(requestPathsWithinPatterns(outsidePatch, ["src/**"])).toBe(false);
    expect(requestPathsWithinPatterns({ toolName: "apply_patch", input: { patch: "not a patch header" } }, ["src/**"])).toBe(false);
  });

  test("handles unified, delete, and move patch headers", () => {
    expect(permissionRequestPaths({
      toolName: "apply_patch",
      input: { patch: "*** Delete File: src/old.ts\n*** Update File: src/current.ts\n*** Move to: src/renamed.ts\n+++ b/src/current.ts\n" },
    })).toEqual(["src/old.ts", "src/current.ts", "src/renamed.ts"]);
  });

  test("maps bash policy and edit policy aliases onto runtime tools", () => {
    const policy = withPermissionAliases({
      edit: { "src/**": "allow", "*": "deny" },
      bash: { "npm test*": "allow", "*": "deny" },
    });
    expect(policy.run_command).toEqual({ "npm test*": "allow", "*": "deny" });
    const engine = new PermissionEngine({ mode: policy });
    expect(engine.evaluate({ toolName: "write_file", path: "src/index.ts" }).effect).toBe("allow");
    expect(engine.evaluate({ toolName: "apply_patch", path: "docs/readme.md" }).effect).toBe("deny");
    expect(engine.evaluate({ toolName: "run_command", command: "npm test -- unit" }).effect).toBe("allow");
    expect(engine.evaluate({ toolName: "run_command", command: "node script.js" }).effect).toBe("deny");
  });

  test("advertises the runtime command alias for bash and shell modes", () => {
    expect(withRuntimeToolAliases(mode({ tools: ["bash"] })).tools).toEqual(["bash", "run_command"]);
    expect(withRuntimeToolAliases(mode({ tools: ["shell", "run_command"] })).tools).toEqual(["shell", "run_command"]);
    expect(withRuntimeToolAliases(mode({ tools: ["run_command"] })).tools).toEqual(["run_command"]);
  });

  test("intersects permission engines with deny, then ask, precedence", () => {
    const allow = { evaluate: () => ({ effect: "allow" as const, source: "mode" as const }) };
    const ask = { evaluate: () => ({ effect: "ask" as const, source: "mode" as const }) };
    const deny = { evaluate: () => ({ effect: "deny" as const, source: "mode" as const }) };
    expect(intersectPermissionEngines(allow, ask).evaluate({ toolName: "edit" }).effect).toBe("ask");
    expect(intersectPermissionEngines(allow, ask, deny).evaluate({ toolName: "edit" }).effect).toBe("deny");
    expect(intersectPermissionEngines(allow).evaluate({ toolName: "edit" }).effect).toBe("allow");
  });

  test("bounds source content across groups in deterministic order", () => {
    const bounded = boundSourceGroups([
      [{ source: "workspace", content: "a".repeat(6) }],
      [{ source: "skills", content: "b".repeat(6) }],
      [{ source: "default", content: "c".repeat(6) }],
    ], 10);
    expect(bounded).toEqual([
      [{ source: "workspace", content: "a".repeat(6) }],
      [{ source: "skills", content: "b".repeat(4) }],
      [],
    ]);
    expect(bounded.flat().reduce((total, source) => total + source.content.length, 0)).toBe(10);
  });
});
