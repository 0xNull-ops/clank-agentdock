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
}

export class FreebuffSidecarManager {
  private child?: child_process.ChildProcess;
  private statusState: FreebuffSidecarStatus = "stopped";
  private lastError?: string;
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly storageDir: string;

  constructor(config: FreebuffSidecarConfig = {}) {
    this.port = config.port ?? 8080;
    this.baseUrl = `http://127.0.0.1:${this.port}/v1`;
    this.storageDir = config.storageDir ?? path.join(os.homedir(), ".freebuff-agent-harness");
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

  async isRunning(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      const res = await fetch(`${this.baseUrl}/models`, { method: "GET", signal: controller.signal });
      clearTimeout(timeout);
      return res.ok || res.status === 401;
    } catch {
      return false;
    }
  }

  async findOrInstallBinary(): Promise<string> {
    // 1. Check bundled binary in extension
    const bundledDist = path.join(__dirname, "Freebuff2API");
    if (fs.existsSync(bundledDist)) return bundledDist;
    const bundledResources = path.join(__dirname, "..", "resources", "Freebuff2API");
    if (fs.existsSync(bundledResources)) return bundledResources;

    // 2. Check custom storage dir
    const localBin = path.join(this.storageDir, "Freebuff2API");
    if (fs.existsSync(localBin)) return localBin;

    // 3. Check GOPATH bin
    const home = os.homedir();
    const gopathBin = path.join(home, "go", "bin", "Freebuff2API");
    if (fs.existsSync(gopathBin)) return gopathBin;

    // 4. Check system PATH
    try {
      const whichResult = child_process.execSync("which Freebuff2API", { encoding: "utf8" }).trim();
      if (whichResult && fs.existsSync(whichResult)) return whichResult;
    } catch {
      // not in path
    }

    // 4. Auto-install using go install
    try {
      child_process.execSync("go install github.com/Quorinex/Freebuff2API@latest", {
        encoding: "utf8",
        timeout: 45000,
        env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      });
      if (fs.existsSync(gopathBin)) return gopathBin;
    } catch (err) {
      throw new Error(`Failed to compile Freebuff2API binary: ${err instanceof Error ? err.message : String(err)}`);
    }

    throw new Error("Freebuff2API binary not found after compilation attempt.");
  }

  async start(authToken: string): Promise<{ ok: boolean; message?: string }> {
    const trimmedToken = authToken.trim();
    if (!trimmedToken) return { ok: false, message: "Freebuff authToken is required" };

    if (await this.isRunning()) {
      this.statusState = "running";
      return { ok: true };
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

      this.child.on("error", (err) => {
        this.statusState = "error";
        this.lastError = `Freebuff sidecar error: ${err.message}`;
      });

      this.child.on("exit", (code) => {
        if (this.statusState === "running" || this.statusState === "starting") {
          this.statusState = code === 0 ? "stopped" : "error";
          if (code !== 0 && !this.lastError) {
            this.lastError = `Freebuff sidecar exited with code ${code}`;
          }
        }
      });

      // Poll until ready (up to 8 seconds)
      const start = Date.now();
      while (Date.now() - start < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (await this.isRunning()) {
          this.statusState = "running";
          return { ok: true };
        }
      }

      if (await this.isRunning()) {
        this.statusState = "running";
        return { ok: true };
      }

      this.statusState = "error";
      this.lastError = "Freebuff sidecar process started but did not respond on port 8080 in time.";
      return { ok: false, message: this.lastError };
    } catch (error) {
      this.statusState = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, message: this.lastError };
    }
  }

  stop(): void {
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.child = undefined;
    }
    try {
      child_process.execSync("pkill -f Freebuff2API || true", { stdio: "ignore" });
    } catch {
      // ignore
    }
    this.statusState = "stopped";
  }

  dispose(): void {
    this.stop();
  }
}
