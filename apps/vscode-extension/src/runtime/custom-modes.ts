import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import {
  loadModeRegistry,
  type ModeDefinition,
  type ModeDiagnostic,
  type ModeRegistryEntry,
  type ModeRegistryResult,
  type ModeScope,
  type ModeSource,
} from "@freebuff/agent-core";
import type { ModeOption } from "../shared/protocol";

const PRODUCT_DIRECTORY = "freebuff-agent-harness";
// Compatibility sources load first; the native project location therefore
// wins deterministic same-scope collisions without modifying third-party files.
const PROJECT_GLOBS = [".opencode/agents/*.md", ".kilo/agents/*.md", ".agent/agents/*.md"] as const;

/** Host-owned loader for global and project Markdown agent profiles. */
export class CustomModeStore implements vscode.Disposable {
  private snapshot: ModeRegistryResult = loadModeRegistry();
  private reloadQueue: Promise<ModeRegistryResult> = Promise.resolve(this.snapshot);
  private readonly changed = new vscode.EventEmitter<ModeRegistryResult>();
  private readonly watchers: vscode.Disposable[] = [];

  private constructor() {}

  public static async open(_context: vscode.ExtensionContext): Promise<CustomModeStore> {
    const store = new CustomModeStore();
    await store.reload();
    for (const pattern of PROJECT_GLOBS) {
      const watcher = vscode.workspace.createFileSystemWatcher(`**/${pattern}`);
      watcher.onDidCreate(() => void store.reload());
      watcher.onDidChange(() => void store.reload());
      watcher.onDidDelete(() => void store.reload());
      store.watchers.push(watcher);
    }
    const globalWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(store.userDirectory(), "*.md"));
    globalWatcher.onDidCreate(() => void store.reload());
    globalWatcher.onDidChange(() => void store.reload());
    globalWatcher.onDidDelete(() => void store.reload());
    store.watchers.push(globalWatcher);
    store.watchers.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void store.reload()));
    store.watchers.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void store.reload()));
    store.watchers.push(vscode.workspace.onDidSaveTextDocument((document) => {
      if (store.isManagedUri(document.uri, "user")) void store.reload();
    }));
    return store;
  }

  public readonly onDidChange = this.changed.event;

  public get(slug: string): ModeDefinition | undefined {
    return this.snapshot.get(slug);
  }

  public entries(): readonly ModeRegistryEntry[] {
    return this.snapshot.entries;
  }

  public entry(slug: string): ModeRegistryEntry | undefined {
    return this.snapshot.entries.find((entry) => entry.mode.slug === slug);
  }

  public requiresExplicitReselection(slug: string): boolean {
    return this.snapshot.diagnostics.some((diagnostic) => diagnostic.slug === slug && (diagnostic.code === "shadowed-mode" || diagnostic.code === "built-in-collision"));
  }

  public diagnostics(): readonly ModeDiagnostic[] {
    return this.snapshot.diagnostics;
  }

  public canManage(entry: ModeRegistryEntry): boolean {
    return entry.scope !== "built-in" && Boolean(entry.source) && this.isManagedUri(vscode.Uri.parse(entry.source!, true), entry.scope);
  }

  public options(): ModeOption[] {
    const builtInSlugs = new Set(loadModeRegistry().entries.filter((entry) => entry.scope === "built-in").map((entry) => entry.mode.slug));
    return this.snapshot.entries
      .filter((entry) => entry.mode.type === "primary" || entry.mode.type === "all")
      .map((entry) => ({
        id: entry.mode.slug,
        label: entry.scope !== "built-in" && builtInSlugs.has(entry.mode.slug) ? `${entry.mode.name} · ${entry.scope} override` : entry.mode.name,
        description: entry.mode.description ?? entry.mode.instructions.slice(0, 160),
        ...(entry.mode.colorToken ? { colorToken: entry.mode.colorToken } : {}),
        source: entry.scope === "user" ? "global" : entry.scope,
      }));
  }

  public reload(): Promise<ModeRegistryResult> {
    const run = this.reloadQueue.then(() => this.performReload());
    this.reloadQueue = run.catch(() => this.snapshot);
    return run;
  }

  private async performReload(): Promise<ModeRegistryResult> {
    const [user, project] = await Promise.all([this.readUserSources(), this.readProjectSources()]);
    this.snapshot = loadModeRegistry({ user, project, builtInCollision: "override" });
    this.changed.fire(this.snapshot);
    return this.snapshot;
  }

  public async create(scope: ModeScope, markdown: string, preferredSlug: string): Promise<vscode.Uri> {
    const fileName = `${safeSlug(preferredSlug)}.md`;
    const directory = scope === "user" ? vscode.Uri.file(this.userDirectory()) : await this.pickProjectDirectory();
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, fileName);
    try {
      await vscode.workspace.fs.stat(uri);
      throw new Error(`A mode file already exists at ${uri.fsPath}.`);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(markdown));
        await this.reload();
        return uri;
      }
      throw error;
    }
  }

  public async delete(entry: ModeRegistryEntry): Promise<void> {
    if (entry.scope === "built-in" || !entry.source) throw new Error("Built-in modes cannot be deleted.");
    const uri = vscode.Uri.parse(entry.source, true);
    if (!this.isManagedUri(uri, entry.scope)) throw new Error("Refusing to delete a mode outside a managed agents directory.");
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
    await this.reload();
  }

  public async openSource(entry: ModeRegistryEntry): Promise<void> {
    if (!entry.source) throw new Error("This built-in mode has no Markdown source file.");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.source, true));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.changed.dispose();
  }

  private userDirectory(): string {
    return join(homedir(), ".config", PRODUCT_DIRECTORY, "agents");
  }

  private async readUserSources(): Promise<ModeSource[]> {
    return this.readDirectory(vscode.Uri.file(this.userDirectory()), "user");
  }

  private async readProjectSources(): Promise<ModeSource[]> {
    if (!vscode.workspace.isTrusted) return [];
    const sources: ModeSource[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const pattern of PROJECT_GLOBS) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 200);
        for (const uri of files.sort((left, right) => left.toString(true).localeCompare(right.toString(true)))) {
          if (!(await isContainedProjectFile(folder.uri, uri))) {
            sources.push({ content: "", source: uri.toString(true), scope: "project" });
            continue;
          }
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > 512 * 1024) {
            sources.push({ content: "", source: uri.toString(true), scope: "project" });
            continue;
          }
          sources.push({ content: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), source: uri.toString(true), scope: "project" });
        }
      }
    }
    return sources;
  }

  private async readDirectory(directory: vscode.Uri, scope: ModeScope): Promise<ModeSource[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      const markdown = entries.filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith(".md")).sort(([left], [right]) => left.localeCompare(right));
      return Promise.all(markdown.slice(0, 200).map(async ([name]) => {
        const uri = vscode.Uri.joinPath(directory, name);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 512 * 1024) return { content: "", source: uri.toString(true), scope };
        return { content: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), source: uri.toString(true), scope };
      }));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return [];
      throw error;
    }
  }

  private async pickProjectDirectory(): Promise<vscode.Uri> {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before creating a project mode.");
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error("Open a workspace before creating a project mode.");
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the workspace folder for this mode" });
    if (!folder) throw new Error("No workspace folder selected.");
    return vscode.Uri.joinPath(folder.uri, ".agent", "agents");
  }

  private isManagedUri(uri: vscode.Uri, scope: ModeScope): boolean {
    if (uri.scheme !== "file" || basename(uri.fsPath).toLowerCase().endsWith(".md") === false) return false;
    const target = resolve(uri.fsPath);
    const roots = scope === "user"
      ? [resolve(this.userDirectory())]
      : (vscode.workspace.workspaceFolders ?? []).map((folder) => resolve(folder.uri.fsPath, ".agent", "agents"));
    return roots.some((root) => target.startsWith(`${root}${sep}`));
  }
}

async function isContainedProjectFile(root: vscode.Uri, target: vscode.Uri): Promise<boolean> {
  if (root.scheme !== "file" || target.scheme !== "file") return root.scheme === target.scheme;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root.fsPath), realpath(target.fsPath)]);
    const rel = relative(canonicalRoot, canonicalTarget);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(canonicalTarget).startsWith(`${resolve(canonicalRoot)}${sep}.git${sep}`);
  } catch {
    return false;
  }
}

function safeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "custom";
}
