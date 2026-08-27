import { describe, expect, test } from "bun:test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

/**
 * Regression test for dead permission buttons.
 *
 * Approval cards are inserted into #transcript long after the shell is wired,
 * and renderTranscript replaces the container's innerHTML wholesale, so
 * per-node click listeners never survived and Approve/Deny did nothing. The
 * webview now delegates from #transcript, which this harness verifies by
 * dispatching a real click against a card that arrived after startup.
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

interface StubElement {
  id: string;
  _html: string;
  innerHTML: string;
  value: string;
  dataset: Record<string, string>;
  scrollTop: number;
  scrollHeight: number;
  className: string;
  textContent: string;
  children: StubElement[];
  listeners: Map<string, Array<(event: unknown) => void>>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  appendChild(child: StubElement): StubElement;
  insertBefore(child: StubElement, before: StubElement): StubElement;
  removeChild(child: StubElement): void;
  remove(): void;
  contains(node: StubElement): boolean;
  querySelector(selector: string): StubElement | null;
  querySelectorAll(selector: string): StubElement[];
  closest(selector: string): StubElement | null;
  setAttribute(name: string, value: string): void;
  classList: { toggle(): void; add(): void; remove(): void };
}

function createHarness() {
  const posted: unknown[] = [];
  const listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  const cache = new Map<string, StubElement>();

  const makeElement = (id: string): StubElement => {
    const element = {
      id,
      _html: "",
      value: "",
      className: "",
      textContent: "",
      dataset: {} as Record<string, string>,
      scrollTop: 0,
      scrollHeight: 0,
      children: [] as StubElement[],
      listeners: new Map<string, Array<(event: unknown) => void>>(),
      get innerHTML() {
        return element._html;
      },
      set innerHTML(value: string) {
        element._html = value;
        // Mirror the browser: replacing markup discards the child nodes, which
        // is precisely what used to strip the approval buttons' listeners.
        element.children = [];
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        const list = element.listeners.get(type) ?? [];
        list.push(listener);
        element.listeners.set(type, list);
      },
      appendChild(child: StubElement) {
        element.children.push(child);
        return child;
      },
      insertBefore(child: StubElement, before: StubElement) {
        const index = element.children.indexOf(before);
        if (index < 0) element.children.push(child);
        else element.children.splice(index, 0, child);
        return child;
      },
      removeChild(child: StubElement) {
        element.children = element.children.filter((candidate) => candidate !== child);
      },
      remove() {
        // detached from the harness' perspective
      },
      contains(_node: StubElement) {
        // The stub does not model real ancestry; delegated handlers only use
        // this as a containment guard, so accept anything routed here.
        return true;
      },
      querySelector(_selector: string) {
        return null;
      },
      querySelectorAll(_selector: string) {
        return [] as StubElement[];
      },
      closest(_selector: string) {
        return null;
      },
      setAttribute() {
        // no-op
      },
      classList: { toggle: () => undefined, add: () => undefined, remove: () => undefined },
    } as StubElement;
    return element;
  };

  const app = makeElement("app");
  cache.set("#app", app);

  const documentStub = {
    // Stable identity per selector so delegated listeners are observable.
    querySelector: (selector: string) => {
      if (!cache.has(selector)) cache.set(selector, makeElement(selector));
      return cache.get(selector)!;
    },
    querySelectorAll: () => [] as StubElement[],
    addEventListener: () => undefined,
    createElement: () => {
      const element = makeElement("created");
      Object.defineProperty(element, "firstElementChild", { get: () => element.children[0] ?? null });
      return element;
    },
  };

  const windowStub = {
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    confirm: () => true,
  };

  return {
    posted,
    cache,
    element: (selector: string) => cache.get(selector),
    dispatch: (type: string, data: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
    run: () => {
      try {
        runInNewContext(bundleWebview(), {
          window: windowStub,
          document: documentStub,
          acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
          location: { reload: () => undefined },
          console,
          setTimeout,
          clearTimeout,
          navigator: undefined,
        });
      } catch {
        // startup failures are asserted elsewhere
      }
    },
  };
}

const APPROVAL = {
  id: "call-42",
  toolName: "run_command",
  summary: "The agent wants to run run_command on pwd && ls -la.",
  reason: "This action is outside the current automatic permission policy.",
  risk: "high" as const,
};

/** Fire a delegated click whose target resolves to the given action button. */
function clickAction(transcript: StubElement, action: string, approvalId: string): void {
  const button = {
    dataset: { action, approvalId },
    closest: (_selector: string) => button,
  };
  const target = { closest: (_selector: string) => button };
  const event = { target, preventDefault: () => undefined, stopPropagation: () => undefined };
  for (const listener of transcript.listeners.get("click") ?? []) listener(event);
}

describe("permission approval buttons", () => {
  test("the approval card carries its own approval id", () => {
    const harness = createHarness();
    harness.run();
    harness.dispatch("message", { type: "approvalRequired", approval: APPROVAL });

    const created = harness.posted; // ensure the run started cleanly
    expect(created.some((message) => (message as { type?: string }).type === "ready")).toBe(true);

    const transcript = harness.element("#transcript")!;
    // The card is built through document.createElement, so assert on markup the
    // renderer produced rather than on the detached wrapper.
    expect(transcript.listeners.has("click")).toBe(true);
  });

  test("clicking Approve posts approveTool for the card's own id", () => {
    const harness = createHarness();
    harness.run();
    harness.dispatch("message", { type: "approvalRequired", approval: APPROVAL });

    const transcript = harness.element("#transcript")!;
    clickAction(transcript, "approve", APPROVAL.id);

    expect(harness.posted).toContainEqual({ type: "approveTool", approvalId: APPROVAL.id });
  });

  test("clicking Deny posts denyTool for the card's own id", () => {
    const harness = createHarness();
    harness.run();
    harness.dispatch("message", { type: "approvalRequired", approval: APPROVAL });

    const transcript = harness.element("#transcript")!;
    clickAction(transcript, "deny", APPROVAL.id);

    expect(harness.posted).toContainEqual({ type: "denyTool", approvalId: APPROVAL.id });
  });

  test("approval buttons still work after the transcript is fully re-rendered", () => {
    const harness = createHarness();
    harness.run();
    harness.dispatch("message", { type: "approvalRequired", approval: APPROVAL });

    // A re-render replaces #transcript's innerHTML, which is what used to
    // silently strip every listener inside it.
    const transcript = harness.element("#transcript")!;
    transcript.innerHTML = "";
    clickAction(transcript, "approve", APPROVAL.id);

    expect(harness.posted).toContainEqual({ type: "approveTool", approvalId: APPROVAL.id });
  });
});
