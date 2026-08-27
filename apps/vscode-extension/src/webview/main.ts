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
  ProviderPresetView,
  ModeDetailView,
  CustomModeDiagnosticView,
  SkillOptionView,
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
let settingsTab: "modes" | "subagents" | "providers" | "general" = "modes";
let settingsQuery = "";
let settingsState: HarnessSettingsState | undefined;
const providerTestResults: Record<string, { success: boolean; message: string; loading?: boolean }> = {};

type TimelineItem =
  | { kind: "user_message"; id: string; text: string; createdAt: number; images?: string[] }
  | { kind: "assistant_message"; id: string; text: string; createdAt: number; isStreaming?: boolean }
  | { kind: "system_message"; id: string; text: string; createdAt: number }
  | { kind: "tool"; id: string; tool: ToolActivity }
  | { kind: "subagent"; id: string; subagent: SubagentActivity }
  | { kind: "plan"; id: string; plan: PlanView }
  | { kind: "checkpoint"; id: string; checkpoint: CheckpointSummaryCard }
  | { kind: "approval"; id: string; approval: ToolApproval };

let timeline: TimelineItem[] = [];
let attachedImages: Array<{ id: string; name: string; dataUrl: string }> = [];
let modes: ModeOption[] = [...BUILT_IN_MODES];
let models: ModelOption[] = [
  { id: "openai-compatible", label: "Configure model…", hint: "OpenAI-compatible endpoint" }
];
let sessions: SessionHistoryItem[] = [];
let activeSessionId = "";
let historyOpen = false;
let historyBusy = false;
let historyQuery = "";
let skills: SkillOptionView[] = [];
let selectedSkillIds: string[] = [];
let mandatorySkillIds: string[] = [];
let skillMenuOpen = false;
let skillQuery = "";

let modelMenuOpen = false;
let modelQuery = "";
let modelOutsideClickListenerAttached = false;
let showFreebuffManualInput = false;

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
      skills = message.skills;
      selectedSkillIds = message.selectedSkillIds;
      mandatorySkillIds = message.mandatorySkillIds;
      plan = message.plan;
      contextRefs = [];
      rebuildTimeline(message.messages, message.tools, message.subagents, message.plan);
      appRoot.innerHTML = "";
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
      skills = message.skills;
      selectedSkillIds = message.selectedSkillIds;
      mandatorySkillIds = message.mandatorySkillIds;
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
      appRoot.innerHTML = "";
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
    case "skillsChanged":
      skills = message.skills;
      selectedSkillIds = message.selectedSkillIds;
      mandatorySkillIds = message.mandatorySkillIds;
      updateSkillControls();
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
      if (currentView === "settings") render();
      break;
    case "providerTestResult":
      providerTestResults[message.profileId] = {
        success: message.success,
        message: message.message,
        loading: false,
      };
      if (currentView === "settings") render();
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
      timeline.push({ kind: "user_message", id: msg.id, text: msg.text, createdAt: msg.createdAt, images: msg.images });
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
    return;
  }
  renderChat();
}

let currentTheme: "charcoal" | "beige" = (() => {
  try {
    if (typeof localStorage !== "undefined") {
      return (localStorage.getItem("clank-theme") as "charcoal" | "beige") || "charcoal";
    }
  } catch {}
  return "charcoal";
})();

function moonIconSvg(size = 15): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  </svg>`;
}

function sunIconSvg(size = 15): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="5"></circle>
    <line x1="12" y1="1" x2="12" y2="3"></line>
    <line x1="12" y1="21" x2="12" y2="23"></line>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
    <line x1="1" y1="12" x2="3" y2="12"></line>
    <line x1="21" y1="12" x2="23" y2="12"></line>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
  </svg>`;
}

function updateThemeButtons(): void {
  try {
    if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
      document.querySelectorAll<HTMLButtonElement>("[data-action=toggle-theme]").forEach((btn) => {
        btn.setAttribute("title", currentTheme === "beige" ? "Switch to Charcoal (Dark)" : "Switch to Warm Beige (Light)");
        btn.setAttribute("aria-label", currentTheme === "beige" ? "Switch to Charcoal (Dark)" : "Switch to Warm Beige (Light)");
        btn.innerHTML = currentTheme === "beige" ? sunIconSvg(15) : moonIconSvg(15);
      });
      document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.themeChoice === currentTheme);
      });
    }
  } catch {}
}

function applyTheme(theme: "charcoal" | "beige"): void {
  currentTheme = theme;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("clank-theme", theme);
    }
  } catch {}
  try {
    if (typeof document !== "undefined") {
      if (document.documentElement && typeof document.documentElement.setAttribute === "function") {
        document.documentElement.setAttribute("data-theme", theme);
      }
      if (document.body && typeof document.body.setAttribute === "function") {
        document.body.setAttribute("data-theme", theme);
      }
      const app = document.getElementById("app");
      if (app && typeof app.setAttribute === "function") {
        app.setAttribute("data-theme", theme);
      }
      if (typeof document.querySelectorAll === "function") {
        document.querySelectorAll<HTMLElement>(".shell").forEach((s) => {
          if (typeof s.setAttribute === "function") s.setAttribute("data-theme", theme);
        });
      }
    }
  } catch {}
  updateThemeButtons();
}

// Initial theme apply
applyTheme(currentTheme);

function clankLogoSvg(size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M46 28 L24 50 L46 72" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M46 28 L51 34" stroke="#a1a1aa" stroke-width="7" stroke-linecap="round"/>
    <path d="M46 72 L51 66" stroke="#a1a1aa" stroke-width="7" stroke-linecap="round"/>
    <path d="M54 28 L76 50 L54 72" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M54 28 L49 34" stroke="#a1a1aa" stroke-width="7" stroke-linecap="round"/>
    <path d="M54 72 L49 66" stroke="#a1a1aa" stroke-width="7" stroke-linecap="round"/>
  </svg>`;
}

function clockIconSvg(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <polyline points="12 6 12 12 16 14"></polyline>
  </svg>`;
}

function gearIconSvg(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>`;
}

function mapIconSvg(size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
    <line x1="8" y1="2" x2="8" y2="18"></line>
    <line x1="16" y1="6" x2="16" y2="22"></line>
  </svg>`;
}

function compassIconSvg(size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor" stroke="none"></polygon>
  </svg>`;
}

function arrowRightSvg(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"></line>
    <polyline points="12 5 19 12 12 19"></polyline>
  </svg>`;
}

function statusLabel(): string {
  if (runState === "running") return "Agent is working…";
  if (runState === "awaiting_approval") return "Waiting for approval…";
  if (runState === "cancelled") return "Run cancelled";
  return "Ready when you are";
}

function renderChat(): void {
  const mode = modes.find((item) => item.id === activeMode) ?? modes[0];
  const visibleModels = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
  
  const existingShell = Boolean(appRoot.innerHTML && appRoot.innerHTML.includes('id="chat-shell"'));
  if (!existingShell) {
    const workingIndicatorHtml = runState === "running"
      ? `<div class="agent-working-indicator" id="agent-working-indicator"><span class="working-spinner">✦</span><span class="working-text">Agent is working…</span></div>`
      : runState === "awaiting_approval"
        ? `<div class="agent-working-indicator waiting" id="agent-working-indicator"><span class="working-spinner">!</span><span class="working-text">Waiting for approval…</span></div>`
        : "";

    const transcriptContent = timeline.length === 0
      ? emptyState(mode.label)
      : renderTimeline() + workingIndicatorHtml;

    appRoot.innerHTML = `
      <section class="shell" id="chat-shell">
        <header class="header">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">${clankLogoSvg(20)}</span>
            <div>
              <p class="eyebrow">CLANK / LOCAL HARNESS</p>
              <h1>Agent chat</h1>
            </div>
          </div>
          <div class="header-actions">
            <button class="new-session-header-btn" data-action="new" aria-label="Start new session" title="New Session">
              <span class="new-session-plus">＋</span>
              <span class="new-session-text">New</span>
            </button>
            <button class="session-picker ${historyOpen ? "open" : ""}" data-action="history" aria-label="Open recent sessions" aria-haspopup="menu" aria-expanded="${historyOpen}">
              <span class="session-picker-icon">${clockIconSvg(14)}</span>
              <span class="session-picker-label" id="session-picker-label">${escapeHtml(activeSessionTitle())}</span>
              <span class="session-picker-chevron">⌄</span>
            </button>
            <button class="icon-button theme-toggle-btn" data-action="toggle-theme" aria-label="Toggle theme" title="${currentTheme === "beige" ? "Switch to Charcoal (Dark)" : "Switch to Warm Beige (Light)"}">${currentTheme === "beige" ? sunIconSvg(15) : moonIconSvg(15)}</button>
            <button class="icon-button" data-action="open-settings" aria-label="Open Clank settings" title="Clank Settings">${gearIconSvg(16)}</button>
          </div>
        </header>
        <div id="session-menu-container">${historyOpen ? sessionMenu() : ""}</div>
        <div class="control-strip" id="control-strip">
          <label class="select-wrap mode-select" id="mode-select-wrap" title="${escapeHtml(`${mode.description} · ${mode.source ?? "unavailable"}`)}">
            <span class="mode-dot mode-${safeCssToken(mode.id)}"></span>
            <span class="sr-only">Mode</span>
            <select id="mode-select">${modes.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeMode ? "selected" : ""}>${escapeHtml(`${item.label} · ${item.source ?? "unavailable"}`)}</option>`).join("")}</select>
            <span class="chevron">⌄</span>
          </label>
          <button type="button" class="model-picker-btn ${modelPolicy.policy} ${modelMenuOpen ? "open" : ""}" id="model-picker-btn" data-action="toggle-model-picker" ${modelPolicy.policy === "fixed" ? "disabled" : ""} title="${escapeHtml(modelPolicy.reason ?? `${modelPolicy.policy} model policy`)}">
            <span class="model-glyph">${modelPolicy.policy === "fixed" ? "▣" : modelPolicy.policy === "preferred" ? "◇" : "◈"}</span>
            <span class="model-picker-label" id="model-picker-label">${escapeHtml(visibleModels.find((m) => m.id === activeModel)?.label || activeModel)}</span>
            <span class="chevron">${modelPolicy.policy === "fixed" ? "fixed" : "⌄"}</span>
          </button>
        </div>
        <div id="model-menu-container">${modelMenuOpen ? modelMenu() : ""}</div>
        <div class="status-row" id="status-row">
          <div class="status-left">
            <span class="status-dot ${runState === "running" ? "pulse" : ""}"></span>
            <span class="status-label">${statusLabel()}</span>
          </div>
          <div class="context-track-wrap">
            <span class="context-label">Context 12%</span>
            <div class="context-pill-bar"><span style="width: 12%;"></span></div>
          </div>
        </div>
        <div class="rule"></div>
        <section class="transcript" id="transcript" aria-live="polite">${transcriptContent}</section>
        <footer class="composer-wrap">
          <div class="context-chips" id="context-chips">${composerChips()}</div>
          <div class="skill-picker-container" id="skill-picker-container">${skillMenuOpen ? skillPicker() : ""}</div>
          <form class="composer" id="composer-form">
            <div class="composer-top-indicator" title="Connected"></div>
            <textarea id="composer-input" rows="3" placeholder="${mode.id === "ask" ? "Ask anything…" : `Ask ${escapeHtml(mode.label)} anything…`}" aria-label="Message Clank"></textarea>
            <div class="composer-actions" id="composer-actions">
              <div class="composer-left-actions">${composerLeftActions()}</div>
              <div class="composer-right-actions">
                <span class="composer-hint"><span class="key-glyph">↵</span> to send</span>
                ${runState === "running" || runState === "awaiting_approval" ? `<button type="button" class="cancel-button" data-action="cancel" aria-label="Cancel run">cancel</button>` : `<button type="submit" class="send-button" aria-label="Send message">↑</button>`}
              </div>
            </div>
          </form>
        </footer>
      </section>`;
    wireChatInteractions();
  } else {
    updateControlStrip();
    updateSessionPicker();
    updateContextChips();
    renderTranscript();
    updateRunStateUi();
  }

  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function updateControlStrip(): void {
  const mode = modes.find((item) => item.id === activeMode) ?? modes[0];
  const modeSelect = document.querySelector<HTMLSelectElement>("#mode-select");
  if (modeSelect) {
    modeSelect.innerHTML = modes.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeMode ? "selected" : ""}>${escapeHtml(`${item.label} · ${item.source ?? "unavailable"}`)}</option>`).join("");
    const wrap = document.querySelector<HTMLElement>("#mode-select-wrap");
    if (wrap) wrap.title = `${mode.description} · ${mode.source ?? "unavailable"}`;
    const dot = document.querySelector<HTMLElement>("#mode-select-wrap .mode-dot");
    if (dot) dot.className = `mode-dot mode-${safeCssToken(mode.id)}`;
  }

  const visibleModels = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
  const labelEl = document.querySelector<HTMLElement>("#model-picker-label");
  if (labelEl) {
    labelEl.textContent = visibleModels.find((m) => m.id === activeModel)?.label || activeModel;
  }
  const btnEl = document.querySelector<HTMLButtonElement>("#model-picker-btn");
  if (btnEl) {
    btnEl.className = `model-picker-btn ${modelPolicy.policy} ${modelMenuOpen ? "open" : ""}`;
    btnEl.disabled = modelPolicy.policy === "fixed";
    btnEl.title = modelPolicy.reason ?? `${modelPolicy.policy} model policy`;
  }
  const glyph = document.querySelector<HTMLElement>("#model-picker-btn .model-glyph");
  if (glyph) glyph.textContent = modelPolicy.policy === "fixed" ? "▣" : modelPolicy.policy === "preferred" ? "◇" : "◈";
  const chevron = document.querySelector<HTMLElement>("#model-picker-btn .chevron");
  if (chevron) chevron.textContent = modelPolicy.policy === "fixed" ? "fixed" : "⌄";

  const menuContainer = document.querySelector<HTMLElement>("#model-menu-container");
  if (menuContainer) {
    menuContainer.innerHTML = modelMenuOpen ? modelMenu() : "";
    if (modelMenuOpen) wireModelDropdownInteractions();
  }

  const composerInput = document.querySelector<HTMLTextAreaElement>("#composer-input");
  if (composerInput && !composerInput.value) {
    composerInput.placeholder = mode.id === "ask" ? "Ask anything…" : `Ask ${mode.label} anything…`;
  }
}

function startNewSession(): void {
  timeline = [];
  checkpoints = [];
  checkpointConflict = undefined;
  approval = undefined;
  plan = undefined;
  runState = "idle";
  historyOpen = false;
  selectedSkillIds = [];
  mandatorySkillIds = [];
  skillMenuOpen = false;
  vscode.postMessage({ type: "newSession" });
  updateSessionPicker();
  renderTranscript();
  updateRunStateUi();
}

function updateSessionPicker(): void {
  const label = document.querySelector<HTMLElement>("#session-picker-label");
  if (label) label.textContent = activeSessionTitle();
  const pickerBtn = document.querySelector<HTMLElement>(".session-picker");
  if (pickerBtn) {
    pickerBtn.className = `session-picker ${historyOpen ? "open" : ""}`;
  }
  const menuContainer = document.querySelector<HTMLElement>("#session-menu-container");
  if (menuContainer) {
    menuContainer.innerHTML = historyOpen ? sessionMenu() : "";
    if (historyOpen) wireSessionMenuInteractions();
  }
}

function updateContextChips(): void {
  const container = document.querySelector<HTMLElement>("#context-chips");
  if (container) container.innerHTML = composerChips();
  wireChipInteractions();
}

function updateSkillControls(): void {
  updateContextChips();
  const container = document.querySelector<HTMLElement>("#skill-picker-container");
  if (container) container.innerHTML = skillMenuOpen ? skillPicker() : "";
  const left = document.querySelector<HTMLElement>("#composer-actions .composer-left-actions");
  if (left) left.innerHTML = composerLeftActions();
  wireSkillInteractions();
  document.querySelector<HTMLButtonElement>("#composer-actions [data-action=attach]")?.addEventListener("click", () => vscode.postMessage({ type: "pickContext" }));
}

function updateRunStateUi(): void {
  const statusLabelEl = document.querySelector<HTMLElement>("#status-row .status-label");
  if (statusLabelEl) statusLabelEl.textContent = statusLabel();
  const statusDotEl = document.querySelector<HTMLElement>("#status-row .status-dot");
  if (statusDotEl) statusDotEl.className = `status-dot ${runState === "running" ? "pulse" : ""}`;

  const actions = document.querySelector<HTMLElement>("#composer-actions");
  if (actions) {
    actions.innerHTML = `
      <div class="composer-left-actions">${composerLeftActions()}</div>
      <div class="composer-right-actions">
        <span class="composer-hint"><span class="key-glyph">↵</span> to send</span>
        ${runState === "running" || runState === "awaiting_approval" ? `<button type="button" class="cancel-button" data-action="cancel" aria-label="Cancel run">cancel</button>` : `<button type="submit" class="send-button" aria-label="Send message">↑</button>`}
      </div>
    `;
    document.querySelector<HTMLButtonElement>("#composer-actions [data-action=cancel]")?.addEventListener("click", () => vscode.postMessage({ type: "cancelRun" }));
    document.querySelector<HTMLButtonElement>("#composer-actions [data-action=attach]")?.addEventListener("click", () => vscode.postMessage({ type: "pickContext" }));
    wireSkillInteractions();
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
    if (workingEl && typeof workingEl.remove === "function") workingEl.remove();
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
    const existingEmpty = document.querySelector<HTMLElement>("#transcript .empty-state");
    if (existingEmpty) {
      const kicker = document.querySelector<HTMLElement>("#transcript .empty-state .kicker");
      if (kicker) kicker.textContent = `${mode.label.toUpperCase()} MODE`;
      return;
    }
    transcript.innerHTML = emptyState(mode.label);
    document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
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

  transcript.innerHTML = renderTimeline() + workingIndicatorHtml;
  scrollToBottom();
}

function renderTimelineItem(item: TimelineItem): string {
  switch (item.kind) {
    case "user_message": {
      const imagePreviews = item.images && item.images.length > 0
        ? `<div class="message-images">${item.images.map((src) => `<img src="${escapeHtml(src)}" class="message-image-thumb" alt="Attached image" />`).join("")}</div>`
        : "";
      return `<article class="message user" id="msg-${item.id}">
        <div class="message-header">
          <span class="message-label">YOU</span>
          <div class="message-actions">
            <button type="button" class="msg-action-btn" data-copy-msg="${item.id}" title="Copy message text">📋 Copy</button>
          </div>
        </div>
        <div class="message-body">${imagePreviews}${formatMarkdown(item.text)}</div>
      </article>`;
    }
    case "assistant_message":
      return `<article class="message assistant" id="msg-${item.id}">
        <div class="message-header">
          <span class="message-label">AGENT</span>
          <div class="message-actions">
            <button type="button" class="msg-action-btn" data-copy-msg="${item.id}" title="Copy response">📋 Copy</button>
          </div>
        </div>
        <div class="message-body">${formatMarkdown(item.text)}${item.isStreaming ? '<span class="streaming-cursor"></span>' : ''}</div>
      </article>`;
    case "system_message":
      return `<article class="message system" id="msg-${item.id}">
        <div class="message-header">
          <span class="message-label">SYSTEM</span>
        </div>
        <div class="message-body">${formatMarkdown(item.text)}</div>
      </article>`;
    case "tool":
      return toolCard(item.tool);
    case "subagent":
      return subagentTree(item.subagent);
    case "plan":
      return planCard(item.plan);
    case "checkpoint":
      return checkpointCard(item.checkpoint);
    case "approval":
      return approvalCard(item.approval);
  }
}

function renderTimeline(): string {
  const ids = new Set(timeline.filter((item): item is Extract<TimelineItem, { kind: "subagent" }> => item.kind === "subagent").map((item) => item.id));
  return timeline
    .filter((item) => item.kind !== "subagent" || !item.subagent.parentRunId || !ids.has(item.subagent.parentRunId))
    .map(renderTimelineItem)
    .join("");
}

function subagentTree(item: SubagentActivity): string {
  const children = timeline
    .filter((entry): entry is Extract<TimelineItem, { kind: "subagent" }> => entry.kind === "subagent" && entry.subagent.parentRunId === item.id)
    .map((entry) => subagentTree(entry.subagent))
    .join("");
  return `<div class="subagent-node" id="subagent-${safeCssToken(item.id)}">${subagentCard(item)}${children ? `<div class="subagent-children">${children}</div>` : ""}</div>`;
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
    renderTranscript();
    return;
  }

  const newItem: TimelineItem = { kind: "subagent", id: subagent.id, subagent };
  timeline.push(newItem);

  renderTranscript();
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
            <p class="eyebrow">CLANK / CONFIGURATION</p>
            <h1>Clank settings</h1>
          </div>
        </div>
        <div class="header-actions">
          <button class="icon-button theme-toggle-btn" data-action="toggle-theme" aria-label="Toggle theme" title="${currentTheme === "beige" ? "Switch to Charcoal (Dark)" : "Switch to Warm Beige (Light)"}">${currentTheme === "beige" ? sunIconSvg(15) : moonIconSvg(15)}</button>
          <button class="icon-button" data-action="back-to-chat" title="Close settings (Esc)">✕</button>
        </div>
      </header>

      <div class="settings-tabs-bar">
        <nav class="settings-tabs" role="tablist">
          <button class="settings-tab ${settingsTab === "modes" ? "active" : ""}" data-tab="modes" role="tab" aria-selected="${settingsTab === "modes"}">
            <span class="tab-glyph">👥</span>
            <span>Modes</span>
            <span class="settings-count">${modesCount}</span>
          </button>
          <button class="settings-tab ${settingsTab === "subagents" ? "active" : ""}" data-tab="subagents" role="tab" aria-selected="${settingsTab === "subagents"}">
            <span class="tab-glyph">🌿</span>
            <span>Subagents</span>
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
        <input id="settings-search" class="settings-search" type="search" value="${escapeHtml(settingsQuery)}" placeholder="Filter ${settingsTab === "modes" ? "modes, tools, models" : settingsTab === "subagents" ? "subagents, authority, steps" : settingsTab === "providers" ? "providers, endpoints, models" : "settings"}…" aria-label="Search settings" />
        ${settingsQuery ? `<button class="clear-search-btn" data-action="clear-search" aria-label="Clear filter">×</button>` : ""}
      </div>

      <main class="settings-body" id="settings-scroll-body">
        ${settingsTab === "modes" ? renderModesTab() : settingsTab === "subagents" ? renderSubagentsTab() : settingsTab === "providers" ? renderProvidersTab() : renderGeneralTab()}
      </main>
    </section>`;
  wireSettingsInteractions();
}

let isAddingProvider = false;
let editingProfileId: string | null = null;
let editingApiKeyProfileId: string | null = null;
let selectedProviderPresetId: string | undefined;
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
            ${item.provider ? `<span class="meta-badge">Provider: <b>${escapeHtml(item.provider)}</b></span>` : ""}
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
        <h3>New Clank Mode</h3>
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
        <label for="mode-provider">Provider Route (Optional)</label>
        <select id="mode-provider" class="setting-select"><option value="">Inherit active provider</option>${(settingsState?.profiles ?? []).map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("")}</select>
      </div>

      <div class="form-row">
        <div class="form-field">
          <label for="mode-model">Model Route (Optional)</label>
          <input type="text" id="mode-model" placeholder="Provider model id" />
        </div>
        <div class="form-field">
          <label for="mode-model-policy">Model Policy</label>
          <select id="mode-model-policy" class="setting-select"><option value="user-selectable">User-selectable override</option><option value="preferred">Prefer configured model</option><option value="fixed">Fixed configured model</option></select>
        </div>
      </div>

      <div class="form-field">
        <label class="checkbox-label"><input type="checkbox" id="mode-delegation" /> Allow this agent to spawn subagents</label>
        <label class="checkbox-label"><input type="checkbox" id="mode-route-overrides" /> Allow parent task to override this agent's model</label>
        <input type="text" id="mode-allowed-agents" placeholder="Allowed child slugs, comma separated" />
      </div>

      <div class="form-field">
        <label for="mode-skills">Required Skills (Optional)</label>
        <input type="text" id="mode-skills" placeholder="Skill ids, comma separated" />
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

  const sidecarStatus = settingsState?.freebuffSidecarStatus ?? "stopped";
  const detected = settingsState?.detectedFreebuff;

  return `
    <div class="vibeproxy-quick-setup-card">
      <div class="vibeproxy-quick-header">
        <div class="vibeproxy-title-row">
          <span class="vibeproxy-badge">1-Click Connect</span>
          <span class="vibeproxy-title">VibeProxy (Port 8317)</span>
        </div>
      </div>
      <p class="vibeproxy-quick-desc">
        Connect to your local running VibeProxy daemon to automatically pull models from Claude Code, Codex, Gemini, and Kimi.
      </p>
      <div class="vibeproxy-action-row">
        <button type="button" class="settings-action-btn primary vibeproxy-connect-btn" data-action="connect-vibeproxy">
          Connect VibeProxy &amp; Pull Live Models
        </button>
      </div>
    </div>

    <div class="freebuff-quick-setup-card">
      <div class="freebuff-quick-header">
        <div class="freebuff-title-row">
          <span class="freebuff-badge">Auto-Detect &amp; Connect</span>
          <span class="freebuff-title">Freebuff Quick Connect</span>
        </div>
        <span class="sidecar-status-pill ${sidecarStatus === "running" ? "running" : detected ? "detected" : sidecarStatus === "error" ? "error" : "stopped"}">
          ${sidecarStatus === "running" ? "● Sidecar Running (:8080)" : sidecarStatus === "starting" ? "⟳ Starting…" : detected ? "● Local Credentials Found" : "○ Terminal Auth Required"}
        </span>
      </div>
      <p class="freebuff-quick-desc">
        Connect to Freebuff using your local terminal authentication (<code>~/.config/manicode/credentials.json</code>) or sidecar.
      </p>
      ${detected ? `
        <div class="freebuff-detected-banner">
          <div class="freebuff-detected-icon">⚡</div>
          <div class="freebuff-detected-info">
            <b>Local Freebuff Credentials Detected</b>
            <span>User: <strong>${escapeHtml(detected.name || detected.email || "Default")}</strong> ${detected.email && detected.name ? `(${escapeHtml(detected.email)})` : ""}</span>
            <span>Active Model: <strong>${escapeHtml(detected.activeModel || "deepseek/deepseek-v4-flash")}</strong></span>
            <small style="color: var(--forge-muted); font-size: 10px; margin-top: 2px;">Note: Freebuff allows 1 active session per account at a time.</small>
            <code>${escapeHtml(detected.source)}</code>
          </div>
        </div>
        <div class="freebuff-action-row">
          <button type="button" class="settings-action-btn primary freebuff-connect-btn" data-action="connect-freebuff-auto">
            ${sidecarStatus === "running" ? "↻ Sync Freebuff Models" : `⚡ Connect as ${escapeHtml(detected.name || "Detected User")} & Auto-Start`}
          </button>
          ${sidecarStatus === "running" ? `<button type="button" class="settings-action-btn secondary freebuff-stop-btn" data-action="toggle-freebuff-sidecar">■ Stop</button>` : ""}
        </div>` : `
        <div class="freebuff-cli-instruction">
          <p>Authenticate once in your terminal to enable automatic token discovery:</p>
          <div class="freebuff-cmd-box">
            <code>npm i -g freebuff && freebuff</code>
            <button type="button" class="copy-cmd-btn" data-copy="npm i -g freebuff && freebuff" title="Copy command to clipboard">Copy</button>
          </div>
        </div>
        <div class="freebuff-action-row">
          <button type="button" class="settings-action-btn primary freebuff-connect-btn" data-action="connect-freebuff-auto">
            ⚡ Auto-Detect &amp; Connect
          </button>
          <button type="button" class="settings-action-btn secondary" data-action="toggle-freebuff-manual">
            ${showFreebuffManualInput ? "Hide Manual Input" : "Manual Paste"}
          </button>
        </div>
        ${showFreebuffManualInput ? `
          <form class="freebuff-setup-form" id="freebuff-setup-form" style="margin-top: 8px;">
            <div class="freebuff-step-row input-row">
              <input type="password" id="freebuff-token-input" class="setting-input" placeholder="Paste Freebuff authToken here…" required />
              <button type="submit" class="settings-action-btn primary freebuff-connect-btn">Connect &amp; Start</button>
            </div>
          </form>
        ` : ""}
      `}
    </div>

    <div class="aihubmix-quick-setup-card">
      <div class="aihubmix-quick-header">
        <div class="aihubmix-title-row">
          <span class="aihubmix-badge">1-Click Connect</span>
          <span class="aihubmix-title">AI HubMix (Inferera API)</span>
        </div>
        <span class="sidecar-status-pill ${settingsState?.profiles.find((p) => p.id === "aihubmix") ? "running" : "stopped"}">
          ${(() => {
            const prof = settingsState?.profiles.find((p) => p.id === "aihubmix");
            if (!prof) return "○ Ready to Connect";
            if (prof.isActive) return "● Active";
            return `● Added (${prof.models.length} models)`;
          })()}
        </span>
      </div>
      <p class="aihubmix-quick-desc">
        Multi-model gateway (https://api.inferera.com) for Claude 3.7, GPT-4o, DeepSeek R1, Qwen, and Gemini.
      </p>
      <form class="aihubmix-setup-form" id="aihubmix-setup-form">
        <div class="aihubmix-step-row input-row">
          <input type="password" id="aihubmix-key-input" class="setting-input" placeholder="${settingsState?.profiles.find((p) => p.id === "aihubmix")?.hasApiKey ? "API Key is configured (paste to update)…" : "Paste your AI HubMix API key (sk-…)…"}" ${settingsState?.profiles.find((p) => p.id === "aihubmix")?.hasApiKey ? "" : "required"} />
          <button type="submit" class="settings-action-btn primary aihubmix-connect-btn">
            ${settingsState?.profiles.find((p) => p.id === "aihubmix") ? "Update & Pull Models" : "Connect & Pull Models"}
          </button>
        </div>
      </form>
    </div>

    <div class="settings-actions-bar">
      <button class="settings-action-btn full-width" data-action="add-profile">＋ Add Provider Profile</button>
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
                <span>${profile.models.length ? `${profile.models.length} available (${profile.models.slice(0, 3).map((m) => escapeHtml(m.id)).join(", ")}${profile.models.length > 3 ? `, +${profile.models.length - 3} more` : ""})` : "0 discovered (auto-discovers on API key save)"}</span>
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

const DEFAULT_PRESETS_FALLBACK: ProviderPresetView[] = [
  { id: "openai", name: "OpenAI", description: "OpenAI official endpoints", category: "cloud", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { id: "openrouter", name: "OpenRouter", description: "Universal API gateway", category: "cloud", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", name: "Ollama", description: "Local model runner", category: "local", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "vllm", name: "vLLM", description: "Local high-throughput engine", category: "local", baseUrl: "http://127.0.0.1:8000/v1" },
  { id: "deepseek", name: "DeepSeek", description: "DeepSeek API", category: "cloud", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
  { id: "vibeproxy", name: "VibeProxy", description: "Local subscription proxy (8317)", category: "proxy", baseUrl: "http://127.0.0.1:8317/v1", helpText: "Launch VibeProxy, connect an account, then fetch its live model catalog." },
  { id: "freebuff2api", name: "Freebuff2API", description: "Local Freebuff proxy (8080)", category: "proxy", baseUrl: "http://127.0.0.1:8080/v1", helpText: "Launch Freebuff2API or use the 1-click Freebuff connector above." },
];

function renderProviderForm(editingProfile?: ProviderProfileView): string {
  const isEditing = Boolean(editingProfile);
  const profileName = editingProfile?.name ?? "";
  const profileUrl = editingProfile?.baseUrl ?? "";
  const profileDefaultModel = editingProfile?.defaultModel ?? "";
  const hasKey = editingProfile?.hasApiKey ?? false;
  const presets = (settingsState?.providerPresets && settingsState.providerPresets.length > 0)
    ? settingsState.providerPresets
    : DEFAULT_PRESETS_FALLBACK;
  const selectedPreset = selectedProviderPresetId ? presets.find((item) => item.id === selectedProviderPresetId) : undefined;

  return `
    <form class="settings-form-card" id="provider-form" data-profile-id="${escapeHtml(editingProfile?.id ?? "")}">
      <div class="form-header">
        <h3>${isEditing ? `Edit “${escapeHtml(editingProfile!.name)}”` : "Add Provider Profile"}</h3>
        <button type="button" class="close-form-btn" data-action="cancel-provider-form" title="Close">✕</button>
      </div>

      <div class="preset-pills">
        <span class="preset-label">Presets:</span>
        ${presets.map((preset) => `<button type="button" class="preset-pill ${selectedPreset?.id === preset.id ? "selected" : ""}" data-preset="${escapeHtml(preset.id)}" title="${escapeHtml(preset.description)}">${escapeHtml(preset.name)}${preset.category === "proxy" ? " (Proxy)" : preset.category === "local" ? " (Local)" : ""}</button>`).join("")}
      </div>
      <div id="provider-preset-help">${selectedPreset ? providerPresetHelp(selectedPreset) : ""}</div>

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

function providerPresetHelp(preset: ProviderPresetView): string {
  const help = preset.helpText ?? preset.description;
  return `<div class="provider-preset-help"><b>${escapeHtml(preset.name)}</b><span>${escapeHtml(help)}</span>${preset.helpUrl ? `<code>${escapeHtml(preset.helpUrl)}</code>` : ""}</div>`;
}

function renderSubagentsTab(): string {
  const subagentsState = settingsState?.subagents;
  const authority = subagentsState?.defaultAuthority ?? "read-only";
  const subagentSteps = subagentsState?.maxSteps ?? 15;
  const turnSteps = settingsState?.maxSteps ?? 20;
  const concurrent = subagentsState?.maxConcurrent ?? 3;
  const total = subagentsState?.maxTotal ?? 8;
  const depth = subagentsState?.maxDepth ?? 1;
  const requireApproval = subagentsState?.requireWriteApproval ?? true;

  const builtInSubagentsList = [
    { slug: "explore", name: "Explore", desc: "Read-only codebase investigator for searching, grepping, and reading files.", defaultAuth: "read-only", icon: "🔍" },
    { slug: "general", name: "General", desc: "Broad autonomous worker for bounded execution and synthesis.", defaultAuth: "write", icon: "⚡" },
    { slug: "test", name: "Test", desc: "Validation specialist for running test runners, linters, and diagnostics.", defaultAuth: "read-only", icon: "🧪" },
    { slug: "review", name: "Review", desc: "Code and architecture reviewer producing prioritized findings.", defaultAuth: "read-only", icon: "📋" },
    { slug: "research", name: "Research", desc: "Documentation and repository evidence gathering specialist.", defaultAuth: "read-only", icon: "📚" },
    { slug: "implementer", name: "Implementer", desc: "Implementation worker permitted to edit code and create files.", defaultAuth: "write", icon: "🛠" },
  ];

  return `
    <div class="subagents-settings">
      <div class="general-setting-item">
        <label for="subagent-authority">Subagent Authority Level</label>
        <p class="setting-help">Controls whether delegated subagents can make code changes and edit files or only perform read-only analysis.</p>
        <select id="subagent-authority" class="setting-select">
          <option value="read-only" ${authority === "read-only" ? "selected" : ""}>Read-Only (Safest) — Subagents cannot modify any files</option>
          <option value="same-as-parent" ${authority === "same-as-parent" ? "selected" : ""}>Same as Parent — Inherit write capability if parent mode allows writing</option>
          <option value="write" ${authority === "write" ? "selected" : ""}>Write Authority — Permit write-capable subagents (Implementer, General) to modify files</option>
        </select>
        
        <div style="margin-top: 12px;">
          <label class="checkbox-label" style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--forge-text);">
            <input type="checkbox" id="subagent-require-approval" ${requireApproval ? "checked" : ""} />
            Require user confirmation before spawning write-capable subagents
          </label>
        </div>
      </div>

      <div class="general-setting-item">
        <label>Execution &amp; Step Budgets</label>
        <p class="setting-help">Configure autonomous loop limits and worker bounds for subagent runs.</p>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px;">
          <div>
            <label for="subagent-max-steps" style="font-size: 11px; font-weight: 500;">Subagent Step Budget</label>
            <p class="setting-help" style="margin-bottom: 4px;">Max steps per subagent.</p>
            <input id="subagent-max-steps" class="setting-input" type="number" min="1" max="50" value="${subagentSteps}" />
          </div>
          <div>
            <label for="parent-turn-max-steps" style="font-size: 11px; font-weight: 500;">Turn Step Budget</label>
            <p class="setting-help" style="margin-bottom: 4px;">Max steps for parent turn.</p>
            <input id="parent-turn-max-steps" class="setting-input" type="number" min="1" max="100" value="${turnSteps}" />
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
          <div>
            <label for="subagent-max-concurrent" style="font-size: 11px; font-weight: 500;">Max Concurrent Workers</label>
            <p class="setting-help" style="margin-bottom: 4px;">Parallel subagents running simultaneously.</p>
            <input id="subagent-max-concurrent" class="setting-input" type="number" min="1" max="8" value="${concurrent}" />
          </div>
          <div>
            <label for="subagent-max-total" style="font-size: 11px; font-weight: 500;">Max Total Subagents</label>
            <p class="setting-help" style="margin-bottom: 4px;">Max spawned subagents per turn.</p>
            <input id="subagent-max-total" class="setting-input" type="number" min="1" max="16" value="${total}" />
          </div>
        </div>

        <div style="margin-top: 10px;">
          <label for="subagent-max-depth" style="font-size: 11px; font-weight: 500;">Delegation Nesting Depth</label>
          <p class="setting-help" style="margin-bottom: 4px;">How deep subagents can recursively delegate to children.</p>
          <select id="subagent-max-depth" class="setting-select">
            <option value="1" ${depth === 1 ? "selected" : ""}>Depth 1 — Direct delegation only (Parent ➔ Subagent)</option>
            <option value="2" ${depth === 2 ? "selected" : ""}>Depth 2 — Nested delegation (Orchestrator ➔ Subagent ➔ Child Subagent)</option>
            <option value="0" ${depth === 0 ? "selected" : ""}>Depth 0 — Disable subagent spawning</option>
          </select>
        </div>

        <div style="margin-top: 14px;">
          <button type="button" class="settings-action-btn primary" id="btn-save-subagents">Save Subagent Settings</button>
        </div>
      </div>

      <div class="general-setting-item">
        <label>Available Subagent Directory</label>
        <p class="setting-help">Specialized agents available for orchestration and task delegation in this workspace.</p>
        <div class="subagent-directory-grid" style="display: grid; gap: 8px; margin-top: 8px;">
          ${builtInSubagentsList.map((agent) => `
            <div class="subagent-dir-card" style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--forge-border); border-radius: var(--forge-radius-sm); background: var(--forge-surface-2);">
              <span style="font-size: 16px;">${agent.icon}</span>
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <b style="font-size: 11.5px; color: var(--forge-text);">${escapeHtml(agent.name)} <code style="font-size: 9.5px; opacity: 0.7;">task:${agent.slug}</code></b>
                  <span style="font-size: 9px; font-family: var(--forge-code); padding: 1px 5px; border-radius: 3px; background: ${agent.defaultAuth === "write" ? "rgba(245, 158, 11, 0.15); color: #f59e0b;" : "rgba(59, 130, 246, 0.15); color: #3b82f6;"}">${agent.defaultAuth === "write" ? "WRITE-CAPABLE" : "READ-ONLY"}</span>
                </div>
                <p style="margin: 3px 0 0; font-size: 10.5px; color: var(--forge-text-secondary); line-height: 1.35;">${escapeHtml(agent.desc)}</p>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    </div>`;
}

function renderGeneralTab(): string {
  const currentDefaultMode = settingsState?.defaultMode ?? activeMode;
  const currentMaxSteps = settingsState?.maxSteps ?? 20;

  return `
    <div class="general-settings">
      <div class="general-setting-item">
        <label>Theme Appearance</label>
        <p class="setting-help">Choose between minimalist Charcoal (Dark) and Warm Beige (Light) paper aesthetic.</p>
        <div class="theme-switcher-grid">
          <button type="button" class="theme-option-btn ${currentTheme === "charcoal" ? "active" : ""}" data-theme-choice="charcoal">
            <span class="theme-preview charcoal"></span>
            <span>Charcoal (Dark)</span>
          </button>
          <button type="button" class="theme-option-btn ${currentTheme === "beige" ? "active" : ""}" data-theme-choice="beige">
            <span class="theme-preview beige"></span>
            <span>Warm Beige (Light)</span>
          </button>
        </div>
      </div>

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
  return `
    <div class="empty-state">
      <div class="clank-hero-orb">
        <svg class="clank-orb-svg" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="80" cy="80" r="48" fill="#121319" stroke="rgba(255,255,255,0.08)" stroke-width="1.2"/>
          <g transform="translate(80, 80) scale(0.68) translate(-50, -50)">
            <path d="M46 28 L24 50 L46 72" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M46 28 L51 34" stroke="#71717a" stroke-width="6" stroke-linecap="round"/>
            <path d="M46 72 L51 66" stroke="#71717a" stroke-width="6" stroke-linecap="round"/>
            <path d="M54 28 L76 50 L54 72" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M54 28 L49 34" stroke="#71717a" stroke-width="6" stroke-linecap="round"/>
            <path d="M54 72 L49 66" stroke="#71717a" stroke-width="6" stroke-linecap="round"/>
          </g>
        </svg>
      </div>
      <p class="kicker">${mode.toUpperCase()} MODE</p>
      <h2>Make a <span class="highlight-blue">sharp</span> start.</h2>
      <p class="empty-copy">Point me at a problem, a file, or a decision. I’ll keep the work grounded in your workspace.</p>
      <div class="starter-grid">
        <button data-prompt="Map the architecture of this workspace" class="starter">
          <span class="starter-left">
            <span class="starter-icon map">${mapIconSvg()}</span>
            <span>Map this workspace</span>
          </span>
          <span class="starter-arrow">${arrowRightSvg()}</span>
        </button>
        <button data-prompt="What should I work on first?" class="starter">
          <span class="starter-left">
            <span class="starter-icon compass">${compassIconSvg()}</span>
            <span>What should I work on first?</span>
          </span>
          <span class="starter-arrow">${arrowRightSvg()}</span>
        </button>
      </div>
    </div>`;
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
  const activities = item.activities?.length ? `<details class="subagent-activity"><summary>Activity · ${item.activities.length}</summary>${item.activities.map((activity) => `<div class="subagent-activity-row ${activity.state}"><span>${activity.state === "complete" ? "✓" : activity.state === "error" ? "!" : "↻"}</span><b>${escapeHtml(activity.summary)}</b>${activity.detail ? `<pre>${escapeHtml(activity.detail)}</pre>` : ""}</div>`).join("")}</details>` : "";
  const route = [item.providerName ?? item.providerId, item.modelId].filter(Boolean).join(" / ");
  return `<details class="subagent-card" ${item.state === "running" || item.state === "queued" ? "open" : ""}><summary><span class="subagent-icon ${item.state}">${icon}</span><span class="subagent-main"><span class="kicker">SUBAGENT · DEPTH ${item.depth}</span><b>${escapeHtml(item.agent)}</b><small>${escapeHtml(item.task)}</small></span><span class="subagent-state">${item.state}</span></summary>${route ? `<div class="subagent-model">route · ${escapeHtml(route)}</div>` : ""}${activities}${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}${inspected}${changed}${followups}</details>`;
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

function activeSkillIds(): string[] {
  return [...new Set([...mandatorySkillIds, ...selectedSkillIds])];
}

function skillChip(id: string): string {
  const skill = skills.find((item) => item.id === id);
  if (!skill) return "";
  const mandatory = mandatorySkillIds.includes(id);
  const action = mandatory
    ? `<span class="skill-lock" title="Required by the active mode">◆</span>`
    : `<button data-remove-skill="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(skill.name)}">×</button>`;
  return `<span class="skill-chip" title="${escapeHtml(skill.description)}"><span>✦</span>${escapeHtml(skill.name)}${action}</span>`;
}

function imageChip(img: { id: string; name: string; dataUrl: string }): string {
  return `<span class="image-chip" title="${escapeHtml(img.name)}">
    <img src="${escapeHtml(img.dataUrl)}" class="image-chip-thumb" alt="Preview" />
    <span class="image-chip-name">${escapeHtml(img.name)}</span>
    <button type="button" data-remove-image="${escapeHtml(img.id)}" aria-label="Remove image">×</button>
  </span>`;
}

function composerChips(): string {
  return [
    ...attachedImages.map(imageChip),
    ...contextRefs.map(contextChip),
    ...activeSkillIds().map(skillChip),
  ].join("");
}

function composerLeftActions(): string {
  const count = activeSkillIds().length;
  return `<button type="button" class="context-btn" data-action="attach" aria-label="Attach context">＋ context</button>
    <button type="button" class="image-btn" data-action="pick-image" aria-label="Attach image">📷 image</button>
    <input type="file" id="image-file-input" accept="image/*" multiple class="sr-only" style="display:none !important; position:absolute !important; width:0 !important; height:0 !important; opacity:0 !important; pointer-events:none !important;" />
    <button type="button" class="skill-btn ${skillMenuOpen ? "open" : ""}" data-action="skills" aria-label="Choose skills" aria-expanded="${skillMenuOpen}">✦ skills${count ? ` <span>${count}</span>` : ""}</button>`;
}

function skillPicker(): string {
  const rows = skills.map((skill) => {
    const mandatory = mandatorySkillIds.includes(skill.id);
    const checked = mandatory || selectedSkillIds.includes(skill.id);
    const search = `${skill.name} ${skill.description} ${skill.id} ${skill.source ?? ""}`.toLocaleLowerCase();
    return `<button type="button" class="skill-option ${checked ? "selected" : ""}" data-skill-id="${escapeHtml(skill.id)}" data-skill-search="${escapeHtml(search)}" ${mandatory ? "disabled" : ""}>
      <span class="skill-check">${mandatory ? "◆" : checked ? "✓" : ""}</span>
      <span class="skill-copy">
        <b>${escapeHtml(skill.name)}</b>
        <small>${escapeHtml(skill.description || skill.id)}</small>
        ${skill.source ? `<span class="skill-source-path" title="${escapeHtml(skill.source)}">📁 ${escapeHtml(skill.source)}</span>` : ""}
      </span>
      <span class="skill-scope">${escapeHtml(skill.scope)}</span>
    </button>`;
  }).join("");
  return `<section class="skill-picker" aria-label="Available skills">
    <div class="skill-picker-head"><b>Skills</b><small>Loaded for this conversation</small></div>
    <input id="skill-search" type="search" value="${escapeHtml(skillQuery)}" placeholder="Search installed skills…" aria-label="Search skills">
    <div class="skill-options">${rows || `<p class="skill-empty">No installed skills found.</p>`}</div>
  </section>`;
}

function modelMenu(): string {
  const visible = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
  const q = modelQuery.trim().toLowerCase();
  const filtered = q
    ? visible.filter((m) => m.id.toLowerCase().includes(q) || (m.label && m.label.toLowerCase().includes(q)) || (m.hint && m.hint.toLowerCase().includes(q)))
    : visible;

  const items = filtered.length
    ? filtered.map((m) => {
        const isSelected = m.id === activeModel;
        return `<button type="button" class="model-menu-item ${isSelected ? "selected" : ""}" data-model-id="${escapeHtml(m.id)}">
          <span class="model-menu-radio">${isSelected ? "●" : "○"}</span>
          <div class="model-menu-info">
            <span class="model-menu-name">${escapeHtml(m.label || m.id)}</span>
            ${m.hint ? `<span class="model-menu-hint">${escapeHtml(m.hint)}</span>` : ""}
          </div>
          ${isSelected ? `<span class="model-menu-check">✓</span>` : ""}
        </button>`;
      }).join("")
    : `<div class="model-menu-empty">No models match “${escapeHtml(modelQuery)}”</div>`;

  return `<div class="model-menu" id="model-menu" role="menu" aria-label="Choose Model">
    <div class="model-menu-head">
      <b>Select Model</b>
      <span class="model-menu-count">${visible.length} available</span>
    </div>
    <div class="model-menu-search-wrap">
      <input id="model-search" class="model-search" type="search" value="${escapeHtml(modelQuery)}" placeholder="Search ${visible.length} models (e.g. claude, gpt, deepseek)…" aria-label="Search models" autofocus />
    </div>
    <div class="model-menu-list">
      ${items}
    </div>
  </div>`;
}

function wireModelMenuItems(): void {
  document.querySelectorAll<HTMLButtonElement>("#model-menu-container .model-menu-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const modelId = btn.dataset.modelId;
      if (modelId) {
        activeModel = modelId;
        modelMenuOpen = false;
        modelQuery = "";
        vscode.postMessage({ type: "changeModel", modelId });
        updateControlStrip();
      }
    });
  });
}

function wireModelDropdownInteractions(): void {
  const searchInput = document.querySelector<HTMLInputElement>("#model-search");
  searchInput?.addEventListener("input", (e) => {
    modelQuery = (e.target as HTMLInputElement).value;
    const list = document.querySelector<HTMLElement>(".model-menu-list");
    if (list) {
      const visible = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
      const q = modelQuery.trim().toLowerCase();
      const filtered = q
        ? visible.filter((m) => m.id.toLowerCase().includes(q) || (m.label && m.label.toLowerCase().includes(q)) || (m.hint && m.hint.toLowerCase().includes(q)))
        : visible;
      list.innerHTML = filtered.length
        ? filtered.map((m) => {
            const isSelected = m.id === activeModel;
            return `<button type="button" class="model-menu-item ${isSelected ? "selected" : ""}" data-model-id="${escapeHtml(m.id)}">
              <span class="model-menu-radio">${isSelected ? "●" : "○"}</span>
              <div class="model-menu-info">
                <span class="model-menu-name">${escapeHtml(m.label || m.id)}</span>
                ${m.hint ? `<span class="model-menu-hint">${escapeHtml(m.hint)}</span>` : ""}
              </div>
              ${isSelected ? `<span class="model-menu-check">✓</span>` : ""}
            </button>`;
          }).join("")
        : `<div class="model-menu-empty">No models match “${escapeHtml(modelQuery)}”</div>`;
      wireModelMenuItems();
    }
  });

  wireModelMenuItems();
}

function wireModelPickerToggle(): void {
  document.querySelector<HTMLButtonElement>("[data-action=toggle-model-picker]")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    modelMenuOpen = !modelMenuOpen;
    historyOpen = false;
    skillMenuOpen = false;
    updateControlStrip();
    if (modelMenuOpen) {
      setTimeout(() => {
        const search = document.querySelector<HTMLInputElement>("#model-search");
        search?.focus();
        search?.select();
      }, 50);
    }
  });

  if (!modelOutsideClickListenerAttached && typeof document !== "undefined" && typeof document.addEventListener === "function") {
    modelOutsideClickListenerAttached = true;
    document.addEventListener("click", (e) => {
      if (!modelMenuOpen) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const isInside = target.closest(".model-menu") || target.closest("[data-action=toggle-model-picker]");
      if (!isInside) {
        modelMenuOpen = false;
        updateControlStrip();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modelMenuOpen) {
        modelMenuOpen = false;
        updateControlStrip();
      }
    });
  }
}

function postSkillSelection(): void {
  vscode.postMessage({ type: "changeSkills", skillIds: selectedSkillIds });
}

function wireChipInteractions(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-remove-image]").forEach((button) => button.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = button.dataset.removeImage;
    if (!id) return;
    attachedImages = attachedImages.filter((img) => img.id !== id);
    updateContextChips();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-remove-skill]").forEach((button) => button.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = button.dataset.removeSkill;
    if (!id) return;
    selectedSkillIds = selectedSkillIds.filter((skillId) => skillId !== id);
    postSkillSelection();
    updateSkillControls();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-remove-context]").forEach((button) => button.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = button.dataset.removeContext;
    if (!id) return;
    contextRefs = contextRefs.filter((ref) => ref.id !== id);
    vscode.postMessage({ type: "removeContext", refId: id });
    updateContextChips();
  }));
}

let skillOutsideClickListenerAttached = false;

function wireSkillInteractions(): void {
  document.querySelector<HTMLButtonElement>("[data-action=skills]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    skillMenuOpen = !skillMenuOpen;
    updateSkillControls();
    if (skillMenuOpen) document.querySelector<HTMLInputElement>("#skill-search")?.focus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-skill-id]").forEach((button) => button.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = button.dataset.skillId;
    if (!id || mandatorySkillIds.includes(id)) return;
    selectedSkillIds = selectedSkillIds.includes(id)
      ? selectedSkillIds.filter((skillId) => skillId !== id)
      : [...selectedSkillIds, id];
    postSkillSelection();
    updateSkillControls();
  }));
  document.querySelector<HTMLInputElement>("#skill-search")?.addEventListener("input", (event) => {
    skillQuery = (event.target as HTMLInputElement).value;
    const query = skillQuery.trim().toLocaleLowerCase();
    document.querySelectorAll<HTMLElement>("[data-skill-search]").forEach((row) => {
      row.hidden = query.length > 0 && !(row.dataset.skillSearch ?? "").includes(query);
    });
  });

  if (!skillOutsideClickListenerAttached && typeof document !== "undefined" && typeof document.addEventListener === "function") {
    skillOutsideClickListenerAttached = true;
    document.addEventListener("click", (e) => {
      if (!skillMenuOpen) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const isInside = target.closest(".skill-picker") || target.closest("[data-action=skills]");
      if (!isInside) {
        skillMenuOpen = false;
        updateSkillControls();
      }
    });
  }

  wireChipInteractions();
}

function wireChatInteractions(): void {
  wireSkillInteractions();

  // Paste image directly into textarea
  const inputEl = document.querySelector<HTMLTextAreaElement>("#composer-input");
  inputEl?.addEventListener("paste", (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          const reader = new FileReader();
          reader.onload = (ev) => {
            const dataUrl = ev.target?.result as string;
            if (dataUrl) {
              attachedImages.push({
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name: file.name || `pasted-image-${attachedImages.length + 1}.png`,
                dataUrl,
              });
              updateContextChips();
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }
  });

  // Attach image button
  document.querySelector<HTMLButtonElement>("[data-action=pick-image]")?.addEventListener("click", () => {
    document.querySelector<HTMLInputElement>("#image-file-input")?.click();
  });
  document.querySelector<HTMLInputElement>("#image-file-input")?.addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (dataUrl) {
          attachedImages.push({
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: file.name,
            dataUrl,
          });
          updateContextChips();
        }
      };
      reader.readAsDataURL(file);
    }
    (e.target as HTMLInputElement).value = "";
  });

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
    const rawText = input?.value.trim() ?? "";
    if (!rawText && attachedImages.length === 0) return;
    const text = rawText || (attachedImages.length > 0 ? "Inspect the attached image(s)." : "");
    const images = [...attachedImages];
    timeline.push({
      kind: "user_message",
      id: `user-${Date.now()}`,
      text,
      createdAt: Date.now(),
      ...(images.length > 0 ? { images: images.map((i) => i.dataUrl) } : {}),
    });
    runState = "running";
    vscode.postMessage({
      type: "sendMessage",
      text,
      mode: activeMode,
      modelId: activeModel,
      context: contextRefs,
      skillIds: selectedSkillIds,
      ...(images.length > 0 ? { images } : {}),
    });
    if (input) input.value = "";
    attachedImages = [];
    updateContextChips();
    renderTranscript();
    updateRunStateUi();
  });
  document.querySelector<HTMLTextAreaElement>("#composer-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.querySelector<HTMLFormElement>("#composer-form")?.requestSubmit();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    const input = document.querySelector<HTMLTextAreaElement>("#composer-input");
    if (input) { input.value = button.dataset.prompt ?? ""; input.focus(); }
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-action=toggle-theme]").forEach((btn) => btn.addEventListener("click", () => {
    applyTheme(currentTheme === "beige" ? "charcoal" : "beige");
    render();
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
  document.querySelector<HTMLButtonElement>("[data-action=history]")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    historyOpen = !historyOpen;
    modelMenuOpen = false;
    skillMenuOpen = false;
    updateSessionPicker();
    if (historyOpen) {
      setTimeout(() => {
        const search = document.querySelector<HTMLInputElement>("#session-search");
        search?.focus();
        search?.select();
      }, 50);
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-msg]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.copyMsg;
    const item = timeline.find((t) => t.id === id);
    if (item && "text" in item && item.text && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(item.text);
      const prev = btn.textContent;
      btn.textContent = "✓ Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }
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
  document.querySelectorAll<HTMLButtonElement>("[data-action=new]").forEach((btn) => {
    btn.addEventListener("click", () => startNewSession());
  });
  wireModelPickerToggle();
  for (const action of ["approve", "revise", "save", "discard"] as const) {
    document.querySelector<HTMLButtonElement>(`[data-action=plan-${action}]`)?.addEventListener("click", () => {
      if (!plan) return;
      const type = `${action}Plan` as "approvePlan" | "revisePlan" | "savePlan" | "discardPlan";
      vscode.postMessage({ type, planId: plan.id, revision: plan.revision });
    });
  }
}

function wireSettingsInteractions(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-action=back-to-chat]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.preventDefault();
    currentView = "chat";
    isAddingProvider = false;
    editingProfileId = null;
    editingApiKeyProfileId = null;
    isAddingMode = false;
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.preventDefault();
    const target = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-tab]") ?? btn;
    const tab = target.dataset.tab as "modes" | "subagents" | "providers" | "general" | undefined;
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
    const provider = (document.querySelector<HTMLSelectElement>("#mode-provider")?.value ?? "").trim();
    const modelPolicy = (document.querySelector<HTMLSelectElement>("#mode-model-policy")?.value ?? "user-selectable") as "user-selectable" | "preferred" | "fixed";
    const delegationAllowed = document.querySelector<HTMLInputElement>("#mode-delegation")?.checked ?? false;
    const routeOverrides = document.querySelector<HTMLInputElement>("#mode-route-overrides")?.checked ?? false;
    const allowedAgents = commaSeparatedIds(document.querySelector<HTMLInputElement>("#mode-allowed-agents")?.value ?? "");
    const requiredSkills = commaSeparatedIds(document.querySelector<HTMLInputElement>("#mode-skills")?.value ?? "");
    const instructions = (document.querySelector<HTMLTextAreaElement>("#mode-instructions")?.value ?? "").trim();

    if (!name || !slug || !instructions || (modelPolicy === "fixed" && !model)) return;
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
        provider: provider || undefined,
        modelPolicy,
        delegationAllowed,
        routeOverrides,
        allowedAgents,
        skills: requiredSkills,
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
    selectedProviderPresetId = undefined;
    editingProfileId = null;
    editingApiKeyProfileId = null;
    render();
    document.querySelector<HTMLInputElement>("#provider-name")?.focus();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=connect-vibeproxy]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Connecting…";
    vscode.postMessage({ type: "setupVibeProxy" });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=connect-freebuff-auto]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Connecting…";
    vscode.postMessage({ type: "setupFreebuff" });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=toggle-freebuff-sidecar]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Stopping…";
    vscode.postMessage({ type: "toggleFreebuffSidecar" });
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=toggle-freebuff-manual]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    showFreebuffManualInput = !showFreebuffManualInput;
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    const text = btn.dataset.copy;
    if (text && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-action=open-freebuff-login]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "openExternalUrl", url: "https://freebuff.llm.pm" });
  }));

  document.querySelector<HTMLFormElement>("#freebuff-setup-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const tokenInput = document.querySelector<HTMLInputElement>("#freebuff-token-input");
    const authToken = (tokenInput?.value ?? "").trim();
    if (!authToken) return;
    const btn = document.querySelector<HTMLButtonElement>(".freebuff-connect-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Connecting…";
    }
    vscode.postMessage({ type: "setupFreebuff", authToken });
  });

  document.querySelector<HTMLFormElement>("#aihubmix-setup-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const keyInput = document.querySelector<HTMLInputElement>("#aihubmix-key-input");
    const apiKey = (keyInput?.value ?? "").trim();
    if (!apiKey) return;
    const btn = document.querySelector<HTMLButtonElement>(".aihubmix-connect-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Connecting…";
    }
    vscode.postMessage({ type: "setupAiHubMix", apiKey });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action=cancel-provider-form]").forEach((btn) => btn.addEventListener("click", () => {
    isAddingProvider = false;
    selectedProviderPresetId = undefined;
    editingProfileId = null;
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => btn.addEventListener("click", () => {
    const presetId = btn.dataset.preset;
    const preset = settingsState?.providerPresets.find((item) => item.id === presetId);
    const nameInput = document.querySelector<HTMLInputElement>("#provider-name");
    const urlInput = document.querySelector<HTMLInputElement>("#provider-url");
    const modelInput = document.querySelector<HTMLInputElement>("#provider-model");

    if (!nameInput || !urlInput || !modelInput || !preset) return;
    selectedProviderPresetId = preset.id;
    document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((p) => p.classList.remove("selected"));
    btn.classList.add("selected");
    nameInput.value = preset.name;
    urlInput.value = preset.baseUrl;
    modelInput.value = preset.defaultModel ?? "";
    const help = document.querySelector<HTMLElement>("#provider-preset-help");
    if (help) help.innerHTML = providerPresetHelp(preset);
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
        presetId: selectedProviderPresetId,
        name,
        baseUrl,
        defaultModel: defaultModel || undefined,
        apiKey: key || undefined,
      },
    });
    isAddingProvider = false;
    selectedProviderPresetId = undefined;
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

  document.querySelector<HTMLButtonElement>("#btn-save-subagents")?.addEventListener("click", () => {
    const authority = (document.querySelector<HTMLSelectElement>("#subagent-authority")?.value ?? "read-only") as "read-only" | "same-as-parent" | "write";
    const requireApproval = document.querySelector<HTMLInputElement>("#subagent-require-approval")?.checked ?? true;
    const subagentSteps = Number(document.querySelector<HTMLInputElement>("#subagent-max-steps")?.value ?? 15);
    const turnSteps = Number(document.querySelector<HTMLInputElement>("#parent-turn-max-steps")?.value ?? 20);
    const concurrent = Number(document.querySelector<HTMLInputElement>("#subagent-max-concurrent")?.value ?? 3);
    const total = Number(document.querySelector<HTMLInputElement>("#subagent-max-total")?.value ?? 8);
    const depth = Number(document.querySelector<HTMLSelectElement>("#subagent-max-depth")?.value ?? 1);

    vscode.postMessage({
      type: "saveSubagentSettings",
      defaultAuthority: authority,
      requireWriteApproval: requireApproval,
      maxSteps: subagentSteps,
      maxConcurrent: concurrent,
      maxTotal: total,
      maxDepth: depth,
    });
    vscode.postMessage({
      type: "saveMaxSteps",
      steps: turnSteps,
    });
  });

  document.querySelector<HTMLButtonElement>("[data-action=open-advanced-settings]")?.addEventListener("click", () => {
    vscode.postMessage({ type: "openAdvancedSettings" });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action=toggle-theme]").forEach((btn) => btn.addEventListener("click", () => {
    applyTheme(currentTheme === "beige" ? "charcoal" : "beige");
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((btn) => btn.addEventListener("click", () => {
    const choice = btn.dataset.themeChoice as "charcoal" | "beige" | undefined;
    if (choice) {
      applyTheme(choice);
      render();
    }
  }));
}

function sessionMenu(): string {
  const items = sessions.length
    ? sessions.map((session) => {
      const search = `${session.title} ${session.activeMode} ${session.modelId} ${formatSessionDate(session.updatedAt)}`.toLocaleLowerCase();
      const hidden = historyQuery.trim() && !search.includes(historyQuery.trim().toLocaleLowerCase()) ? " hidden" : "";
      return `<div class="session-item ${session.id === activeSessionId ? "active" : ""}" data-session-search="${escapeHtml(search)}"${hidden}>
        <button class="session-item-open" data-session-id="${escapeHtml(session.id)}" role="menuitem" ${historyBusy ? "disabled" : ""}>
          <span class="session-item-main">
            <b>${escapeHtml(session.title || "Untitled session")}</b>
            <small>${escapeHtml(session.activeMode)} · ${escapeHtml(session.modelId)} · ${formatSessionDate(session.updatedAt)}</small>
          </span>
          <span class="session-item-status ${session.status}">${session.id === activeSessionId ? "open" : session.status === "waiting_for_approval" ? "waiting" : ""}</span>
        </button>
        <div class="session-item-actions" aria-label="Session actions">
          <button type="button" class="session-action-btn" data-session-action="rename" data-action-session-id="${escapeHtml(session.id)}" title="Rename session">✎</button>
          <button type="button" class="session-action-btn" data-session-action="duplicate" data-action-session-id="${escapeHtml(session.id)}" title="Duplicate session">⧉</button>
          <button type="button" class="session-action-btn" data-session-action="export" data-action-session-id="${escapeHtml(session.id)}" title="Export session">⇩</button>
          <button type="button" class="session-action-btn delete-btn" data-session-action="delete" data-action-session-id="${escapeHtml(session.id)}" title="Delete session">×</button>
        </div>
      </div>`;
    }).join("")
    : `<p class="session-empty">No recent sessions in this workspace.</p>`;
  return `
    <div class="session-menu" role="menu" aria-label="Workspace sessions">
      <div class="session-menu-heading">
        <span>SESSION HISTORY</span>
        <button data-action="refresh-sessions" aria-label="Refresh sessions" title="Refresh">↻</button>
      </div>
      <button class="session-new-menu-btn" data-action="new" role="menuitem">
        <span class="new-icon">＋</span>
        <span>Start New Session</span>
      </button>
      <input id="session-search" class="session-search" type="search" value="${escapeHtml(historyQuery)}" placeholder="Search title, mode, or model…" aria-label="Search sessions">
      <div class="session-list">${items}</div>
    </div>`;
}

function wireSessionMenuInteractions(): void {
  document.querySelectorAll<HTMLButtonElement>("#session-menu-container [data-action=new]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startNewSession();
    });
  });
  document.querySelector<HTMLButtonElement>("#session-menu-container [data-action=refresh-sessions]")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: "listSessions" });
  });
  document.querySelector<HTMLInputElement>("#session-search")?.addEventListener("input", (event) => {
    historyQuery = (event.target as HTMLInputElement).value;
    const query = historyQuery.trim().toLocaleLowerCase();
    document.querySelectorAll<HTMLElement>("#session-menu-container [data-session-search]").forEach((row) => {
      row.hidden = query.length > 0 && !(row.dataset.sessionSearch ?? "").includes(query);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#session-menu-container [data-session-id]").forEach((button) => button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sessionId = button.dataset.sessionId;
    if (!sessionId || historyBusy) return;
    historyBusy = true;
    historyOpen = false;
    updateSessionPicker();
    vscode.postMessage({ type: "openSession", sessionId });
  }));
  document.querySelectorAll<HTMLButtonElement>("#session-menu-container [data-session-action]").forEach((button) => button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sessionId = button.dataset.actionSessionId;
    const action = button.dataset.sessionAction;
    if (!sessionId || historyBusy) return;
    if (action === "rename") vscode.postMessage({ type: "renameSession", sessionId });
    if (action === "duplicate") vscode.postMessage({ type: "duplicateSession", sessionId });
    if (action === "export") vscode.postMessage({ type: "exportSession", sessionId });
    if (action === "delete") {
      historyBusy = true;
      vscode.postMessage({ type: "deleteSession", sessionId });
    }
  }));

  if (!historyOutsideClickListenerAttached && typeof document !== "undefined" && typeof document.addEventListener === "function") {
    historyOutsideClickListenerAttached = true;
    document.addEventListener("click", (e) => {
      if (!historyOpen) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const isInside = target.closest("#session-menu-container") || target.closest("[data-action=history]");
      if (!isInside) {
        historyOpen = false;
        updateSessionPicker();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && historyOpen) {
        historyOpen = false;
        updateSessionPicker();
      }
    });
  }
}

let historyOutsideClickListenerAttached = false;

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

function commaSeparatedIds(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter((item) => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(item)))].slice(0, 32);
}

vscode.postMessage({ type: "ready" });
