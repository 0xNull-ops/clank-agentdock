import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_MODES,
  REQUIRED_PLAN_HEADINGS,
  composeSystemPrompt,
  formatApprovedPlanPrompt,
  validatePlanMarkdown,
} from "../src";

const planMarkdown = REQUIRED_PLAN_HEADINGS.map((heading) => `# ${heading}\nPlan ${heading}.`).join("\n\n");

describe("formal plan contract", () => {
  test("validates the required headings and returns structured sections", () => {
    const result = validatePlanMarkdown(planMarkdown);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.contract).toMatchObject({
      goal: "Plan Goal.",
      filesComponents: "Plan Files / Components.",
      acceptanceCriteria: "Plan Acceptance Criteria.",
    });
  });

  test("rejects missing, duplicate, empty, and oversized sections", () => {
    const missing = validatePlanMarkdown("# Goal\nA goal.");
    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain("Tests");

    const duplicate = validatePlanMarkdown(`${planMarkdown}\n\n# Goal\nAnother goal.`);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.duplicate).toEqual(["Goal"]);

    const empty = validatePlanMarkdown(REQUIRED_PLAN_HEADINGS.map((heading) => `# ${heading}\n${heading === "Tests" ? "" : "content"}`).join("\n\n"));
    expect(empty.ok).toBe(false);
    expect(empty.errors.some((error) => error.includes("# Tests"))).toBe(true);

    const oversized = validatePlanMarkdown(planMarkdown, 20);
    expect(oversized.ok).toBe(false);
    expect(oversized.errors[0]).toContain("20-character limit");
  });

  test("formats only an approved compact contract and enforces the prompt bound", () => {
    const contract = validatePlanMarkdown(planMarkdown).contract!;
    const prompt = formatApprovedPlanPrompt({ id: "plan_123", revision: 2, status: "APPROVED", contract }, 700);

    expect(prompt.length).toBeLessThanOrEqual(700);
    expect(prompt).toContain("You are implementing approved plan plan_123 (revision 2).");
    expect(prompt).toContain("## Goal");
    expect(prompt).not.toMatch(/\n# Goal\n/);
    expect(() => formatApprovedPlanPrompt({ id: "plan_123", revision: 2, status: "DRAFT", contract })).toThrow("approved plan");
  });

  test("integrates the approved structured contract into system prompt composition", () => {
    const contract = validatePlanMarkdown(planMarkdown).contract!;
    const prompt = composeSystemPrompt({
      mode: BUILT_IN_MODES.find((mode) => mode.slug === "implement")!,
      approvedPlan: { id: "plan_123", revision: 1, status: "APPROVED", contract },
    });

    expect(prompt).toContain("# Approved plan");
    expect(prompt).toContain("You are implementing approved plan plan_123 (revision 1).");
  });
});
