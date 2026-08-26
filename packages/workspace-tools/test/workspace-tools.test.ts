import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyCommand } from "../src/commands";
import { WorkspaceToolError } from "../src/paths";
import { WorkspaceTools } from "../src/workspace-tools";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "freebuff-workspace-tools-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "one.ts"), "alpha\nbeta\ngamma\n", "utf8");
  return root;
}

describe("workspace path safety", () => {
  test("rejects traversal and absolute paths", async () => {
    const tools = new WorkspaceTools({ root: await fixture() });
    await expect(tools.readFile({ path: "../outside.txt" })).rejects.toMatchObject({ code: "PATH_TRAVERSAL" });
    await expect(tools.readFile({ path: "/tmp/outside.txt" })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("rejects symlink escapes for reads and mutations", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "freebuff-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "linked"));
    const tools = new WorkspaceTools({ root });
    await expect(tools.readFile({ path: "linked/secret.txt" })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(tools.writeFile({ path: "linked/new.txt", content: "nope" })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
  });

  test("protects credentials and environment files from mutation", async () => {
    const tools = new WorkspaceTools({ root: await fixture() });
    await expect(tools.writeFile({ path: ".env", content: "TOKEN=bad" })).rejects.toMatchObject({ code: "PROTECTED_PATH" });
    await expect(tools.applyPatch({ patch: "*** Begin Patch\n*** Update File: .env\n@@ -1 +1 @@\n-x\n+y\n*** End Patch" })).rejects.toMatchObject({ code: "PROTECTED_PATH" });
  });
});

describe("file and search tools", () => {
  test("reads inclusive line ranges with output caps", async () => {
    const tools = new WorkspaceTools({ root: await fixture(), limits: { maxOutputBytes: 4 } });
    const result = await tools.readFile({ path: "src/one.ts", startLine: 2, endLine: 3 });
    expect(result.content).toBe("beta");
    expect(result.totalLines).toBe(4);
    expect(result.truncated).toBe(true);
  });

  test("edit_file requires an exact precondition and writes atomically", async () => {
    const root = await fixture(); const tools = new WorkspaceTools({ root });
    await expect(tools.editFile({ path: "src/one.ts", oldText: "alpha", newText: "A", expectedReplacements: 2 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const result = await tools.editFile({ path: "src/one.ts", oldText: "beta", newText: "B" });
    expect(result.replacements).toBe(1);
    expect(await readFile(path.join(root, "src/one.ts"), "utf8")).toContain("B");
  });

  test("apply_patch enforces exact context and supports add/update", async () => {
    const root = await fixture(); const tools = new WorkspaceTools({ root });
    const result = await tools.applyPatch({ patch: "*** Begin Patch\n*** Update File: src/one.ts\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n*** Add File: notes.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n*** End Patch" });
    expect(result.files.map((file) => file.path)).toEqual(["src/one.ts", "notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("first\nsecond\n");
    await expect(tools.applyPatch({ patch: "*** Begin Patch\n*** Update File: src/one.ts\n@@ -1,1 +1,1 @@\n-wrong\n+value\n*** End Patch" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  test("accepts compact bare-hunk patches with unique exact context", async () => {
    const root = await fixture(); const tools = new WorkspaceTools({ root });
    await tools.applyPatch({ patch: "*** Begin Patch\n*** Update File: src/one.ts\n@@\n beta\n-gamma\n+GAMMA\n*** End Patch" });
    expect(await readFile(path.join(root, "src/one.ts"), "utf8")).toContain("GAMMA");
  });

  test("accepts Git-style unified metadata while keeping context strict", async () => {
    const root = await fixture(); const tools = new WorkspaceTools({ root });
    await tools.applyPatch({ patch: "diff --git a/src/one.ts b/src/one.ts\nindex 1..2 100644\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1,1 +1,1 @@\n-alpha\n+ALPHA\n" });
    expect(await readFile(path.join(root, "src/one.ts"), "utf8")).toContain("ALPHA");
  });

  test("glob and grep return bounded workspace-relative results", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "credentials.json"), '{"token":"beta"}', "utf8");
    const tools = new WorkspaceTools({ root });
    const glob = await tools.glob({ pattern: "src/**/*.ts" });
    expect(glob.matches).toEqual(["src/one.ts"]);
    const grep = await tools.grep({ pattern: "beta", path: "src/one.ts" });
    expect(grep.matches[0]).toMatchObject({ path: "src/one.ts", line: 2, column: 1, text: "beta" });
    const broad = await tools.grep({ pattern: "beta" });
    expect(broad.matches.map((match) => match.path)).toEqual(["src/one.ts"]);
  });
});

describe("command and Git reads", () => {
  test("classifies commands before execution", () => {
    expect(classifyCommand("npm test")).toBe("TEST");
    expect(classifyCommand("npm install zod")).toBe("PACKAGE_INSTALL");
    expect(classifyCommand("git status --short")).toBe("READ_ONLY");
    expect(classifyCommand("rm -rf tmp")).toBe("DESTRUCTIVE");
    expect(classifyCommand("git commit -am save")).toBe("GIT_WRITE");
  });

  test("runs bounded commands and reports classification", async () => {
    const tools = new WorkspaceTools({ root: await fixture() });
    const result = await tools.runCommand({ command: "printf hello" });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("hello"); expect(result.classification).toBe("READ_ONLY");
    await expect(tools.runCommand({ command: "rm -rf ." })).rejects.toBeInstanceOf(WorkspaceToolError);
  });

  test("cancels a command and cleans up its process group", async () => {
    const tools = new WorkspaceTools({ root: await fixture() }); const controller = new AbortController();
    const pending = tools.runCommand({ command: "sleep 5", timeoutMs: 5_000 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("exposes dedicated Git status and diff operations", async () => {
    const root = await fixture();
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    const tools = new WorkspaceTools({ root });
    const status = await tools.gitStatus();
    expect(status.entries.some((entry) => entry.path === "src/one.ts")).toBe(true);
    const diff = await tools.gitDiff();
    expect(typeof diff.diff).toBe("string");
  });
});
