import { describe, expect, test } from "bun:test";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

/**
 * Regression test for the blank-panel defect: the webview shell loads
 * dist/webview/main.js with a classic <script src> tag, so the bundle must not
 * contain top-level module syntax. We bundle the real entry point the same way
 * the release script does and execute it against a minimal DOM stub to prove
 * the chat surface renders, posts ready, and renders a visible failure surface
 * when startup throws.
 */
const sourceRoot = resolve(import.meta.dir, "../src/webview/main.ts");

function bundleWebview(): string {
  const result = buildSync({
    entryPoints: [sourceRoot],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

interface MessageListener {
  (event: { data: unknown }): void;
}

/** Minimal DOM stub sufficient for webview main.ts startup and rendering. */
function createHarness(options: { throwOnFirstRender?: boolean } = {}) {
  const posted: unknown[] = [];
  const listeners = new Map<string, MessageListener[]>();

  const makeElement = (id: string) => {
    const element = {
      id,
      _html: "",
      value: "",
      dataset: {} as Record<string, string>,
      scrollTop: 0,
      scrollHeight: 0,
      addEventListener: () => undefined,
      get innerHTML() {
        return element._html;
      },
      set innerHTML(value: string) {
        if (options.throwOnFirstRender && id === "app" && element._html === "" && value.includes("shell")) {
          throw new Error("simulated render crash");
        }
        element._html = value;
      },
    };
    return element;
  };

  const app = makeElement("app");

  const documentStub = {
    querySelector: (selector: string) => {
      if (selector === "#app") return app;
      const element = makeElement(selector);
      if (selector === "#transcript") {
        Object.defineProperty(element, "innerHTML", {
          get: () => element._html,
          set: (value: string) => {
            element._html = value;
            if (app._html.includes('id="transcript"')) {
              app._html = app._html.replace(/(<section[^>]*id="transcript"[^>]*>)([\s\S]*?)(<\/section>)/, `$1${value}$3`);
            }
          },
        });
      }
      return element;
    },
    querySelectorAll: () => [] as never[],
  };

  const windowStub = {
    addEventListener: (type: string, listener: MessageListener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    confirm: () => true,
  };

  const acquireVsCodeApi = () => ({ postMessage: (message: unknown) => posted.push(message) });
  const locationStub = { reload: () => undefined };

  return {
    posted,
    app,
    listeners,
    dispatch: (type: string, data: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
    run: () => {
      // main.ts re-throws after rendering the startup-failure surface so the
      // original error still reaches the browser console; tolerate that here.
      try {
        runInNewContext(bundleWebview(), {
          window: windowStub,
          document: documentStub,
          acquireVsCodeApi,
          location: locationStub,
          console,
        });
      } catch {
        // startup failure surfaces are asserted through app.innerHTML
      }
    },
  };
}

describe("webview mount (blank-panel regression)", () => {
  test("bundle is a classic script without top-level module syntax", () => {
    const code = bundleWebview();
    expect(/^\s*(import|export)\s/m.test(code)).toBe(false);
    expect(code).toContain("acquireVsCodeApi");
    expect(code).toContain("startup-");
  });

  test("renders the chat shell and posts ready without throwing", () => {
    const harness = createHarness();
    harness.run();

    expect(harness.posted.some((message) => (message as { type?: string }).type === "ready")).toBe(true);
    expect(harness.app.innerHTML).toContain('class="shell"');
    expect(harness.app.innerHTML).toContain("brand-mark");
    expect(harness.app.innerHTML).toContain("mode-select");
    expect(harness.app.innerHTML).toContain("composer");
    expect(harness.app.innerHTML).toContain("Make a <span class=\"highlight-blue\">sharp</span> start.");
  });

  test("renders a visible startup-failure surface with a correlation id when render throws", () => {
    const harness = createHarness({ throwOnFirstRender: true });
    harness.run();

    expect(harness.app.innerHTML).toContain("startup-failure");
    expect(harness.app.innerHTML).toContain("The chat surface could not start");
    expect(harness.app.innerHTML).toContain("Correlation id:");
    expect(harness.app.innerHTML).toContain("simulated render crash");
  });

  test("renders streamed messages after initialize", () => {
    const harness = createHarness();
    harness.run();

    harness.dispatch("message", {
      type: "initialize",
      sessionId: "session-test",
      mode: "ask",
      modeOptions: [{ id: "ask", label: "Ask", description: "Understand and explain" }],
      modelId: "model-x",
      modelPolicy: { policy: "user-selectable" },
      models: [{ id: "model-x", label: "Model X", hint: "test" }],
      skills: [{ id: "review", name: "Review", description: "Review changes", scope: "installed", sourceKind: "installed" }],
      selectedSkillIds: ["review"],
      mandatorySkillIds: [],
      messages: [{ id: "m1", role: "assistant", text: "Hello from the harness", createdAt: Date.now() }],
      tools: [],
      subagents: [],
      plan: undefined,
      workspaceName: "test",
    });

    expect(harness.app.innerHTML).toContain("Hello from the harness");
    expect(harness.app.innerHTML).toContain("AGENT");
    expect(harness.app.innerHTML).toContain("skill-chip");
    expect(harness.app.innerHTML).toContain("Review");
  });

  test("renders nested subagents with safe route details", () => {
    const harness = createHarness();
    harness.run();
    const common = {
      type: "initialize",
      sessionId: "session-tree",
      mode: "orchestrate",
      modeOptions: [{ id: "orchestrate", label: "Orchestrate", description: "Delegate" }],
      modelId: "parent-model",
      modelPolicy: { policy: "user-selectable" },
      models: [{ id: "parent-model", label: "Parent", hint: "test" }],
      skills: [], selectedSkillIds: [], mandatorySkillIds: [], messages: [], tools: [], plan: undefined,
      workspaceName: "test",
    } as const;
    harness.dispatch("message", {
      ...common,
      subagents: [
        { id: "root-child", agent: "research-specialist", task: "Research", state: "running", depth: 1, providerId: "vibeproxy", modelId: "research-model" },
        { id: "nested-child", parentRunId: "root-child", agent: "review", task: "Review", state: "queued", depth: 2, providerId: "freebuff2api", modelId: "review-model" },
      ],
    });
    expect(harness.app.innerHTML).toContain("subagent-children");
    expect(harness.app.innerHTML).toContain("vibeproxy / research-model");
    expect(harness.app.innerHTML).toContain("freebuff2api / review-model");
  });
});
