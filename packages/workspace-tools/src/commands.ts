import { spawn, type ChildProcess } from "node:child_process";
import { WorkspaceToolError, WorkspacePathGuard } from "./paths";
import type { CommandClass, RunCommandInput, RunCommandResult, WorkspaceToolsLimits } from "./types";

export const DEFAULT_TOOL_LIMITS: WorkspaceToolsLimits = {
  maxFileBytes: 2 * 1024 * 1024,
  maxOutputBytes: 128 * 1024,
  maxResults: 500,
  maxCommandTimeoutMs: 120_000,
};

export function classifyCommand(command: string): CommandClass {
  const value = command.trim().toLowerCase();
  if (!value) return "UNKNOWN";
  if (/\b(sudo|doas|pkexec|su)\b|(^|[;&|])\s*(chown|mount|umount)\b/.test(value)) return "PRIVILEGED";
  if (/(^|[;&|])\s*(rm\s+-[a-z]*r[a-z]*|rmdir|del\s+\/s|format\s+|mkfs|dd\s+if=|shutdown|reboot)\b/.test(value)
    || /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)\b/.test(value)
    || /:\(\)\s*\{/.test(value)) return "DESTRUCTIVE";
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade|unlink|link)\b/.test(value)) return "PACKAGE_INSTALL";
  if (/\b(curl|wget|fetch|nc|netcat|ssh|scp|rsync)\b|\bgit\s+(clone|fetch|pull|submodule)\b/.test(value)) return "NETWORK";
  if (/\bgit\s+(commit|merge|rebase|cherry-pick|tag|branch\s+(-[a-z]+\s+)*(-d|-D)|worktree\s+(add|remove))\b/.test(value)) return "GIT_WRITE";
  if (/(^|[;&|])\s*(rm|rmdir|del|erase|mkdir|md|touch|cp|copy|mv|move|install|ln|chmod)\b|(^|\s)(sed|perl)\s+(-[a-z]*i\b|.*-i\b)|(^|[^<])>>?\s*/.test(value)) return "FILE_MUTATION";
  if (/\b(test|vitest|jest|mocha|pytest|bun\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test)\b/.test(value)) return "TEST";
  if (/\b(eslint|biome|stylelint|tslint|golangci-lint|ruff|pylint)\b/.test(value)) return "LINT";
  if (/\b(prettier|gofmt|rustfmt|clang-format)\b/.test(value)) return "FORMAT";
  if (/\b(build|compile|tsc|webpack|vite\s+build|cargo\s+build|go\s+build|make)\b/.test(value)) return "BUILD";
  if (/^(git\s+(status|diff|log|show|branch|blame)|rg\b|grep\b|find\b|ls\b|pwd\b|cat\b|head\b|tail\b|printf\b|echo\b|which\b|command\s+-v\b)/.test(value)) return "READ_ONLY";
  return "UNKNOWN";
}

interface ExecCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): { value: string; truncated: boolean } {
  const used = Buffer.byteLength(current, "utf8");
  if (used >= maxBytes) return { value: current, truncated: true };
  const remaining = maxBytes - used;
  if (chunk.byteLength <= remaining) return { value: current + chunk.toString("utf8"), truncated: false };
  return { value: current + chunk.subarray(0, remaining).toString("utf8"), truncated: true };
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function sanitizedCommandEnvironment(): NodeJS.ProcessEnv {
  const sensitive = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|COOKIE)(?:_|$)/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => value !== undefined && !sensitive.test(name)),
  );
}

function captureExecFile(file: string, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number): Promise<ExecCapture> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const onAbort = (): void => killProcessGroup(child);
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, maxBytes);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, maxBytes);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Search tools can fall back to a native walker when ripgrep is not
      // installed. Preserve a conventional 127 status for that case.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`, exitCode: 127, signal: null, truncated });
      } else {
        reject(new WorkspaceToolError("EXEC_FAILED", `Unable to execute ${file}: ${error.message}`, error));
      }
    });
    child.once("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr: timedOut ? `${stderr}${stderr ? "\n" : ""}Command timed out.` : stderr, exitCode: code, signal: childSignal, truncated });
    });
    if (signal?.aborted) onAbort();
  });
}

export async function runCommand(
  input: RunCommandInput,
  guard: WorkspacePathGuard,
  limits: WorkspaceToolsLimits = DEFAULT_TOOL_LIMITS,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  if (typeof input.command !== "string" || !input.command.trim()) throw new WorkspaceToolError("INVALID_COMMAND", "A non-empty command is required.");
  const classification = classifyCommand(input.command);
  if (classification === "DESTRUCTIVE" || classification === "PRIVILEGED") {
    throw new WorkspaceToolError("COMMAND_DENIED", `Command classified as ${classification} and denied by hard safety policy.`);
  }
  const cwd = await guard.resolveDirectory(input.cwd ?? "");
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? limits.maxCommandTimeoutMs, limits.maxCommandTimeoutMs));
  const maxBytes = Math.max(1, Math.min(input.maxOutputBytes ?? limits.maxOutputBytes, limits.maxOutputBytes));
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: cwd.absolute,
      shell: true,
      detached: true,
      env: sanitizedCommandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = Boolean(signal?.aborted);
    const onAbort = (): void => { aborted = true; killProcessGroup(child); };
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const used = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
      const remaining = Math.max(0, maxBytes - used);
      if (remaining === 0) { truncated = true; return; }
      const clipped = chunk.byteLength > remaining;
      const value = chunk.subarray(0, remaining).toString("utf8");
      if (target === "stdout") stdout += value; else stderr += value;
      truncated ||= clipped;
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new WorkspaceToolError("EXEC_FAILED", `Unable to execute command: ${error.message}`, error));
    });
    child.once("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        command: input.command,
        cwd: cwd.relative || ".",
        classification,
        exitCode: code,
        signal: childSignal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated,
        timedOut,
        aborted,
      });
    });
    if (aborted) onAbort();
  });
}

export { captureExecFile };
