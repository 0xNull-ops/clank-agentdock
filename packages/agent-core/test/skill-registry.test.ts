import { describe, expect, test } from "bun:test";
import { loadSkillRegistry } from "../src/skill-registry";

describe("skill registry", () => {
  test("discovers safe metadata while keeping the instruction body behind resolve", () => {
    const registry = loadSkillRegistry({
      sources: [{
        scope: "project",
        source: "file:///workspace/.agent/skills/react/SKILL.md",
        content: `---\nname: react-component\ndescription: Build accessible React components.\n---\n# Instructions\n\nUse semantic HTML.`,
      }],
    });

    expect(registry.options).toEqual([{
      id: "react-component",
      name: "react-component",
      description: "Build accessible React components.",
      scope: "project",
      sourceKind: "native",
    }]);
    expect(registry.resolve("react-component")?.content).toContain("Use semantic HTML.");
  });

  test("keeps valid skills when another source is malformed and applies source precedence", () => {
    const registry = loadSkillRegistry({
      sources: [
        {
          scope: "installed",
          sourceKind: "installed",
          source: "file:///home/.codex/skills/review/SKILL.md",
          content: `---\nname: review\ndescription: Installed review skill.\n---\nInstalled body.`,
        },
        {
          scope: "project",
          source: "file:///workspace/.agent/skills/review/SKILL.md",
          content: `---\nname: review\ndescription: Project review skill.\n---\nProject body.`,
        },
        { scope: "project", source: "file:///workspace/.agent/skills/broken/SKILL.md", content: "not frontmatter" },
      ],
    });

    expect(registry.options).toEqual([{
      id: "review",
      name: "review",
      description: "Project review skill.",
      scope: "project",
      sourceKind: "native",
    }]);
    expect(registry.resolve("review")?.content).toBe("Project body.");
    expect(registry.diagnostics.map((item) => item.code)).toEqual(["shadowed-skill", "parse-error"]);
  });
});
