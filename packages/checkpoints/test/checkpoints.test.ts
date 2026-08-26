import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointConflictError, CheckpointStore } from "../src";

async function workspace(): Promise<{ root: string; store: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-checkpoint-workspace-"));
  const store = await mkdtemp(join(tmpdir(), "forge-checkpoint-store-"));
  await fs.mkdir(join(root, ".git"));
  await fs.writeFile(join(root, ".gitignore"), "ignored.log\nignored-dir/\n");
  await fs.writeFile(join(root, ".agentignore"), "agent-only.txt\n");
  await fs.writeFile(join(root, "tracked.txt"), "one\ntwo\n");
  await fs.writeFile(join(root, "ignored.log"), "do not snapshot");
  await fs.mkdir(join(root, "ignored-dir"));
  await fs.writeFile(join(root, "ignored-dir", "nested.txt"), "do not snapshot");
  await fs.writeFile(join(root, "agent-only.txt"), "do not snapshot");
  await fs.writeFile(join(root, ".env"), "SECRET=never-copy");
  await fs.writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 2, 3]));
  return { root, store };
}

describe("CheckpointStore", () => {
  test("captures hashes, modes, binary metadata, and exclusion reasons", async () => {
    const fixture = await workspace();
    try {
      const checkpoints = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      const snapshot = await checkpoints.capture("before turn");
      expect(snapshot.storagePath).toContain(fixture.store);
      expect(snapshot.storagePath).not.toContain(join(fixture.root, ".git"));
      expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual([".agentignore", ".gitignore", "asset.bin", "tracked.txt"]);
      expect(snapshot.manifest.files.find((entry) => entry.path === "asset.bin")?.binary).toBe(true);
      expect(snapshot.manifest.files.find((entry) => entry.path === "tracked.txt")?.hash).toHaveLength(64);
      expect(snapshot.manifest.files.find((entry) => entry.path === "tracked.txt")?.mode).toBeGreaterThan(0);
      expect(snapshot.manifest.excluded).toEqual(expect.arrayContaining([
        { path: ".env", reason: "protected" },
        { path: "ignored.log", reason: "gitignore" },
        { path: "agent-only.txt", reason: "agentignore" },
        { path: ".git", reason: "internal" },
      ]));
      const loaded = await checkpoints.load(snapshot.manifest.id);
      expect(loaded.manifest.files).toEqual(snapshot.manifest.files);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
    }
  });

  test("summarizes added, removed, and modified text with line counts", async () => {
    const fixture = await workspace();
    try {
      const checkpoints = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      const before = await checkpoints.capture("before");
      await fs.writeFile(join(fixture.root, "tracked.txt"), "one\nchanged\nthree\n");
      await fs.writeFile(join(fixture.root, "new.txt"), "fresh\nfile\n");
      const after = await checkpoints.capture("after");
      const diff = checkpoints.summarize(before, after);
      expect(diff.filesChanged).toBe(2);
      expect(diff.files.map((file) => [file.path, file.status])).toEqual([["new.txt", "added"], ["tracked.txt", "modified"]]);
      expect(diff.additions).toBeGreaterThan(0);
      expect(diff.removals).toBeGreaterThan(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
    }
  });

  test("reverts text and untracked files atomically when post-state still matches", async () => {
    const fixture = await workspace();
    try {
      const checkpoints = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      const originalMode = (await fs.stat(join(fixture.root, "tracked.txt"))).mode & 0o7777;
      const pair = await checkpoints.create("edit files", async () => {
        await fs.writeFile(join(fixture.root, "tracked.txt"), "edited\n");
        await fs.chmod(join(fixture.root, "tracked.txt"), 0o744);
        await fs.writeFile(join(fixture.root, "new.txt"), "untracked by git\n");
      });
      const summary = await checkpoints.revert(pair);
      expect(summary.filesChanged).toBe(2);
      expect(await fs.readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("one\ntwo\n");
      expect((await fs.stat(join(fixture.root, "tracked.txt"))).mode & 0o7777).toBe(originalMode);
      expect(await fs.stat(join(fixture.root, "new.txt")).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
    }
  });

  test("refuses to revert if the user edits a file after the AI turn", async () => {
    const fixture = await workspace();
    try {
      const checkpoints = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      const pair = await checkpoints.create("edit files", () => fs.writeFile(join(fixture.root, "tracked.txt"), "agent edit\n"));
      await fs.writeFile(join(fixture.root, "tracked.txt"), "user edit\n");
      await expect(checkpoints.revert(pair)).rejects.toBeInstanceOf(CheckpointConflictError);
      expect(await fs.readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("user edit\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted restore journal before the next operation", async () => {
    const fixture = await workspace();
    try {
      const checkpoints = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      const pair = await checkpoints.create("edit files", () => fs.writeFile(join(fixture.root, "tracked.txt"), "agent edit\n"));
      const transaction = join(fixture.store, ".restore-interrupted");
      await fs.mkdir(join(transaction, "backup"), { recursive: true });
      await fs.rename(join(fixture.root, "tracked.txt"), join(transaction, "backup", "tracked.txt"));
      await fs.writeFile(join(fixture.root, "tracked.txt"), "partial restore\n");
      await fs.writeFile(join(transaction, "journal.json"), JSON.stringify({
        version: 1,
        transactionId: ".restore-interrupted",
        workspaceRoot: fixture.root,
        changedPaths: ["tracked.txt"],
        entries: [{ path: "tracked.txt", backup: "moved", installed: false }],
        phase: "installing",
      }));

      // Any subsequent store operation deterministically finishes the old
      // transaction before observing the workspace.
      const reopened = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      await reopened.capture("after interruption");
      expect(await fs.readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("agent edit\n");
      expect(await fs.stat(transaction).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
    }
  });

  test("refuses a symlink parent introduced during restore and recovers after it is removed", async () => {
    const fixture = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "checkpoint-outside-"));
    try {
      await fs.mkdir(join(fixture.root, "nested"));
      await fs.writeFile(join(fixture.root, "nested", "tracked.txt"), "before\n");
      let swapped = false;
      const checkpoints = new CheckpointStore({
        workspaceRoot: fixture.root,
        storeRoot: fixture.store,
        restoreHook: async (step) => {
          if (step !== "before-install" || swapped) return;
          swapped = true;
          await fs.rm(join(fixture.root, "nested"), { recursive: true });
          await fs.symlink(outside, join(fixture.root, "nested"));
        },
      });
      const pair = await checkpoints.create("nested edit", () => fs.writeFile(join(fixture.root, "nested", "tracked.txt"), "after\n"));
      await expect(checkpoints.revert(pair)).rejects.toThrow("symlink");
      expect(await fs.readFile(join(outside, "tracked.txt"), "utf8").catch(() => undefined)).toBeUndefined();

      await fs.unlink(join(fixture.root, "nested"));
      await fs.mkdir(join(fixture.root, "nested"));
      const reopened = new CheckpointStore({ workspaceRoot: fixture.root, storeRoot: fixture.store });
      await reopened.capture("recover rollback");
      expect(await fs.readFile(join(fixture.root, "nested", "tracked.txt"), "utf8")).toBe("after\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("leaves a recoverable journal and restores the post-state on restore failure", async () => {
    const fixture = await workspace();
    try {
      const checkpoints = new CheckpointStore({
        workspaceRoot: fixture.root,
        storeRoot: fixture.store,
        restoreHook: (step) => {
          if (step === "after-backup") throw new Error("simulated restore failure");
        },
      });
      const pair = await checkpoints.create("edit files", () => fs.writeFile(join(fixture.root, "tracked.txt"), "agent edit\n"));
      await expect(checkpoints.revert(pair)).rejects.toThrow("simulated restore failure");
      expect(await fs.readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("agent edit\n");
      expect((await fs.readdir(fixture.store)).filter((name) => name.startsWith(".restore-")).length).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.store, { recursive: true, force: true });
    }
  });
});
