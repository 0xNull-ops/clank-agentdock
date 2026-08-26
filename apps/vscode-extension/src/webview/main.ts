import type {
  AgentMode,
  ChatMessage,
  ContextRef,
  ExtensionToUiMessage,
  ToolActivity,
  ToolApproval,
  UiToExtensionMessage
} from "../shared/protocol";

declare function acquireVsCodeApi(): { postMessage(message: UiToExtensionMessage): void };

const vscode = acquireVsCodeApi();
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Agent Harness root element not found");
const appRoot = root;

const modes: Array<{ id: AgentMode; label: string; description: string }> = [
  { id: "ask", label: "Ask", description: "Understand and explain without editing" },
  { id: "plan", label: "Plan", description: "Explore and shape an implementation plan" },
  { id: "architect", label: "Architect", description: "Decide boundaries, interfaces, and tradeoffs" },
  { id: "implement", label: "Implement", description: "Edit, run, test, and iterate" },
  { id: "debug", label: "Debug", description: "Investigate a failure with a hypothesis loop" },
  { id: "review", label: "Review", description: "Inspect changes and report findings" },
  { id: "orchestrate", label: "Orchestrate", description: "Coordinate focused subagents" },
  { id: "custom", label: "Custom", description: "Use a personalized mode definition" }
];
const models = [
  { id: "openai-compatible", label: "Configure model…", hint: "OpenAI-compatible endpoint" }
];

let activeMode: AgentMode = "ask";
let activeModel = "openai-compatible";
let runState: "idle" | "running" | "awaiting_approval" | "complete" | "cancelled" | "error" = "idle";
let contextRefs: ContextRef[] = [];
let messages: ChatMessage[] = [];
let tools: ToolActivity[] = [];
let approval: ToolApproval | undefined;

render();
window.addEventListener("message", (event: MessageEvent<ExtensionToUiMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "initialize":
      activeMode = message.mode;
      activeModel = message.modelId;
      break;
    case "modeChanged":
      activeMode = message.mode;
      break;
    case "modelChanged":
      activeModel = message.modelId;
      break;
    case "runState":
      runState = message.state;
      if (message.state !== "awaiting_approval") approval = undefined;
      break;
    case "assistantMessage":
      messages = [...messages, message.message];
      break;
    case "toolCall":
      tools = [...tools.filter((tool) => tool.id !== message.tool.id), message.tool];
      break;
    case "approvalRequired":
      approval = message.approval;
      runState = "awaiting_approval";
      break;
    case "error":
      messages = [...messages, { id: `error-${Date.now()}`, role: "system", text: message.message, createdAt: Date.now() }];
      runState = "error";
      break;
    case "usageUpdated":
      // Usage is visualized by the compact meter in the header when wired.
      break;
    case "textDelta":
      appendStreamingText(message.text);
      break;
  }
  render();
});

function render(): void {
  const mode = modes.find((item) => item.id === activeMode) ?? modes[0];
  const visibleModels = models.some((item) => item.id === activeModel) ? models : [...models, { id: activeModel, label: activeModel, hint: "configured" }];
  appRoot.innerHTML = `
    <section class="shell">
      <header class="header">
        <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><div><p class="eyebrow">FORGE / LOCAL HARNESS</p><h1>Agent chat</h1></div></div>
        <button class="icon-button" data-action="settings" aria-label="Open Agent Harness settings">⋯</button>
      </header>
      <div class="control-strip">
        <label class="select-wrap mode-select"><span class="mode-dot mode-${mode.id}"></span><span class="sr-only">Mode</span><select id="mode-select">${modes.map((item) => `<option value="${item.id}" ${item.id === activeMode ? "selected" : ""}>${item.label}</option>`).join("")}</select><span class="chevron">⌄</span></label>
        <label class="select-wrap model-select"><span class="model-glyph">◈</span><span class="sr-only">Model</span><select id="model-select">${visibleModels.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeModel ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select><span class="chevron">⌄</span></label>
      </div>
      <div class="status-row"><span class="status-dot ${runState === "running" ? "pulse" : ""}"></span><span>${statusLabel()}</span><span class="status-spacer"></span><span class="context-label">Context <strong>12%</strong></span><span class="context-track"><span style="width:12%"></span></span></div>
      <div class="rule"></div>
      <section class="transcript" id="transcript" aria-live="polite">
        ${messages.length === 0 && tools.length === 0 ? emptyState(mode.label) : `${messages.map(messageCard).join("")}${tools.map(toolCard).join("")}${approval ? approvalCard(approval) : ""}`}
      </section>
      <footer class="composer-wrap">
        ${contextRefs.length ? `<div class="context-chips">${contextRefs.map(contextChip).join("")}</div>` : ""}
        <form class="composer" id="composer-form">
          <textarea id="composer-input" rows="3" placeholder="Ask ${mode.label.toLowerCase()} anything…" aria-label="Message Agent Harness"></textarea>
          <div class="composer-actions"><button type="button" class="quiet-button" data-action="attach" aria-label="Attach context">＋ context</button><span class="composer-hint">⌘ ↵ to send</span>${runState === "running" || runState === "awaiting_approval" ? `<button type="button" class="quiet-button cancel-button" data-action="cancel" aria-label="Cancel run">cancel</button>` : `<button type="submit" class="send-button" aria-label="Send message">↑</button>`}</div>
        </form>
        <div class="composer-meta"><span><span class="live-dot"></span> local session</span><button type="button" class="text-button" data-action="new">new session</button></div>
      </footer>
    </section>`;
  wireInteractions();
  const transcript = document.querySelector<HTMLElement>("#transcript");
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
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

function approvalCard(item: ToolApproval): string {
  return `<article class="approval-card"><div class="approval-heading"><span class="approval-icon">!</span><div><p class="kicker">PERMISSION REQUEST</p><h3>${escapeHtml(item.toolName)}</h3></div><span class="risk ${item.risk}">${item.risk} risk</span></div><p>${escapeHtml(item.summary)}</p><small>${escapeHtml(item.reason)}</small><div class="approval-actions"><button data-action="deny" class="quiet-button">Deny</button><button data-action="approve" class="approve-button">Approve once</button></div></article>`;
}

function contextChip(ref: ContextRef): string {
  return `<span class="context-chip"><span>${ref.kind === "file" ? "▧" : "⌘"}</span>${escapeHtml(ref.label)}<button data-remove-context="${ref.id}" aria-label="Remove ${escapeHtml(ref.label)}">×</button></span>`;
}

function wireInteractions(): void {
  document.querySelector<HTMLSelectElement>("#mode-select")?.addEventListener("change", (event) => {
    activeMode = (event.target as HTMLSelectElement).value as AgentMode;
    vscode.postMessage({ type: "changeMode", mode: activeMode });
  });
  document.querySelector<HTMLSelectElement>("#model-select")?.addEventListener("change", (event) => {
    activeModel = (event.target as HTMLSelectElement).value;
    vscode.postMessage({ type: "changeModel", modelId: activeModel });
  });
  document.querySelector<HTMLFormElement>("#composer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>("#composer-input");
    if (!input?.value.trim()) return;
    const text = input.value.trim();
    messages = [...messages, { id: `user-${Date.now()}`, role: "user", text, createdAt: Date.now() }];
    vscode.postMessage({ type: "sendMessage", text, mode: activeMode, modelId: activeModel, context: contextRefs });
    input.value = "";
    render();
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
  document.querySelector<HTMLButtonElement>("[data-action=settings]")?.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
  document.querySelector<HTMLButtonElement>("[data-action=cancel]")?.addEventListener("click", () => vscode.postMessage({ type: "cancelRun" }));
  document.querySelector<HTMLButtonElement>("[data-action=approve]")?.addEventListener("click", () => { if (approval) vscode.postMessage({ type: "approveTool", approvalId: approval.id }); });
  document.querySelector<HTMLButtonElement>("[data-action=deny]")?.addEventListener("click", () => { if (approval) vscode.postMessage({ type: "denyTool", approvalId: approval.id }); });
  document.querySelectorAll<HTMLButtonElement>("[data-remove-context]").forEach((button) => button.addEventListener("click", () => {
    const refId = button.dataset.removeContext;
    if (!refId) return;
    contextRefs = contextRefs.filter((ref) => ref.id !== refId);
    vscode.postMessage({ type: "removeContext", refId });
    render();
  }));
  document.querySelector<HTMLButtonElement>("[data-action=attach]")?.addEventListener("click", () => {
    const ref: ContextRef = { id: `context-${Date.now()}`, label: "current selection", kind: "selection" };
    contextRefs = [...contextRefs, ref];
    vscode.postMessage({ type: "addContext", ref });
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-action=new]")?.addEventListener("click", () => { messages = []; tools = []; approval = undefined; runState = "idle"; vscode.postMessage({ type: "newSession" }); render(); });
}

function appendStreamingText(text: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") messages = [...messages.slice(0, -1), { ...last, text: last.text + text }];
  else messages = [...messages, { id: `assistant-${Date.now()}`, role: "assistant", text, createdAt: Date.now() }];
}

function statusLabel(): string {
  return runState === "running" ? "Agent is working" : runState === "awaiting_approval" ? "Waiting for approval" : runState === "error" ? "Run needs attention" : "Ready when you are";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

vscode.postMessage({ type: "ready" });
