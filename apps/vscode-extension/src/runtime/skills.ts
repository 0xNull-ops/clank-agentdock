import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import {
  loadSkillRegistry,
  type InstructionSource,
  type SkillDefinition,
  type SkillDiagnostic,
  type SkillOption,
  type SkillRegistryResult,
  type SkillScope,
  type SkillSource,
  type SkillSourceKind,
} from "@freebuff/agent-core";

const PRODUCT_DIRECTORY = "freebuff-agent-harness";
const MAX_SKILL_FILES_PER_ROOT = 200;
const MAX_SKILL_FILE_BYTES = 128 * 1024;
const MAX_ACTIVE_SKILLS = 20;
const MAX_ACTIVE_SKILL_CHARS = 128_000;
const PROJECT_PATTERNS = [
  ".agents/skills/*/SKILL.md",
  ".agent/skills/*.md",
  ".agent/skills/*/SKILL.md",
] as const;

export interface SkillTurnSnapshot {
  readonly options: readonly SkillOption[];
  resolve(id: string): SkillDefinition | undefined;
  resolveIds(ids: readonly string[]): { resolved: string[]; missing: string[] };
  load(ids: readonly string[]): InstructionSource[];
}

/** Host-owned discovery and loading module for reusable skill instructions. */
export class SkillStore implements vscode.Disposable {
  private snapshot: SkillRegistryResult = loadSkillRegistry();
  private reloadQueue: Promise<SkillRegistryResult> = Promise.resolve(this.snapshot);
  private readonly changed = new vscode.EventEmitter<SkillRegistryResult>();
  private readonly watchers: vscode.Disposable[] = [];

  private constructor() {}

  public static async open(_context: vscode.ExtensionContext): Promise<SkillStore> {
    const store = new SkillStore();
    await store.reload();
    for (const pattern of PROJECT_PATTERNS) {
      const watcher = vscode.workspace.createFileSystemWatcher(`**/${pattern}`);
      watcher.onDidCreate(() => void store.reload());
      watcher.onDidChange(() => void store.reload());
      watcher.onDidDelete(() => void store.reload());
      store.watchers.push(watcher);
    }
    for (const root of store.userRoots()) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root.path, "**/*.{md,MD}"));
      watcher.onDidCreate(() => void store.reload());
      watcher.onDidChange(() => void store.reload());
      watcher.onDidDelete(() => void store.reload());
      store.watchers.push(watcher);
    }
    store.watchers.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void store.reload()));
    store.watchers.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void store.reload()));
    return store;
  }

  public readonly onDidChange = this.changed.event;

  public options(): readonly SkillOption[] {
    return this.snapshot.options;
  }

  public capture(): SkillTurnSnapshot {
    const snapshot = this.snapshot;
    const resolveIds = (ids: readonly string[]): { resolved: string[]; missing: string[] } => {
      const resolved: string[] = [];
      const missing: string[] = [];
      for (const raw of ids.slice(0, MAX_ACTIVE_SKILLS)) {
        const id = raw.trim().toLowerCase();
        if (!id || resolved.includes(id) || missing.includes(id)) continue;
        if (snapshot.resolve(id)) resolved.push(id);
        else missing.push(id);
      }
      return { resolved, missing };
    };
    return {
      options: snapshot.options,
      resolve: (id) => snapshot.resolve(id),
      resolveIds,
      load: (ids) => loadSkillSources(snapshot, resolveIds(ids).resolved),
    };
  }

  public diagnostics(): readonly SkillDiagnostic[] {
    return this.snapshot.diagnostics;
  }

  public resolve(id: string): SkillDefinition | undefined {
    return this.snapshot.resolve(id);
  }

  public resolveIds(ids: readonly string[]): { resolved: string[]; missing: string[] } {
    return this.capture().resolveIds(ids);
  }

  public load(ids: readonly string[]): InstructionSource[] {
    return this.capture().load(ids);
  }

  public reload(): Promise<SkillRegistryResult> {
    const run = this.reloadQueue.then(() => this.performReload());
    this.reloadQueue = run.catch(() => this.snapshot);
    return run;
  }

  public dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.changed.dispose();
  }

  private async performReload(): Promise<SkillRegistryResult> {
    const userRoots = this.userRoots();
    const [codex, agents, global, project] = await Promise.all([
      this.readRoot(userRoots[0]),
      this.readRoot(userRoots[1]),
      this.readRoot(userRoots[2]),
      this.readProjectSources(),
    ]);
    // Low-precedence sources load first; equal-precedence definitions loaded
    // later replace earlier ones deterministically.
    this.snapshot = loadSkillRegistry({ sources: [...codex, ...agents, ...global, ...project] });
    this.changed.fire(this.snapshot);
    return this.snapshot;
  }

  private userRoots(): Array<{ path: string; scope: SkillScope; sourceKind: SkillSourceKind }> {
    return [
      { path: join(homedir(), ".codex", "skills"), scope: "installed", sourceKind: "installed" },
      { path: join(homedir(), ".agents", "skills"), scope: "installed", sourceKind: "installed" },
      { path: join(homedir(), ".config", PRODUCT_DIRECTORY, "skills"), scope: "user", sourceKind: "native" },
    ];
  }

  private async readProjectSources(): Promise<SkillSource[]> {
    if (!vscode.workspace.isTrusted) return [];
    const sources: SkillSource[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const pattern of PROJECT_PATTERNS) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, MAX_SKILL_FILES_PER_ROOT);
        for (const uri of files.sort((left, right) => left.toString(true).localeCompare(right.toString(true)))) {
          const sourceKind: SkillSourceKind = pattern.startsWith(".agent/") ? "native" : "compatibility";
          const source = await this.readSkillFile(uri, folder.uri, "project", sourceKind);
          if (source) sources.push(source);
        }
      }
    }
    return sources;
  }

  private async readRoot(root: { path: string; scope: SkillScope; sourceKind: SkillSourceKind }): Promise<SkillSource[]> {
    const directory = vscode.Uri.file(root.path);
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      const candidates: vscode.Uri[] = [];
      for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_SKILL_FILES_PER_ROOT)) {
        if (type === vscode.FileType.Directory) candidates.push(vscode.Uri.joinPath(directory, name, "SKILL.md"));
        else if (type === vscode.FileType.File && name.toLowerCase().endsWith(".md")) candidates.push(vscode.Uri.joinPath(directory, name));
      }
      const sources: SkillSource[] = [];
      for (const uri of candidates) {
        const source = await this.readSkillFile(uri, directory, root.scope, root.sourceKind);
        if (source) sources.push(source);
      }
      return sources;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return [];
      return [];
    }
  }

  private async readSkillFile(
    uri: vscode.Uri,
    root: vscode.Uri,
    scope: SkillScope,
    sourceKind: SkillSourceKind,
  ): Promise<SkillSource | undefined> {
    try {
      if (!(await isContainedFile(root, uri))) return { content: "", source: uri.toString(true), scope, sourceKind };
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SKILL_FILE_BYTES) return { content: "", source: uri.toString(true), scope, sourceKind };
      return {
        content: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)),
        source: uri.toString(true),
        scope,
        sourceKind,
      };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
      return { content: "", source: uri.toString(true), scope, sourceKind };
    }
  }
}

function loadSkillSources(snapshot: SkillRegistryResult, ids: readonly string[]): InstructionSource[] {
  const sources: InstructionSource[] = [];
  let remaining = MAX_ACTIVE_SKILL_CHARS;
  for (const id of ids) {
    const skill = snapshot.resolve(id);
    if (!skill || remaining <= 0) continue;
    const content = skill.content.slice(0, Math.min(32_000, remaining));
    if (!content) continue;
    sources.push({ source: `skill:${skill.id}`, content });
    remaining -= content.length;
  }
  return sources;
}

async function isContainedFile(root: vscode.Uri, target: vscode.Uri): Promise<boolean> {
  if (root.scheme !== "file" || target.scheme !== "file") return root.scheme === target.scheme;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root.fsPath), realpath(target.fsPath)]);
    const rel = relative(canonicalRoot, canonicalTarget);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && basename(canonicalTarget).toLowerCase().endsWith(".md");
  } catch {
    return false;
  }
}
