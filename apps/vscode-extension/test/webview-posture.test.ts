import { describe, expect, test } from "bun:test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

/**
 * The posture control is the second axis of the mode model: it must reach the
 * host on click and on Shift+Tab, must skip postures the workspace cannot
 * support, and must never post a change for a posture that is already active.
 */
const sourceRoot = resolve(import.meta.dir, "../src/webview/main.ts");

function bundleWebview(): string {
  return buildSync({
    entryPoints: [sourceRoot],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    write: false,
    logLevel: "silent",
  }).outputFiles[0].text;
}

function createHarness() {
  const posted: unknown[] = [];
  const listeners = new Map<string, Array<(event: any) => void>>();
  const cache = new Map<string, any>();

  const makeElement = (id: string) => {
    const element: any = {
      id,
      _html: "",
      value: "",
      className: "",
      textContent: "",
      dataset: {} as Record<string, string>,
      style: {},
      scrollTop: 0,
      scrollHeight: 0,
      children: [] as any[],
      listeners: new Map<string, Array<(event: any) => void>>(),
      get innerHTML() { return element._html; },
      set innerHTML(value: string) { element._html = value; },
      addEventListener(type: string, listener: (event: any) => void) {
        const list = element.listeners.get(type) ?? [];
        list.push(listener);
        element.listeners.set(type, list);
      },
      appendChild: (child: any) => child,
      insertBefore: (child: any) => child,
      remove: () => undefined,
      contains: () => true,
      querySelector: () => null,
      querySelectorAll: () => [] as any[],
      closest: () => null,
      setAttribute: () => undefined,
      hasAttribute: () => false,
      classList: { toggle: () => undefined, add: () => undefined, remove: () => undefined },
    };
    return element;
  };

  const app = makeElement("app");
  cache.set("#app", app);

  const documentStub = {
    querySelector: (selector: string) => {
      if (!cache.has(selector)) cache.set(selector, makeElement(selector));
      return cache.get(selector);
    },
    querySelectorAll: () => [] as any[],
    addEventListener: (type: string, listener: (event: any) => void) => {
      const list = listeners.get(`doc:${type}`) ?? [];
      list.push(listener);
      listeners.set(`doc:${type}`, list);
    },
    createElement: () => makeElement("created"),
  };

  const windowStub = {
    innerHeight: 900,
    addEventListener: (type: string, listener: (event: any) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    confirm: () => true,
  };

  return {
    posted,
    element: (selector: string) => cache.get(selector),
    dispatch: (type: string, data: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
    keydown: (event: Record<string, unknown>) => {
      const full = { preventDefault: () => undefined, stopPropagation: () => undefined, ...event };
      for (const listener of listeners.get("doc:keydown") ?? []) listener(full);
      for (const listener of listeners.get("keydown") ?? []) listener(full);
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
        // startup failures are asserted in the mount suite
      }
    },
  };
}

const POSTURES = [
  { id: "manual", label: "Manual", description: "Ask before every edit.", risk: "none", available: true },
  { id: "auto-edit", label: "Edit automatically", description: "Apply edits.", risk: "low", available: true },
  { id: "plan", label: "Plan", description: "Plan artifacts only.", risk: "none", available: true },
  { id: "auto", label: "Auto", description: "Approve safe actions.", risk: "elevated", available: false, unavailableReason: "Workspace is not trusted." },
];

function initialize(harness: ReturnType<typeof createHarness>, posture = "manual") {
  harness.dispatch("message", {
    type: "initialize",
    sessionId: "s1",
    mode: "ask",
    modeOptions: [{ id: "ask", label: "Ask", description: "Understand" }],
    modelId: "m",
    modelPolicy: { policy: "user-selectable" },
    models: [{ id: "m", label: "M", hint: "" }],
    skills: [],
    selectedSkillIds: [],
    mandatorySkillIds: [],
    messages: [],
    tools: [],
    subagents: [],
    posture,
    postures: POSTURES,
  });
}

/** Fire a delegated click on the control strip resolving to a posture option. */
function clickPostureOption(harness: ReturnType<typeof createHarness>, id: string) {
  const menu = harness.element("#posture-menu-container");
  const option = { dataset: { posture: id }, hasAttribute: () => false, closest: () => option };
  const target = { closest: () => option };
  const event = { target, preventDefault: () => undefined, stopPropagation: () => undefined };
  for (const listener of menu.listeners.get("click") ?? []) listener(event);
}

describe("permission posture control", () => {
  test("renders the posture pill in the control strip", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness);
    expect(harness.element("#app").innerHTML).toContain('id="posture-btn"');
    expect(harness.element("#app").innerHTML).toContain("Manual");
  });

  test("selecting a posture posts changePosture", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness);
    clickPostureOption(harness, "auto-edit");
    expect(harness.posted).toContainEqual({ type: "changePosture", posture: "auto-edit" });
  });

  test("selecting the active posture posts nothing", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness);
    const before = harness.posted.length;
    clickPostureOption(harness, "manual");
    expect(harness.posted.length).toBe(before);
  });

  test("Shift+Tab cycles to the next available posture", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness);
    harness.keydown({ key: "Tab", shiftKey: true });
    expect(harness.posted).toContainEqual({ type: "changePosture", posture: "auto-edit" });
  });

  test("Shift+Tab skips postures the workspace cannot support", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness, "plan");
    harness.keydown({ key: "Tab", shiftKey: true });
    // Auto is unavailable here, so the cycle wraps past it back to Manual.
    expect(harness.posted).toContainEqual({ type: "changePosture", posture: "manual" });
    expect(harness.posted).not.toContainEqual({ type: "changePosture", posture: "auto" });
  });

  test("plain Tab and modified Tab are left alone", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness);
    const before = harness.posted.length;
    harness.keydown({ key: "Tab", shiftKey: false });
    harness.keydown({ key: "Tab", shiftKey: true, metaKey: true });
    harness.keydown({ key: "Tab", shiftKey: true, ctrlKey: true });
    expect(harness.posted.length).toBe(before);
  });

  test("a postureChanged message updates the pill", () => {
    const harness = createHarness();
    harness.run();
    initialize(harness);
    harness.dispatch("message", { type: "postureChanged", posture: "auto-edit", postures: POSTURES });
    const label = harness.element("#posture-label");
    expect(label.textContent).toBe("Edit automatically");
  });
});
