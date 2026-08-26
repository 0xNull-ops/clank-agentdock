import * as vscode from "vscode";
import type { NormalizedMessage } from "@freebuff/agent-core";
import {
  type AgentMode,
  type ExtensionToUiMessage,
  type UiToExtensionMessage,
  type ContextRef,
  type ChatMessage,
  type ToolActivity,
  MODEL_OPTIONS
} from "./shared/protocol";
import { AgentRuntimeBridge } from "./runtime/bridge";
import { SessionPersistenceCoordinator, type RestoredSession } from "./runtime/session-persistence";
import { CHECKPOINT_DOCUMENT_SCHEME } from "./checkpoint";
import { chatMessagesFromNormalized, sessionHistoryItemFromSession, toolActivitiesFromSnapshot } from "./shared/session-history";

const VIEW_ID = "agentdock.agentView";
const API_KEY_SECRET = "agentdock.provider.apiKey";
const SESSION_LIST_LIMIT = 24;

let sessionPersistence: SessionPersistenceCoordinator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  sessionPersistence = await SessionPersistenceCoordinator.open(context);
  const recent = (await sessionPersistence.list({ limit: 1 }))[0];
  const restored = recent ? await sessionPersistence.restore(recent.id) : undefined;
  const replayMessages = recent ? await sessionPersistence.replayMessages(recent.id) : undefined;
  const snapshot = recent ? await sessionPersistence.openSnapshot(recent.id) : undefined;
  const provider = new AgentViewProvider(context, sessionPersistence, restored, replayMessages, snapshot ? toolActivitiesFromSnapshot(snapshot) : []);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_DOCUMENT_SCHEME, provider.checkpointDocumentProvider()),
    provider.checkpointDocumentProvider(),
    vscode.commands.registerCommand("agentdock.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.agentdock");
    }),
    vscode.commands.registerCommand("agentdock.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "Provider API key", password: true, ignoreFocusOut: true, placeHolder: "Stored securely in VS Code SecretStorage" });
      if (key === undefined) return;
      if (!key.trim()) {
        void vscode.window.showWarningMessage("Agent Harness API key was not changed.");
        return;
      }
      await context.secrets.store(API_KEY_SECRET, key.trim());
      void vscode.window.showInformationMessage("Agent Harness API key stored securely.");
    }),
    vscode.commands.registerCommand("agentdock.clearApiKey", async () => {
      await context.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage("Agent Harness API key cleared.");
    }),
    vscode.commands.registerCommand("agentdock.validateProvider", async () => {
      const config = vscode.workspace.getConfiguration("agentdock.provider");
      const baseUrl = config.get<string>("baseUrl", "").trim();
      if (!baseUrl) {
        void vscode.window.showErrorMessage("Set Agent Harness › Provider: Base URL before validating the provider.");
        return;
      }
      try {
        const modelsUrl = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
        if (modelsUrl.protocol !== "http:" && modelsUrl.protocol !== "https:") throw new Error("Base URL must use http:// or https://");
        const apiKey = await context.secrets.get(API_KEY_SECRET);
        const response = await fetch(modelsUrl, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined });
        if (response.ok) void vscode.window.showInformationMessage("Agent Harness provider is reachable.");
        else void vscode.window.showErrorMessage(`Agent Harness provider returned HTTP ${response.status}. Check its URL and credentials.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Agent Harness provider is unreachable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("agentdock.refreshModels", async () => {
      await provider.refreshModels(true);
    }),
    { dispose: () => { void sessionPersistence?.close(); } }
  );
}

export async function deactivate(): Promise<void> {
  await sessionPersistence?.close();
  sessionPersistence = undefined;
}

class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private sessionId: string;
  private mode: AgentMode;
  private modelId: string;
  private readonly runtime: AgentRuntimeBridge;
  private restoredMessages: ChatMessage[];
  private restoredTools: ToolActivity[];
  private sessionOperations: Promise<void> = Promise.resolve();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly persistence: SessionPersistenceCoordinator,
    restored?: RestoredSession,
    replayMessages?: NormalizedMessage[],
    restoredTools: ToolActivity[] = [],
  ) {
    const config = vscode.workspace.getConfiguration("agentdock");
    this.mode = restored ? normalizeMode(restored.session.activeMode) : normalizeMode(config.get<string>("defaultMode", "ask"));
    this.modelId = restored?.session.modelId
      ?? (config.get<string>("provider.model", "").trim() || config.get<string>("defaultModel", MODEL_OPTIONS[0].id));
    this.sessionId = restored?.session.id ?? `session-${Date.now().toString(36)}`;
    this.restoredMessages = restored ? chatMessagesFromNormalized(restored.messages) : [];
    this.restoredTools = restoredTools;
    this.runtime = new AgentRuntimeBridge({ context, post: (message) => this.post(message) }, persistence);
    if (restored) this.runtime.restoreHistory(restored.session.id, replayMessages ?? restored.messages);
  }

  public async refreshModels(notifyUser = true): Promise<void> {
    await this.runtime.refreshModels(notifyUser);
  }

  public checkpointDocumentProvider(): vscode.TextDocumentContentProvider & vscode.Disposable {
    return this.runtime.checkpointDocumentProvider();
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")]
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => { void this.handleMessage(message); });
    view.onDidDispose(() => {
      this.runtime.cancel(this.sessionId);
      if (this.view === view) this.view = undefined;
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isUiToExtensionMessage(message)) return;
    switch (message.type) {
      case "ready":
        this.post({
          type: "initialize",
          sessionId: this.sessionId,
          mode: this.mode,
          modelId: this.modelId,
          models: this.runtime.cachedModelOptions(this.modelId),
          messages: this.restoredMessages,
          tools: this.restoredTools,
          workspaceName: vscode.workspace.name
        });
        await this.postSessionList();
        void this.runtime.restoreRecentCheckpointCards();
        void this.runtime.refreshModels(false);
        return;
      case "changeMode":
        await this.enqueueSessionOperation(async () => {
          this.mode = message.mode;
          this.post({ type: "modeChanged", mode: this.mode });
          await this.persistence.updateSessionSelection(this.sessionId, { activeMode: this.mode });
        });
        return;
      case "changeModel":
        await this.enqueueSessionOperation(async () => {
          this.modelId = message.modelId;
          this.post({ type: "modelChanged", modelId: this.modelId });
          await this.persistence.updateSessionSelection(this.sessionId, { modelId: this.modelId });
        });
        return;
      case "sendMessage":
        await this.enqueueSessionOperation(async () => {
          void this.runtime.run({ sessionId: this.sessionId, text: message.text, mode: message.mode, modelId: message.modelId, context: message.context })
            .finally(() => this.postSessionList())
            .catch((error) => this.post({ type: "error", kind: "unknown", message: error instanceof Error ? error.message : String(error) }));
        });
        return;
      case "cancelRun":
        this.runtime.cancel(this.sessionId);
        return;
      case "newSession":
        await this.enqueueSessionOperation(() => this.startNewSession());
        return;
      case "listSessions":
        await this.enqueueSessionOperation(() => this.postSessionList());
        return;
      case "openSession":
        await this.enqueueSessionOperation(() => this.openSession(message.sessionId));
        return;
      case "approveTool":
        void this.runtime.approve(message.approvalId, "allow");
        return;
      case "denyTool":
        void this.runtime.approve(message.approvalId, "deny");
        return;
      case "openCheckpointDiff":
        void this.runtime.openCheckpointDiff(message.checkpointId, message.path);
        return;
      case "revertCheckpoint":
        void this.runtime.revertCheckpoint(message.checkpointId);
        return;
      case "addContext":
      case "removeContext":
      case "openSettings":
        if (message.type === "openSettings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:freebuff.freebuff-agent-harness-vscode");
        }
        return;
    }
  }

  private async startNewSession(): Promise<void> {
    const previousSessionId = this.sessionId;
    this.runtime.reset(previousSessionId);
    const session = await this.persistence.newSession({ activeMode: this.mode, modelId: this.modelId });
    this.sessionId = session.id;
    this.restoredMessages = [];
    this.restoredTools = [];
    this.post({
      type: "initialize",
      sessionId: this.sessionId,
      mode: this.mode,
      modelId: this.modelId,
      models: this.runtime.cachedModelOptions(this.modelId),
      messages: [],
      tools: [],
      workspaceName: vscode.workspace.name,
    });
    await this.postSessionList();
  }

  /** Queue stateful session work so an open cannot race a send or new session. */
  private enqueueSessionOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.sessionOperations.then(operation, operation);
    this.sessionOperations = next.catch(() => undefined);
    return next;
  }

  private async postSessionList(): Promise<void> {
    const sessions = await this.persistence.list({ limit: SESSION_LIST_LIMIT });
    this.post({
      type: "sessionList",
      sessions: sessions.map(sessionHistoryItemFromSession),
      activeSessionId: this.sessionId,
    });
  }

  private async openSession(sessionId: string): Promise<void> {
    const previousSessionId = this.sessionId;
    if (sessionId === this.sessionId) {
      await this.postSessionList();
      return;
    }
    this.runtime.cancel(previousSessionId);
    // The list is both the workspace scope check and the source of the item
    // shown in the menu. Do not open an arbitrary id supplied by the webview.
    const listed = (await this.persistence.list({ limit: SESSION_LIST_LIMIT })).find((session) => session.id === sessionId);
    if (!listed) {
      this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
      return;
    }
    const restored = await this.persistence.restore(sessionId);
    if (!restored) {
      this.post({ type: "error", kind: "workspace", message: "The selected session could not be restored." });
      return;
    }
    // replayMessages intentionally remains host-only: the bridge needs the
    // provider frames, while the webview receives only chatMessages below.
    const replayMessages = await this.persistence.replayMessages(sessionId);
    const snapshot = await this.persistence.openSnapshot(sessionId);
    this.runtime.reset(previousSessionId);
    this.sessionId = restored.session.id;
    this.mode = normalizeMode(restored.session.activeMode);
    this.modelId = restored.session.modelId;
    this.restoredMessages = chatMessagesFromNormalized(restored.messages);
    this.restoredTools = snapshot ? toolActivitiesFromSnapshot(snapshot) : [];
    this.runtime.restoreHistory(this.sessionId, replayMessages);
    this.post({
      type: "sessionOpened",
      session: sessionHistoryItemFromSession(restored.session),
      messages: this.restoredMessages,
      tools: this.restoredTools,
    });
    this.post({ type: "runState", state: "idle" });
    await this.postSessionList();
  }

  private post(message: ExtensionToUiMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "styles.css")
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Agent Harness</title>
</head>
<body>
  <main id="app" aria-label="Agent Harness chat"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function normalizeMode(value: string): AgentMode {
  const valid: AgentMode[] = ["ask", "plan", "architect", "implement", "debug", "review", "orchestrate", "custom"];
  return valid.includes(value as AgentMode) ? (value as AgentMode) : "ask";
}

function isUiToExtensionMessage(value: unknown): value is UiToExtensionMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string") return false;
  switch (message.type) {
    case "ready":
    case "cancelRun":
    case "newSession":
    case "listSessions":
    case "openSettings":
      return true;
    case "openSession":
      return typeof message.sessionId === "string" && message.sessionId.length > 0 && message.sessionId.length <= 256;
    case "changeMode":
      return typeof message.mode === "string" && normalizeMode(message.mode) === message.mode;
    case "changeModel":
      return typeof message.modelId === "string" && message.modelId.length > 0 && message.modelId.length <= 256;
    case "approveTool":
    case "denyTool":
      return typeof message.approvalId === "string" && message.approvalId.length <= 256;
    case "openCheckpointDiff":
      return typeof message.checkpointId === "string"
        && message.checkpointId.length > 0
        && message.checkpointId.length <= 256
        && (message.path === undefined || (typeof message.path === "string" && message.path.length <= 4_096));
    case "revertCheckpoint":
      return typeof message.checkpointId === "string" && message.checkpointId.length > 0 && message.checkpointId.length <= 256;
    case "removeContext":
      return typeof message.refId === "string" && message.refId.length <= 256;
    case "addContext":
      return isContextRef(message.ref);
    case "sendMessage":
      return typeof message.text === "string"
        && message.text.length > 0
        && message.text.length <= 100_000
        && typeof message.mode === "string"
        && normalizeMode(message.mode) === message.mode
        && typeof message.modelId === "string"
        && message.modelId.length > 0
        && message.modelId.length <= 256
        && Array.isArray(message.context)
        && message.context.length <= 32
        && message.context.every(isContextRef);
    default:
      return false;
  }
}

function isContextRef(value: unknown): value is ContextRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.id === "string"
    && ref.id.length <= 256
    && typeof ref.label === "string"
    && ref.label.length <= 512
    && ["file", "selection", "folder", "diagnostics"].includes(String(ref.kind))
    && (ref.uri === undefined || (typeof ref.uri === "string" && ref.uri.length <= 4_096));
}
