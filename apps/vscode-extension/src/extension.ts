import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NormalizedMessage } from "@freebuff/agent-core";
import {
  type AgentMode,
  type ExtensionToUiMessage,
  type UiToExtensionMessage,
  type ContextRef,
  type ChatMessage,
  type ToolActivity,
  type SubagentActivity,
  MODEL_OPTIONS
} from "./shared/protocol";
import { AgentRuntimeBridge } from "./runtime/bridge";
import { SessionPersistenceCoordinator, type RestoredSession } from "./runtime/session-persistence";
import {
  ProviderProfileStore,
  ProviderProfileValidationError,
  resolveProfileModel,
  type ProviderProfile,
} from "./runtime/provider-profiles";
import { CHECKPOINT_DOCUMENT_SCHEME } from "./checkpoint";
import { chatMessagesFromNormalized, sessionHistoryItemFromSession, subagentActivityFromRecord, toolActivitiesFromSnapshot } from "./shared/session-history";

const VIEW_ID = "agentdock.agentView";
const SESSION_LIST_LIMIT = 2_000;

let sessionPersistence: SessionPersistenceCoordinator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  sessionPersistence = await SessionPersistenceCoordinator.open(context);
  const providerProfiles = await ProviderProfileStore.open(context, { legacyConfiguration: vscode.workspace.getConfiguration("agentdock") });
  const recent = (await sessionPersistence.list({ limit: 1 }))[0];
  const restored = recent ? await sessionPersistence.restore(recent.id) : undefined;
  const replayMessages = recent ? await sessionPersistence.replayMessages(recent.id) : undefined;
  const snapshot = recent ? await sessionPersistence.openSnapshot(recent.id) : undefined;
  const restoredSubagents = recent ? (await sessionPersistence.listSubagentRuns(recent.id)).map(subagentActivityFromRecord) : [];
  const activeProfile = await providerProfiles.getActiveProfile();
  const provider = new AgentViewProvider(context, sessionPersistence, providerProfiles, restored, replayMessages, snapshot ? toolActivitiesFromSnapshot(snapshot) : [], restoredSubagents, activeProfile ? resolveProfileModel(activeProfile, { mode: restored?.session.activeMode }) : undefined);
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
      const active = await providerProfiles.getActiveProfile();
      if (!active) return provider.manageProviders();
      const key = await vscode.window.showInputBox({ prompt: "Provider API key", password: true, ignoreFocusOut: true, placeHolder: "Stored securely in VS Code SecretStorage" });
      if (key === undefined) return;
      if (!key.trim()) {
        void vscode.window.showWarningMessage("Agent Harness API key was not changed.");
        return;
      }
      await providerProfiles.setApiKey(active.id, key.trim());
      void vscode.window.showInformationMessage("Agent Harness API key stored securely.");
    }),
    vscode.commands.registerCommand("agentdock.clearApiKey", async () => {
      const active = await providerProfiles.getActiveProfile();
      if (!active) return;
      await providerProfiles.clearApiKey(active.id);
      void vscode.window.showInformationMessage("Agent Harness API key cleared.");
    }),
    vscode.commands.registerCommand("agentdock.validateProvider", async () => {
      await provider.validateActiveProvider();
    }),
    vscode.commands.registerCommand("agentdock.manageProviders", async () => provider.manageProviders()),
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
  private restoredSubagents: SubagentActivity[];
  private sessionOperations: Promise<void> = Promise.resolve();
  private readonly contextSnapshots = new Map<string, { ref: ContextRef; snapshot: string }>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly persistence: SessionPersistenceCoordinator,
    private readonly providerProfiles: ProviderProfileStore,
    restored?: RestoredSession,
    replayMessages?: NormalizedMessage[],
    restoredTools: ToolActivity[] = [],
    restoredSubagents: SubagentActivity[] = [],
    initialModelId?: string,
  ) {
    const config = vscode.workspace.getConfiguration("agentdock");
    this.mode = restored ? normalizeMode(restored.session.activeMode) : normalizeMode(config.get<string>("defaultMode", "ask"));
    this.modelId = restored?.session.modelId
      ?? initialModelId
      ?? (config.get<string>("provider.model", "").trim() || config.get<string>("defaultModel", MODEL_OPTIONS[0].id));
    this.sessionId = restored?.session.id ?? `session-${Date.now().toString(36)}`;
    this.restoredMessages = restored ? chatMessagesFromNormalized(restored.messages) : [];
    this.restoredTools = restoredTools;
    this.restoredSubagents = restoredSubagents;
    this.runtime = new AgentRuntimeBridge({ context, post: (message) => this.post(message) }, persistence, providerProfiles);
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
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message).catch((error) => this.post({ type: "error", kind: "unknown", message: error instanceof Error ? error.message : String(error) }));
    });
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
          modelPolicy: this.runtime.modelPolicyState(this.mode),
          models: this.runtime.cachedModelOptions(this.modelId),
          messages: this.restoredMessages,
          tools: this.restoredTools,
          subagents: this.restoredSubagents,
          workspaceName: vscode.workspace.name
        });
        await this.postSessionList();
        void this.runtime.restoreRecentCheckpointCards();
        void this.runtime.refreshModels(false);
        return;
      case "changeMode":
        await this.enqueueSessionOperation(async () => {
          this.mode = message.mode;
          const profile = await this.providerProfiles.getActiveProfile();
          const modeModel = profile?.modeDefaults[this.mode];
          if (modeModel) {
            this.modelId = modeModel;
            this.post({ type: "modelChanged", modelId: this.modelId });
          }
          this.post({ type: "modeChanged", mode: this.mode });
          this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
          await this.persistence.updateSessionSelection(this.sessionId, { activeMode: this.mode, ...(modeModel ? { modelId: modeModel } : {}) });
        });
        return;
      case "changeModel":
        await this.enqueueSessionOperation(async () => {
          const policy = this.runtime.modelPolicyState(this.mode);
          if (policy.policy === "fixed") {
            this.post({ type: "modelPolicyChanged", modelPolicy: policy });
            void vscode.window.showInformationMessage(policy.reason ?? "The active mode fixes its model.");
            return;
          }
          this.modelId = message.modelId;
          this.post({ type: "modelChanged", modelId: this.modelId });
          await this.persistence.updateSessionSelection(this.sessionId, { modelId: this.modelId });
        });
        return;
      case "sendMessage":
        await this.enqueueSessionOperation(async () => {
          const context = message.context.flatMap(({ id }) => {
            const stored = this.contextSnapshots.get(id);
            return stored ? [{ ...stored.ref, snapshot: stored.snapshot }] : [];
          });
          void this.runtime.run({ sessionId: this.sessionId, text: message.text, mode: message.mode, modelId: message.modelId, context })
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
      case "renameSession":
        await this.enqueueSessionOperation(() => this.renameSession(message.sessionId));
        return;
      case "duplicateSession":
        await this.enqueueSessionOperation(() => this.duplicateSession(message.sessionId));
        return;
      case "deleteSession":
        await this.enqueueSessionOperation(() => this.deleteSession(message.sessionId));
        return;
      case "exportSession":
        await this.enqueueSessionOperation(() => this.exportSession(message.sessionId));
        return;
      case "pickContext":
        await this.pickContext();
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
      case "removeContext":
        this.contextSnapshots.delete(message.refId);
        return;
      case "openSettings":
        await this.manageProviders();
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
    this.contextSnapshots.clear();
    this.post({
      type: "initialize",
      sessionId: this.sessionId,
      mode: this.mode,
      modelId: this.modelId,
      models: this.runtime.cachedModelOptions(this.modelId),
      modelPolicy: this.runtime.modelPolicyState(this.mode),
      messages: [],
      tools: [],
      subagents: [],
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
    // Resolve directly through the coordinator's workspace guard so a valid
    // older session remains openable even when it is outside the visible list.
    const listed = await this.persistence.getSession(sessionId);
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
    const restoredSubagents = (await this.persistence.listSubagentRuns(sessionId)).map(subagentActivityFromRecord);
    this.runtime.reset(previousSessionId);
    this.sessionId = restored.session.id;
    this.mode = normalizeMode(restored.session.activeMode);
    this.modelId = restored.session.modelId;
    this.restoredMessages = chatMessagesFromNormalized(restored.messages);
    this.restoredTools = snapshot ? toolActivitiesFromSnapshot(snapshot) : [];
    this.restoredSubagents = restoredSubagents;
    this.contextSnapshots.clear();
    this.runtime.restoreHistory(this.sessionId, replayMessages);
    this.post({
      type: "sessionOpened",
      session: sessionHistoryItemFromSession(restored.session),
      modelPolicy: this.runtime.modelPolicyState(this.mode),
      messages: this.restoredMessages,
      tools: this.restoredTools,
      subagents: this.restoredSubagents,
    });
    this.post({ type: "runState", state: "idle" });
    await this.postSessionList();
  }

  private async renameSession(sessionId: string): Promise<void> {
    const session = await this.persistence.getSession(sessionId);
    if (!session) return this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
    const title = await vscode.window.showInputBox({
      title: "Rename Agent Harness session",
      value: session.title,
      prompt: "Use a short title that will be easy to find later.",
      validateInput: (value) => !value.trim() ? "Enter a session title." : [...value.trim()].length > 200 ? "Use 200 characters or fewer." : undefined,
    });
    if (title === undefined) return;
    await this.persistence.renameSession(sessionId, title);
    await this.postSessionList();
  }

  private async duplicateSession(sessionId: string): Promise<void> {
    if (this.runtime.isRunning(sessionId)) return this.post({ type: "error", kind: "workspace", message: "Cancel the active run before duplicating this session." });
    const duplicate = await this.persistence.duplicateSession(sessionId);
    if (!duplicate) return this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
    await this.openSession(duplicate.id);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (this.runtime.isRunning(sessionId)) return this.post({ type: "error", kind: "workspace", message: "Cancel the active run before deleting this session." });
    const session = await this.persistence.getSession(sessionId);
    if (!session) return this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
    const confirmed = await vscode.window.showWarningMessage(
      `Delete “${session.title}” and its local transcript?`,
      { modal: true, detail: "This removes messages, tool records, approvals, and usage stored by Agent Harness." },
      "Delete",
    );
    if (confirmed !== "Delete") return;
    this.runtime.cancel(sessionId);
    if (!await this.persistence.deleteSession(sessionId)) return;
    if (sessionId === this.sessionId) await this.startNewSession();
    else await this.postSessionList();
  }

  private async exportSession(sessionId: string): Promise<void> {
    if (this.runtime.isRunning(sessionId)) return this.post({ type: "error", kind: "workspace", message: "Wait for the active run to finish, or cancel it before exporting." });
    const exported = await this.persistence.exportSession(sessionId);
    if (!exported) return this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
    const format = await vscode.window.showQuickPick([
      { label: "Markdown", description: "Readable transcript without provider-private frames", extension: "md" as const },
      { label: "JSON", description: "Structured safe export without provider-private frames", extension: "json" as const },
    ], { title: "Export Agent Harness session" });
    if (!format) return;
    const slug = exported.session.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "agent-session";
    const uri = await vscode.window.showSaveDialog({
      title: "Export Agent Harness session",
      defaultUri: vscode.Uri.file(`${slug}.${format.extension}`),
      filters: format.extension === "md" ? { Markdown: ["md"] } : { JSON: ["json"] },
    });
    if (!uri) return;
    const body = format.extension === "json" ? `${JSON.stringify(exported, null, 2)}\n` : sessionMarkdown(exported);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(body));
    void vscode.window.showInformationMessage(`Exported “${exported.session.title}”.`);
  }

  private async pickContext(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const activeUri = editor?.document.uri;
    const activeInWorkspace = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    const selection = editor && !editor.selection.isEmpty && activeInWorkspace
      ? editor.document.getText(editor.selection).slice(0, 32_000)
      : "";
    type ContextChoice = vscode.QuickPickItem & { contextKind: "selection" | "active-file" | "choose-file" | "folder" | "diagnostics"; uri?: vscode.Uri };
    const choices: ContextChoice[] = [];
    if (selection) choices.push({ label: "Current selection", description: vscode.workspace.asRelativePath(activeUri!), contextKind: "selection", uri: activeUri });
    if (activeInWorkspace) choices.push({ label: "Active file", description: vscode.workspace.asRelativePath(activeUri!), contextKind: "active-file", uri: activeUri });
    choices.push({ label: "Choose workspace file…", description: "Attach a text snapshot", contextKind: "choose-file" });
    for (const folder of vscode.workspace.workspaceFolders ?? []) choices.push({ label: `Folder: ${folder.name}`, description: "Attach a bounded directory listing", contextKind: "folder", uri: folder.uri });
    choices.push({ label: "Workspace diagnostics", description: "Attach current Problems diagnostics", contextKind: "diagnostics" });
    const picked = await vscode.window.showQuickPick(choices, { title: "Add context to Agent Harness", placeHolder: "Context is captured as a bounded snapshot" });
    if (!picked) return;

    let uri = picked.uri;
    if (picked.contextKind === "choose-file") {
      uri = (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: "Attach file" }))?.[0];
      if (!uri) return;
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        void vscode.window.showWarningMessage("Agent Harness context files must be inside the current workspace.");
        return;
      }
    }
    if (uri && picked.contextKind !== "diagnostics" && !await isCanonicalWorkspaceUri(uri)) {
      void vscode.window.showWarningMessage("Agent Harness refused context that resolves outside the current workspace.");
      return;
    }

    let ref: ContextRef;
    let snapshot: string;
    if (picked.contextKind === "selection") {
      ref = { id: contextId(), label: `Selection · ${vscode.workspace.asRelativePath(uri!)}`, kind: "selection", uri: uri!.toString(true) };
      snapshot = selection;
    } else if (picked.contextKind === "active-file" || picked.contextKind === "choose-file") {
      const bytes = await vscode.workspace.fs.readFile(uri!);
      snapshot = new TextDecoder().decode(bytes.subarray(0, 64_000));
      ref = { id: contextId(), label: vscode.workspace.asRelativePath(uri!), kind: "file", uri: uri!.toString(true) };
    } else if (picked.contextKind === "folder") {
      const entries = (await vscode.workspace.fs.readDirectory(uri!)).slice(0, 200);
      snapshot = entries.map(([name, type]) => `${type === vscode.FileType.Directory ? "dir" : "file"}\t${name}`).join("\n");
      ref = { id: contextId(), label: vscode.workspace.asRelativePath(uri!, false) || picked.label, kind: "folder", uri: uri!.toString(true) };
    } else {
      const diagnostics = vscode.languages.getDiagnostics()
        .filter(([diagnosticUri]) => Boolean(vscode.workspace.getWorkspaceFolder(diagnosticUri)))
        .flatMap(([diagnosticUri, items]) => items.map((item) => `${vscode.workspace.asRelativePath(diagnosticUri)}:${item.range.start.line + 1}: ${item.message}`));
      snapshot = diagnostics.slice(0, 500).join("\n") || "No workspace diagnostics.";
      ref = { id: contextId(), label: "Workspace diagnostics", kind: "diagnostics" };
    }
    this.contextSnapshots.set(ref.id, { ref, snapshot });
    this.post({ type: "contextAdded", ref });
  }

  public async manageProviders(): Promise<void> {
    const profiles = await this.providerProfiles.listProfiles();
    const activeId = await this.providerProfiles.getActiveProfileId();
    type ProfilePick = vscode.QuickPickItem & { profile?: ProviderProfile; add?: true };
    const picked = await vscode.window.showQuickPick<ProfilePick>([
      { label: "$(add) Add provider profile", description: "OpenAI-compatible endpoint", add: true },
      ...profiles.map((profile) => ({
        label: `${profile.id === activeId ? "$(check) " : ""}${profile.name}`,
        description: profile.baseUrl,
        detail: `${profile.manualModels.length} model${profile.manualModels.length === 1 ? "" : "s"} · ${profile.defaultModel ?? "no default"}`,
        profile,
      })),
    ], { title: "Agent Harness providers", placeHolder: profiles.length ? "Choose a provider to manage" : "Add your first provider" });
    if (!picked) return;
    if (picked.add) return this.addProviderProfile();
    if (picked.profile) return this.manageProviderProfile(picked.profile);
  }

  public async validateActiveProvider(): Promise<void> {
    const profile = await this.providerProfiles.getActiveProfile();
    if (!profile) return void vscode.window.showErrorMessage("Add or activate a provider profile first.");
    try {
      const response = await this.fetchProviderModels(profile);
      void vscode.window.showInformationMessage(`${profile.name} is reachable (${response.length} model${response.length === 1 ? "" : "s"}).`);
    } catch (error) {
      void vscode.window.showErrorMessage(`${profile.name} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async addProviderProfile(): Promise<void> {
    const providerType = await vscode.window.showQuickPick([{ label: "OpenAI Compatible", id: "openai-compatible" as const }], { title: "Provider type" });
    if (!providerType) return;
    const name = await vscode.window.showInputBox({ title: "Add provider", prompt: "Display name", value: "OpenAI Compatible", validateInput: requiredInput });
    if (!name) return;
    const suggestedId = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "provider";
    const id = await vscode.window.showInputBox({ title: "Add provider", prompt: "Stable profile id", value: suggestedId, validateInput: (value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.trim()) ? undefined : "Use letters, numbers, dots, underscores, and dashes." });
    if (!id) return;
    const baseUrl = await vscode.window.showInputBox({ title: "Add provider", prompt: "OpenAI-compatible base URL", placeHolder: "https://api.example.com/v1", validateInput: validateProviderUrl });
    if (!baseUrl) return;
    const modelId = await vscode.window.showInputBox({ title: "Add provider", prompt: "Default model id (optional)", placeHolder: "model-name" });
    try {
      const profile = await this.providerProfiles.createProfile({
        id,
        name,
        type: providerType.id,
        baseUrl,
        manualModels: modelId?.trim() ? [{ id: modelId.trim(), displayName: modelId.trim() }] : [],
        ...(modelId?.trim() ? { defaultModel: modelId.trim() } : {}),
      });
      const apiKey = await vscode.window.showInputBox({ title: "Add provider", prompt: "API key (optional)", password: true, ignoreFocusOut: true });
      if (apiKey?.trim()) await this.providerProfiles.setApiKey(profile.id, apiKey);
      await this.activateProvider(profile);
    } catch (error) {
      void vscode.window.showErrorMessage(providerProfileError(error));
    }
  }

  private async manageProviderProfile(profile: ProviderProfile): Promise<void> {
    const active = (await this.providerProfiles.getActiveProfileId()) === profile.id;
    const action = await vscode.window.showQuickPick([
      ...(!active ? [{ label: "$(check) Activate", id: "activate" }] : []),
      { label: "$(edit) Edit endpoint", id: "edit" },
      { label: "$(symbol-property) Compatibility", id: "compatibility" },
      { label: "$(key) Set API key", id: "key" },
      { label: "$(add) Add model manually", id: "model" },
      { label: "$(star) Set default model", id: "default" },
      { label: "$(settings-gear) Set mode default", id: "mode" },
      { label: "$(plug) Test connection", id: "test" },
      { label: "$(refresh) Fetch models", id: "fetch" },
      { label: "$(trash) Delete profile", id: "delete" },
    ], { title: profile.name, placeHolder: profile.baseUrl });
    if (!action) return;
    if (action.id === "activate") return this.activateProvider(profile);
    if (action.id === "key") {
      const key = await vscode.window.showInputBox({ title: `API key · ${profile.name}`, password: true, ignoreFocusOut: true, prompt: "Leave empty to clear the stored key" });
      if (key === undefined) return;
      await this.providerProfiles.setApiKey(profile.id, key);
    } else if (action.id === "model") {
      const modelId = await vscode.window.showInputBox({ title: "Add model manually", prompt: "Provider model id", validateInput: requiredInput });
      if (!modelId) return;
      const displayName = await vscode.window.showInputBox({ title: "Add model manually", prompt: "Display name (optional)", value: modelId.trim() });
      if (displayName === undefined) return;
      const contextWindow = await vscode.window.showInputBox({ title: "Add model manually", prompt: "Context window tokens (optional)", validateInput: optionalPositiveInteger });
      if (contextWindow === undefined) return;
      const maxOutputTokens = await vscode.window.showInputBox({ title: "Add model manually", prompt: "Maximum output tokens (optional)", validateInput: optionalPositiveInteger });
      if (maxOutputTokens === undefined) return;
      const capabilityChoices = [
        { label: "Streaming", key: "streaming" as const, picked: true },
        { label: "Tool calls", key: "tools" as const, picked: true },
        { label: "Parallel tool calls", key: "parallelTools" as const, picked: true },
        { label: "Reasoning", key: "reasoning" as const },
        { label: "Vision", key: "vision" as const },
        { label: "JSON Schema", key: "jsonSchema" as const },
        { label: "Temperature", key: "temperature" as const, picked: true },
      ];
      const selectedCapabilities = await vscode.window.showQuickPick(capabilityChoices, { title: "Model capabilities", canPickMany: true });
      if (!selectedCapabilities) return;
      const selected = new Set(selectedCapabilities.map((item) => item.key));
      const model = {
        id: modelId.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(contextWindow.trim() ? { contextWindow: Number(contextWindow) } : {}),
        ...(maxOutputTokens.trim() ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
        capabilities: Object.fromEntries(capabilityChoices.map((item) => [item.key, selected.has(item.key)])),
      };
      const manualModels = [...profile.manualModels.filter((item) => item.id !== model.id), model];
      await this.providerProfiles.updateProfile(profile.id, { manualModels });
    } else if (action.id === "default") {
      const modelId = await vscode.window.showInputBox({ title: "Set default model", value: profile.defaultModel, validateInput: requiredInput });
      if (!modelId) return;
      await this.providerProfiles.updateProfile(profile.id, { defaultModel: modelId.trim() });
    } else if (action.id === "mode") {
      const mode = await vscode.window.showQuickPick(["ask", "plan", "architect", "implement", "debug", "review", "orchestrate", "custom"], { title: "Choose mode" });
      if (!mode) return;
      const modelId = await vscode.window.showInputBox({ title: `Default model · ${mode}`, value: profile.modeDefaults[mode] ?? profile.defaultModel, validateInput: requiredInput });
      if (!modelId) return;
      await this.providerProfiles.updateProfile(profile.id, { modeDefaults: { ...profile.modeDefaults, [mode]: modelId.trim() } });
    } else if (action.id === "edit") {
      const name = await vscode.window.showInputBox({ title: "Edit provider", prompt: "Display name", value: profile.name, validateInput: requiredInput });
      if (!name) return;
      const baseUrl = await vscode.window.showInputBox({ title: "Edit provider", prompt: "Base URL", value: profile.baseUrl, validateInput: validateProviderUrl });
      if (!baseUrl) return;
      const headersJson = await vscode.window.showInputBox({ title: "Edit provider", prompt: "Non-secret headers as JSON", value: JSON.stringify(profile.headers), validateInput: validateHeadersJson });
      if (headersJson === undefined) return;
      try { await this.providerProfiles.updateProfile(profile.id, { name, baseUrl, headers: JSON.parse(headersJson) as Record<string, string> }); }
      catch (error) { return void vscode.window.showErrorMessage(providerProfileError(error)); }
    } else if (action.id === "compatibility") {
      const choices = [
        { label: "Supports developer role", key: "supportsDeveloperRole" as const, picked: profile.compatibility.supportsDeveloperRole },
        { label: "Supports parallel tool calls", key: "supportsParallelToolCalls" as const, picked: profile.compatibility.supportsParallelToolCalls },
        { label: "Requires assistant reasoning replay", key: "requiresAssistantReasoningReplay" as const, picked: profile.compatibility.requiresAssistantReasoningReplay },
        { label: "Requires opaque assistant frame replay", key: "requiresAssistantFrameReplay" as const, picked: profile.compatibility.requiresAssistantFrameReplay },
      ];
      const enabled = await vscode.window.showQuickPick(choices, { title: `Compatibility · ${profile.name}`, canPickMany: true, placeHolder: "Select capabilities required by this endpoint" });
      if (!enabled) return;
      const sendMaxTokensAs = await vscode.window.showQuickPick(["max_tokens", "max_completion_tokens"] as const, { title: "Output token wire field", placeHolder: profile.compatibility.sendMaxTokensAs });
      if (!sendMaxTokensAs) return;
      const selected = new Set(enabled.map((item) => item.key));
      await this.providerProfiles.updateProfile(profile.id, { compatibility: {
        ...profile.compatibility,
        supportsDeveloperRole: selected.has("supportsDeveloperRole"),
        supportsParallelToolCalls: selected.has("supportsParallelToolCalls"),
        requiresAssistantReasoningReplay: selected.has("requiresAssistantReasoningReplay"),
        requiresAssistantFrameReplay: selected.has("requiresAssistantFrameReplay"),
        sendMaxTokensAs: sendMaxTokensAs === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
      } });
    } else if (action.id === "test") {
      try {
        const models = await this.fetchProviderModels(profile);
        void vscode.window.showInformationMessage(`Found ${models.length} model${models.length === 1 ? "" : "s"} from ${profile.name}.`);
      } catch (error) { void vscode.window.showErrorMessage(`${profile.name}: ${error instanceof Error ? error.message : String(error)}`); }
    } else if (action.id === "fetch") {
      const models = await this.runtime.refreshModels(false, profile.id);
      if (!models) return void vscode.window.showErrorMessage(`Could not fetch models from ${profile.name}. Check its endpoint and credentials.`);
      if (active) this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId) });
      void vscode.window.showInformationMessage(`Fetched ${models.length} model${models.length === 1 ? "" : "s"} from ${profile.name}.`);
    } else if (action.id === "delete") {
      const confirmation = await vscode.window.showWarningMessage(`Delete provider profile “${profile.name}”?`, { modal: true }, "Delete");
      if (confirmation === "Delete") await this.providerProfiles.deleteProfile(profile.id);
    }
    await this.refreshProviderSelection();
  }

  private async activateProvider(profile: ProviderProfile): Promise<void> {
    await this.providerProfiles.setActiveProfile(profile.id);
    await this.refreshProviderSelection();
    void vscode.window.showInformationMessage(`${profile.name} is now active.`);
  }

  private async refreshProviderSelection(): Promise<void> {
    const profile = await this.providerProfiles.getActiveProfile();
    const model = profile ? resolveProfileModel(profile, { mode: this.mode }) : undefined;
    if (model) {
      this.modelId = model;
      await this.persistence.updateSessionSelection(this.sessionId, { modelId: model });
      this.post({ type: "modelChanged", modelId: model });
    }
    this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId) });
    this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
  }

  private async fetchProviderModels(profile: ProviderProfile): Promise<unknown[]> {
    const apiKey = await this.providerProfiles.getApiKey(profile.id);
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, "")}/models`, { headers: { ...profile.headers, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}. Check the endpoint and credentials.`);
    const payload = await response.json() as { data?: unknown[] };
    return Array.isArray(payload.data) ? payload.data : [];
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
    case "pickContext":
    case "openSettings":
      return true;
    case "openSession":
    case "renameSession":
    case "duplicateSession":
    case "deleteSession":
    case "exportSession":
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

function sessionMarkdown(exported: Awaited<ReturnType<SessionPersistenceCoordinator["exportSession"]>> & {}): string {
  const lines = [
    `# ${exported.session.title}`,
    "",
    `- Session: ${exported.session.id}`,
    `- Workspace: ${exported.session.workspaceId}`,
    `- Provider: ${exported.session.providerId}`,
    `- Model: ${exported.session.modelId}`,
    `- Mode: ${exported.session.activeMode}`,
    `- Status: ${exported.session.status}`,
    `- Created: ${new Date(exported.session.createdAt).toISOString()}`,
    `- Updated: ${new Date(exported.session.updatedAt).toISOString()}`,
    "",
  ];
  for (const stored of exported.messages) {
    const content = typeof stored.message.content === "string"
      ? stored.message.content
      : stored.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (!content) continue;
    lines.push(`## ${stored.message.role}`, "", content, "");
  }
  return `${lines.join("\n")}\n`;
}

async function isCanonicalWorkspaceUri(uri: vscode.Uri): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return false;
  if (uri.scheme !== "file" || folder.uri.scheme !== "file") return true;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(folder.uri.fsPath), realpath(uri.fsPath)]);
    const rel = relative(resolve(canonicalRoot), resolve(canonicalTarget));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function requiredInput(value: string): string | undefined {
  return value.trim() ? undefined : "A value is required.";
}

function optionalPositiveInteger(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "Enter a positive whole number.";
}

function validateProviderUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return "Use a valid http:// or https:// URL.";
    if (url.username || url.password) return "Store credentials as the profile API key, not in the URL.";
    return undefined;
  } catch {
    return "Use a valid http:// or https:// URL.";
  }
}

function validateHeadersJson(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return "Enter a JSON object.";
    if (!Object.values(parsed).every((item) => typeof item === "string")) return "Every header value must be a string.";
    return undefined;
  } catch {
    return "Enter valid JSON.";
  }
}

function providerProfileError(error: unknown): string {
  if (error instanceof ProviderProfileValidationError) return `Invalid provider profile: ${error.issues.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

function contextId(): string {
  return `context-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
