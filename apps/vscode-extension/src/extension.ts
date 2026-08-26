import * as vscode from "vscode";
import {
  type AgentMode,
  type ExtensionToUiMessage,
  type UiToExtensionMessage,
  type ContextRef,
  MODEL_OPTIONS
} from "./shared/protocol";
import { AgentRuntimeBridge } from "./runtime/bridge";

const VIEW_ID = "agentdock.agentView";
const API_KEY_SECRET = "agentdock.provider.apiKey";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AgentViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
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
    })
  );
}

export function deactivate(): void {
  // The agent bridge owns cancellation. Keeping deactivation side-effect free
  // lets VS Code tear down a run without leaving child processes behind.
}

class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly sessionId = `session-${Date.now().toString(36)}`;
  private mode: AgentMode;
  private modelId: string;
  private readonly runtime: AgentRuntimeBridge;

  public constructor(private readonly context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("agentdock");
    this.mode = normalizeMode(config.get<string>("defaultMode", "ask"));
    this.modelId = config.get<string>("provider.model", "").trim() || config.get<string>("defaultModel", MODEL_OPTIONS[0].id);
    this.runtime = new AgentRuntimeBridge({ context, post: (message) => this.post(message) });
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")]
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    view.onDidDispose(() => {
      this.runtime.cancel(this.sessionId);
      if (this.view === view) this.view = undefined;
    });
  }

  private handleMessage(message: unknown): void {
    if (!isUiToExtensionMessage(message)) return;
    switch (message.type) {
      case "ready":
        this.post({
          type: "initialize",
          sessionId: this.sessionId,
          mode: this.mode,
          modelId: this.modelId,
          workspaceName: vscode.workspace.name
        });
        return;
      case "changeMode":
        this.mode = message.mode;
        this.post({ type: "modeChanged", mode: this.mode });
        return;
      case "changeModel":
        this.modelId = message.modelId;
        this.post({ type: "modelChanged", modelId: this.modelId });
        return;
      case "sendMessage":
        void this.runtime.run({ sessionId: this.sessionId, text: message.text, mode: message.mode, modelId: message.modelId, context: message.context });
        return;
      case "cancelRun":
        this.runtime.cancel(this.sessionId);
        return;
      case "newSession":
        this.runtime.reset(this.sessionId);
        return;
      case "approveTool":
        this.runtime.approve(message.approvalId, "allow");
        return;
      case "denyTool":
        this.runtime.approve(message.approvalId, "deny");
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
    case "openSettings":
      return true;
    case "changeMode":
      return typeof message.mode === "string" && normalizeMode(message.mode) === message.mode;
    case "changeModel":
      return typeof message.modelId === "string" && message.modelId.length > 0 && message.modelId.length <= 256;
    case "approveTool":
    case "denyTool":
      return typeof message.approvalId === "string" && message.approvalId.length <= 256;
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
