import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FreebuffSidecarStatus } from "../shared/protocol";

export interface DetectedFreebuffCredentials {
  authToken: string;
  name?: string;
  email?: string;
  source: string;
  activeModel?: string;
}

export interface FreebuffModelDefinition {
  id: string;
  displayName: string;
  category: "premium" | "unlimited";
  hint: string;
}

export const FREEBUFF_REAL_MODELS: readonly FreebuffModelDefinition[] = Object.freeze([
  {
    id: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash 07/31",
    category: "unlimited",
    hint: "unlimited · smart & fast · reasoning: high",
  },
  {
    id: "mimo/mimo-v2.5",
    displayName: "MiMo 2.5",
    category: "unlimited",
    hint: "unlimited · balanced · images",
  },
  {
    id: "openai/gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    category: "premium",
    hint: "premium · strong all-around · reasoning: high · images",
  },
  {
    id: "glm-5.3-flash",
    displayName: "GLM 5.3 Flash",
    category: "premium",
    hint: "premium · deep reasoning · images",
  },
]);

export function detectFreebuffCredentials(): DetectedFreebuffCredentials | undefined {
  const home = os.homedir();
  const candidatePaths = [
    path.join(home, ".config", "manicode", "credentials.json"),
    path.join(home, ".config", "freebuff", "credentials.json"),
    path.join(home, ".manicode", "credentials.json"),
    path.join(home, ".freebuff", "credentials.json"),
  ];

  let detectedCreds: { authToken: string; name?: string; email?: string; source: string } | undefined;

  for (const credPath of candidatePaths) {
    if (fs.existsSync(credPath)) {
      try {
        const raw = fs.readFileSync(credPath, "utf8");
        const json = JSON.parse(raw) as Record<string, unknown>;
        const entry = (json.default as Record<string, unknown> | undefined) ?? (json as Record<string, unknown>);
        let token = typeof entry.authToken === "string" ? entry.authToken : undefined;
        let name = typeof entry.name === "string" ? entry.name : undefined;
        let email = typeof entry.email === "string" ? entry.email : undefined;

        if (!token) {
          for (const val of Object.values(json)) {
            if (val && typeof val === "object" && typeof (val as Record<string, unknown>).authToken === "string") {
              const v = val as Record<string, unknown>;
              token = v.authToken as string;
              name = typeof v.name === "string" ? (v.name as string) : name;
              email = typeof v.email === "string" ? (v.email as string) : email;
              break;
            }
          }
        }

        if (token && token.trim()) {
          detectedCreds = {
            authToken: token.trim(),
            name,
            email,
            source: credPath,
          };
          break;
        }
      } catch {
        // continue
      }
    }
  }

  if (!detectedCreds) return undefined;

  // Check for active model in settings.json
  let activeModel: string | undefined;
  const settingsPaths = [
    path.join(home, ".config", "manicode", "settings.json"),
    path.join(home, ".config", "freebuff", "settings.json"),
  ];
  for (const sp of settingsPaths) {
    if (fs.existsSync(sp)) {
      try {
        const raw = fs.readFileSync(sp, "utf8");
        const json = JSON.parse(raw) as Record<string, unknown>;
        if (typeof json.freebuffModel === "string" && json.freebuffModel.trim()) {
          activeModel = json.freebuffModel.trim();
          break;
        }
      } catch {
        // continue
      }
    }
  }

  return {
    ...detectedCreds,
    activeModel: activeModel || "deepseek/deepseek-v4-flash",
  };
}

export interface FreebuffSidecarConfig {
  port?: number;
  listenAddr?: string;
  upstreamBaseUrl?: string;
  storageDir?: string;
  /** Sink for sidecar stdout/stderr, wired to an output channel by the host. */
  onLog?: (line: string) => void;
}

/** ECONNREFUSED means nothing is listening; anything else means something is. */
function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  if (code) return code === "ECONNREFUSED";
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ECONNREFUSED") || message.includes("fetch failed");
}

export class FreebuffSidecarManager {
  private child?: child_process.ChildProcess;
  private statusState: FreebuffSidecarStatus = "stopped";
  private lastError?: string;
  private readonly logs: string[] = [];
  private readonly onLog?: (line: string) => void;
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly storageDir: string;

  constructor(config: FreebuffSidecarConfig = {}) {
    this.port = config.port ?? 8080;
    this.baseUrl = `http://127.0.0.1:${this.port}/v1`;
    this.storageDir = config.storageDir ?? path.join(os.homedir(), ".freebuff-agent-harness");
    this.onLog = config.onLog;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getPort(): number {
    return this.port;
  }

  getStatus(): { status: FreebuffSidecarStatus; error?: string } {
    return { status: this.statusState, error: this.lastError };
  }

  /**
   * Status backed by a live probe. The cached field alone went stale across
   * window reloads, so the settings panel would offer "Connect" for a sidecar
   * that was already up, or "Stop" for one that had died.
   */
  async refreshStatus(): Promise<{ status: FreebuffSidecarStatus; error?: string }> {
    if (this.statusState === "starting") return this.getStatus();
    const probe = await this.probe();
    if (probe === "running") {
      this.statusState = "running";
      this.lastError = undefined;
    } else if (probe === "port-conflict") {
      this.statusState = "error";
      this.lastError = `Port ${this.port} is held by another process that is not Freebuff2API. Stop it, or free the port, then reconnect.`;
    } else if (this.statusState === "running") {
      this.statusState = "stopped";
    }
    return this.getStatus();
  }

  /**
   * True only when the port is answered by Freebuff2API itself.
   *
   * The previous check accepted any 200 or 401 on /v1/models, so an unrelated
   * service holding :8080 — a very common port — read as a healthy sidecar and
   * every request then failed against the wrong server. /healthz is specific to
   * this proxy and reports its token rotation state, which nothing else does.
   */
  async isRunning(): Promise<boolean> {
    return (await this.probe()) === "running";
  }

  /**
   * Distinguishes "our sidecar" from "port busy" from "nothing listening" so
   * callers can report the real problem instead of a generic timeout.
   */
  async probe(): Promise<"running" | "port-conflict" | "stopped"> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${this.port}/healthz`, { method: "GET", signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) return response.status === 401 ? "running" : "port-conflict";
      const payload = await response.json() as { ok?: unknown; token_state?: unknown };
      if (payload && payload.ok === true && payload.token_state !== undefined) return "running";
      return "port-conflict";
    } catch (error) {
      // A refused connection means the port is free; anything else means
      // something is listening but is not answering as Freebuff2API.
      return isConnectionRefused(error) ? "stopped" : "port-conflict";
    }
  }

  /** Recent sidecar stdout/stderr, newest last. Empty until the child starts. */
  getLogs(): string[] {
    return [...this.logs];
  }

  private record(line: string): void {
    for (const entry of line.split(/\r?\n/)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      this.logs.push(trimmed);
      if (this.logs.length > 200) this.logs.shift();
      this.onLog?.(trimmed);
    }
  }

  /**
   * VSIX extraction does not reliably preserve the executable bit, so every
   * candidate is made runnable before it is handed back. Without this the
   * spawn fails with a bare EACCES that surfaced as a generic timeout.
   */
  private useBinary(candidate: string): string {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(candidate, 0o755);
      } catch (error) {
        throw new Error(`Freebuff2API at ${candidate} is not executable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return candidate;
  }

  async findOrInstallBinary(): Promise<string> {
    // 1. Check bundled binary in extension
    const bundledDist = path.join(__dirname, "Freebuff2API");
    if (fs.existsSync(bundledDist)) return this.useBinary(bundledDist);
    const bundledResources = path.join(__dirname, "..", "resources", "Freebuff2API");
    if (fs.existsSync(bundledResources)) return this.useBinary(bundledResources);

    // 2. Check custom storage dir
    const localBin = path.join(this.storageDir, "Freebuff2API");
    if (fs.existsSync(localBin)) return this.useBinary(localBin);

    // 3. Check GOPATH bin
    const home = os.homedir();
    const gopathBin = path.join(home, "go", "bin", "Freebuff2API");
    if (fs.existsSync(gopathBin)) return this.useBinary(gopathBin);

    // 4. Check system PATH
    try {
      const lookup = process.platform === "win32" ? "where Freebuff2API" : "command -v Freebuff2API";
      const whichResult = child_process.execSync(lookup, { encoding: "utf8" }).trim().split(/\r?\n/)[0] ?? "";
      if (whichResult && fs.existsSync(whichResult)) return this.useBinary(whichResult);
    } catch {
      // not in path
    }

    // 5. Last resort: build from source. execSync blocks the extension host,
    // so this runs off the event loop and reports go's own stderr on failure.
    try {
      await new Promise<void>((resolve, reject) => {
        child_process.execFile(
          "go",
          ["install", "github.com/Quorinex/Freebuff2API@latest"],
          { timeout: 120_000, env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" } },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
          },
        );
      });
      if (fs.existsSync(gopathBin)) return this.useBinary(gopathBin);
    } catch (err) {
      throw new Error(`Freebuff2API is not bundled for ${process.platform}/${process.arch} and could not be built. Install Go, or place the binary at ${path.join(this.storageDir, "Freebuff2API")}. Build error: ${err instanceof Error ? err.message : String(err)}`);
    }

    throw new Error("Freebuff2API binary not found after compilation attempt.");
  }

  async start(authToken: string): Promise<{ ok: boolean; message?: string }> {
    const trimmedToken = authToken.trim();
    if (!trimmedToken) return { ok: false, message: "Freebuff authToken is required" };

    const before = await this.probe();
    if (before === "running") {
      this.statusState = "running";
      this.lastError = undefined;
      return { ok: true };
    }
    if (before === "port-conflict" && !this.child) {
      this.statusState = "error";
      this.lastError = `Port ${this.port} is already in use by another process that does not answer as Freebuff2API. Free the port and try again.`;
      return { ok: false, message: this.lastError };
    }

    this.statusState = "starting";
    this.lastError = undefined;

    try {
      const binaryPath = await this.findOrInstallBinary();

      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }

      const configPath = path.join(this.storageDir, "freebuff2api-config.json");
      const configContent = {
        LISTEN_ADDR: `:${this.port}`,
        UPSTREAM_BASE_URL: "https://codebuff.com",
        AUTH_TOKENS: [trimmedToken],
        ROTATION_INTERVAL: "6h",
        REQUEST_TIMEOUT: "15m",
        API_KEYS: [],
      };
      fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2), { mode: 0o600 });

      this.child = child_process.spawn(binaryPath, ["-config", configPath], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AUTH_TOKENS: trimmedToken,
          LISTEN_ADDR: `:${this.port}`,
          UPSTREAM_BASE_URL: "https://codebuff.com",
        },
      });

      // The pipes must be drained or the child blocks once its buffers fill,
      // and their contents are the only diagnosis available when it refuses to
      // come up. Previously both were opened and then ignored.
      this.child.stdout?.setEncoding("utf8");
      this.child.stdout?.on("data", (chunk: string) => this.record(chunk));
      this.child.stderr?.setEncoding("utf8");
      this.child.stderr?.on("data", (chunk: string) => this.record(chunk));

      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

      this.child.on("error", (err) => {
        this.statusState = "error";
        this.lastError = `Freebuff sidecar error: ${err.message}`;
        this.record(`spawn error: ${err.message}`);
      });

      this.child.on("exit", (code, signal) => {
        exited = { code, signal };
        this.child = undefined;
        if (this.statusState === "running" || this.statusState === "starting") {
          this.statusState = code === 0 ? "stopped" : "error";
          if (code !== 0 && !this.lastError) {
            this.lastError = `Freebuff sidecar exited with code ${code ?? signal}`;
          }
        }
      });

      // Poll until ready, but stop early if the child already died.
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (exited) break;
        if (await this.isRunning()) {
          this.statusState = "running";
          this.lastError = undefined;
          return { ok: true };
        }
      }

      if (!exited && await this.isRunning()) {
        this.statusState = "running";
        this.lastError = undefined;
        return { ok: true };
      }

      this.statusState = "error";
      const tail = this.logs.slice(-6).join(" | ");
      this.lastError = exited
        ? `Freebuff sidecar exited with code ${exited.code ?? exited.signal} before it became ready.${tail ? ` Output: ${tail}` : ""}`
        : `Freebuff sidecar started but did not answer /healthz on port ${this.port} in time.${tail ? ` Output: ${tail}` : ""}`;
      return { ok: false, message: this.lastError };
    } catch (error) {
      this.statusState = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, message: this.lastError };
    }
  }

  /**
   * Stops only the child this manager spawned. The previous implementation ran
   * `pkill -f Freebuff2API` unconditionally, which killed sidecars owned by
   * other VS Code windows or started by hand outside the extension.
   */
  stop(): void {
    if (!this.child) {
      this.statusState = "stopped";
      return;
    }
    const child = this.child;
    this.child = undefined;
    try {
      child.kill("SIGTERM");
      // Escalate only if the process ignores the polite signal.
      const escalate = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2_000);
      if (typeof escalate.unref === "function") escalate.unref();
    } catch {
      // already gone
    }
    this.statusState = "stopped";
    this.lastError = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
