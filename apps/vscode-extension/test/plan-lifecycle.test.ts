import { describe, expect, test } from "bun:test";
import { REQUIRED_PLAN_HEADINGS, validatePlanMarkdown } from "@freebuff/agent-core";
import {
  contentHashOf,
  decideArtifactPlanAction,
  isPlanActionPayload,
  planTitleFromMarkdown,
  planViewForSession,
} from "../src/runtime/plan-lifecycle";
import type { PlanRecord } from "@freebuff/agent-storage";

const validPlan = REQUIRED_PLAN_HEADINGS.map((heading) => `# ${heading}\nPlan ${heading}.`).join("\n\n");

const record = (overrides: Partial<PlanRecord> = {}): PlanRecord => ({
  id: "plan-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  title: "Add the lifecycle",
  content: validPlan,
  status: "READY_FOR_APPROVAL",
  revision: 3,
  artifactPath: ".agent/plans/2026-08-27-lifecycle.md",
  contentHash: contentHashOf(validPlan),
  contractJson: JSON.stringify(validatePlanMarkdown(validPlan).contract),
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

describe("plan lifecycle helpers", () => {
  test("plan view is sanitized: no Markdown, no absolute path, no contract", () => {
    const view = planViewForSession([record()])!;
    expect(view).toEqual({
      id: "plan-1",
      title: "Add the lifecycle",
      status: "READY_FOR_APPROVAL",
      revision: 3,
      artifactLabel: ".agent/plans/2026-08-27-lifecycle.md",
      updatedAt: 200,
    });
    expect(JSON.stringify(view)).not.toContain("# Goal");
    expect(JSON.stringify(view)).not.toContain("contract");
    expect(JSON.stringify(view)).not.toContain("/Users/");
    expect(JSON.stringify(view)).not.toContain(validPlan.slice(0, 20));
  });

  test("plan view for a session picks the newest visible plan and hides discarded/superseded", () => {
    const visible = record({ id: "plan-visible", status: "READY_FOR_APPROVAL", updatedAt: 300 });
    const discarded = record({ id: "plan-discarded", status: "DISCARDED", updatedAt: 400 });
    const superseded = record({ id: "plan-superseded", status: "SUPERSEDED", updatedAt: 500 });
    const latestVisible = record({ id: "plan-latest", status: "DRAFT", updatedAt: 600 });
    const view = planViewForSession([discarded, superseded, visible, latestVisible]);
    expect(view?.id).toBe("plan-latest");
    expect(view?.status).toBe("DRAFT");
  });

  test("plan view is undefined when every plan is hidden", () => {
    expect(planViewForSession([record({ status: "SUPERSEDED" }), record({ status: "DISCARDED", id: "other" })])).toBeUndefined();
  });

  test("artifact decisions create, skip, update, or supersede by content and status", () => {
    const candidate = { artifactPath: ".agent/plans/plan.md", content: validPlan };
    expect(decideArtifactPlanAction(undefined, candidate, true)).toEqual({ action: "create", status: "READY_FOR_APPROVAL" });
    expect(decideArtifactPlanAction(undefined, { ...candidate, content: "invalid" }, false)).toEqual({ action: "create", status: "DRAFT" });

    const same = record({ contentHash: contentHashOf(validPlan) });
    expect(decideArtifactPlanAction(same, candidate, true)).toEqual({ action: "skip" });

    const mutable = record({ status: "DRAFT", contentHash: contentHashOf("older") });
    expect(decideArtifactPlanAction(mutable, candidate, true)).toEqual({ action: "update", status: "READY_FOR_APPROVAL" });

    const approved = record({ status: "APPROVED", contentHash: contentHashOf("older") });
    expect(decideArtifactPlanAction(approved, candidate, true)).toEqual({ action: "supersede", status: "READY_FOR_APPROVAL" });
  });

  test("plan titles are derived from the Goal heading and bounded", () => {
    expect(planTitleFromMarkdown(validPlan, ".agent/plans/x.md")).toBe("Plan Goal.");
    expect(planTitleFromMarkdown("# Goal\n  \n# Tests\nx", "fallback")).toBe("fallback");
    expect(planTitleFromMarkdown(validPlan.replace("# Goal", "# Goal  \n  \n"), "fallback").length).toBeLessThanOrEqual(80);
  });

  test("plan action payloads accept only bounded planId plus revision", () => {
    expect(isPlanActionPayload({ planId: "plan-1", revision: 2 })).toBe(true);
    expect(isPlanActionPayload({ planId: "", revision: 2 })).toBe(false);
    expect(isPlanActionPayload({ planId: "plan-1", revision: 0 })).toBe(false);
    expect(isPlanActionPayload({ planId: "plan-1", revision: 1.5 })).toBe(false);
    expect(isPlanActionPayload({ planId: "plan-1", revision: 2, content: "markdown" })).toBe(false);
    expect(isPlanActionPayload({ planId: "x".repeat(300), revision: 2 })).toBe(false);
    expect(isPlanActionPayload(null)).toBe(false);
  });
});
