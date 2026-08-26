import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import {
  CheckpointConflictError,
  CheckpointStore,
  type CheckpointPair,
  type DiffSummary,
  type Snapshot,
} from "@freebuff/checkpoints";
import { checkpointCardFromSummary } from "./shared/checkpoints";
import type { CheckpointSummaryCard, ExtensionToUiMessage } from "./shared/protocol";

export const CHECKPOINT_DOCUMENT_SCHEME = "agentdock-checkpoint";
export { CheckpointConflictError };

const CHECKPOINTS_STATE_KEY = "agentdock.checkpoints.recent";
const MAX_PERSISTED_CHECKPOINTS = 20;
const MAX_VIRTUAL_DOCUMENT_BYTES = 2_000_000;

interface CheckpointDescriptor {
  id: string;
  label: string;
  createdAt: number;
  workspaceRoot: string;
  beforeId: string;
  afterId: string;
}

export interface CheckpointTurn {
  id: string;
  label: string;
  before: Snapshot;
  startedAt: number;
}

export interface CheckpointCompletion {
  pair: CheckpointPair;
  summary: DiffSummary;
  card: CheckpointSummaryCard;
}

export interface CheckpointRunResult<T> {
  result: T;
  completion?: CheckpointCompletion;
}

export interface CheckpointCoordinatorHost {
  context: vscode.ExtensionContext;
  post(message: ExtensionToUiMessage): void;
}

interface ActiveTurn {
  turn: CheckpointTurn;
  store: CheckpointStore;
  workspaceRoot: string;
}

/**
 * Extension-host lifecycle adapter for durable before/after workspace snapshots.
 * It intentionally does not know how tools mutate files: callers bracket the
 * operation with beginTurn/completeTurn, or use runWithCheckpoint.
 */
export class CheckpointCoordinator {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly pairs = new Map<string, { pair: CheckpointPair; store: CheckpointStore }>();
  public readonly documents: CheckpointDocumentProvider;

  public constructor(private readonly host: CheckpointCoordinatorHost) {
    this.documents = new CheckpointDocumentProvider(this);
  }

  public async beginTurn(label: string): Promise<CheckpointTurn | undefined> {
    const workspaceRoot = this.workspaceRoot();
    if (!workspaceRoot) return undefined;
    const store = this.store(workspaceRoot);
    const before = await store.capture(`${label} · before`);
    const turn: CheckpointTurn = {
      id: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      label,
      before,
      startedAt: Date.now(),
    };
    this.active.set(turn.id, { turn, store, workspaceRoot });
    return turn;
  }

  public async completeTurn(turn: CheckpointTurn | undefined): Promise<CheckpointCompletion | undefined> {
    if (!turn) return undefined;
    const active = this.active.get(turn.id);
    if (!active) return undefined;
    this.active.delete(turn.id);
    const after = await active.store.capture(`${turn.label} · after`);
    const pair: CheckpointPair = {
      id: turn.id,
      label: turn.label,
      before: turn.before,
      after,
      createdAt: Date.now(),
    };
    const summary = active.store.summarize(pair.before, pair.after);
    const card = checkpointCardFromSummary(pair.id, pair.label, summary, pair.createdAt);
    this.pairs.set(pair.id, { pair, store: active.store });
    await this.remember({
      id: pair.id,
      label: pair.label,
      createdAt: pair.createdAt,
      workspaceRoot: active.workspaceRoot,
      beforeId: pair.before.manifest.id,
      afterId: pair.after.manifest.id,
    });
    // No noisy empty cards: a checkpoint still exists for callers, but the UI
    // only needs an action card when the turn changed workspace files.
    if (summary.filesChanged > 0) this.host.post({ type: "checkpointSummary", checkpoint: card });
    return { pair, summary, card };
  }

  public async runWithCheckpoint<T>(label: string, operation: () => Promise<T> | T): Promise<CheckpointRunResult<T>> {
    const turn = await this.beginTurn(label);
    let result!: T;
    let operationError: unknown;
    let operationFailed = false;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }
    let completion: CheckpointCompletion | undefined;
    let checkpointError: unknown;
    let checkpointFailed = false;
    try {
      completion = await this.completeTurn(turn);
    } catch (error) {
      checkpointError = error;
      checkpointFailed = true;
    }
    if (operationFailed) throw operationError;
    if (checkpointFailed) throw checkpointError;
    return { result, completion };
  }

  public async getPair(id: string): Promise<{ pair: CheckpointPair; store: CheckpointStore } | undefined> {
    const existing = this.pairs.get(id);
    if (existing) return existing;
    const descriptor = this.descriptors().find((candidate) => candidate.id === id);
    const workspaceRoot = this.workspaceRoot();
    if (!descriptor || !workspaceRoot || resolve(descriptor.workspaceRoot) !== resolve(workspaceRoot)) return undefined;
    const store = this.store(workspaceRoot);
    try {
      const [before, after] = await Promise.all([store.load(descriptor.beforeId), store.load(descriptor.afterId)]);
      const pair: CheckpointPair = { id: descriptor.id, label: descriptor.label, before, after, createdAt: descriptor.createdAt };
      const value = { pair, store };
      this.pairs.set(id, value);
      return value;
    } catch {
      return undefined;
    }
  }

  public async restoreRecentCards(): Promise<void> {
    const descriptors = this.descriptors();
    for (const descriptor of descriptors) {
      const loaded = await this.getPair(descriptor.id);
      if (!loaded) continue;
      const summary = loaded.store.summarize(loaded.pair.before, loaded.pair.after);
      if (summary.filesChanged > 0) this.host.post({ type: "checkpointSummary", checkpoint: checkpointCardFromSummary(descriptor.id, descriptor.label, summary, descriptor.createdAt) });
    }
  }

  public async revert(id: string): Promise<CheckpointCompletion> {
    const loaded = await this.getPair(id);
    if (!loaded) throw new Error("Checkpoint is no longer available in this workspace.");
    const summary = await loaded.store.revert(loaded.pair);
    const card = checkpointCardFromSummary(loaded.pair.id, loaded.pair.label, summary, loaded.pair.createdAt);
    this.pairs.delete(id);
    await this.forget(id);
    return { pair: loaded.pair, summary, card };
  }

  public async openDiff(id: string, path?: string): Promise<void> {
    const loaded = await this.getPair(id);
    if (!loaded) {
      void vscode.window.showErrorMessage("The requested Agent Harness checkpoint is no longer available.");
      return;
    }
    const summary = loaded.store.summarize(loaded.pair.before, loaded.pair.after);
    if (!summary.files.length) {
      void vscode.window.showInformationMessage("This checkpoint contains no file changes.");
      return;
    }
    let selectedPath = path;
    if (selectedPath && !summary.files.some((file) => file.path === selectedPath)) selectedPath = undefined;
    if (!selectedPath && summary.files.length > 1) {
      const selected = await vscode.window.showQuickPick(
        summary.files.map((file) => ({ label: file.path, description: formatDiffFile(file) })),
        { placeHolder: "Choose a changed file to compare" },
      );
      selectedPath = selected?.label;
    }
    if (!selectedPath) selectedPath = summary.files[0].path;
    const beforeUri = checkpointDocumentUri(loaded.pair.id, "before", selectedPath);
    const afterUri = checkpointDocumentUri(loaded.pair.id, "after", selectedPath);
    await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `${loaded.pair.label}: ${selectedPath}`);
  }

  public async readDocument(id: string, side: "before" | "after", path: string): Promise<string> {
    const loaded = await this.getPair(id);
    if (!loaded) return `Checkpoint ${id} is no longer available.`;
    const snapshot = side === "before" ? loaded.pair.before : loaded.pair.after;
    const entry = snapshot.manifest.files.find((candidate) => candidate.path === path);
    if (!entry) return "";
    if (entry.binary) return `[Binary file: ${entry.path}]\nSize: ${entry.size} bytes\nSHA-256: ${entry.hash}`;
    const blob = resolve(snapshot.storagePath, entry.blobPath);
    if (!isWithin(snapshot.storagePath, blob)) return "Checkpoint blob path is invalid.";
    try {
      const bytes = await fs.readFile(blob);
      return new TextDecoder().decode(bytes.subarray(0, MAX_VIRTUAL_DOCUMENT_BYTES));
    } catch {
      return `Unable to read checkpoint content for ${entry.path}.`;
    }
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private store(workspaceRoot: string): CheckpointStore {
    return new CheckpointStore({ workspaceRoot });
  }

  private descriptors(): CheckpointDescriptor[] {
    return this.host.context.globalState.get<CheckpointDescriptor[]>(CHECKPOINTS_STATE_KEY, []);
  }

  private async remember(descriptor: CheckpointDescriptor): Promise<void> {
    const descriptors = [descriptor, ...this.descriptors().filter((candidate) => candidate.id !== descriptor.id)].slice(0, MAX_PERSISTED_CHECKPOINTS);
    await this.host.context.globalState.update(CHECKPOINTS_STATE_KEY, descriptors);
  }

  private async forget(id: string): Promise<void> {
    await this.host.context.globalState.update(CHECKPOINTS_STATE_KEY, this.descriptors().filter((candidate) => candidate.id !== id));
  }
}

export class CheckpointDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.changes.event;

  public constructor(private readonly coordinator: CheckpointCoordinator) {}

  public provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
    const params = new URLSearchParams(uri.query);
    const id = params.get("checkpointId");
    const side = params.get("side");
    const path = params.get("path");
    if (!id || (side !== "before" && side !== "after") || !path) return Promise.resolve("Invalid checkpoint document URI.");
    return this.coordinator.readDocument(id, side, path);
  }

  public dispose(): void {
    this.changes.dispose();
  }
}

export function checkpointDocumentUri(id: string, side: "before" | "after", path: string): vscode.Uri {
  const query = new URLSearchParams({ checkpointId: id, side, path }).toString();
  return vscode.Uri.parse(`${CHECKPOINT_DOCUMENT_SCHEME}:snapshot?${query}`);
}

function formatDiffFile(file: DiffSummary["files"][number]): string {
  if (file.binary) return `${file.status} · binary`;
  return `${file.status} · +${file.linesAdded} -${file.linesRemoved}`;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
