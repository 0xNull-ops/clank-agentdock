import type {
  AgentMode,
  ChatMessage,
  ContextRef,
  ExtensionToUiMessage,
  ToolActivity,
  ToolApproval,
  CheckpointSummaryCard,
  UiToExtensionMessage,
  ModelOption,
  ModelPolicyView,
  ModeOption,
  PlanView,
  SessionHistoryItem,
  SubagentActivity,
  HarnessSettingsState,
  ProviderProfileView,
  ModeDetailView,
  CustomModeDiagnosticView,
} from "../shared/protocol";
import { BUILT_IN_MODES } from "../shared/protocol";

declare function acquireVsCodeApi(): { postMessage(message: UiToExtensionMessage): void };

const vscode = acquireVsCodeApi();
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Agent Harness root element not found");
const appRoot = root;

/**
 * Visible startup-failure surface. If anything throws before the first render
 * (or a future bundle regression reintroduces module syntax), the panel must
 * show a readable error with a correlation id instead of a silent blank view.
 */
const startupCorrelationId = `startup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let startupSucceeded = false;

function renderStartupFailure(message: string, detail?: unknown): void {
  if (startupSucceeded) return;
  startupSucceeded = true;
  console.error("Agent Harness webview startup failed", startupCorrelationId, detail ?? "");
  appRoot.innerHTML = `
    <section class="startup-failure" role="alert">
      <div class="startup-failure-icon">!</div>
      <p class="kicker">AGENT HARNESS</p>
      <h2>The chat surface could not start.</h2>
      <p>${escapeHtml(message)}</p>
      <small>Correlation id: ${escapeHtml(startupCorrelationId)}</small>
      <button type="button" class="quiet-button" data-action="reload-webview">Reload panel</button>
    </section>`;
  document.querySelector<HTMLButtonElement>("[data-action=reload-webview]")?.addEventListener("click", () => location.reload());
}

window.addEventListener("error", (event) => {
  if (startupSucceeded) return;
  const message = event.message || "Unknown script error";
  renderStartupFailure(message, event.error ?? event);
});
window.addEventListener("unhandledrejection", (event) => {
  if (startupSucceeded) return;
  renderStartupFailure("An unhandled promise rejection stopped the chat surface.", event.reason);
});

let currentView: "chat" | "settings" = "chat";
let settingsTab: "modes" | "providers" | "general" = "modes";
let settingsQuery = "";
let settingsState: HarnessSettingsState | undefined;
const providerTestResults: Record<string, { success: boolean; message: string; loading?: boolean }> = {};

type TimelineItem =
  | { kind: "user_message"; id: string; text: string; createdAt: number }
  | { kind: "assistant_message"; id: string; text: string; createdAt: number; isStreaming?: boolean }
  | { kind: "system_message"; id: string; text: string; createdAt: number }
  | { kind: "tool"; id: string; tool: ToolActivity }
  | { kind: "subagent"; id: string; subagent: SubagentActivity }
  | { kind: "plan"; id: string; plan: PlanView }
  | { kind: "checkpoint"; id: string; checkpoint: CheckpointSummaryCard }
  | { kind: "approval"; id: string; approval: ToolApproval };

let timeline: TimelineItem[] = [];
let modes: ModeOption[] = [...BUILT_IN_MODES];
let models: ModelOption[] = [
  { id: "openai-compatible", label: "Configure model…", hint: "OpenAI-compatible endpoint" }
];
let sessions: SessionHistoryItem[] = [];
let activeSessionId = "";
let historyOpen = false;
let historyBusy = false;
let historyQuery = "";

let activeMode: AgentMode = "ask";
let activeModel = "openai-compatible";
let modelPolicy: ModelPolicyView = { policy: "user-selectable" };
let runState: "idle" | "running" | "awaiting_approval" | "complete" | "cancelled" | "error" = "idle";
let contextRefs: ContextRef[] = [];
let approval: ToolApproval | undefined;
let plan: PlanView | undefined;
let checkpoints: CheckpointSummaryCard[] = [];
let checkpointConflict: { checkpointId: string; paths: string[]; message: string } | undefined;

try {
  render();
  startupSucceeded = true;
} catch (error) {
  renderStartupFailure(error instanceof Error ? error.message : String(error), error);
  throw error;
}

window.addEventListener("message", (event: MessageEvent<ExtensionToUiMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "initialize":
      activeSessionId = message.sessionId;
      activeMode = message.mode;
      modes = message.modeOptions;
      activeModel = message.modelId;
      modelPolicy = message.modelPolicy;
      if (modelPolicy.policy === "fixed" && modelPolicy.modelId) activeModel = modelPolicy.modelId;
      models = message.models;
      plan = message.plan;
      contextRefs = [];
      rebuildTimeline(message.messages, message.tools, message.subagents, message.plan);
      render();
      break;
    case "sessionList":
      sessions = message.sessions;
      activeSessionId = message.activeSessionId;
      historyBusy = false;
      updateSessionPicker();
      break;
    case "sessionOpened":
      activeSessionId = message.session.id;
      activeMode = message.session.activeMode;
      modes = message.modeOptions;
      activeModel = message.session.modelId;
      modelPolicy = message.modelPolicy;
      if (modelPolicy.policy === "fixed" && modelPolicy.modelId) activeModel = modelPolicy.modelId;
      plan = message.plan;
      checkpoints = [];
      checkpointConflict = undefined;
      approval = undefined;
      historyBusy = false;
      historyOpen = false;
      runState = "idle";
      contextRefs = [];
      rebuildTimeline(message.messages, message.tools, message.subagents, message.plan);
      render();
      break;
    case "contextAdded":
      contextRefs = [...contextRefs.filter((ref) => ref.id !== message.ref.id), message.ref];
      updateContextChips();
      break;
    case "modeChanged":
      activeMode = message.mode;
      updateControlStrip();
      break;
    case "modesChanged":
      modes = message.modes;
      updateControlStrip();
      break;
    case "modelChanged":
      activeModel = message.modelId;
      updateControlStrip();
      break;
    case "modelPolicyChanged":
      modelPolicy = message.modelPolicy;
      if (modelPolicy.policy === "fixed" && modelPolicy.modelId) activeModel = modelPolicy.modelId;
      updateControlStrip();
      break;
    case "modelsChanged":
      models = message.models;
      updateControlStrip();
      break;
    case "runState":
      runState = message.state;
      if (message.state !== "awaiting_approval") approval = undefined;
      updateRunStateUi();
      break;
    case "assistantMessage":
      onAssistantMessage(message.message);
      break;
    case "toolCall":
      onToolCall(message.tool);
      break;
    case "subagentUpdate":
      onSubagentUpdate(message.subagent);
      break;
    case "approvalRequired":
      approval = message.approval;
      runState = "awaiting_approval";
      onApprovalRequired(message.approval);
      break;
    case "planChanged":
      plan = message.plan;
      onPlanChanged(message.plan);
      break;
    case "checkpointSummary":
      checkpoints = [...checkpoints.filter((c) => c.id !== message.checkpoint.id), message.checkpoint];
      checkpointConflict = undefined;
      onCheckpointSummary(message.checkpoint);
      break;
    case "checkpointReverted":
      checkpoints = checkpoints.filter((c) => c.id !== message.checkpointId);
      checkpointConflict = undefined;
      appendSystemMessage(`Reverted ${message.summary.filesChanged} file${message.summary.filesChanged === 1 ? "" : "s"} from the agent checkpoint.`);
      break;
    case "checkpointRevertConflict":
      checkpointConflict = message;
      appendSystemMessage(`${message.message} Affected paths: ${message.paths.slice(0, 5).join(", ")}${message.paths.length > 5 ? "…" : ""}`);
      break;
    case "settingsState":
      settingsState = message.state;
      if (currentView === "settings") renderSettings();
      break;
    case "providerTestResult":
      providerTestResults[message.profileId] = {
        success: message.success,
        message: message.message,
        loading: false,
      };
      if (currentView === "settings") renderSettings();
      break;
    case "error":
      historyBusy = false;
      appendSystemMessage(message.message);
      runState = "error";
      updateRunStateUi();
      break;
    case "usageUpdated":
      break;
    case "textDelta":
      appendStreamingText(message.text);
      break;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && currentView === "settings") {
    currentView = "chat";
    render();
  }
});

function rebuildTimeline(restoredMessages: ChatMessage[], restoredTools: ToolActivity[], restoredSubagents: SubagentActivity[], restoredPlan?: PlanView): void {
  timeline = [];
  for (const msg of restoredMessages) {
    if (msg.role === "user") {
      timeline.push({ kind: "user_message", id: msg.id, text: msg.text, createdAt: msg.createdAt });
    } else if (msg.role === "assistant") {
      timeline.push({ kind: "assistant_message", id: msg.id, text: msg.text, createdAt: msg.createdAt });
    } else {
      timeline.push({ kind: "system_message", id: msg.id, text: msg.text, createdAt: msg.createdAt });
    }
  }
  for (const tool of restoredTools) {
    timeline.push({ kind: "tool", id: tool.id, tool });
  }
  for (const sub of restoredSubagents) {
    timeline.push({ kind: "subagent", id: sub.id, subagent: sub });
  }
  if (restoredPlan) {
    timeline.push({ kind: "plan", id: restoredPlan.id, plan: restoredPlan });
  }
}

function render(): void {
  if (currentView === "settings") {
    renderSettings();
    wireSettingsInteractions();
    return;
  }
  renderChat();
  wireChatInteractions();
}

function renderChat(): void {
  const mode = modes.find((item) => item.id === activeMode) ?? modes[0];
  const visibleModels = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
  
  const workingIndicatorHtml = runState === "running"
    ? `<div class="agent-working-indicator" id="agent-working-indicator"><span class="working-spinner">✦</span><span class="working-text">Agent is working…</span></div>`
    : runState === "awaiting_approval"
      ? `<div class="agent-working-indicator waiting" id="agent-working-indicator"><span class="working-spinner">!</span><span class="working-text">Waiting for approval…</span></div>`
      : "";

  const transcriptContent = timeline.length === 0
    ? emptyState(mode.label)
    : timeline.map(renderTimelineItem).join("") + workingIndicatorHtml;

  appRoot.innerHTML = `
    <section class="shell" id="chat-shell">
      <header class="header">
        <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><div><p class="eyebrow">FORGE / LOCAL HARNESS</p><h1>Agent chat</h1></div></div>
        <div class="header-actions">
          <button class="session-picker ${historyOpen ? "open" : ""}" data-action="history" aria-label="Open recent sessions" aria-haspopup="menu" aria-expanded="${historyOpen}"><span class="session-picker-icon">◷</span><span class="session-picker-label" id="session-picker-label">${escapeHtml(activeSessionTitle())}</span><span class="session-picker-chevron">⌄</span></button>
          <button class="icon-button" data-action="open-settings" aria-label="Open Agent Harness settings" title="Extension Settings">⚙</button>
        </div>
      </header>
      <div id="session-menu-container">${historyOpen ? sessionMenu() : ""}</div>
      <div class="control-strip" id="control-strip">
        <label class="select-wrap mode-select" id="mode-select-wrap" title="${escapeHtml(`${mode.description} · ${mode.source ?? "unavailable"}`)}"><span class="mode-dot mode-${safeCssToken(mode.id)}"></span><span class="sr-only">Mode</span><select id="mode-select">${modes.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeMode ? "selected" : ""}>${escapeHtml(`${item.label} · ${item.source ?? "unavailable"}`)}</option>`).join("")}</select><span class="chevron">⌄</span></label>
        <label class="select-wrap model-select ${modelPolicy.policy}" id="model-select-wrap" title="${escapeHtml(modelPolicy.reason ?? `${modelPolicy.policy} model policy`)}"><span class="model-glyph">${modelPolicy.policy === "fixed" ? "▣" : modelPolicy.policy === "preferred" ? "◇" : "◈"}</span><span class="sr-only">Model</span><select id="model-select" ${modelPolicy.policy === "fixed" ? "disabled" : ""}>${visibleModels.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeModel ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select><span class="chevron">${modelPolicy.policy === "fixed" ? "fixed" : "⌄"}</span></label>
      </div>
      <div class="rule"></div>
      <section class="transcript" id="transcript" aria-live="polite">${transcriptContent}</section>
      <footer class="composer-wrap">
        <div class="context-chips" id="context-chips">${contextRefs.map(contextChip).join("")}</div>
        <form class="composer" id="composer-form">
          <textarea id="composer-input" rows="3" placeholder="Ask ${mode.label.toLowerCase()} anything…" aria-label="Message Agent Harness"></textarea>
          <div class="composer-actions" id="composer-actions">
            <button type="button" class="quiet-button" data-action="attach" aria-label="Attach context">＋ context</button>
            <span class="composer-hint">⌘ ↵ to send</span>
            ${runState === "running" || runState === "awaiting_approval" ? `<button type="button" class="quiet-button cancel-button" data-action="cancel" aria-label="Cancel run">cancel</button>` : `<button type="submit" class="send-button" aria-label="Send message">↑</button>`}
          </div>
        </form>
        <div class="composer-meta"><span><span class="live-dot"></span> local session</span><button type="button" class="text-button" data-action="new">new session</button></div>
      </footer>
    </section>`;

  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function updateControlStrip(): void {
  const mode = modes.find((item) => item.id === activeMode) ?? modes[0];
  const modeSelect = document.querySelector<HTMLSelectElement>("#mode-select");
  if (modeSelect) {
    modeSelect.innerHTML = modes.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeMode ? "selected" : ""}>${escapeHtml(`${item.label} · ${item.source ?? "unavailable"}`)}</option>`).join("");
    const wrap = document.querySelector<HTMLElement>("#mode-select-wrap");
    if (wrap) {
      wrap.title = `${mode.description} · ${mode.source ?? "unavailable"}`;
      const dot = wrap.querySelector(".mode-dot");
      if (dot) dot.className = `mode-dot mode-${safeCssToken(mode.id)}`;
    }
  }

  const visibleModels = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
  const modelSelect = document.querySelector<HTMLSelectElement>("#model-select");
  if (modelSelect) {
    modelSelect.disabled = modelPolicy.policy === "fixed";
    modelSelect.innerHTML = visibleModels.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeModel ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
    const wrap = document.querySelector<HTMLElement>("#model-select-wrap");
    if (wrap) {
      wrap.className = `select-wrap model-select ${modelPolicy.policy}`;
      wrap.title = modelPolicy.reason ?? `${modelPolicy.policy} model policy`;
      const glyph = wrap.querySelector(".model-glyph");
      if (glyph) glyph.textContent = modelPolicy.policy === "fixed" ? "▣" : modelPolicy.policy === "preferred" ? "◇" : "◈";
      const chevron = wrap.querySelector(".chevron");
      if (chevron) chevron.textContent = modelPolicy.policy === "fixed" ? "fixed" : "⌄";
    }
  }

  const composerInput = document.querySelector<HTMLTextAreaElement>("#composer-input");
  if (composerInput && !composerInput.value) {
    composerInput.placeholder = `Ask ${mode.label.toLowerCase()} anything…`;
  }
}

function updateSessionPicker(): void {
  const label = document.querySelector<HTMLElement>("#session-picker-label");
  if (label) label.textContent = activeSessionTitle();
  const menuContainer = document.querySelector<HTMLElement>("#session-menu-container");
  if (menuContainer) menuContainer.innerHTML = historyOpen ? sessionMenu() : "";
}

function updateContextChips(): void {
  const container = document.querySelector<HTMLElement>("#context-chips");
  if (container) container.innerHTML = contextRefs.map(contextChip).join("");
}

function updateRunStateUi(): void {
  const actions = document.querySelector<HTMLElement>("#composer-actions");
  if (actions) {
    actions.innerHTML = `
      <button type="button" class="quiet-button" data-action="attach" aria-label="Attach context">＋ context</button>
      <span class="composer-hint">⌘ ↵ to send</span>
      ${runState === "running" || runState === "awaiting_approval" ? `<button type="button" class="quiet-button cancel-button" data-action="cancel" aria-label="Cancel run">cancel</button>` : `<button type="submit" class="send-button" aria-label="Send message">↑</button>`}
    `;
    actions.querySelector("[data-action=cancel]")?.addEventListener("click", () => vscode.postMessage({ type: "cancelRun" }));
    actions.querySelector("[data-action=attach]")?.addEventListener("click", () => vscode.postMessage({ type: "pickContext" }));
  }

  const transcript = document.querySelector<HTMLElement>("#transcript");
  let workingEl = document.querySelector<HTMLElement>("#agent-working-indicator");

  if (runState === "running") {
    if (!workingEl && transcript) {
      workingEl = document.createElement("div");
      workingEl.className = "agent-working-indicator";
      workingEl.id = "agent-working-indicator";
      workingEl.innerHTML = `<span class="working-spinner">✦</span><span class="working-text">Agent is working…</span>`;
      transcript.appendChild(workingEl);
      scrollToBottom();
    } else if (workingEl) {
      workingEl.className = "agent-working-indicator";
      workingEl.innerHTML = `<span class="working-spinner">✦</span><span class="working-text">Agent is working…</span>`;
    }
  } else if (runState === "awaiting_approval") {
    if (!workingEl && transcript) {
      workingEl = document.createElement("div");
      workingEl.className = "agent-working-indicator waiting";
      workingEl.id = "agent-working-indicator";
      workingEl.innerHTML = `<span class="working-spinner">!</span><span class="working-text">Waiting for approval…</span>`;
      transcript.appendChild(workingEl);
      scrollToBottom();
    } else if (workingEl) {
      workingEl.className = "agent-working-indicator waiting";
      workingEl.innerHTML = `<span class="working-spinner">!</span><span class="working-text">Waiting for approval…</span>`;
    }
  } else {
    if (workingEl) workingEl.remove();
    // Finalize any streaming messages
    for (const item of timeline) {
      if (item.kind === "assistant_message" && item.isStreaming) {
        item.isStreaming = false;
        const msgEl = document.querySelector<HTMLElement>(`#msg-${item.id} .message-body`);
        if (msgEl) msgEl.innerHTML = formatMarkdown(item.text);
      }
    }
  }
}

function renderTranscript(): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const mode = modes.find((item) => item.id === activeMode) ?? modes[0];
  if (timeline.length === 0) {
    transcript.innerHTML = emptyState(mode.label);
    transcript.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
      const input = document.querySelector<HTMLTextAreaElement>("#composer-input");
      if (input) { input.value = button.dataset.prompt ?? ""; input.focus(); }
    }));
    return;
  }

  const workingIndicatorHtml = runState === "running"
    ? `<div class="agent-working-indicator" id="agent-working-indicator"><span class="working-spinner">✦</span><span class="working-text">Agent is working…</span></div>`
    : runState === "awaiting_approval"
      ? `<div class="agent-working-indicator waiting" id="agent-working-indicator"><span class="working-spinner">!</span><span class="working-text">Waiting for approval…</span></div>`
      : "";

  transcript.innerHTML = timeline.map(renderTimelineItem).join("") + workingIndicatorHtml;
  scrollToBottom();
}

function renderTimelineItem(item: TimelineItem): string {
  switch (item.kind) {
    case "user_message":
      return `<article class="message user" id="msg-${item.id}"><div class="message-label">YOU</div><div class="message-body">${formatMarkdown(item.text)}</div></article>`;
    case "assistant_message":
      return `<article class="message assistant" id="msg-${item.id}"><div class="message-label">AGENT</div><div class="message-body">${formatMarkdown(item.text)}${item.isStreaming ? '<span class="streaming-cursor"></span>' : ''}</div></article>`;
    case "system_message":
      return `<article class="message system" id="msg-${item.id}"><div class="message-label">SYSTEM</div><div class="message-body">${formatMarkdown(item.text)}</div></article>`;
    case "tool":
      return toolCard(item.tool);
    case "subagent":
      return subagentCard(item.subagent);
    case "plan":
      return planCard(item.plan);
    case "checkpoint":
      return checkpointCard(item.checkpoint);
    case "approval":
      return approvalCard(item.approval);
  }
}

function appendStreamingText(text: string): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) {
    render();
    return;
  }

  // Remove empty state if present
  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();

  const lastItem = timeline[timeline.length - 1];
  if (lastItem && lastItem.kind === "assistant_message" && lastItem.isStreaming) {
    lastItem.text += text;
    const bodyEl = document.querySelector<HTMLElement>(`#msg-${lastItem.id} .message-body`);
    if (bodyEl) {
      bodyEl.innerHTML = formatMarkdown(lastItem.text) + '<span class="streaming-cursor"></span>';
      scrollToBottom();
      return;
    }
  }

  // Finalize preceding assistant message if any
  if (lastItem && lastItem.kind === "assistant_message" && lastItem.isStreaming) {
    lastItem.isStreaming = false;
  }

  const id = `assistant-${Date.now()}`;
  const newItem: TimelineItem = { kind: "assistant_message", id, text, createdAt: Date.now(), isStreaming: true };
  timeline.push(newItem);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderTimelineItem(newItem);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function onToolCall(tool: ToolActivity): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();

  const existing = timeline.find((item) => item.kind === "tool" && item.id === tool.id);
  if (existing && existing.kind === "tool") {
    existing.tool = tool;
    const existingEl = document.querySelector<HTMLElement>(`#tool-${safeCssToken(tool.id)}`);
    if (existingEl) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = toolCard(tool);
      if (wrapper.firstElementChild) {
        existingEl.replaceWith(wrapper.firstElementChild);
      }
      return;
    }
  }

  // Finalize any in-flight streaming text before this tool
  const lastItem = timeline[timeline.length - 1];
  if (lastItem && lastItem.kind === "assistant_message" && lastItem.isStreaming) {
    lastItem.isStreaming = false;
    const bodyEl = document.querySelector<HTMLElement>(`#msg-${lastItem.id} .message-body`);
    if (bodyEl) bodyEl.innerHTML = formatMarkdown(lastItem.text);
  }

  const newItem: TimelineItem = { kind: "tool", id: tool.id, tool };
  timeline.push(newItem);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = toolCard(tool);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function onAssistantMessage(msg: ChatMessage): void {
  const lastItem = timeline[timeline.length - 1];
  if (lastItem && lastItem.kind === "assistant_message" && lastItem.isStreaming) {
    lastItem.isStreaming = false;
    lastItem.text = msg.text;
    const bodyEl = document.querySelector<HTMLElement>(`#msg-${lastItem.id} .message-body`);
    if (bodyEl) bodyEl.innerHTML = formatMarkdown(lastItem.text);
    return;
  }

  const newItem: TimelineItem = { kind: "assistant_message", id: msg.id, text: msg.text, createdAt: msg.createdAt };
  timeline.push(newItem);

  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderTimelineItem(newItem);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function onSubagentUpdate(subagent: SubagentActivity): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const existing = timeline.find((item) => item.kind === "subagent" && item.id === subagent.id);
  if (existing && existing.kind === "subagent") {
    existing.subagent = subagent;
    const existingEl = document.querySelector<HTMLElement>(`#subagent-${safeCssToken(subagent.id)}`);
    if (existingEl) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = subagentCard(subagent);
      if (wrapper.firstElementChild) existingEl.replaceWith(wrapper.firstElementChild);
      return;
    }
  }

  const newItem: TimelineItem = { kind: "subagent", id: subagent.id, subagent };
  timeline.push(newItem);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = subagentCard(subagent);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function onPlanChanged(newPlan?: PlanView): void {
  if (!newPlan) return;
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const existing = timeline.find((item) => item.kind === "plan" && item.id === newPlan.id);
  if (existing && existing.kind === "plan") {
    existing.plan = newPlan;
    const existingEl = document.querySelector<HTMLElement>(`#plan-${safeCssToken(newPlan.id)}`);
    if (existingEl) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = planCard(newPlan);
      if (wrapper.firstElementChild) existingEl.replaceWith(wrapper.firstElementChild);
      return;
    }
  }

  const newItem: TimelineItem = { kind: "plan", id: newPlan.id, plan: newPlan };
  timeline.push(newItem);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = planCard(newPlan);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function onCheckpointSummary(cp: CheckpointSummaryCard): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const newItem: TimelineItem = { kind: "checkpoint", id: cp.id, checkpoint: cp };
  timeline.push(newItem);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = checkpointCard(cp);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function onApprovalRequired(app: ToolApproval): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const newItem: TimelineItem = { kind: "approval", id: app.id, approval: app };
  timeline.push(newItem);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = approvalCard(app);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function appendSystemMessage(text: string): void {
  const id = `sys-${Date.now()}`;
  const newItem: TimelineItem = { kind: "system_message", id, text, createdAt: Date.now() };
  timeline.push(newItem);

  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (!transcript) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderTimelineItem(newItem);
  const cardNode = wrapper.firstElementChild;
  if (cardNode) {
    const workingEl = document.querySelector("#agent-working-indicator");
    if (workingEl) {
      transcript.insertBefore(cardNode, workingEl);
    } else {
      transcript.appendChild(cardNode);
    }
  }
  scrollToBottom();
}

function scrollToBottom(): void {
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (transcript) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function formatMarkdown(text: string): string {
  if (!text) return "";

  // 1. Preserve code blocks
  const codeBlocks: string[] = [];
  let processed = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    const escapedCode = escapeHtml(code.trimEnd());
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    codeBlocks.push(`<div class="code-block-wrap">${langLabel}<pre><code>${escapedCode}</code></pre></div>`);
    return placeholder;
  });

  // 2. Escape HTML
  processed = escapeHtml(processed);

  // 3. Inline code
  processed = processed.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);

  // 4. Bold & Italics
  processed = processed.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  processed = processed.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  processed = processed.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  processed = processed.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  processed = processed.replace(/_([^_]+)_/g, "<em>$1</em>");

  // 5. Headings
  processed = processed.replace(/^### (.*$)/gim, "<h4>$1</h4>");
  processed = processed.replace(/^## (.*$)/gim, "<h3>$1</h3>");
  processed = processed.replace(/^# (.*$)/gim, "<h2>$1</h2>");

  // 6. Blockquotes
  processed = processed.replace(/^&gt; (.*$)/gim, "<blockquote>$1</blockquote>");

  // 7. Bullet lists
  processed = processed.replace(/^[\*\-\+] (.*$)/gim, "<li>$1</li>");
  processed = processed.replace(/(<li>.*<\/li>)/gms, "<ul>$1</ul>");
  processed = processed.replace(/<\/ul>\s*<ul>/g, "");

  // 8. Paragraphs
  processed = processed.replace(/\n\n+/g, "</p><p>");
  processed = processed.replace(/\n/g, "<br>");
  processed = `<p>${processed}</p>`;

  // 9. Restore code blocks
  codeBlocks.forEach((block, idx) => {
    processed = processed.replace(`<p>__CODE_BLOCK_${idx}__</p>`, block);
    processed = processed.replace(`__CODE_BLOCK_${idx}__`, block);
  });

  // Clean empty paragraphs
  processed = processed.replace(/<p>\s*<\/p>/g, "");
  return processed;
}

function renderSettings(): void {
  const modesCount = settingsState?.modes.length ?? modes.length;
  const profilesCount = settingsState?.profiles.length ?? 1;

  appRoot.innerHTML = `
    <section class="shell settings-shell">
      <header class="header settings-header">
        <div class="settings-nav">
          <button class="settings-back-btn" data-action="back-to-chat" aria-label="Back to chat" title="Back to Chat (Esc)">
            <span class="back-chevron">‹</span>
            <span>Chat</span>
          </button>
          <div class="settings-title-wrap">
            <p class="eyebrow">FORGE / CONFIGURATION</p>
            <h1>Agent Harness settings</h1>
          </div>
        </div>
        <div class="header-actions">
          <button class="icon-button" data-action="back-to-chat" title="Close settings (Esc)">✕</button>
        </div>
      </header>

      <div class="settings-tabs-bar">
        <nav class="settings-tabs" role="tablist">
          <button class="settings-tab ${settingsTab === "modes" ? "active" : ""}" data-tab="modes" role="tab" aria-selected="${settingsTab === "modes"}">
            <span class="tab-glyph">👥</span>
            <span>Agents &amp; Modes</span>
            <span class="settings-count">${modesCount}</span>
          </button>
          <button class="settings-tab ${settingsTab === "providers" ? "active" : ""}" data-tab="providers" role="tab" aria-selected="${settingsTab === "providers"}">
            <span class="tab-glyph">🗄</span>
            <span>Providers</span>
            <span class="settings-count">${profilesCount}</span>
          </button>
          <button class="settings-tab ${settingsTab === "general" ? "active" : ""}" data-tab="general" role="tab" aria-selected="${settingsTab === "general"}">
            <span class="tab-glyph">⚙️</span>
            <span>General</span>
          </button>
        </nav>
      </div>

      <div class="settings-search-wrap">
        <span class="search-icon">🔍</span>
        <input id="settings-search" class="settings-search" type="search" value="${escapeHtml(settingsQuery)}" placeholder="Filter ${settingsTab === "modes" ? "modes, tools, models" : settingsTab === "providers" ? "providers, endpoints, models" : "settings"}…" aria-label="Search settings" />
        ${settingsQuery ? `<button class="clear-search-btn" data-action="clear-search" aria-label="Clear filter">×</button>` : ""}
      </div>

      <main class="settings-body" id="settings-scroll-body">
        ${settingsTab === "modes" ? renderModesTab() : settingsTab === "providers" ? renderProvidersTab() : renderGeneralTab()}
      </main>
    </section>`;
}

let isAddingProvider = false;
let editingProfileId: string | null = null;
let editingApiKeyProfileId: string | null = null;
let isAddingMode = false;

function renderModesTab(): string {
  const allModes: ModeDetailView[] = settingsState?.modes ?? modes.map((m) => ({
    id: m.id,
    slug: m.id,
    name: m.label,
    description: m.description,
    scope: m.source === "global" ? "global" : m.source === "project" ? "project" : "built-in",
    type: "all",
    canManage: m.source !== "built-in",
  }));

  const query = settingsQuery.trim().toLowerCase();
  const filtered = query
    ? allModes.filter((m) =>
        m.name.toLowerCase().includes(query) ||
        m.slug.toLowerCase().includes(query) ||
        (m.description && m.description.toLowerCase().includes(query)) ||
        m.scope.toLowerCase().includes(query) ||
        (m.model && m.model.toLowerCase().includes(query))
      )
    : allModes;

  const diagnostics = settingsState?.diagnostics ?? [];

  return `
    <div class="settings-actions-bar">
      <button class="settings-action-btn primary" data-action="create-mode">＋ New Mode</button>
      <button class="settings-action-btn" data-action="import-mode">⇩ Import Mode</button>
      <button class="settings-action-btn" data-action="reload-modes">↻ Reload Modes</button>
    </div>

    ${isAddingMode ? renderModeForm() : ""}

    ${diagnostics.length ? `
      <div class="settings-diagnostics-card">
        <div class="diag-header">
          <span class="diag-icon">⚠️</span>
          <b>Mode Diagnostics (${diagnostics.length})</b>
        </div>
        <ul class="diag-list">
          ${diagnostics.map((d) => `
            <li>
              <button data-action="open-diagnostic" data-source="${escapeHtml(d.source ?? "")}" data-line="${d.line ?? 1}">
                <span class="diag-sev ${d.severity}">${d.severity}</span>
                <span>${escapeHtml(d.message)}</span>
                <small>${escapeHtml(d.source ?? "")}${d.line ? `:${d.line}` : ""}</small>
              </button>
            </li>
          `).join("")}
        </ul>
      </div>
    ` : ""}

    <div class="modes-grid">
      ${filtered.length ? filtered.map((item) => `
        <article class="settings-card mode-card">
          <div class="card-header">
            <div class="mode-header-info">
              <span class="mode-dot mode-${safeCssToken(item.slug)}"></span>
              <div>
                <h3>${escapeHtml(item.name)} <code class="slug-tag">${escapeHtml(item.slug)}</code></h3>
                <p class="card-desc">${escapeHtml(item.description || "Custom agent prompt and tool instructions")}</p>
              </div>
            </div>
            <span class="scope-badge ${item.scope}">${item.scope}</span>
          </div>

          <div class="card-badges">
            <span class="meta-badge">Target: <b>${item.type}</b></span>
            <span class="meta-badge">Model: <b>${escapeHtml(item.model || (item.modelPolicy ? `${item.modelPolicy}` : "Default"))}</b></span>
            <span class="meta-badge">Steps: <b>${item.steps ?? 20}</b></span>
            ${item.tools?.length ? `<span class="meta-badge">Tools: <b>${escapeHtml(item.tools.join(", "))}</b></span>` : ""}
          </div>

          <div class="card-actions">
            ${item.canManage ? `<button class="card-btn" data-action="edit-mode" data-slug="${escapeHtml(item.slug)}">✎ Open / Edit .md</button>` : ""}
            <button class="card-btn" data-action="duplicate-mode" data-slug="${escapeHtml(item.slug)}">⧉ Duplicate</button>
            ${item.canManage ? `<button class="card-btn danger" data-action="delete-mode" data-slug="${escapeHtml(item.slug)}">🗑 Delete</button>` : ""}
          </div>
        </article>
      `).join("") : `<p class="session-empty">No modes match “${escapeHtml(settingsQuery)}”.</p>`}
    </div>`;
}

function renderModeForm(): string {
  return `
    <form class="settings-form-card" id="mode-form">
      <div class="form-header">
        <h3>New Agent Harness Mode</h3>
        <button type="button" class="close-form-btn" data-action="cancel-mode-form" title="Close">✕</button>
      </div>

      <div class="form-field">
        <label for="mode-name">Mode Name <span class="req">*</span></label>
        <input type="text" id="mode-name" required placeholder="e.g. Security Auditor, Performance Guru" />
      </div>

      <div class="form-field">
        <label for="mode-slug">Slug Identifier <span class="req">*</span></label>
        <input type="text" id="mode-slug" required placeholder="e.g. security-auditor" />
        <small class="field-hint">Unique filename identifier (lowercase letters, numbers, and dashes)</small>
      </div>

      <div class="form-row">
        <div class="form-field">
          <label for="mode-scope">Scope</label>
          <select id="mode-scope" class="setting-select">
            <option value="project">Project (.agent/agents) — workspace shared</option>
            <option value="global">Global (~/.config) — available everywhere</option>
          </select>
        </div>
        <div class="form-field">
          <label for="mode-type">Execution Target</label>
          <select id="mode-type" class="setting-select">
            <option value="all">All (Primary chat + Subagent)</option>
            <option value="primary">Primary only</option>
            <option value="subagent">Subagent only</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-field">
          <label for="mode-authority">Permissions Baseline</label>
          <select id="mode-authority" class="setting-select">
            <option value="write">Coding with Approval (edits, commands, checkpoints)</option>
            <option value="read">Read-Only (inspection, search, diagnostics)</option>
          </select>
        </div>
        <div class="form-field">
          <label for="mode-steps">Max Steps</label>
          <input type="number" id="mode-steps" min="1" max="100" value="20" class="setting-input" />
        </div>
      </div>

      <div class="form-field">
        <label for="mode-model">Model Override (Optional)</label>
        <input type="text" id="mode-model" placeholder="Leave empty for session/provider default" />
      </div>

      <div class="form-field">
        <label for="mode-instructions">Instructions &amp; Role Prompt <span class="req">*</span></label>
        <textarea id="mode-instructions" rows="4" required placeholder="Describe the role, responsibilities, guidelines, and behavioral boundaries for this agent..."></textarea>
      </div>

      <div class="form-actions">
        <button type="button" class="card-btn" data-action="cancel-mode-form">Cancel</button>
        <button type="submit" class="settings-action-btn primary">Create Mode</button>
      </div>
    </form>`;
}

function renderProvidersTab(): string {
  const profiles: ProviderProfileView[] = settingsState?.profiles ?? [
    {
      id: "openai-compatible",
      name: "OpenAI Compatible",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o" }],
      isActive: true,
      hasApiKey: false,
    },
  ];

  const query = settingsQuery.trim().toLowerCase();
  const filtered = query
    ? profiles.filter((p) =>
        p.name.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query) ||
        p.baseUrl.toLowerCase().includes(query) ||
        (p.defaultModel && p.defaultModel.toLowerCase().includes(query))
      )
    : profiles;

  return `
    <div class="settings-actions-bar">
      <button class="settings-action-btn primary full-width" data-action="add-profile">＋ Add Provider Profile</button>
    </div>

    ${isAddingProvider ? renderProviderForm() : ""}

    <div class="providers-list">
      ${filtered.length ? filtered.map((profile) => {
        if (editingProfileId === profile.id) {
          return renderProviderForm(profile);
        }
        const testResult = providerTestResults[profile.id];
        const isEditingKey = editingApiKeyProfileId === profile.id;
        return `
          <article class="settings-card ${profile.isActive ? "active-profile" : ""}">
            <div class="card-header">
              <div>
                <h3>
                  ${escapeHtml(profile.name)}
                  ${profile.isActive ? `<span class="profile-active-tag">● Active</span>` : ""}
                </h3>
                <p class="card-desc"><code>${escapeHtml(profile.baseUrl)}</code></p>
              </div>
              <span class="scope-badge">${escapeHtml(profile.type)}</span>
            </div>

            <div class="profile-meta-grid">
              <div class="profile-row">
                <span>API KEY:</span>
                <span class="key-status ${profile.hasApiKey ? "set" : "unset"}">
                  ${profile.hasApiKey ? "● Configured securely in SecretStorage" : "○ Not set (Public/Local)"}
                </span>
              </div>
              <div class="profile-row">
                <span>DEFAULT MODEL:</span>
                <code>${escapeHtml(profile.defaultModel || "None (session picker)")}</code>
              </div>
              <div class="profile-row">
                <span>MODELS:</span>
                <span>${profile.models.length} configured</span>
              </div>
            </div>

            ${isEditingKey ? `
              <form class="inline-key-form" data-key-profile-id="${escapeHtml(profile.id)}">
                <input type="password" class="setting-input inline-key-input" placeholder="Paste API key here (sk-…)..." required autofocus />
                <button type="submit" class="card-btn primary">Save Key</button>
                <button type="button" class="card-btn" data-action="cancel-inline-key">Cancel</button>
              </form>
            ` : ""}

            ${testResult ? `
              <div class="test-result-box ${testResult.success ? "success" : "error"}">
                ${testResult.success ? "✓" : "✕"} ${escapeHtml(testResult.message)}
              </div>
            ` : ""}

            <div class="card-actions">
              ${!profile.isActive ? `<button class="card-btn primary" data-action="activate-profile" data-profile-id="${escapeHtml(profile.id)}">✓ Set as Active</button>` : ""}
              <button class="card-btn" data-action="set-api-key" data-profile-id="${escapeHtml(profile.id)}">🔑 ${profile.hasApiKey ? "Change API Key" : "Set API Key"}</button>
              ${profile.hasApiKey ? `<button class="card-btn" data-action="clear-api-key" data-profile-id="${escapeHtml(profile.id)}">Clear Key</button>` : ""}
              <button class="card-btn" data-action="test-connection" data-profile-id="${escapeHtml(profile.id)}">⚡ Test Connection</button>
              <button class="card-btn" data-action="fetch-models" data-profile-id="${escapeHtml(profile.id)}">↻ Fetch Models</button>
              <button class="card-btn" data-action="edit-profile" data-profile-id="${escapeHtml(profile.id)}">✎ Edit</button>
              ${profiles.length > 1 ? `<button class="card-btn danger" data-action="delete-profile" data-profile-id="${escapeHtml(profile.id)}">🗑 Delete</button>` : ""}
            </div>
          </article>
        `;
      }).join("") : `
        <div class="empty-state" style="margin: 30px auto;">
          <p class="empty-copy">No provider profiles configured yet.</p>
          <button class="settings-action-btn primary" data-action="add-profile" style="margin-top: 10px;">＋ Add Your First Provider</button>
        </div>
      `}
    </div>`;
}

function renderProviderForm(editingProfile?: ProviderProfileView): string {
  const isEditing = Boolean(editingProfile);
  const profileName = editingProfile?.name ?? "";
  const profileUrl = editingProfile?.baseUrl ?? "";
  const profileDefaultModel = editingProfile?.defaultModel ?? "";
  const hasKey = editingProfile?.hasApiKey ?? false;

  return `
    <form class="settings-form-card" id="provider-form" data-profile-id="${escapeHtml(editingProfile?.id ?? "")}">
      <div class="form-header">
        <h3>${isEditing ? `Edit “${escapeHtml(editingProfile!.name)}”` : "Add Provider Profile"}</h3>
        <button type="button" class="close-form-btn" data-action="cancel-provider-form" title="Close">✕</button>
      </div>

      <div class="preset-pills">
        <span class="preset-label">Presets:</span>
        <button type="button" class="preset-pill" data-preset="openai">OpenAI</button>
        <button type="button" class="preset-pill" data-preset="ollama">Ollama (Local)</button>
        <button type="button" class="preset-pill" data-preset="openrouter">OpenRouter</button>
        <button type="button" class="preset-pill" data-preset="vllm">vLLM</button>
        <button type="button" class="preset-pill" data-preset="deepseek">DeepSeek</button>
      </div>

      <div class="form-field">
        <label for="provider-name">Profile Name <span class="req">*</span></label>
        <input type="text" id="provider-name" required placeholder="e.g. OpenAI, Local Ollama, vLLM" value="${escapeHtml(profileName)}" />
      </div>

      <div class="form-field">
        <label for="provider-url">Base URL <span class="req">*</span></label>
        <input type="url" id="provider-url" required placeholder="e.g. https://api.openai.com/v1 or http://localhost:11434/v1" value="${escapeHtml(profileUrl)}" />
        <small class="field-hint">The OpenAI-compatible /v1 endpoint URL</small>
      </div>

      <div class="form-field">
        <label for="provider-key">API Key ${hasKey ? "(Optional)" : "(Optional for local endpoints)"}</label>
        <input type="password" id="provider-key" placeholder="${hasKey ? "Leave blank to keep existing key" : "sk-…"}" />
        <small class="field-hint">Encrypted and saved into VS Code SecretStorage</small>
      </div>

      <div class="form-field">
        <label for="provider-model">Default Model (Optional)</label>
        <input type="text" id="provider-model" placeholder="e.g. gpt-4o, llama3.1, deepseek-chat" value="${escapeHtml(profileDefaultModel)}" />
      </div>

      <div class="form-actions">
        <button type="button" class="card-btn" data-action="cancel-provider-form">Cancel</button>
        <button type="submit" class="settings-action-btn primary">${isEditing ? "Save Changes" : "Add Provider"}</button>
      </div>
    </form>`;
}

function renderGeneralTab(): string {
  const currentDefaultMode = settingsState?.defaultMode ?? activeMode;
  const currentMaxSteps = settingsState?.maxSteps ?? 20;

  return `
    <div class="general-settings">
      <div class="general-setting-item">
        <label for="settings-default-mode">Default Startup Mode</label>
        <p class="setting-help">The default role and permissions assigned to new agent sessions.</p>
        <select id="settings-default-mode" class="setting-select">
          ${modes.map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === currentDefaultMode ? "selected" : ""}>${escapeHtml(m.label)} (${escapeHtml(m.source ?? "built-in")})</option>`).join("")}
        </select>
      </div>

      <div class="general-setting-item">
        <label for="settings-max-steps">Max Agent Steps</label>
        <p class="setting-help">Maximum autonomous tool loops before pausing for user continuation.</p>
        <input id="settings-max-steps" class="setting-input" type="number" min="1" max="100" value="${currentMaxSteps}" />
      </div>

      <div class="general-setting-item">
        <label>Advanced Extension Preferences</label>
        <p class="setting-help">Configure headers, smart commit options, and proxy settings in VS Code JSON settings.</p>
        <button class="card-btn" data-action="open-advanced-settings" style="margin-top: 4px;">Open VS Code Extension Settings</button>
      </div>

      <div class="general-setting-item">
        <label>Storage &amp; Runtime</label>
        <p class="setting-help">Local-first durable SQLite persistence with safe checkpoints.</p>
        <div class="profile-meta-grid" style="margin-top: 6px;">
          <div class="profile-row"><span>PERSISTENCE:</span><code>SQLite (sql.js WASM)</code></div>
          <div class="profile-row"><span>WORKSPACE:</span><code>${escapeHtml(settingsState?.workspaceName ?? "Active")}</code></div>
        </div>
      </div>
    </div>`;
}

function emptyState(mode: string): string {
  return `<div class="empty-state"><div class="orbit"><span>✦</span></div><p class="kicker">${mode.toUpperCase()} MODE</p><h2>Make a sharp start.</h2><p class="empty-copy">Point me at a problem, a file, or a decision. I’ll keep the work grounded in your workspace.</p><div class="starter-grid"><button data-prompt="Map the architecture of this workspace" class="starter">Map this workspace <span>↗</span></button><button data-prompt="What should I work on first?" class="starter">What should I work on first? <span>↗</span></button></div></div>`;
}

function messageCard(message: ChatMessage): string {
  return `<article class="message ${message.role}"><div class="message-label">${message.role === "user" ? "YOU" : message.role === "system" ? "SYSTEM" : "AGENT"}</div><div class="message-body">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div></article>`;
}

function toolCard(tool: ToolActivity): string {
  const stateIcon = tool.state === "complete" ? "✓" : tool.state === "error" ? "!" : "◌";
  return `<details class="tool-card" ${tool.state === "running" ? "open" : ""}><summary><span class="tool-icon ${tool.state}">${stateIcon}</span><span><b>${escapeHtml(tool.name)}</b><small>${escapeHtml(tool.summary)}</small></span><span class="tool-state">${tool.state}</span></summary>${tool.detail ? `<pre>${escapeHtml(tool.detail)}</pre>` : ""}</details>`;
}

function subagentCard(item: SubagentActivity): string {
  const icon = item.state === "complete" ? "✓" : item.state === "error" ? "!" : item.state === "cancelled" ? "×" : "↻";
  const inspected = item.filesInspected?.length ? `<div class="subagent-files"><span>inspected</span>${item.filesInspected.slice(0, 8).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>` : "";
  const changed = item.filesChanged?.length ? `<div class="subagent-files changed"><span>changed</span>${item.filesChanged.slice(0, 8).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>` : "";
  const followups = item.followups?.length ? `<ul>${item.followups.slice(0, 5).map((followup) => `<li>${escapeHtml(followup)}</li>`).join("")}</ul>` : "";
  return `<details class="subagent-card" ${item.state === "running" || item.state === "queued" ? "open" : ""}><summary><span class="subagent-icon ${item.state}">${icon}</span><span class="subagent-main"><span class="kicker">SUBAGENT · DEPTH ${item.depth}</span><b>${escapeHtml(item.agent)}</b><small>${escapeHtml(item.task)}</small></span><span class="subagent-state">${item.state}</span></summary>${item.modelId ? `<div class="subagent-model">model · ${escapeHtml(item.modelId)}</div>` : ""}${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}${inspected}${changed}${followups}</details>`;
}

function approvalCard(item: ToolApproval): string {
  return `<article class="approval-card"><div class="approval-heading"><span class="approval-icon">!</span><div><p class="kicker">PERMISSION REQUEST</p><h3>${escapeHtml(item.toolName)}</h3></div><span class="risk ${item.risk}">${item.risk} risk</span></div><p>${escapeHtml(item.summary)}</p><small>${escapeHtml(item.reason)}</small><div class="approval-actions"><button data-action="deny" class="quiet-button">Deny</button><button data-action="approve" class="approve-button">Approve once</button></div></article>`;
}

function planCard(item: PlanView): string {
  const actions = item.status === "READY_FOR_APPROVAL"
    ? `<div class="plan-actions"><button data-action="plan-discard" class="quiet-button">Discard</button><button data-action="plan-save" class="quiet-button">Save Plan</button><button data-action="plan-revise" class="quiet-button">Revise Plan</button><button data-action="plan-approve" class="approve-button">Approve &amp; Implement</button></div>`
    : `<div class="plan-actions"><button data-action="plan-save" class="quiet-button">Open Plan</button></div>`;
  return `<article class="plan-card"><div class="plan-heading"><span class="plan-icon">≡</span><div><p class="kicker">PLAN · REVISION ${item.revision}</p><h3>${escapeHtml(item.title)}</h3></div><span class="plan-status ${item.status.toLowerCase()}">${escapeHtml(item.status.replaceAll("_", " "))}</span></div><p>${escapeHtml(item.artifactLabel)}</p>${actions}</article>`;
}

function checkpointCard(item: CheckpointSummaryCard): string {
  const conflict = checkpointConflict?.checkpointId === item.id ? `<div class="checkpoint-conflict"><b>Revert paused.</b> Workspace edits were detected after this run. Resolve or review the affected files, then try again.<small>${checkpointConflict.paths.slice(0, 4).map(escapeHtml).join(" · ")}${checkpointConflict.paths.length > 4 ? " · …" : ""}</small></div>` : "";
  const files = item.files.slice(0, 12).map((file) => `<li><button data-checkpoint-path="${escapeHtml(file.path)}" data-checkpoint-id="${escapeHtml(item.id)}" title="Open ${escapeHtml(file.path)} in native diff"><span class="diff-status ${file.status}">${file.status === "added" ? "+" : file.status === "removed" ? "−" : "~"}</span><code>${escapeHtml(file.path)}</code><small>${file.binary ? "binary" : `+${file.linesAdded} −${file.linesRemoved}`}</small></button></li>`).join("");
  return `<article class="checkpoint-card"><div class="checkpoint-heading"><span class="checkpoint-icon">↔</span><div><p class="kicker">CHECKPOINT</p><h3>${escapeHtml(item.label)}</h3></div><span class="checkpoint-count">${item.filesChanged} file${item.filesChanged === 1 ? "" : "s"}</span></div><div class="checkpoint-stats"><strong>+${item.additions}</strong><span>−${item.removals}</span><span class="checkpoint-spacer"></span><small>${new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div><ul class="checkpoint-files">${files}${item.files.length > 12 ? `<li class="checkpoint-more">+ ${item.files.length - 12} more files</li>` : ""}</ul>${conflict}<div class="checkpoint-actions"><button class="quiet-button" data-action="checkpoint-diff" data-checkpoint-id="${escapeHtml(item.id)}">View Diff</button><button class="approve-button checkpoint-revert" data-action="checkpoint-revert" data-checkpoint-id="${escapeHtml(item.id)}">Revert</button></div></article>`;
}

function contextChip(ref: ContextRef): string {
  return `<span class="context-chip"><span>${ref.kind === "file" ? "▧" : "⌘"}</span>${escapeHtml(ref.label)}<button data-remove-context="${ref.id}" aria-label="Remove ${escapeHtml(ref.label)}">×</button></span>`;
}

function wireChatInteractions(): void {
  document.querySelector<HTMLSelectElement>("#mode-select")?.addEventListener("change", (event) => {
    activeMode = (event.target as HTMLSelectElement).value as AgentMode;
    vscode.postMessage({ type: "changeMode", mode: activeMode });
    updateControlStrip();
  });
  document.querySelector<HTMLSelectElement>("#model-select")?.addEventListener("change", (event) => {
    activeModel = (event.target as HTMLSelectElement).value;
    vscode.postMessage({ type: "changeModel", modelId: activeModel });
    updateControlStrip();
  });
  document.querySelector<HTMLFormElement>("#composer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>("#composer-input");
    if (!input?.value.trim()) return;
    const text = input.value.trim();
    timeline.push({ kind: "user_message", id: `user-${Date.now()}`, text, createdAt: Date.now() });
    runState = "running";
    vscode.postMessage({ type: "sendMessage", text, mode: activeMode, modelId: activeModel, context: contextRefs });
    input.value = "";
    renderTranscript();
    updateRunStateUi();
  });
  document.querySelector<HTMLTextAreaElement>("#composer-input")?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      document.querySelector<HTMLFormElement>("#composer-form")?.requestSubmit();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    const input = document.querySelector<HTMLTextAreaElement>("#composer-input");
    if (input) { input.value = button.dataset.prompt ?? ""; input.focus(); }
  }));
  document.querySelector<HTMLButtonElement>("[data-action=open-settings]")?.addEventListener("click", () => {
    currentView = "settings";
    isAddingProvider = false;
    editingProfileId = null;
    editingApiKeyProfileId = null;
    isAddingMode = false;
    vscode.postMessage({ type: "requestSettings" });
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-action=history]")?.addEventListener("click", () => {
    historyOpen = !historyOpen;
    updateSessionPicker();
  });
  document.querySelector<HTMLButtonElement>("[data-action=refresh-sessions]")?.addEventListener("click", () => {
    vscode.postMessage({ type: "listSessions" });
  });
  document.querySelector<HTMLInputElement>("#session-search")?.addEventListener("input", (event) => {
    historyQuery = (event.target as HTMLInputElement).value;
    const query = historyQuery.trim().toLocaleLowerCase();
    document.querySelectorAll<HTMLElement>("[data-session-search]").forEach((row) => {
      row.hidden = query.length > 0 && !(row.dataset.sessionSearch ?? "").includes(query);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) => button.addEventListener("click", () => {
    const sessionId = button.dataset.sessionId;
    if (!sessionId || historyBusy) return;
    historyBusy = true;
    historyOpen = false;
    updateSessionPicker();
    vscode.postMessage({ type: "openSession", sessionId });
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-session-action]").forEach((button) => button.addEventListener("click", () => {
    const sessionId = button.dataset.actionSessionId;
    const action = button.dataset.sessionAction;
    if (!sessionId || historyBusy) return;
    if (action === "rename") vscode.postMessage({ type: "renameSession", sessionId });
    if (action === "duplicate") vscode.postMessage({ type: "duplicateSession", sessionId });
    if (action === "export") vscode.postMessage({ type: "exportSession", sessionId });
    if (action === "delete") vscode.postMessage({ type: "deleteSession", sessionId });
  }));
  document.querySelector<HTMLButtonElement>("[data-action=cancel]")?.addEventListener("click", () => vscode.postMessage({ type: "cancelRun" }));
  document.querySelector<HTMLButtonElement>("[data-action=approve]")?.addEventListener("click", () => { if (approval) vscode.postMessage({ type: "approveTool", approvalId: approval.id }); });
  document.querySelector<HTMLButtonElement>("[data-action=deny]")?.addEventListener("click", () => { if (approval) vscode.postMessage({ type: "denyTool", approvalId: approval.id }); });
  document.querySelectorAll<HTMLButtonElement>("[data-action=checkpoint-diff]").forEach((button) => button.addEventListener("click", () => {
    const checkpointId = button.dataset.checkpointId;
    if (checkpointId) vscode.postMessage({ type: "openCheckpointDiff", checkpointId });
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-action=checkpoint-revert]").forEach((button) => button.addEventListener("click", () => {
    const checkpointId = button.dataset.checkpointId;
    if (!checkpointId || !window.confirm("Revert this agent checkpoint? Revert is guarded and will stop if the workspace changed.")) return;
    vscode.postMessage({ type: "revertCheckpoint", checkpointId });
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-checkpoint-path]").forEach((button) => button.addEventListener("click", () => {
    const checkpointId = button.dataset.checkpointId;
    const path = button.dataset.checkpointPath;
    if (checkpointId && path) vscode.postMessage({ type: "openCheckpointDiff", checkpointId, path });
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-remove-context]").forEach((button) => button.addEventListener("click", () => {
    const refId = button.dataset.removeContext;
    if (!refId) return;
    contextRefs = contextRefs.filter((ref) => ref.id !== refId);
    vscode.postMessage({ type: "removeContext", refId });
    updateContextChips();
  }));
  document.querySelector<HTMLButtonElement>("[data-action=attach]")?.addEventListener("click", () => {
    vscode.postMessage({ type: "pickContext" });
  });
  document.querySelector<HTMLButtonElement>("[data-action=new]")?.addEventListener("click", () => {
    timeline = [];
    checkpoints = [];
    checkpointConflict = undefined;
    approval = undefined;
    plan = undefined;
    runState = "idle";
    historyOpen = false;
    vscode.postMessage({ type: "newSession" });
    renderTranscript();
    updateRunStateUi();
  });
  for (const action of ["approve", "revise", "save", "discard"] as const) {
    document.querySelector<HTMLButtonElement>(`[data-action=plan-${action}]`)?.addEventListener("click", () => {
      if (!plan) return;
      const type = `${action}Plan` as "approvePlan" | "revisePlan" | "savePlan" | "discardPlan";
      vscode.postMessage({ type, planId: plan.id, revision: plan.revision });
    });
  }
}

function wireSettingsInteractions(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-action=back-to-chat]").forEach((btn) => btn.addEventListener("click", () => {
    currentView = "chat";
    isAddingProvider = false;
    editingProfileId = null;
    editingApiKeyProfileId = null;
    isAddingMode = false;
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => btn.addEventListener("click", () => {
    const tab = btn.dataset.tab as "modes" | "providers" | "general" | undefined;
    if (tab) {
      settingsTab = tab;
      isAddingProvider = false;
      editingProfileId = null;
      editingApiKeyProfileId = null;
      isAddingMode = false;
      render();
    }
  }));

  document.querySelector<HTMLInputElement>("#settings-search")?.addEventListener("input", (event) => {
    settingsQuery = (event.target as HTMLInputElement).value;
    render();
  });

  document.querySelector<HTMLButtonElement>("[data-action=clear-search]")?.addEventListener("click", () => {
    settingsQuery = "";
    render();
  });

  document.querySelector<HTMLButtonElement>("[data-action=create-mode]")?.addEventListener("click", () => {
    isAddingMode = true;
    render();
    document.querySelector<HTMLInputElement>("#mode-name")?.focus();
  });

  document.querySelector<HTMLButtonElement>("[data-action=cancel-mode-form]")?.addEventListener("click", () => {
    isAddingMode = false;
    render();
  });

  const modeNameInput = document.querySelector<HTMLInputElement>("#mode-name");
  const modeSlugInput = document.querySelector<HTMLInputElement>("#mode-slug");
  let slugUserEdited = false;
  modeSlugInput?.addEventListener("input", () => { slugUserEdited = true; });
  modeNameInput?.addEventListener("input", () => {
    if (!slugUserEdited && modeSlugInput) {
      modeSlugInput.value = safeCssToken(modeNameInput.value);
    }
  });

  document.querySelector<HTMLFormElement>("#mode-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = (document.querySelector<HTMLInputElement>("#mode-name")?.value ?? "").trim();
    const slug = (document.querySelector<HTMLInputElement>("#mode-slug")?.value ?? "").trim();
    const scope = (document.querySelector<HTMLSelectElement>("#mode-scope")?.value ?? "project") as "project" | "global";
    const type = (document.querySelector<HTMLSelectElement>("#mode-type")?.value ?? "all") as "all" | "primary" | "subagent";
    const authority = (document.querySelector<HTMLSelectElement>("#mode-authority")?.value ?? "write") as "read" | "write";
    const steps = Number(document.querySelector<HTMLInputElement>("#mode-steps")?.value ?? 20);
    const model = (document.querySelector<HTMLInputElement>("#mode-model")?.value ?? "").trim();
    const instructions = (document.querySelector<HTMLTextAreaElement>("#mode-instructions")?.value ?? "").trim();

    if (!name || !slug || !instructions) return;
    vscode.postMessage({
      type: "saveCustomMode",
      mode: {
        name,
        slug,
        scope,
        type,
        authority,
        steps: Number.isSafeInteger(steps) && steps > 0 ? steps : 20,
        model: model || undefined,
        instructions,
      },
    });
    isAddingMode = false;
  });

  document.querySelector<HTMLButtonElement>("[data-action=import-mode]")?.addEventListener("click", () => {
    vscode.postMessage({ type: "importMode" });
  });

  document.querySelector<HTMLButtonElement>("[data-action=reload-modes]")?.addEventListener("click", () => {
    vscode.postMessage({ type: "reloadModes" });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action=open-diagnostic]").forEach((btn) => btn.addEventListener("click", () => {
    const source = btn.dataset.source;
    const line = btn.dataset.line ? Number(btn.dataset.line) : undefined;
    if (source) vscode.postMessage({ type: "openModeDiagnostic", source, line });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=edit-mode]").forEach((btn) => btn.addEventListener("click", () => {
    const slug = btn.dataset.slug;
    if (slug) vscode.postMessage({ type: "openModeSource", slug });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=duplicate-mode]").forEach((btn) => btn.addEventListener("click", () => {
    const slug = btn.dataset.slug;
    if (slug) vscode.postMessage({ type: "duplicateMode", slug });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=delete-mode]").forEach((btn) => btn.addEventListener("click", () => {
    const slug = btn.dataset.slug;
    if (slug) vscode.postMessage({ type: "deleteMode", slug });
  }));

  // Provider Form wiring
  document.querySelectorAll<HTMLButtonElement>("[data-action=add-profile]").forEach((btn) => btn.addEventListener("click", () => {
    isAddingProvider = true;
    editingProfileId = null;
    editingApiKeyProfileId = null;
    render();
    document.querySelector<HTMLInputElement>("#provider-name")?.focus();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=cancel-provider-form]").forEach((btn) => btn.addEventListener("click", () => {
    isAddingProvider = false;
    editingProfileId = null;
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => btn.addEventListener("click", () => {
    const preset = btn.dataset.preset;
    const nameInput = document.querySelector<HTMLInputElement>("#provider-name");
    const urlInput = document.querySelector<HTMLInputElement>("#provider-url");
    const modelInput = document.querySelector<HTMLInputElement>("#provider-model");

    if (!nameInput || !urlInput || !modelInput) return;
    if (preset === "openai") {
      nameInput.value = "OpenAI";
      urlInput.value = "https://api.openai.com/v1";
      modelInput.value = "gpt-4o";
    } else if (preset === "ollama") {
      nameInput.value = "Ollama";
      urlInput.value = "http://localhost:11434/v1";
      modelInput.value = "llama3.1";
    } else if (preset === "openrouter") {
      nameInput.value = "OpenRouter";
      urlInput.value = "https://openrouter.ai/api/v1";
      modelInput.value = "anthropic/claude-3.5-sonnet";
    } else if (preset === "vllm") {
      nameInput.value = "vLLM";
      urlInput.value = "http://localhost:8000/v1";
      modelInput.value = "";
    } else if (preset === "deepseek") {
      nameInput.value = "DeepSeek";
      urlInput.value = "https://api.deepseek.com/v1";
      modelInput.value = "deepseek-chat";
    }
  }));

  document.querySelector<HTMLFormElement>("#provider-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const id = form.dataset.profileId || undefined;
    const name = (document.querySelector<HTMLInputElement>("#provider-name")?.value ?? "").trim();
    const baseUrl = (document.querySelector<HTMLInputElement>("#provider-url")?.value ?? "").trim();
    const key = (document.querySelector<HTMLInputElement>("#provider-key")?.value ?? "").trim();
    const defaultModel = (document.querySelector<HTMLInputElement>("#provider-model")?.value ?? "").trim();

    if (!name || !baseUrl) return;
    vscode.postMessage({
      type: "saveProviderProfile",
      profile: {
        id,
        name,
        baseUrl,
        defaultModel: defaultModel || undefined,
        apiKey: key || undefined,
      },
    });
    isAddingProvider = false;
    editingProfileId = null;
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action=edit-profile]").forEach((btn) => btn.addEventListener("click", () => {
    editingProfileId = btn.dataset.profileId ?? null;
    isAddingProvider = false;
    editingApiKeyProfileId = null;
    render();
    document.querySelector<HTMLInputElement>("#provider-name")?.focus();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=activate-profile]").forEach((btn) => btn.addEventListener("click", () => {
    const profileId = btn.dataset.profileId;
    if (profileId) vscode.postMessage({ type: "activateProvider", profileId });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=set-api-key]").forEach((btn) => btn.addEventListener("click", () => {
    editingApiKeyProfileId = btn.dataset.profileId ?? null;
    render();
    document.querySelector<HTMLInputElement>(".inline-key-input")?.focus();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=cancel-inline-key]").forEach((btn) => btn.addEventListener("click", () => {
    editingApiKeyProfileId = null;
    render();
  }));

  document.querySelectorAll<HTMLFormElement>(".inline-key-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const profileId = form.dataset.keyProfileId;
    const keyInput = form.querySelector<HTMLInputElement>(".inline-key-input");
    const key = keyInput?.value.trim() ?? "";
    if (profileId && key) {
      const p = settingsState?.profiles.find((item) => item.id === profileId);
      if (p) {
        vscode.postMessage({
          type: "saveProviderProfile",
          profile: {
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            defaultModel: p.defaultModel,
            apiKey: key,
          },
        });
      }
    }
    editingApiKeyProfileId = null;
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=clear-api-key]").forEach((btn) => btn.addEventListener("click", () => {
    const profileId = btn.dataset.profileId;
    if (profileId) vscode.postMessage({ type: "clearProviderApiKey", profileId });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=test-connection]").forEach((btn) => btn.addEventListener("click", () => {
    const profileId = btn.dataset.profileId;
    if (profileId) {
      providerTestResults[profileId] = { success: false, message: "Testing connection…", loading: true };
      render();
      vscode.postMessage({ type: "testProviderConnection", profileId });
    }
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=fetch-models]").forEach((btn) => btn.addEventListener("click", () => {
    const profileId = btn.dataset.profileId;
    if (profileId) vscode.postMessage({ type: "fetchProviderModels", profileId });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=delete-profile]").forEach((btn) => btn.addEventListener("click", () => {
    const profileId = btn.dataset.profileId;
    if (profileId) vscode.postMessage({ type: "deleteProvider", profileId });
  }));

  document.querySelector<HTMLSelectElement>("#settings-default-mode")?.addEventListener("change", (event) => {
    const mode = (event.target as HTMLSelectElement).value;
    vscode.postMessage({ type: "saveDefaultMode", mode });
  });

  document.querySelector<HTMLInputElement>("#settings-max-steps")?.addEventListener("change", (event) => {
    const steps = Number((event.target as HTMLInputElement).value);
    if (Number.isSafeInteger(steps) && steps >= 1 && steps <= 100) {
      vscode.postMessage({ type: "saveMaxSteps", steps });
    }
  });

  document.querySelector<HTMLButtonElement>("[data-action=open-advanced-settings]")?.addEventListener("click", () => {
    vscode.postMessage({ type: "openAdvancedSettings" });
  });
}

function sessionMenu(): string {
  const items = sessions.length
    ? sessions.map((session) => {
      const search = `${session.title} ${session.activeMode} ${session.modelId} ${formatSessionDate(session.updatedAt)}`.toLocaleLowerCase();
      const hidden = historyQuery.trim() && !search.includes(historyQuery.trim().toLocaleLowerCase()) ? " hidden" : "";
      return `<div class="session-item ${session.id === activeSessionId ? "active" : ""}" data-session-search="${escapeHtml(search)}"${hidden}><button class="session-item-open" data-session-id="${escapeHtml(session.id)}" role="menuitem" ${historyBusy ? "disabled" : ""}><span class="session-item-main"><b>${escapeHtml(session.title || "Untitled session")}</b><small>${escapeHtml(session.activeMode)} · ${escapeHtml(session.modelId)} · ${formatSessionDate(session.updatedAt)}</small></span><span class="session-item-status ${session.status}">${session.id === activeSessionId ? "open" : session.status === "waiting_for_approval" ? "waiting" : ""}</span></button><div class="session-item-actions" aria-label="Session actions"><button data-session-action="rename" data-action-session-id="${escapeHtml(session.id)}" title="Rename">✎</button><button data-session-action="duplicate" data-action-session-id="${escapeHtml(session.id)}" title="Duplicate">⧉</button><button data-session-action="export" data-action-session-id="${escapeHtml(session.id)}" title="Export">⇩</button><button data-session-action="delete" data-action-session-id="${escapeHtml(session.id)}" title="Delete">×</button></div></div>`;
    }).join("")
    : `<p class="session-empty">No recent sessions in this workspace.</p>`;
  return `<div class="session-menu" role="menu" aria-label="Workspace sessions"><div class="session-menu-heading"><span>SESSION HISTORY</span><button data-action="refresh-sessions" aria-label="Refresh sessions">↻</button></div><input id="session-search" class="session-search" type="search" value="${escapeHtml(historyQuery)}" placeholder="Search title, mode, or model…" aria-label="Search sessions">${items}</div>`;
}

function activeSessionTitle(): string {
  return sessions.find((session) => session.id === activeSessionId)?.title || "Current session";
}

function formatSessionDate(value: number): string {
  if (!Number.isFinite(value)) return "";
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function safeCssToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "custom";
}

vscode.postMessage({ type: "ready" });

