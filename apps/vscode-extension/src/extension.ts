import * as vscode from "vscode";
import * as os from "node:os";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadModeRegistry, type ModeDefinition, type NormalizedMessage } from "@freebuff/agent-core";
import {
  type AgentMode,
  type ExtensionToUiMessage,
  type UiToExtensionMessage,
  type ContextRef,
  type ChatMessage,
  type ToolActivity,
  type SubagentActivity,
  type ModeOption,
  type SkillOptionView,
  type PlanView,
  type ProviderProfileView,
  type ProviderPresetView,
  type ModeDetailView,
  type CustomModeDiagnosticView,
  type HarnessSettingsState,
  type SaveProviderProfileInput,
  type SaveCustomModeInput,
  MODEL_OPTIONS,
  BUILT_IN_MODES,
} from "./shared/protocol";
import { planViewForSession } from "./runtime/plan-lifecycle";
import { AgentRuntimeBridge, cachedModelsByProfile, modelIdsForProfile, pruneCachedModels } from "./runtime/bridge";
import { SessionPersistenceCoordinator, type RestoredSession } from "./runtime/session-persistence";
import {
  ProviderProfileStore,
  ProviderProfileValidationError,
  resolveProfileModel,
  type ProviderProfile,
} from "./runtime/provider-profiles";
import { CHECKPOINT_DOCUMENT_SCHEME } from "./checkpoint";
import { CustomModeStore } from "./runtime/custom-modes";
import { SkillStore } from "./runtime/skills";
import { providerPreset, providerPresets } from "./runtime/provider-presets";
import { FreebuffSidecarManager, detectFreebuffCredentials, FREEBUFF_REAL_MODELS } from "./runtime/freebuff-sidecar";
import { chatMessagesFromNormalized, sessionHistoryItemFromSession, subagentActivityFromRecord, toolActivitiesFromSnapshot } from "./shared/session-history";

const VIEW_ID = "agentdock.agentView";
const SESSION_LIST_LIMIT = 2_000;
const SESSION_SKILLS_STATE_KEY = "agentdock.sessionSkills.v1";

let sessionPersistence: SessionPersistenceCoordinator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand("agentdock.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.agentdock");
    }),
  );

  try {
    const sessionPersistenceCoordinator = await SessionPersistenceCoordinator.open(context);
    sessionPersistence = sessionPersistenceCoordinator;
    const customModes = await CustomModeStore.open(context);
    const skills = await SkillStore.open(context);
    const providerProfiles = await ProviderProfileStore.open(context, { legacyConfiguration: vscode.workspace.getConfiguration("agentdock") });
    const recent = (await sessionPersistence.list({ limit: 1 }))[0];
    const restored = recent ? await sessionPersistence.restore(recent.id) : undefined;
    const replayMessages = recent ? await sessionPersistence.replayMessages(recent.id) : undefined;
    const snapshot = recent ? await sessionPersistence.openSnapshot(recent.id) : undefined;
    const restoredSubagents = recent ? (await sessionPersistence.listSubagentRuns(recent.id)).map(subagentActivityFromRecord) : [];
    const activeProfile = await providerProfiles.getActiveProfile();
    const provider = new AgentViewProvider(
      context,
      sessionPersistence,
      providerProfiles,
      customModes,
      skills,
      restored,
      replayMessages,
      snapshot ? toolActivitiesFromSnapshot(snapshot) : [],
      restoredSubagents,
      activeProfile ? resolveProfileModel(activeProfile, { mode: restored?.session.activeMode }) : undefined,
    );

    context.subscriptions.push(
      provider,
      vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_DOCUMENT_SCHEME, provider.checkpointDocumentProvider()),
      provider.checkpointDocumentProvider(),
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
      vscode.commands.registerCommand("agentdock.manageModes", async () => provider.manageModes()),
      vscode.commands.registerCommand("agentdock.refreshModels", async () => {
        await provider.refreshModels(true);
      }),
      customModes,
      skills,
      { dispose: () => { void sessionPersistence?.close(); } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureProvider = new StartupFailureViewProvider(context.extensionUri, `Agent Harness failed to start: ${message}`);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, failureProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
    void vscode.window.showErrorMessage(
      `Agent Harness failed to start: ${message}`,
      "Retry",
    ).then((choice) => {
      if (choice === "Retry") void vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
  }
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
  private modeSelectionRequired = false;
  /** Report a Freebuff port conflict once per occurrence, not once per turn. */
  private freebuffPortConflictReported = false;
  private acceptedModeSource: string | undefined;
  private sessionOperations: Promise<void> = Promise.resolve();
  private readonly contextSnapshots = new Map<string, { ref: ContextRef; snapshot: string }>();
  /** Sidecar stdout/stderr, so a failed start is diagnosable from the UI. */
  private readonly freebuffLog = vscode.window.createOutputChannel("Clank · Freebuff Sidecar");
  private readonly freebuffSidecar = new FreebuffSidecarManager({
    onLog: (line) => this.freebuffLog.appendLine(line),
  });

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly persistence: SessionPersistenceCoordinator,
    private readonly providerProfiles: ProviderProfileStore,
    private readonly customModes: CustomModeStore,
    private readonly skills: SkillStore,
    restored?: RestoredSession,
    replayMessages?: NormalizedMessage[],
    restoredTools: ToolActivity[] = [],
    restoredSubagents: SubagentActivity[] = [],
    initialModelId?: string,
  ) {
    const config = vscode.workspace.getConfiguration("agentdock");
    const requestedMode = restored?.session.activeMode ?? config.get<string>("defaultMode", "ask");
    this.mode = isCanonicalModeSlug(requestedMode) ? requestedMode : "ask";
    this.acceptedModeSource = restored ? undefined : modeSourceKey(customModes.entry(this.mode));
    if (restored && (!customModes.get(restored.session.activeMode) || customModes.requiresExplicitReselection(restored.session.activeMode))) {
      this.modeSelectionRequired = true;
      void vscode.window.showWarningMessage(`Session mode '${restored.session.activeMode}' is unavailable. Select an installed mode before running.`);
    }
    this.modelId = restored?.session.modelId
      ?? initialModelId
      ?? (config.get<string>("provider.model", "").trim() || config.get<string>("defaultModel", MODEL_OPTIONS[0].id));
    this.sessionId = restored?.session.id ?? `session-${Date.now().toString(36)}`;
    this.restoredMessages = restored ? chatMessagesFromNormalized(restored.messages) : [];
    this.restoredTools = restoredTools;
    this.restoredSubagents = restoredSubagents;
    this.runtime = new AgentRuntimeBridge({ context, post: (message) => this.post(message) }, persistence, providerProfiles, customModes, skills);
    context.subscriptions.push(customModes.onDidChange(() => this.handleModesReloaded()));
    context.subscriptions.push(skills.onDidChange(() => this.postSkillState()));
    if (restored) {
      this.runtime.restoreHistory(
        restored.session.id,
        replayMessages ?? restored.messages,
        restored.session.providerId && restored.session.modelId
          ? { providerId: restored.session.providerId, modelId: restored.session.modelId }
          : undefined,
      );
    }
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
          modeOptions: this.modeOptions(),
          modelId: this.modelId,
          modelPolicy: this.runtime.modelPolicyState(this.mode),
          models: this.runtime.cachedModelOptions(this.modelId, this.mode),
          ...this.skillState(),
          messages: this.restoredMessages,
          tools: this.restoredTools,
          subagents: this.restoredSubagents,
          plan: await this.currentPlanView(),
          workspaceName: vscode.workspace.name
        });
        if (this.modeSelectionRequired) this.post({ type: "error", kind: "workspace", message: `Mode '${this.mode}' is unavailable. Select an installed mode before running.` });
        await this.postSessionList();
        void this.ensureFreebuffSidecarRunningIfNeeded();
        void this.runtime.restoreRecentCheckpointCards();
        void this.runtime.refreshModels(false, this.customModes.get(this.mode)?.provider);
        return;
      case "changeMode":
        await this.enqueueSessionOperation(async () => {
          const requestedMode = this.customModes.get(message.mode);
          if (!requestedMode || (requestedMode.type !== "primary" && requestedMode.type !== "all")) {
            this.post({ type: "error", kind: "workspace", message: `Mode '${message.mode}' is unavailable. Reload or choose another mode.` });
            return;
          }
          this.mode = message.mode;
          this.modeSelectionRequired = false;
          this.acceptedModeSource = modeSourceKey(this.customModes.entry(this.mode));
          const definition = this.customModes.get(this.mode)!;
          const profile = definition.provider ? await this.providerProfiles.getProfile(definition.provider) : await this.providerProfiles.getActiveProfile();
          const modeModel = definition.model ?? profile?.modeDefaults[this.mode];
          if (modeModel) {
            this.modelId = modeModel;
            this.post({ type: "modelChanged", modelId: this.modelId });
          }
          this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId, this.mode) });
          this.post({ type: "modeChanged", mode: this.mode });
          this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
          this.postSkillState();
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
          const previousModelId = this.modelId;
          this.modelId = message.modelId;
          this.post({ type: "modelChanged", modelId: this.modelId });
          await this.persistence.updateSessionSelection(this.sessionId, { modelId: this.modelId });
          this.warnAboutMidConversationSwitch("model", previousModelId, this.modelId);
        });
        return;
      case "sendMessage":
        await this.enqueueSessionOperation(async () => {
          const selectedMode = this.customModes.get(message.mode);
          if (this.modeSelectionRequired || message.mode !== this.mode || !selectedMode || (selectedMode.type !== "primary" && selectedMode.type !== "all")) {
            this.post({ type: "error", kind: "workspace", message: "The selected mode changed or is no longer available. Choose a mode and send again." });
            return;
          }
          const context = message.context.flatMap(({ id }) => {
            const stored = this.contextSnapshots.get(id);
            return stored ? [{ ...stored.ref, snapshot: stored.snapshot }] : [];
          });
          const skillIds = await this.setSelectedSkills(message.skillIds);
          const images = message.images?.map((img) => img.dataUrl);
          await this.ensureFreebuffSidecarRunningIfNeeded();
          void this.runtime.run({ sessionId: this.sessionId, text: message.text, mode: message.mode, modelId: message.modelId, context, skillIds, images })
            .finally(() => this.postSessionList())
            .catch((error) => this.post({ type: "error", kind: "unknown", message: error instanceof Error ? error.message : String(error) }));
        });
        return;
      case "changeSkills":
        await this.enqueueSessionOperation(async () => {
          await this.setSelectedSkills(message.skillIds);
          this.postSkillState();
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
      case "requestSettings":
        await this.postSettingsState();
        return;
      case "activateProvider": {
        const profile = await this.providerProfiles.getProfile(message.profileId);
        if (profile) await this.activateProvider(profile);
        await this.postSettingsState();
        return;
      }
      case "setProviderApiKey": {
        const profile = await this.providerProfiles.getProfile(message.profileId);
        if (profile) {
          const key = await vscode.window.showInputBox({
            title: `API key · ${profile.name}`,
            password: true,
            ignoreFocusOut: true,
            prompt: "Leave empty to clear the stored key",
          });
          if (key !== undefined) {
            await this.providerProfiles.setApiKey(profile.id, key.trim() || undefined);
            if (key.trim()) {
              try {
                const fetched = await this.runtime.refreshModels(false, profile.id);
                if (fetched && fetched.length > 0) {
                  void vscode.window.showInformationMessage(`Auto-discovered ${fetched.length} model${fetched.length === 1 ? "" : "s"} for ${profile.name}.`);
                }
              } catch {
                // Non-blocking background discovery
              }
            }
            await this.refreshProviderSelection();
            await this.postSettingsState();
          }
        }
        return;
      }
      case "clearProviderApiKey": {
        await this.providerProfiles.clearApiKey(message.profileId);
        await this.postSettingsState();
        return;
      }
      case "testProviderConnection": {
        const profile = await this.providerProfiles.getProfile(message.profileId);
        if (!profile) return;
        try {
          const fetched = await this.runtime.refreshModels(false, profile.id, true);
          const count = fetched?.length ?? 0;
          this.post({
            type: "providerTestResult",
            profileId: message.profileId,
            success: true,
            message: `Reachable (${count} model${count === 1 ? "" : "s"} discovered)`,
          });
          await this.refreshProviderSelection();
          await this.postSettingsState();
        } catch (error) {
          this.post({
            type: "providerTestResult",
            profileId: message.profileId,
            success: false,
            message: providerConnectionError(error),
          });
        }
        return;
      }
      case "fetchProviderModels": {
        const profile = await this.providerProfiles.getProfile(message.profileId);
        if (profile) {
          try {
            const fetched = await this.runtime.refreshModels(true, profile.id);
          } catch (error) {
            void vscode.window.showErrorMessage(`Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`);
          }
          await this.refreshProviderSelection();
          await this.postSettingsState();
        }
        return;
      }
      case "addProvider":
        await this.addProviderProfile();
        await this.postSettingsState();
        return;
      case "editProvider": {
        const profile = await this.providerProfiles.getProfile(message.profileId);
        if (profile) {
          await this.manageProviderProfile(profile);
          await this.postSettingsState();
        }
        return;
      }
      case "deleteProvider": {
        const profile = await this.providerProfiles.getProfile(message.profileId);
        if (profile) {
          const confirmed = await vscode.window.showWarningMessage(
            `Delete provider profile “${profile.name}”?`,
            { modal: true },
            "Delete"
          );
          if (confirmed === "Delete") {
            if (profile.id === "freebuff" || profile.id === "freebuff2api") {
              this.freebuffSidecar.stop();
            }
            await this.providerProfiles.deleteProfile(profile.id);
            await pruneCachedModels(this.context);
            await this.refreshProviderSelection();
            await this.postSettingsState();
            void vscode.window.showInformationMessage(`Deleted profile “${profile.name}”.`);
          }
        }
        return;
      }
      case "createMode":
        await this.createMode();
        await this.postSettingsState();
        return;
      case "importMode":
        await this.importMode();
        await this.postSettingsState();
        return;
      case "reloadModes":
        await this.customModes.reload();
        await this.postSettingsState();
        void vscode.window.showInformationMessage("Agent Harness modes reloaded.");
        return;
      case "openModeSource": {
        const entry = this.customModes.entry(message.slug);
        if (entry) await this.customModes.openSource(entry);
        return;
      }
      case "duplicateMode": {
        const entry = this.customModes.entry(message.slug);
        if (entry) {
          await this.createMode(entry.mode);
          await this.postSettingsState();
        }
        return;
      }
      case "deleteMode": {
        const entry = this.customModes.entry(message.slug);
        if (entry && this.customModes.canManage(entry)) {
          const confirmed = await vscode.window.showWarningMessage(
            `Delete mode “${entry.mode.name}”?`,
            { modal: true, detail: entry.source },
            "Delete"
          );
          if (confirmed === "Delete") {
            await this.customModes.delete(entry);
            await this.postSettingsState();
          }
        }
        return;
      }
      case "openModeDiagnostic": {
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(message.source, true));
          const editor = await vscode.window.showTextDocument(document, { preview: false });
          if (message.line) {
            const position = new vscode.Position(Math.max(0, message.line - 1), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
          }
        } catch {
          // ignore
        }
        return;
      }
      case "openAdvancedSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:freebuff.clank-harness");
        return;
      case "saveDefaultMode": {
        const config = vscode.workspace.getConfiguration("agentdock");
        await config.update("defaultMode", message.mode, vscode.ConfigurationTarget.Global);
        await this.postSettingsState();
        return;
      }
      case "saveMaxSteps": {
        const config = vscode.workspace.getConfiguration("agentdock");
        await config.update("maxSteps", message.steps, vscode.ConfigurationTarget.Global);
        await this.postSettingsState();
        return;
      }
      case "saveSubagentSettings": {
        const config = vscode.workspace.getConfiguration("agentdock");
        if (message.defaultAuthority !== undefined) {
          await config.update("subagents.defaultAuthority", message.defaultAuthority, vscode.ConfigurationTarget.Global);
        }
        if (message.maxSteps !== undefined) {
          await config.update("subagents.maxSteps", message.maxSteps, vscode.ConfigurationTarget.Global);
        }
        if (message.maxConcurrent !== undefined) {
          await config.update("subagents.maxConcurrent", message.maxConcurrent, vscode.ConfigurationTarget.Global);
        }
        if (message.maxTotal !== undefined) {
          await config.update("subagents.maxTotal", message.maxTotal, vscode.ConfigurationTarget.Global);
        }
        if (message.maxDepth !== undefined) {
          await config.update("subagents.maxDepth", message.maxDepth, vscode.ConfigurationTarget.Global);
        }
        if (message.requireWriteApproval !== undefined) {
          await config.update("subagents.requireWriteApproval", message.requireWriteApproval, vscode.ConfigurationTarget.Global);
        }
        await this.postSettingsState();
        void vscode.window.showInformationMessage("Subagent settings saved.");
        return;
      }
      case "saveProviderProfile": {
        const input = message.profile;
        const preset = input.presetId ? providerPreset(input.presetId) : undefined;
        const profileId = input.id || safeModeSlug(input.name) || `provider-${Date.now().toString(36)}`;
        const existing = await this.providerProfiles.getProfile(profileId);
        if (existing) {
          await this.providerProfiles.updateProfile(profileId, {
            name: input.name.trim(),
            baseUrl: input.baseUrl.trim(),
            defaultModel: input.defaultModel?.trim() || undefined,
            ...(input.headers ? { headers: input.headers } : {}),
          });
        } else {
          await this.providerProfiles.createProfile({
            id: profileId,
            name: input.name.trim(),
            type: (input.type || "openai-compatible") as "openai-compatible",
            baseUrl: input.baseUrl.trim(),
            headers: input.headers ?? {},
            manualModels: input.defaultModel?.trim() ? [{ id: input.defaultModel.trim(), displayName: input.defaultModel.trim() }] : [],
            defaultModel: input.defaultModel?.trim() || undefined,
            modeDefaults: {},
            compatibility: {
              supportsDeveloperRole: preset?.compatibility.supportsDeveloperRole ?? true,
              supportsParallelToolCalls: preset?.compatibility.supportsParallelToolCalls ?? true,
              requiresAssistantReasoningReplay: preset?.compatibility.requiresAssistantReasoningReplay ?? false,
              requiresAssistantFrameReplay: preset?.compatibility.requiresAssistantFrameReplay ?? false,
              sendMaxTokensAs: preset?.compatibility.sendMaxTokensAs ?? "max_tokens",
            },
          });
        }
        if (input.apiKey !== undefined) {
          await this.providerProfiles.setApiKey(profileId, input.apiKey.trim() || undefined);
        }

        // Auto-discover models upon adding or saving provider profile
        try {
          const fetched = await this.runtime.refreshModels(false, profileId);
          if (fetched && fetched.length > 0) {
            void vscode.window.showInformationMessage(`Auto-discovered ${fetched.length} model${fetched.length === 1 ? "" : "s"} for ${input.name.trim()}.`);
          }
        } catch {
          // Non-blocking
        }

        await this.refreshProviderSelection();
        await this.postSettingsState();
        void vscode.window.showInformationMessage(`Provider profile '${input.name.trim()}' saved.`);
        return;
      }
      case "saveCustomMode": {
        const input = message.mode;
        const slug = safeModeSlug(input.slug || input.name);
        const scope = input.scope === "global" ? "user" : "project";
        const markdown = modeMarkdown({
          name: input.name.trim(),
          slug,
          type: input.type,
          provider: input.provider?.trim() || undefined,
          model: input.model?.trim() || undefined,
          modelPolicy: input.modelPolicy ?? "user-selectable",
          routeOverrides: input.routeOverrides ?? false,
          steps: input.steps || 20,
          instructions: input.instructions.trim(),
          ...modeAuthority(input.authority),
          ...(input.skills ? { skills: input.skills } : {}),
          ...(input.delegationAllowed !== undefined ? { delegationAllowed: input.delegationAllowed } : {}),
          ...(input.allowedAgents ? { allowedAgents: input.allowedAgents } : {}),
        });
        await this.customModes.create(scope, markdown, slug);
        await this.customModes.reload();
        await this.postSettingsState();
        void vscode.window.showInformationMessage(`Custom mode '${input.name.trim()}' saved.`);
        return;
      }
      case "openExternalUrl": {
        void vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      }
      case "setupFreebuff": {
        const detected = detectFreebuffCredentials();
        const token = (message.authToken && message.authToken.trim()) || detected?.authToken || (await this.providerProfiles.getApiKey("freebuff")) || "";
        if (!token) {
          void vscode.window.showErrorMessage("No Freebuff credentials found. Run 'npm i -g freebuff && freebuff' in terminal or enter an authToken.");
          return;
        }
        void vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Starting Freebuff sidecar${detected?.name ? ` for ${detected.name}` : ""}…` },
          async () => {
            const startResult = await this.freebuffSidecar.start(token);
            if (!startResult.ok) {
              void vscode.window.showErrorMessage(`Failed to start Freebuff: ${startResult.message}`, "Show Log")
                .then((choice) => { if (choice === "Show Log") this.freebuffLog.show(true); });
              await this.postSettingsState();
              return;
            }

            const profileId = "freebuff";
            const freebuffManualModels = FREEBUFF_REAL_MODELS.map((m) => ({
              id: m.id,
              displayName: `${m.displayName} (${m.category})`,
              capabilities: { reasoning: m.hint.includes("reasoning"), tools: true },
            }));
            const defaultFreebuffModel = detected?.activeModel || "deepseek/deepseek-v4-flash";

            const existing = await this.providerProfiles.getProfile(profileId);
            if (!existing) {
              await this.providerProfiles.createProfile({
                id: profileId,
                name: "Freebuff",
                type: "openai-compatible",
                baseUrl: this.freebuffSidecar.getBaseUrl(),
                headers: {},
                defaultModel: defaultFreebuffModel,
                manualModels: freebuffManualModels,
                modeDefaults: {},
                compatibility: {
                  supportsDeveloperRole: true,
                  supportsParallelToolCalls: true,
                  requiresAssistantReasoningReplay: false,
                  requiresAssistantFrameReplay: false,
                  sendMaxTokensAs: "max_tokens",
                },
              });
            } else {
              await this.providerProfiles.updateProfile(profileId, {
                baseUrl: this.freebuffSidecar.getBaseUrl(),
                manualModels: freebuffManualModels,
                defaultModel: existing.defaultModel || defaultFreebuffModel,
              });
            }

            await this.providerProfiles.setApiKey(profileId, token);
            await this.providerProfiles.setActiveProfile(profileId);

            try {
              await this.runtime.refreshModels(false, profileId);
            } catch {
              // ignore
            }

            await this.refreshProviderSelection();
            await this.postSettingsState();
            void vscode.window.showInformationMessage(`Freebuff connected${detected?.name ? ` for ${detected.name}` : ""}! Active model: ${defaultFreebuffModel}.`);
          }
        );
        return;
      }
      case "toggleFreebuffSidecar": {
        const isRunning = await this.freebuffSidecar.isRunning();
        if (isRunning) {
          this.freebuffSidecar.stop();
          void vscode.window.showInformationMessage("Freebuff sidecar stopped.");
        } else {
          const detected = detectFreebuffCredentials();
          const token = (await this.providerProfiles.getApiKey("freebuff")) || detected?.authToken || "";
          if (!token) {
            void vscode.window.showErrorMessage("No Freebuff authToken found. Please configure Freebuff first.");
            return;
          }
          const res = await this.freebuffSidecar.start(token);
          if (res.ok) {
            void vscode.window.showInformationMessage("Freebuff sidecar started.");
          } else {
            void vscode.window.showErrorMessage(`Failed to start Freebuff: ${res.message}`, "Show Log")
              .then((choice) => { if (choice === "Show Log") this.freebuffLog.show(true); });
          }
        }
        await this.postSettingsState();
        return;
      }
      case "setupVibeProxy": {
        const profileId = "vibeproxy";
        const baseUrl = "http://127.0.0.1:8317/v1";
        const existing = await this.providerProfiles.getProfile(profileId);
        if (!existing) {
          await this.providerProfiles.createProfile({
            id: profileId,
            name: "VibeProxy",
            type: "openai-compatible",
            baseUrl,
            headers: {},
            manualModels: [],
            modeDefaults: {},
            compatibility: {
              supportsDeveloperRole: true,
              supportsParallelToolCalls: true,
              requiresAssistantReasoningReplay: false,
              requiresAssistantFrameReplay: false,
              sendMaxTokensAs: "max_tokens",
            },
          });
        }
        await this.providerProfiles.setActiveProfile(profileId);
        try {
          const fetched = await this.runtime.refreshModels(false, profileId, true);
          if (fetched && fetched.length > 0) {
            const currentProf = await this.providerProfiles.getProfile(profileId);
            if (currentProf && !currentProf.defaultModel && fetched[0]) {
              await this.providerProfiles.updateProfile(profileId, { defaultModel: fetched[0].id });
            }
            void vscode.window.showInformationMessage(`VibeProxy connected! Discovered ${fetched.length} model${fetched.length === 1 ? "" : "s"}.`);
          } else {
            void vscode.window.showInformationMessage("VibeProxy profile created! (No live models returned yet; ensure an account is added in VibeProxy)");
          }
        } catch (err) {
          void vscode.window.showWarningMessage(`VibeProxy profile saved, but endpoint probe failed: ${err instanceof Error ? err.message : String(err)}. Ensure VibeProxy is running on port 8317.`);
        }
        await this.refreshProviderSelection();
        await this.postSettingsState();
        return;
      }
      case "setupAiHubMix": {
        const profileId = "aihubmix";
        const baseUrl = "https://api.inferera.com/v1";
        const key = message.apiKey.trim();
        if (!key) {
          void vscode.window.showErrorMessage("Please enter an AI HubMix API key.");
          return;
        }
        const existing = await this.providerProfiles.getProfile(profileId);
        if (!existing) {
          await this.providerProfiles.createProfile({
            id: profileId,
            name: "AI HubMix",
            type: "openai-compatible",
            baseUrl,
            headers: {},
            manualModels: [],
            modeDefaults: {},
            compatibility: {
              supportsDeveloperRole: true,
              supportsParallelToolCalls: true,
              requiresAssistantReasoningReplay: false,
              requiresAssistantFrameReplay: false,
              sendMaxTokensAs: "max_tokens",
            },
          });
        }
        await this.providerProfiles.setApiKey(profileId, key);
        await this.providerProfiles.setActiveProfile(profileId);
        try {
          const fetched = await this.runtime.refreshModels(false, profileId, true);
          if (fetched && fetched.length > 0) {
            const currentProf = await this.providerProfiles.getProfile(profileId);
            if (currentProf && !currentProf.defaultModel && fetched[0]) {
              await this.providerProfiles.updateProfile(profileId, { defaultModel: fetched[0].id });
            }
            void vscode.window.showInformationMessage(`AI HubMix connected! Discovered ${fetched.length} model${fetched.length === 1 ? "" : "s"}.`);
          } else {
            void vscode.window.showInformationMessage("AI HubMix profile created!");
          }
        } catch (err) {
          void vscode.window.showWarningMessage(`AI HubMix profile saved, but model discovery probe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refreshProviderSelection();
        await this.postSettingsState();
        return;
      }
      case "approvePlan":
        await this.enqueueSessionOperation(() => this.approvePlan(message.planId, message.revision));
        return;
      case "revisePlan":
        await this.enqueueSessionOperation(() => this.revisePlan(message.planId, message.revision));
        return;
      case "savePlan":
        await this.enqueueSessionOperation(() => this.savePlan(message.planId, message.revision));
        return;
      case "discardPlan":
        await this.enqueueSessionOperation(() => this.discardPlan(message.planId, message.revision));
        return;
    }
  }

  /** Sanitized plan metadata for the active session, or undefined. */
  private async currentPlanView(): Promise<PlanView | undefined> {
    return planViewForSession(await this.persistence.listPlans(this.sessionId));
  }

  /**
   * Approve & Implement. The host owns the transition: storage is mutated
   * atomically with the revision check, then the conversation is preserved and
   * the mode switches to Implement with a recorded `plan-approved` transition.
   */
  private async approvePlan(planId: string, revision: number): Promise<void> {
    const record = await this.persistence.getPlan(planId, this.sessionId);
    if (!record) {
      this.post({ type: "error", kind: "workspace", message: "That plan is not available in this session." });
      return;
    }
    const approved = await this.persistence.approvePlan(planId, { sessionId: this.sessionId, expectedRevision: revision, actor: "user" });
    if (!approved) {
      this.post({ type: "error", kind: "workspace", message: "The plan could not be approved. Reload it and try again." });
      await this.postPlanChanged();
      return;
    }
    // Switch to Implement, preserving the conversation and recording the reason.
    this.mode = "implement";
    this.modeSelectionRequired = false;
    this.acceptedModeSource = modeSourceKey(this.customModes.entry(this.mode));
    const definition = this.customModes.get(this.mode);
    const profile = definition?.provider ? await this.providerProfiles.getProfile(definition.provider) : await this.providerProfiles.getActiveProfile();
    const modeModel = definition?.model ?? profile?.modeDefaults[this.mode];
    if (modeModel) {
      this.modelId = modeModel;
      this.post({ type: "modelChanged", modelId: this.modelId });
    }
    this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId, this.mode) });
    this.post({ type: "modeChanged", mode: this.mode });
    this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
    await this.persistence.updateSessionSelection(this.sessionId, { activeMode: this.mode }, { reason: "plan-approved" });
    await this.postPlanChanged();
  }

  private async revisePlan(planId: string, revision: number): Promise<void> {
    const record = await this.persistence.getPlan(planId, this.sessionId);
    if (!record) {
      this.post({ type: "error", kind: "workspace", message: "That plan is not available in this session." });
      return;
    }
    await this.persistence.revisePlan(planId, { sessionId: this.sessionId, expectedRevision: revision });
    await this.postPlanChanged();
  }

  private async discardPlan(planId: string, revision: number): Promise<void> {
    const record = await this.persistence.getPlan(planId, this.sessionId);
    if (!record) {
      this.post({ type: "error", kind: "workspace", message: "That plan is not available in this session." });
      return;
    }
    await this.persistence.discardPlan(planId, { sessionId: this.sessionId, expectedRevision: revision });
    await this.postPlanChanged();
  }

  /**
   * Save Plan opens the host-owned artifact (never trusting webview content)
   * and refreshes the sanitized card; if a DRAFT/READY plan exists it is kept
   * as the durable record. Reparses the artifact when present so the card
   * reflects the latest on-disk Markdown.
   */
  private async savePlan(planId: string, revision: number): Promise<void> {
    const record = await this.persistence.getPlan(planId, this.sessionId);
    if (!record) {
      this.post({ type: "error", kind: "workspace", message: "That plan is not available in this session." });
      return;
    }
    if (record.artifactPath) {
      const uri = vscode.Uri.joinPath(this.workspaceRoot(), record.artifactPath);
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch {
        this.post({ type: "error", kind: "workspace", message: "The plan artifact could not be opened." });
      }
    }
    await this.postPlanChanged();
  }

  private async postPlanChanged(): Promise<void> {
    this.post({ type: "planChanged", plan: await this.currentPlanView() });
  }

  /** First workspace folder, or undefined when no folder is open. */
  private workspaceRoot(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Plan artifacts require an open workspace folder.");
    return folder.uri;
  }

  private async startNewSession(): Promise<void> {
    const previousSessionId = this.sessionId;
    this.runtime.reset(previousSessionId);
    if (this.modeSelectionRequired || !this.customModes.get(this.mode)) this.mode = "ask";
    const session = await this.persistence.newSession({ activeMode: this.mode, modelId: this.modelId });
    this.sessionId = session.id;
    this.restoredMessages = [];
    this.restoredTools = [];
    this.contextSnapshots.clear();
    this.modeSelectionRequired = false;
    this.acceptedModeSource = modeSourceKey(this.customModes.entry(this.mode));
    this.post({
      type: "initialize",
      sessionId: this.sessionId,
      mode: this.mode,
      modeOptions: this.modeOptions(),
      modelId: this.modelId,
      models: this.runtime.cachedModelOptions(this.modelId, this.mode),
      modelPolicy: this.runtime.modelPolicyState(this.mode),
      ...this.skillState(),
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
    this.mode = isCanonicalModeSlug(restored.session.activeMode) ? restored.session.activeMode : "ask";
    this.acceptedModeSource = undefined;
    if (!this.customModes.get(restored.session.activeMode) || this.customModes.requiresExplicitReselection(restored.session.activeMode)) {
      this.modeSelectionRequired = true;
    } else this.modeSelectionRequired = false;
    this.modelId = restored.session.modelId;
    this.restoredMessages = chatMessagesFromNormalized(restored.messages);
    this.restoredTools = snapshot ? toolActivitiesFromSnapshot(snapshot) : [];
    this.restoredSubagents = restoredSubagents;
    this.contextSnapshots.clear();
    this.runtime.restoreHistory(this.sessionId, replayMessages);
    this.post({
      type: "sessionOpened",
      session: sessionHistoryItemFromSession(restored.session),
      modeOptions: this.modeOptions(),
      modelPolicy: this.runtime.modelPolicyState(this.mode),
      ...this.skillState(),
      messages: this.restoredMessages,
      tools: this.restoredTools,
      subagents: this.restoredSubagents,
      plan: await this.currentPlanView(),
    });
    this.post({ type: "runState", state: "idle" });
    if (this.modeSelectionRequired) this.post({ type: "error", kind: "workspace", message: `Session mode '${restored.session.activeMode}' is unavailable. Select an installed mode before running.` });
    await this.postSessionList();
  }

  private async renameSession(sessionId: string): Promise<void> {
    try {
      const session = await this.persistence.getSession(sessionId);
      if (!session) {
        this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
        return;
      }
      const title = await vscode.window.showInputBox({
        title: "Rename Agent Harness session",
        value: session.title,
        prompt: "Use a short title that will be easy to find later.",
        validateInput: (value) => !value.trim() ? "Enter a session title." : [...value.trim()].length > 200 ? "Use 200 characters or fewer." : undefined,
      });
      if (title === undefined) return;
      await this.persistence.renameSession(sessionId, title);
    } finally {
      await this.postSessionList();
    }
  }

  private async duplicateSession(sessionId: string): Promise<void> {
    if (this.runtime.isRunning(sessionId)) return this.post({ type: "error", kind: "workspace", message: "Cancel the active run before duplicating this session." });
    const duplicate = await this.persistence.duplicateSession(sessionId);
    if (!duplicate) return this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
    const sourceSkills = this.context.workspaceState.get<Record<string, string[]>>(SESSION_SKILLS_STATE_KEY, {})[sessionId] ?? [];
    await this.setSelectedSkills(sourceSkills, duplicate.id);
    await this.openSession(duplicate.id);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      if (this.runtime.isRunning(sessionId)) {
        this.post({ type: "error", kind: "workspace", message: "Cancel the active run before deleting this session." });
        return;
      }
      const session = await this.persistence.getSession(sessionId);
      if (!session) {
        this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Delete “${session.title}” and its local transcript?`,
        { modal: true, detail: "This removes messages, tool records, approvals, and usage stored by Agent Harness." },
        "Delete",
      );
      if (confirmed !== "Delete") return;
      this.runtime.cancel(sessionId);
      await this.persistence.deleteSession(sessionId);
      await this.deleteSelectedSkills(sessionId);
      if (sessionId === this.sessionId) {
        await this.startNewSession();
      }
      void vscode.window.showInformationMessage(`Deleted session “${session.title}”.`);
    } finally {
      await this.postSessionList();
    }
  }

  private async exportSession(sessionId: string): Promise<void> {
    try {
      if (this.runtime.isRunning(sessionId)) {
        this.post({ type: "error", kind: "workspace", message: "Wait for the active run to finish, or cancel it before exporting." });
        return;
      }
      const exported = await this.persistence.exportSession(sessionId);
      if (!exported) {
        this.post({ type: "error", kind: "workspace", message: "That session is not available in this workspace." });
        return;
      }
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
    } finally {
      await this.postSessionList();
    }
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

  public async manageModes(): Promise<void> {
    type ModePick = vscode.QuickPickItem & { entry?: ReturnType<CustomModeStore["entries"]>[number]; action?: "new" | "import" | "reload" | "diagnostics" };
    const diagnostics = this.customModes.diagnostics();
    const picked = await vscode.window.showQuickPick<ModePick>([
      { label: "$(add) New mode", description: "Create a global or project Markdown agent", action: "new" },
      { label: "$(cloud-download) Import mode…", description: "Copy a Markdown agent into a managed directory", action: "import" },
      { label: "$(refresh) Reload modes", description: "Re-read global and workspace definitions", action: "reload" },
      ...(diagnostics.length ? [{ label: `$(warning) View ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`, description: "Invalid, shadowed, or overridden definitions", action: "diagnostics" as const }] : []),
      ...this.customModes.entries().map((entry) => ({
        label: `${entry.scope === "built-in" ? "$(symbol-class)" : entry.scope === "project" ? "$(root-folder)" : "$(home)"} ${entry.mode.name}`,
        description: `${entry.mode.slug} · ${entry.scope}`,
        detail: entry.mode.description ?? entry.source,
        entry,
      })),
    ], { title: "Agent Harness agents / modes", placeHolder: "Create or manage executable agent profiles" });
    if (!picked) return;
    if (picked.action === "new") return this.createMode();
    if (picked.action === "import") return this.importMode();
    if (picked.action === "reload") {
      await this.customModes.reload();
      return void vscode.window.showInformationMessage("Agent Harness modes reloaded.");
    }
    if (picked.action === "diagnostics") return this.showModeDiagnostics();
    if (picked.entry) return this.manageModeEntry(picked.entry);
  }

  private async manageHarnessSettings(): Promise<void> {
    const picked = await vscode.window.showQuickPick([
      { label: "$(organization) Agents / Modes", description: "Custom prompts, tools, permissions, models, and delegation", id: "modes" as const },
      { label: "$(server-environment) Providers", description: "Endpoints, credentials, models, and compatibility", id: "providers" as const },
      { label: "$(settings-gear) Extension Settings", description: "Budgets, defaults, and compatibility options", id: "settings" as const },
    ], { title: "Agent Harness settings" });
    if (picked?.id === "modes") return this.manageModes();
    if (picked?.id === "providers") return this.manageProviders();
    if (picked?.id === "settings") await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:freebuff.clank-harness");
  }

  private async createMode(seed?: ModeDefinition): Promise<void> {
    const name = await vscode.window.showInputBox({ title: seed ? "Duplicate mode" : "New Agent Harness mode", prompt: "Display name", value: seed ? `${seed.name} Copy` : "", validateInput: requiredInput });
    if (!name) return;
    const slug = await vscode.window.showInputBox({ title: "Mode slug", value: safeModeSlug(seed ? `${seed.slug}-copy` : name), validateInput: validateModeSlug });
    if (!slug) return;
    const scope = await vscode.window.showQuickPick([
      { label: "Project", description: ".agent/agents — shared with this workspace", id: "project" as const },
      { label: "Global", description: "~/.config/freebuff-agent-harness/agents", id: "user" as const },
    ], { title: "Mode scope" });
    if (!scope) return;
    const type = await vscode.window.showQuickPick(["primary", "subagent", "all"] as const, { title: "Where can this mode run?", placeHolder: seed?.type ?? "all" });
    if (!type) return;
    const model = await vscode.window.showInputBox({ title: "Preferred model (optional)", value: seed?.model ?? "", prompt: "Use the provider model id; leave empty for profile/session selection" });
    if (model === undefined) return;
    const modelPolicy = await vscode.window.showQuickPick(["user-selectable", "preferred", "fixed"] as const, { title: "Model policy", placeHolder: seed?.modelPolicy ?? "user-selectable" });
    if (!modelPolicy) return;
    if (modelPolicy === "fixed" && !model.trim()) return void vscode.window.showErrorMessage("A fixed mode must declare a model.");
    const stepsText = await vscode.window.showInputBox({ title: "Maximum agent steps", value: String(seed?.steps ?? 20), validateInput: optionalPositiveInteger });
    if (!stepsText) return;
    const instructions = await vscode.window.showInputBox({ title: "System instructions", value: seed?.instructions ?? "", prompt: "Describe the role, priorities, and boundaries", validateInput: requiredInput });
    if (!instructions) return;
    const authority = await vscode.window.showQuickPick([
      { label: "Read only", description: "Workspace inspection, search, diagnostics, and Git reads", id: "read" as const },
      { label: "Coding with approval", description: "Read plus edits, patches, commands, and checkpoints", id: "write" as const },
    ], { title: "Tool and permission baseline" });
    if (!authority) return;
    const markdown = modeMarkdown({
      ...(seed ?? {}),
      name: name.trim(), slug: slug.trim(), type: type as ModeDefinition["type"], model: model.trim() || undefined,
      modelPolicy: modelPolicy as ModeDefinition["modelPolicy"], steps: Number(stepsText), instructions: instructions.trim(),
      ...modeAuthority(authority.id),
    });
    const uri = await this.customModes.create(scope.id, markdown, slug);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(`Created mode “${name.trim()}”. Advanced policy is available in its Markdown frontmatter.`);
  }

  private async manageModeEntry(entry: ReturnType<CustomModeStore["entries"]>[number]): Promise<void> {
    const canManage = this.customModes.canManage(entry);
    const action = await vscode.window.showQuickPick([
      ...(canManage ? [{ label: "$(edit) Edit raw Markdown", id: "edit" as const }] : []),
      { label: "$(copy) Duplicate", id: "duplicate" as const },
      { label: "$(export) Export", id: "export" as const },
      ...(canManage ? [{ label: BUILT_IN_MODES.some((mode) => mode.id === entry.mode.slug) ? "$(discard) Reset built-in override" : "$(trash) Delete custom mode", id: "delete" as const }] : []),
    ], { title: entry.mode.name, placeHolder: entry.mode.description });
    if (!action) return;
    if (action.id === "edit") return this.customModes.openSource(entry);
    if (action.id === "duplicate") return this.createMode(entry.mode);
    if (action.id === "delete") {
      const confirmed = await vscode.window.showWarningMessage(`Delete mode “${entry.mode.name}”?`, { modal: true, detail: entry.source }, "Delete");
      if (confirmed === "Delete") await this.customModes.delete(entry);
      return;
    }
    const uri = await vscode.window.showSaveDialog({ title: `Export ${entry.mode.name}`, defaultUri: vscode.Uri.file(`${entry.mode.slug}.md`), filters: { Markdown: ["md"] } });
    if (uri) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(modeMarkdown(entry.mode)));
  }

  private async importMode(): Promise<void> {
    const source = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Markdown: ["md"] }, openLabel: "Import mode" }))?.[0];
    if (!source) return;
    const markdown = new TextDecoder().decode(await vscode.workspace.fs.readFile(source));
    const scope = await vscode.window.showQuickPick([
      { label: "Project", id: "project" as const },
      { label: "Global", id: "user" as const },
    ], { title: "Import mode scope" });
    if (!scope) return;
    const preview = loadModeRegistry({ [scope.id]: [{ content: markdown, source: source.toString(true), scope: scope.id }], builtInCollision: "override" });
    const imported = preview.entries.find((entry) => entry.scope === scope.id);
    if (!imported || preview.diagnostics.some((item) => item.severity === "error")) {
      return void vscode.window.showErrorMessage(`Mode import failed: ${preview.diagnostics.map((item) => item.message).join("; ") || "No custom definition found."}`);
    }
    const uri = await this.customModes.create(scope.id, markdown, imported.mode.slug);
    void vscode.window.showInformationMessage(`Imported “${imported.mode.name}” to ${uri.fsPath}.`);
  }

  private async showModeDiagnostics(): Promise<void> {
    const diagnostics = this.customModes.diagnostics();
    if (!diagnostics.length) return void vscode.window.showInformationMessage("No custom mode diagnostics.");
    const picked = await vscode.window.showQuickPick(diagnostics.map((item) => ({ label: `${item.severity === "error" ? "$(error)" : "$(warning)"} ${item.message}`, description: item.source, diagnostic: item })), { title: "Custom mode diagnostics" });
    if (picked?.diagnostic.source) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(picked.diagnostic.source, true));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      if (picked.diagnostic.line) {
        const position = new vscode.Position(Math.max(0, picked.diagnostic.line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      }
    }
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
      const mode = await vscode.window.showQuickPick(this.modeOptions().map((item) => ({ label: item.label, description: item.description, id: item.id })), { title: "Choose mode" });
      if (!mode) return;
      const modelId = await vscode.window.showInputBox({ title: `Default model · ${mode.label}`, value: profile.modeDefaults[mode.id] ?? profile.defaultModel, validateInput: requiredInput });
      if (!modelId) return;
      await this.providerProfiles.updateProfile(profile.id, { modeDefaults: { ...profile.modeDefaults, [mode.id]: modelId.trim() } });
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
      if (active || this.customModes.get(this.mode)?.provider === profile.id) this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId, this.mode) });
      void vscode.window.showInformationMessage(`Fetched ${models.length} model${models.length === 1 ? "" : "s"} from ${profile.name}.`);
    } else if (action.id === "delete") {
      const confirmation = await vscode.window.showWarningMessage(`Delete provider profile “${profile.name}”?`, { modal: true }, "Delete");
      if (confirmation === "Delete") {
        await this.providerProfiles.deleteProfile(profile.id);
        await pruneCachedModels(this.context);
      }
    }
    await this.refreshProviderSelection();
  }

  private async activateProvider(profile: ProviderProfile): Promise<void> {
    const previousProviderId = this.runtime.historyRoute(this.sessionId)?.providerId;
    await this.providerProfiles.setActiveProfile(profile.id);
    try {
      await this.runtime.refreshModels(false, profile.id);
    } catch {
      // ignore
    }
    await this.refreshProviderSelection();
    this.warnAboutMidConversationSwitch("provider", previousProviderId, profile.id);
    void vscode.window.showInformationMessage(`${profile.name} is now active.`);
  }

  private async ensureFreebuffSidecarRunningIfNeeded(): Promise<void> {
    try {
      const definition = this.customModes.get(this.mode);
      const profile = definition?.provider
        ? await this.providerProfiles.getProfile(definition.provider)
        : await this.providerProfiles.getActiveProfile();
      if (!profile) return;
      if (profile.id === "freebuff" || profile.id === "freebuff2api" || profile.baseUrl.includes("127.0.0.1:8080") || profile.baseUrl.includes("localhost:8080")) {
        const probe = await this.freebuffSidecar.probe();
        if (probe === "running") return;
        if (probe === "port-conflict") {
          // Auto-start cannot win a port fight, and retrying every turn just
          // hides the real cause behind provider timeouts.
          if (!this.freebuffPortConflictReported) {
            this.freebuffPortConflictReported = true;
            this.post({
              type: "notice",
              level: "warning",
              message: `Port ${this.freebuffSidecar.getPort()} is held by a process that is not the Freebuff sidecar, so Freebuff requests will fail. Stop whatever owns that port, then reconnect Freebuff in Settings.`,
            });
          }
          return;
        }
        this.freebuffPortConflictReported = false;
        const detected = detectFreebuffCredentials();
        const token = (await this.providerProfiles.getApiKey(profile.id)) || detected?.authToken || "";
        if (!token) return;
        const started = await this.freebuffSidecar.start(token);
        if (!started.ok) {
          this.post({ type: "notice", level: "warning", message: `Freebuff sidecar did not start: ${started.message ?? "unknown error"}` });
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Changing the route mid-conversation is allowed, but the transcript then has
   * to be handed over rather than replayed verbatim. Tell the user before the
   * next turn, so a surprise reasoning-trace drop is a stated tradeoff rather
   * than a silent one. AgentRuntimeBridge performs the actual handoff.
   */
  private warnAboutMidConversationSwitch(kind: "model" | "provider", from: string | undefined, to: string | undefined): void {
    if (!from || !to || from === to) return;
    if (!this.runtime.hasHistory(this.sessionId)) return;
    const label = kind === "model" ? "Model" : "Provider";
    this.post({
      type: "notice",
      level: "warning",
      message: `${label} switched to ${to} mid-conversation. The next turn hands this transcript to the new ${kind}: reasoning traces from ${from} cannot be carried over${kind === "provider" ? ", and unfinished tool calls will be summarized as text" : ""}. Start a new session for a clean context.`,
    });
  }

  private async refreshProviderSelection(): Promise<void> {
    // Discovery caches for deleted profiles would otherwise keep feeding the
    // picker models from endpoints the user removed.
    await pruneCachedModels(this.context);
    const definition = this.customModes.get(this.mode);
    const profile = definition?.provider
      ? await this.providerProfiles.getProfile(definition.provider)
      : await this.providerProfiles.getActiveProfile();
    let model = definition?.model ?? (profile ? resolveProfileModel(profile, { mode: this.mode }) : undefined);

    // A selection that the surviving profile cannot route is stale. Clearing it
    // here is what stops a deleted provider's model from staying selected.
    if (profile) {
      const routable = modelIdsForProfile(this.context, profile.id);
      if (routable.size > 0 && this.modelId && !routable.has(this.modelId)) this.modelId = "";
      if (model && routable.size > 0 && !routable.has(model)) model = undefined;
    } else {
      this.modelId = "";
    }

    if (!model && profile) {
      if (profile.defaultModel) {
        model = profile.defaultModel;
      } else if (profile.manualModels.length > 0 && profile.manualModels[0]) {
        model = profile.manualModels[0].id;
      } else {
        const cached = cachedModelsByProfile(this.context);
        const profileModels = cached[profile.id] ?? [];
        if (profileModels.length > 0 && profileModels[0]) {
          model = profileModels[0].id;
        }
      }
    }
    if (model) {
      this.modelId = model;
      await this.persistence.updateSessionSelection(this.sessionId, { modelId: model });
      this.post({ type: "modelChanged", modelId: model });
    } else if (!this.modelId) {
      // No provider can serve this session any more; fall back to the neutral
      // placeholder so the picker stops advertising a removed endpoint.
      this.modelId = MODEL_OPTIONS[0].id;
      await this.persistence.updateSessionSelection(this.sessionId, { modelId: this.modelId });
      this.post({ type: "modelChanged", modelId: this.modelId });
    }
    this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId, this.mode) });
    this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
  }

  private async fetchProviderModels(profile: ProviderProfile): Promise<unknown[]> {
    const apiKey = await this.providerProfiles.getApiKey(profile.id);
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, "")}/models`, { headers: { ...profile.headers, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}. Check the endpoint and credentials.`);
    const payload = await response.json() as { data?: unknown[] };
    return Array.isArray(payload.data) ? payload.data : [];
  }

  private modeOptions(): ModeOption[] {
    const installed = this.customModes.options();
    return this.modeSelectionRequired && !this.customModes.get(this.mode)
      ? [{ id: this.mode, label: `Unavailable · ${this.mode}`, description: "This session's mode definition is missing or invalid." }, ...installed]
      : installed;
  }

  private async handleModesReloaded(): Promise<void> {
    const entry = this.customModes.entry(this.mode);
    const source = modeSourceKey(entry);
    if (entry && (!this.modeSelectionRequired || (this.acceptedModeSource !== undefined && this.acceptedModeSource === source))) {
      this.acceptedModeSource = source;
      this.post({ type: "modesChanged", modes: this.modeOptions() });
      const profile = entry.mode.provider ? await this.providerProfiles.getProfile(entry.mode.provider) : await this.providerProfiles.getActiveProfile();
      const modeModel = entry.mode.model ?? profile?.modeDefaults[entry.mode.slug];
      if (modeModel) {
        this.modelId = modeModel;
        await this.persistence.updateSessionSelection(this.sessionId, { modelId: modeModel });
        this.post({ type: "modelChanged", modelId: modeModel });
      }
      this.post({ type: "modelsChanged", models: this.runtime.cachedModelOptions(this.modelId, this.mode) });
      this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
      return;
    }
    const previous = this.mode;
    this.modeSelectionRequired = true;
    this.post({ type: "modesChanged", modes: this.modeOptions() });
    this.post({ type: "modeChanged", mode: this.mode });
    this.post({ type: "modelPolicyChanged", modelPolicy: this.runtime.modelPolicyState(this.mode) });
    this.post({ type: "error", kind: "workspace", message: `Mode '${previous}' was removed, shadowed, or changed source, so this session must explicitly select an installed mode before running.` });
  }

  public async getHarnessSettingsState(): Promise<HarnessSettingsState> {
    let rawProfiles = await this.providerProfiles.listProfiles();
    if (rawProfiles.length === 0) {
      try {
        const seeded = await this.providerProfiles.createProfile({
          id: "openai-compatible",
          name: "OpenAI Compatible",
          type: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          headers: {},
          manualModels: [{ id: "gpt-4o", displayName: "GPT-4o" }, { id: "gpt-4o-mini", displayName: "GPT-4o Mini" }],
          defaultModel: "gpt-4o",
          modeDefaults: {},
          compatibility: {
            supportsDeveloperRole: true,
            supportsParallelToolCalls: true,
            requiresAssistantReasoningReplay: false,
            requiresAssistantFrameReplay: false,
            sendMaxTokensAs: "max_tokens",
          },
        });
        rawProfiles = [seeded];
      } catch {
        rawProfiles = await this.providerProfiles.listProfiles();
      }
    }
    const activeId = await this.providerProfiles.getActiveProfileId();
    const cachedByProfile = cachedModelsByProfile(this.context);
    const profiles: ProviderProfileView[] = await Promise.all(
      rawProfiles.map(async (p) => {
        const apiKey = await this.providerProfiles.getApiKey(p.id);
        const cached = cachedByProfile[p.id] ?? [];
        const seen = new Set<string>();
        const models: { id: string; displayName?: string }[] = [];
        for (const m of p.manualModels) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            models.push({ id: m.id, displayName: m.displayName });
          }
        }
        for (const c of cached) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            models.push({ id: c.id, displayName: c.label });
          }
        }
        return {
          id: p.id,
          name: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          defaultModel: p.defaultModel,
          models,
          isActive: p.id === activeId,
          hasApiKey: Boolean(apiKey && apiKey.trim().length > 0),
        };
      })
    );
    const activeProfile = profiles.find((p) => p.isActive) ?? profiles[0];

    const modeEntries = this.customModes.entries();
    const modes: ModeDetailView[] = modeEntries.map((entry) => ({
      id: entry.mode.slug,
      slug: entry.mode.slug,
      name: entry.mode.name,
      description: entry.mode.description ?? entry.mode.instructions.slice(0, 160),
      scope: entry.scope === "user" ? "global" : entry.scope,
      type: entry.mode.type,
      model: entry.mode.model,
      provider: entry.mode.provider,
      modelPolicy: entry.mode.modelPolicy,
      steps: entry.mode.steps,
      tools: entry.mode.tools,
      canManage: this.customModes.canManage(entry),
      colorToken: entry.mode.colorToken,
    }));

    const diagnostics: CustomModeDiagnosticView[] = this.customModes.diagnostics().map((d) => ({
      message: d.message,
      severity: d.severity,
      source: d.source,
      line: d.line,
    }));

    const config = vscode.workspace.getConfiguration("agentdock");
    const defaultMode = config.get<string>("defaultMode", "ask");
    const defaultModel = config.get<string>("defaultModel", MODEL_OPTIONS[0].id);
    const maxSteps = config.get<number>("maxSteps", 20);

    const sidecarStatus = await this.freebuffSidecar.refreshStatus();

    return {
      activeProfile,
      profiles,
      providerPresets: providerPresets().map<ProviderPresetView>(({ id, name, description, category, baseUrl, defaultModel, helpUrl, helpText }) => ({
        id,
        name,
        description,
        category,
        baseUrl,
        ...(defaultModel ? { defaultModel } : {}),
        ...(helpUrl ? { helpUrl } : {}),
        ...(helpText ? { helpText } : {}),
      })),
      modes,
      diagnostics,
      defaultMode,
      defaultModel,
      maxSteps,
      subagents: {
        defaultAuthority: config.get<"read-only" | "same-as-parent" | "write">("subagents.defaultAuthority", "read-only"),
        maxSteps: config.get<number>("subagents.maxSteps", 15),
        maxConcurrent: config.get<number>("subagents.maxConcurrent", 3),
        maxTotal: config.get<number>("subagents.maxTotal", 8),
        maxDepth: config.get<number>("subagents.maxDepth", 1),
        requireWriteApproval: config.get<boolean>("subagents.requireWriteApproval", true),
      },
      workspaceName: vscode.workspace.name,
      freebuffSidecarStatus: sidecarStatus.status,
      freebuffSidecarError: sidecarStatus.error,
      detectedFreebuff: detectFreebuffCredentials(),
    };
  }

  public async postSettingsState(): Promise<void> {
    const state = await this.getHarnessSettingsState();
    this.post({ type: "settingsState", state });
  }

  private skillState(): { skills: SkillOptionView[]; selectedSkillIds: string[]; mandatorySkillIds: string[] } {
    const selectedSkillIds = this.context.workspaceState.get<Record<string, string[]>>(SESSION_SKILLS_STATE_KEY, {})[this.sessionId] ?? [];
    const modeSkills = this.customModes.get(this.mode)?.skills ?? [];
    return {
      skills: this.skills.options().map((skill) => {
        const def = this.skills.resolve(skill.id);
        let sourcePath = def?.source;
        if (sourcePath) {
          const home = os.homedir();
          if (sourcePath.startsWith(home)) {
            sourcePath = "~" + sourcePath.slice(home.length);
          }
        }
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          scope: skill.scope === "user" ? "global" : skill.scope,
          sourceKind: skill.sourceKind,
          ...(sourcePath ? { source: sourcePath } : {}),
        };
      }),
      selectedSkillIds: selectedSkillIds.slice(0, 20),
      mandatorySkillIds: this.skills.resolveIds(modeSkills).resolved,
    };
  }

  private postSkillState(): void {
    this.post({ type: "skillsChanged", ...this.skillState() });
  }

  private async setSelectedSkills(ids: readonly string[], sessionId = this.sessionId): Promise<string[]> {
    const { resolved, missing } = this.skills.resolveIds(ids);
    if (missing.length) {
      this.post({ type: "error", kind: "workspace", message: `Unavailable skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Refresh the installed skills and select again.` });
    }
    const selections = this.context.workspaceState.get<Record<string, string[]>>(SESSION_SKILLS_STATE_KEY, {});
    await this.context.workspaceState.update(SESSION_SKILLS_STATE_KEY, { ...selections, [sessionId]: resolved });
    return resolved;
  }

  private async deleteSelectedSkills(sessionId: string): Promise<void> {
    const selections = { ...this.context.workspaceState.get<Record<string, string[]>>(SESSION_SKILLS_STATE_KEY, {}) };
    delete selections[sessionId];
    await this.context.workspaceState.update(SESSION_SKILLS_STATE_KEY, selections);
  }

  private post(message: ExtensionToUiMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    return renderWebviewHtml(this.context.extensionUri, webview);
  }

  /** Stop the sidecar we spawned so it does not outlive the window. */
  public dispose(): void {
    this.freebuffSidecar.dispose();
    this.freebuffLog.dispose();
  }
}

function modeSourceKey(entry: ReturnType<CustomModeStore["entry"]>): string | undefined {
  return entry ? `${entry.scope}:${entry.source ?? entry.mode.slug}` : undefined;
}

/** Render the single shared webview shell with a strict nonce CSP. */
export function renderWebviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "styles.css")
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Clank</title>
</head>
<body>
  <main id="app" aria-label="Clank chat"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * Fallback view shown when the extension host cannot finish activation (for
 * example, storage or sql.js WASM init fails). Registration happens before the
 * heavy init so the view always resolves; this provider surfaces a visible,
 * actionable error instead of a silently blank panel.
 */
class StartupFailureViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly message: string,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = renderWebviewHtml(this.extensionUri, view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") {
        void view.webview.postMessage({ type: "error", kind: "workspace", message: this.message });
      }
    });
  }

  public dispose(): void {
    this.view = undefined;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function isCanonicalModeSlug(value: string): boolean {
  return validateModeSlug(value) === undefined;
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
    case "requestSettings":
    case "addProvider":
    case "createMode":
    case "importMode":
    case "reloadModes":
    case "openAdvancedSettings":
    case "setupVibeProxy":
    case "toggleFreebuffSidecar":
      return true;
    case "openExternalUrl":
      return typeof message.url === "string" && message.url.length > 0 && message.url.length <= 2048;
    case "setupFreebuff":
      return message.authToken === undefined || (typeof message.authToken === "string" && message.authToken.length <= 4096);
    case "setupAiHubMix":
      return typeof message.apiKey === "string" && message.apiKey.length > 0 && message.apiKey.length <= 4096;
    case "activateProvider":
    case "setProviderApiKey":
    case "clearProviderApiKey":
    case "testProviderConnection":
    case "fetchProviderModels":
    case "editProvider":
    case "deleteProvider":
      return typeof message.profileId === "string" && message.profileId.length > 0 && message.profileId.length <= 256;
    case "openModeSource":
    case "duplicateMode":
    case "deleteMode":
      return typeof message.slug === "string" && message.slug.length > 0 && message.slug.length <= 128;
    case "openModeDiagnostic":
      return typeof message.source === "string" && (message.line === undefined || (typeof message.line === "number" && Number.isSafeInteger(message.line)));
    case "saveDefaultMode":
      return typeof message.mode === "string" && message.mode.length > 0 && message.mode.length <= 128;
    case "saveMaxSteps":
      return typeof message.steps === "number" && Number.isSafeInteger(message.steps) && message.steps >= 1 && message.steps <= 100;
    case "saveSubagentSettings":
      return (message.defaultAuthority === undefined || ["read-only", "same-as-parent", "write"].includes(message.defaultAuthority as string))
        && (message.maxSteps === undefined || (typeof message.maxSteps === "number" && Number.isSafeInteger(message.maxSteps) && message.maxSteps >= 1 && message.maxSteps <= 50))
        && (message.maxConcurrent === undefined || (typeof message.maxConcurrent === "number" && Number.isSafeInteger(message.maxConcurrent) && message.maxConcurrent >= 1 && message.maxConcurrent <= 8))
        && (message.maxTotal === undefined || (typeof message.maxTotal === "number" && Number.isSafeInteger(message.maxTotal) && message.maxTotal >= 1 && message.maxTotal <= 16))
        && (message.maxDepth === undefined || (typeof message.maxDepth === "number" && Number.isSafeInteger(message.maxDepth) && message.maxDepth >= 0 && message.maxDepth <= 2))
        && (message.requireWriteApproval === undefined || typeof message.requireWriteApproval === "boolean");
    case "saveProviderProfile":
      return typeof message.profile === "object" && message.profile !== null && typeof (message.profile as Record<string, unknown>).name === "string" && typeof (message.profile as Record<string, unknown>).baseUrl === "string";
    case "saveCustomMode":
      return typeof message.mode === "object" && message.mode !== null && typeof (message.mode as Record<string, unknown>).name === "string" && typeof (message.mode as Record<string, unknown>).instructions === "string";
    case "openSession":
    case "renameSession":
    case "duplicateSession":
    case "deleteSession":
    case "exportSession":
      return typeof message.sessionId === "string" && message.sessionId.length > 0 && message.sessionId.length <= 256;
    case "changeMode":
      return typeof message.mode === "string" && validateModeSlug(message.mode) === undefined;
    case "changeModel":
      return typeof message.modelId === "string" && message.modelId.length > 0 && message.modelId.length <= 256;
    case "changeSkills":
      return isSkillIds(message.skillIds);
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
    case "approvePlan":
    case "revisePlan":
    case "savePlan":
    case "discardPlan":
      return typeof message.planId === "string"
        && message.planId.length > 0
        && message.planId.length <= 256
        && typeof message.revision === "number"
        && Number.isSafeInteger(message.revision)
        && message.revision >= 1
        && message.revision <= 1_000_000;
    case "sendMessage":
      return typeof message.text === "string"
        && message.text.length > 0
        && message.text.length <= 100_000
        && typeof message.mode === "string"
        && validateModeSlug(message.mode) === undefined
        && typeof message.modelId === "string"
        && message.modelId.length > 0
        && message.modelId.length <= 256
        && Array.isArray(message.context)
        && message.context.length <= 32
        && message.context.every(isContextRef)
        && isSkillIds(message.skillIds);
    default:
      return false;
  }
}

function isSkillIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 20
    && value.every((item) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item));
}

function providerConnectionError(error: unknown): string {
  const record = error && typeof error === "object" ? error as { message?: unknown; status?: unknown } : undefined;
  const status = typeof record?.status === "number" ? record.status : undefined;
  const detail = typeof record?.message === "string" ? record.message : error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) return `Authentication failed (HTTP ${status}). Check this profile's API key or the proxy's client-auth settings.`;
  if (status === 429) return "The provider is rate limited (HTTP 429). Wait or explicitly choose another configured route.";
  if (status !== undefined) return `The endpoint returned HTTP ${status}: ${detail.slice(0, 300)}`;
  if (/abort|timeout/i.test(detail)) return "The provider model probe timed out. Check that the endpoint is running and reachable.";
  if (/fetch|network|connect|ECONNREFUSED|ENOTFOUND/i.test(detail)) return `The provider is unreachable: ${detail.slice(0, 300)}`;
  return `The endpoint is not OpenAI-compatible: ${detail.slice(0, 300)}`;
}

function safeModeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "custom";
}

function validateModeSlug(value: string): string | undefined {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.trim()) ? undefined : "Use 1–64 lowercase letters, numbers, and single dashes.";
}

function modeAuthority(authority: "read" | "write"): Pick<ModeDefinition, "tools" | "permission" | "skills" | "delegationAllowed" | "allowedAgents" | "delegationEffects"> {
  if (authority === "write") return {
    tools: ["read*", "list_directory", "glob", "grep", "git_*", "get_diagnostics", "load_skill", "write_file", "edit_file", "apply_patch", "run_command", "task"],
    permission: {
      read: "allow", list_directory: "allow", glob: "allow", grep: "allow", git_read: "allow", get_diagnostics: "allow", load_skill: "allow",
      write_file: "ask", edit_file: "ask", apply_patch: "ask", run_command: { "*": "ask", "git push*": "deny" }, task: "allow",
    },
    skills: [], delegationAllowed: true,
    allowedAgents: ["explore", "research", "test", "review", "general", "implementer"], delegationEffects: "write",
  };
  return {
    tools: ["read*", "list_directory", "glob", "grep", "git_*", "get_diagnostics", "load_skill", "task"],
    permission: { read: "allow", list_directory: "allow", glob: "allow", grep: "allow", git_read: "allow", get_diagnostics: "allow", load_skill: "allow", edit: "deny", write: "deny", run_command: "deny", task: "allow" },
    skills: [], delegationAllowed: true, allowedAgents: ["explore", "research", "test", "review"], delegationEffects: "read-only",
  };
}

function modeMarkdown(mode: ModeDefinition): string {
  const fields: Record<string, unknown> = {
    name: mode.name,
    slug: mode.slug,
    ...(mode.description ? { description: mode.description } : {}),
    type: mode.type,
    ...(mode.icon ? { icon: mode.icon } : {}),
    ...(mode.colorToken ? { colorToken: mode.colorToken } : {}),
    ...(mode.provider ? { provider: mode.provider } : {}),
    ...(mode.routeOverrides !== undefined ? { routeOverrides: mode.routeOverrides } : {}),
    ...(mode.model ? { model: mode.model } : {}),
    modelPolicy: mode.modelPolicy ?? "user-selectable",
    ...(mode.reasoningEffort ? { reasoningEffort: mode.reasoningEffort } : {}),
    ...(mode.temperature !== undefined ? { temperature: mode.temperature } : {}),
    ...(mode.topP !== undefined ? { topP: mode.topP } : {}),
    ...(mode.maxOutputTokens !== undefined ? { maxOutputTokens: mode.maxOutputTokens } : {}),
    steps: mode.steps,
    toolsMode: mode.toolsMode ?? "replace",
    tools: mode.tools,
    permission: mode.permission,
    ...(mode.filePatterns?.length ? { filePatterns: mode.filePatterns } : {}),
    ...(mode.commandPatterns?.length ? { commandPatterns: mode.commandPatterns } : {}),
    ...(mode.mcpToolPatterns?.length ? { mcpToolPatterns: mode.mcpToolPatterns } : {}),
    skillsMode: mode.skillsMode ?? "replace",
    skills: mode.skills,
    delegationAllowed: mode.delegationAllowed,
    allowedAgents: mode.allowedAgents,
    delegationEffects: mode.delegationEffects,
    ...(mode.defaultContextSources?.length ? { defaultContextSources: mode.defaultContextSources } : {}),
    ...(mode.responseTemplate ? { responseTemplate: mode.responseTemplate } : {}),
  };
  return `---\n${yamlObject(fields)}---\n\n${mode.instructions.trim()}\n`;
}

function yamlObject(value: Record<string, unknown>, indent = 0): string {
  const prefix = " ".repeat(indent);
  return Object.entries(value).map(([key, item]) => {
    if (Array.isArray(item)) {
      if (!item.length) return `${prefix}${key}: []\n`;
      return `${prefix}${key}:\n${item.map((entry) => `${prefix}  - ${yamlScalar(entry)}\n`).join("")}`;
    }
    if (item && typeof item === "object") return `${prefix}${key}:\n${yamlObject(item as Record<string, unknown>, indent + 2)}`;
    return `${prefix}${key}: ${yamlScalar(item)}\n`;
  }).join("");
}

function yamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value ?? ""));
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
