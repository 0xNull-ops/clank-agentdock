import { describe, expect, test } from "bun:test";
import {
  SubagentOrchestrator,
  SubagentExecutionContext,
  SubagentExecutionRequest,
  SubagentResult,
} from "../src/subagents";
import { BUILT_IN_MODES } from "../src/modes";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("subagent runtime", () => {
  test("uses depth one by default and permits depth two for explicit Orchestrate", () => {
    const executor = { execute: async () => ({ summary: "done" }) };
    expect(new SubagentOrchestrator({ executor }).stats.maxDepth).toBe(1);
    expect(new SubagentOrchestrator({ executor, mode: "orchestrate" }).stats.maxDepth).toBe(2);
  });

  test("exposes the task tool in every delegating built-in mode", () => {
    for (const mode of BUILT_IN_MODES.filter((item) => item.delegationAllowed)) {
      expect(mode.tools).toContain("task");
      expect(mode.permission.task).toBe("allow");
    }
  });

  test("rejects authority escalation before invoking the executor", async () => {
    let executions = 0;
    const runtime = new SubagentOrchestrator({
      executor: { execute: async () => { executions += 1; return { summary: "unexpected" }; } },
      rootParent: { mode: "implement", authority: "read-only" },
    });

    const result = await runtime.spawn({ agent: "implementer", prompt: "edit the file", authority: "write" });

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("AUTHORITY_ESCALATION");
    expect(executions).toBe(0);
  });

  test("requires and honors approval for a write-capable spawn", async () => {
    const requested: string[] = [];
    const runtime = new SubagentOrchestrator({
      executor: { execute: async () => ({ summary: "implemented" }) },
      rootParent: { mode: "implement", authority: "write" },
      approveWriteSpawn: async (task) => { requested.push(task.agent); return "allow"; },
    });

    const result = await runtime.spawn({ agent: "implementer", prompt: "make the approved edit" });

    expect(result.status).toBe("completed");
    expect(requested).toEqual(["implementer"]);
  });

  test("enforces the configured concurrent worker limit", async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const runtime = new SubagentOrchestrator({
      maxConcurrent: 2,
      executor: {
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => resolvers.push(resolve));
          active -= 1;
          return { summary: "done" };
        },
      },
    });

    const results = [1, 2, 3, 4].map((index) => runtime.spawn({ agent: "explore", prompt: `task ${index}` }));
    await tick();
    expect(runtime.stats.active).toBe(2);
    expect(runtime.stats.queued).toBe(2);
    expect(peak).toBe(2);
    for (let round = 0; round < 2; round += 1) {
      while (resolvers.length) resolvers.shift()!();
      await tick();
    }
    const settled = await Promise.all(results);
    expect(settled.every((result) => result.status === "completed")).toBe(true);
    expect(peak).toBe(2);
  });

  test("enforces total-spawn and nesting limits", async () => {
    const runtime = new SubagentOrchestrator({
      maxTotal: 2,
      maxDepth: 1,
      executor: { execute: async () => ({ summary: "done" }) },
      rootParent: { mode: "orchestrate", authority: "read-only" },
    });

    const first = await runtime.spawn({ agent: "explore", prompt: "one" });
    const second = await runtime.spawn({ agent: "explore", prompt: "two" });
    const total = await runtime.spawn({ agent: "explore", prompt: "three" });
    const tooDeep = await runtime.spawn({ agent: "explore", prompt: "nested", parent: { mode: "orchestrate", authority: "read-only", depth: 1 } });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(total.error?.code).toBe("TOTAL_LIMIT");
    expect(tooDeep.error?.code).toBe("NESTING_LIMIT");
  });

  test("propagates cancellation to the injected executor and normalizes its result", async () => {
    let seenRequest: SubagentExecutionRequest | undefined;
    let seenContext: SubagentExecutionContext | undefined;
    const runtime = new SubagentOrchestrator({
      executor: {
        execute: async (request, context) => {
          seenRequest = request;
          seenContext = context;
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
          return { summary: "never returned" };
        },
      },
    });

    const pending = runtime.spawn({
      id: "cancel-me",
      agent: "explore",
      prompt: "inspect selected files",
      contextRefs: ["src/a.ts"],
    });
    await tick();
    expect(runtime.cancel("cancel-me")).toBe(true);
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("CANCELLED");
    expect(seenRequest?.context.contextRefs).toEqual(["src/a.ts"]);
    expect(seenContext?.signal.aborted).toBe(true);
  });

  test("settles a queued task immediately when its external signal aborts", async () => {
    let release!: () => void;
    const runtime = new SubagentOrchestrator({
      maxConcurrent: 1,
      executor: { execute: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { summary: "done" }; } },
    });
    const first = runtime.spawn({ agent: "explore", prompt: "block the only slot" });
    await tick();
    const controller = new AbortController();
    const queued = runtime.spawn({ agent: "explore", prompt: "cancel while queued", signal: controller.signal });
    await tick();
    controller.abort();

    expect((await queued).status).toBe("cancelled");
    expect(runtime.stats.queued).toBe(0);
    release();
    await first;
  });

  test("reserves explicit write task ids while approval is pending", async () => {
    let approve!: () => void;
    const runtime = new SubagentOrchestrator({
      rootParent: { mode: "implement", authority: "write" },
      approveWriteSpawn: () => new Promise<"allow">((resolve) => { approve = () => resolve("allow"); }),
      executor: { execute: async () => ({ summary: "done" }) },
    });
    const first = runtime.spawn({ id: "same-id", agent: "implementer", prompt: "first", authority: "write" });
    await tick();
    const duplicate = await runtime.spawn({ id: "same-id", agent: "implementer", prompt: "second", authority: "write" });

    expect(duplicate.error?.code).toBe("DUPLICATE_TASK_ID");
    approve();
    expect((await first).status).toBe("completed");
  });

  test("rejects empty allowlists and malformed parent boundaries", async () => {
    const customMode = {
      ...BUILT_IN_MODES.find((mode) => mode.slug === "ask")!,
      slug: "empty-delegator",
      delegationAllowed: true,
      allowedAgents: [],
    };
    const runtime = new SubagentOrchestrator({ executor: { execute: async () => ({ summary: "unexpected" }) }, rootParent: { mode: customMode, authority: "read-only" } });
    expect((await runtime.spawn({ agent: "explore", prompt: "not allowed" })).error?.code).toBe("AGENT_NOT_ALLOWED");
    expect((await runtime.spawn({ agent: "explore", prompt: "bad parent", parent: { authority: "bogus" as never, depth: -1 } })).error?.code).toBe("INVALID_PARENT_AUTHORITY");
    expect(() => new SubagentOrchestrator({ executor: { execute: async () => ({}) }, maxDepth: 3 })).toThrow("between 0 and 2");
  });

  test("returns a summarized normalized result across the context boundary", async () => {
    const runtime = new SubagentOrchestrator({
      executor: {
        run: async () => ({
          message: "Found the issue",
          filesInspected: ["src/a.ts", 42],
          filesChanged: ["src/fix.ts"],
          commandsRun: ["npm test", { command: "git diff", exitCode: 0 }],
          findings: [{ severity: "high", title: "unsafe path" }],
          artifacts: ["report.md"],
          followups: ["Review the fix"],
        }),
      },
    });

    const result: SubagentResult = await runtime.spawn({ agent: "review", prompt: "review the change" });

    expect(result).toMatchObject({
      status: "completed",
      taskId: expect.any(String),
      agent: "review",
      summary: "Found the issue",
      filesInspected: ["src/a.ts"],
      filesChanged: ["src/fix.ts"],
      commandsRun: [{ command: "npm test" }, { command: "git diff", exitCode: 0 }],
      artifacts: ["report.md"],
      followups: ["Review the fix"],
    });
    expect(result.findings?.[0].title).toBe("unsafe path");
  });
});
