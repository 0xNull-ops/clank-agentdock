import { describe, expect, test } from "bun:test";
import { PermissionEngine } from "../src/permissions";
import { BUILT_IN_MODES } from "../src/modes";
import {
  PERMISSION_POSTURES,
  permissionPosture,
  resolvePosture,
  type PermissionPosture,
} from "../src/posture";

const modeFor = (slug: string) => BUILT_IN_MODES.find((mode) => mode.slug === slug)!;

/** Build the engine exactly the way the host does, for a given posture. */
function engineFor(slug: string, posture: PermissionPosture, trusted = true) {
  const mode = modeFor(slug);
  const resolution = resolvePosture(posture);
  return new PermissionEngine({
    mode: mode.permission,
    workspaceTrusted: trusted,
    ...(resolution.session ? { session: resolution.session } : {}),
    ...(resolution.autoApprove ? { autoApprove: resolution.autoApprove } : {}),
  });
}

describe("permission postures", () => {
  test("manual leaves the mode's own policy untouched", () => {
    const engine = engineFor("implement", "manual");
    expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("ask");
    expect(engine.evaluate({ toolName: "run_command", command: "echo hi" }).effect).toBe("ask");
  });

  test("auto-edit allows file edits but still asks for commands", () => {
    const engine = engineFor("implement", "auto-edit");
    expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("allow");
    expect(engine.evaluate({ toolName: "edit_file", path: "src/a.ts" }).effect).toBe("allow");
    expect(engine.evaluate({ toolName: "run_command", command: "echo hi" }).effect).toBe("ask");
  });

  test("auto allows edits and commands", () => {
    const engine = engineFor("implement", "auto");
    expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("allow");
    expect(engine.evaluate({ toolName: "run_command", command: "echo hi" }).effect).toBe("allow");
  });

  test("auto still asks before installing packages", () => {
    const engine = engineFor("implement", "auto");
    expect(engine.evaluate({ toolName: "run_command", command: "npm install left-pad" }).effect).toBe("ask");
  });

  test("plan denies production writes and permits plan artifacts", () => {
    const engine = engineFor("implement", "plan");
    expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("deny");
    // Falls through the session layer to the mode's own rule for this path.
    expect(engine.evaluate({ toolName: "write_file", path: ".agent/plans/p.md" }).effect).toBe("ask");
  });

  describe("safety invariants", () => {
    test("no posture can grant writes to a read-only role", () => {
      for (const posture of PERMISSION_POSTURES) {
        for (const slug of ["ask", "review"]) {
          const engine = engineFor(slug, posture.id);
          const decision = engine.evaluate({ toolName: "write_file", path: "src/a.ts" });
          expect(`${slug}/${posture.id}: ${decision.effect}`).toBe(`${slug}/${posture.id}: deny`);
        }
      }
    });

    test("no posture lifts hard safety on destructive commands", () => {
      for (const posture of PERMISSION_POSTURES) {
        const engine = engineFor("implement", posture.id);
        expect(engine.evaluate({ toolName: "run_command", command: "rm -rf /" }).effect).toBe("deny");
      }
    });

    test("no posture lifts hard safety on protected files", () => {
      for (const posture of PERMISSION_POSTURES) {
        const engine = engineFor("implement", posture.id);
        expect(engine.evaluate({ toolName: "write_file", path: ".env" }).effect).toBe("deny");
      }
    });

    test("no posture lifts hard safety on external paths", () => {
      for (const posture of PERMISSION_POSTURES) {
        const mode = modeFor("implement");
        const resolution = resolvePosture(posture.id);
        const engine = new PermissionEngine({
          mode: mode.permission,
          workspaceRoot: "/repo",
          workspaceTrusted: true,
          ...(resolution.session ? { session: resolution.session } : {}),
          ...(resolution.autoApprove ? { autoApprove: resolution.autoApprove } : {}),
        });
        expect(engine.evaluate({ toolName: "write_file", path: "/etc/hosts" }).effect).toBe("ask");
      }
    });

    test("auto is inert in an untrusted workspace", () => {
      const engine = engineFor("implement", "auto", false);
      expect(engine.evaluate({ toolName: "write_file", path: "src/a.ts" }).effect).toBe("deny");
      expect(engine.evaluate({ toolName: "run_command", command: "echo hi" }).effect).toBe("deny");
    });

    test("reads stay allowed in every posture", () => {
      for (const posture of PERMISSION_POSTURES) {
        const engine = engineFor("implement", posture.id);
        expect(engine.evaluate({ toolName: "read_file", path: "src/a.ts" }).effect).toBe("allow");
      }
    });
  });

  test("unknown posture values fall back to manual", () => {
    expect(permissionPosture("nonsense")).toBe("manual");
    expect(permissionPosture(undefined)).toBe("manual");
    expect(permissionPosture("auto")).toBe("auto");
  });

});
