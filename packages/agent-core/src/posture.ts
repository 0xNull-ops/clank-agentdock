import type { PermissionPolicy } from "./types";

/**
 * How much the agent asks before acting, independent of what it is for.
 *
 * A mode is a *role*: instructions, tool surface, step budget, delegation
 * rights. A posture is orthogonal to that role — the same Implement role can
 * run asking for every edit or running unattended. Keeping the two axes
 * separate is what lets a user change how much they are interrupted without
 * authoring a whole custom mode.
 */
export type PermissionPosture = "manual" | "auto-edit" | "plan" | "auto";

export const DEFAULT_PERMISSION_POSTURE: PermissionPosture = "manual";

export interface PermissionPostureDefinition {
  readonly id: PermissionPosture;
  readonly label: string;
  readonly description: string;
  /** Relative risk, used by hosts to colour the control. */
  readonly risk: "none" | "low" | "elevated";
  /** Whether the posture is meaningful without workspace trust. */
  readonly requiresTrust: boolean;
}

export const PERMISSION_POSTURES: readonly PermissionPostureDefinition[] = Object.freeze([
  {
    id: "manual",
    label: "Manual",
    description: "Ask before every edit and every command.",
    risk: "none",
    requiresTrust: false,
  },
  {
    id: "auto-edit",
    label: "Edit automatically",
    description: "Apply file edits without asking. Commands still need approval.",
    risk: "low",
    requiresTrust: true,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Explore and write plan artifacts only. Production files are read-only.",
    risk: "none",
    requiresTrust: false,
  },
  {
    id: "auto",
    label: "Auto",
    description: "Approve anything that passes the safety check; pause for anything risky.",
    risk: "elevated",
    requiresTrust: true,
  },
]);

export function isPermissionPosture(value: unknown): value is PermissionPosture {
  return typeof value === "string" && PERMISSION_POSTURES.some((posture) => posture.id === value);
}

export function permissionPosture(value: unknown): PermissionPosture {
  return isPermissionPosture(value) ? value : DEFAULT_PERMISSION_POSTURE;
}

export function permissionPostureDefinition(value: PermissionPosture): PermissionPostureDefinition {
  return PERMISSION_POSTURES.find((posture) => posture.id === value) ?? PERMISSION_POSTURES[0];
}

/** Paths a Plan posture may still write, mirroring the Plan mode's own scope. */
export const PLAN_ARTIFACT_PATTERNS = Object.freeze([".agent/plans/**"]);

export interface PostureResolution {
  /** Fine-grained ask→allow upgrades handed to the permission engine. */
  readonly autoApprove?: { readonly edits?: boolean; readonly commands?: boolean };
  /**
   * Narrowing policy applied at session precedence. Only its denies take
   * effect, which is exactly the semantics a posture needs: it may forbid what
   * the role allows, never permit what the role forbids.
   */
  readonly session?: PermissionPolicy;
}

/**
 * Translate a posture into permission-engine options.
 *
 * Both directions are safe by construction rather than by guard. Widening runs
 * through the engine's ask→allow upgrade, which cannot lift a `deny`, so a
 * read-only role stays read-only in every posture. Narrowing runs through the
 * session layer, whose denies are evaluated ahead of every other layer, so a
 * restrictive posture cannot be overridden by a permissive mode.
 */
export function resolvePosture(posture: PermissionPosture): PostureResolution {
  switch (posture) {
    case "auto-edit":
      return { autoApprove: { edits: true } };
    case "auto":
      return { autoApprove: { edits: true, commands: true } };
    case "plan": {
      const scoped: PermissionPolicy[string] = Object.fromEntries([
        ...PLAN_ARTIFACT_PATTERNS.map((pattern) => [pattern, "allow" as const]),
        ["*", "deny" as const],
      ]);
      return {
        session: {
          edit: scoped,
          edit_file: scoped,
          write: scoped,
          write_file: scoped,
          apply_patch: scoped,
          delete: "deny",
          delete_file: "deny",
          move_file: "deny",
        },
      };
    }
    case "manual":
    default:
      return {};
  }
}
