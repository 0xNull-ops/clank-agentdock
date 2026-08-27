import { describe, expect, test } from "bun:test";
import { loadSkillRegistry } from "../src/skill-registry";

const skill = (content: string) => loadSkillRegistry({
  sources: [{ content, source: "test.md", scope: "project" }],
});

describe("skill job bindings", () => {
  test("a skill without a job block still loads", () => {
    const registry = skill(`---
name: plain
description: Does a thing.
---
Body.`);
    expect(registry.ok).toBe(true);
    expect(registry.resolve("plain")?.job).toBeUndefined();
  });

  test("parses every job field", () => {
    const registry = skill(`---
name: db-migration
description: Write and verify reversible Postgres migrations.
job:
  mode: implement
  posture: manual
  model: openai/gpt-5.6-luna
  provider: freebuff
  filePatterns: ["migrations/**", "db/**"]
  subagents: [test, review]
---
Body.`);
    const job = registry.resolve("db-migration")?.job;
    expect(job).toEqual({
      mode: "implement",
      posture: "manual",
      model: "openai/gpt-5.6-luna",
      provider: "freebuff",
      filePatterns: ["migrations/**", "db/**"],
      subagents: ["test", "review"],
    });
  });

  test("stops at the first key outside the job block", () => {
    const registry = skill(`---
name: scoped
description: Scoped job.
job:
  mode: review
other: not-part-of-the-job
---
Body.`);
    expect(registry.resolve("scoped")?.job).toEqual({ mode: "review" });
  });

  test("a partial job keeps only the fields it declared", () => {
    const registry = skill(`---
name: partial
description: Partial job.
job:
  posture: plan
---
Body.`);
    expect(registry.resolve("partial")?.job).toEqual({ posture: "plan" });
  });

  test("an empty job block is dropped rather than failing the skill", () => {
    const registry = skill(`---
name: empty
description: Empty job.
job:
---
Body.`);
    expect(registry.ok).toBe(true);
    expect(registry.resolve("empty")?.job).toBeUndefined();
  });

  test("unknown job keys are ignored", () => {
    const registry = skill(`---
name: extra
description: Extra keys.
job:
  mode: debug
  nonsense: value
---
Body.`);
    expect(registry.resolve("extra")?.job).toEqual({ mode: "debug" });
  });

  test("bare comma lists parse the same as flow sequences", () => {
    const registry = skill(`---
name: bare
description: Bare list.
job:
  subagents: explore, research
---
Body.`);
    expect(registry.resolve("bare")?.job).toEqual({ subagents: ["explore", "research"] });
  });
});
