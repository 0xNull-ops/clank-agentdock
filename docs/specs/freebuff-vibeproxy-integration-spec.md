# Specification: Built-in Freebuff & VibeProxy Provider Integration for Clank

**Status**: Proposal / Draft  
**Target System**: Clank VS Code Extension (`apps/vscode-extension`) & Provider Runtime (`@freebuff/provider-openai-compatible`, `@freebuff/agent-core`)  
**References**:
- Freebuff: [https://freebuff.com/](https://freebuff.com/)
- Freebuff2API: [https://github.com/Quorinex/Freebuff2API](https://github.com/Quorinex/Freebuff2API) / [MCP Market Proxy](https://mcpmarket.com/tools/skills/freebuff2api-openai-proxy)
- VibeProxy: [https://github.com/automazeio/vibeproxy](https://github.com/automazeio/vibeproxy)

---

## 1. Executive Summary

Clank requires seamless, out-of-the-box support for:
1. **Freebuff Provider**: Providing free access to high-capability models (`gpt-5.6-luna`, `deepseek-v4-flash`, `minimax-m3`, `mimo-2.5`, `glm-5.3-flash`, `gemini-3.1-flash-lite`) using session authentication (`authToken`).
2. **VibeProxy Provider**: Bridging local multi-account AI subscriptions (Claude Max, ChatGPT, Gemini, Qwen, GLM, etc.) through VibeProxy's local macOS proxy daemon.
3. **Robust Proxy & Sidecar Architecture**: Supporting both external local proxies (Docker/binary) and direct in-extension protocol translation with live healthchecks, 1-click presets, and automated model catalog discovery.

---

## 2. Background & Architecture Analysis

### 2.1 Freebuff & Freebuff2API Mechanics

```
┌─────────────────────────┐        ┌────────────────────────┐        ┌───────────────────────┐
│     Clank Webview /     │───────▶│  Freebuff2API Proxy    │───────▶│ Freebuff Backend API  │
│  Agent Loop (OpenAI)    │◀───────│  (Go / Docker / Embed) │◀───────│ (https://codebuff.com)│
└─────────────────────────┘  SSE   └────────────────────────┘  HTTP  └───────────────────────┘
                                       - Auth token rotation
                                       - Fingerprint spoofing
                                       - SSE chunk transformation
```

- **Authentication**: Freebuff authenticates via an `authToken` generated from browser login (`https://freebuff.llm.pm`) or CLI login.
- **Protocol**: The Freebuff backend (`https://codebuff.com`) does not expose a standard public `/v1/chat/completions` API; it expects custom JSON payloads, session cookies, and dynamic browser/CLI client fingerprints.
- **Freebuff2API**: Converts standard OpenAI `/v1/chat/completions` (and `/v1/models`) requests to Freebuff backend requests, handles multi-token rotation, and stream normalization.

### 2.2 VibeProxy Mechanics

```
┌─────────────────────────┐        ┌────────────────────────┐        ┌───────────────────────┐
│     Clank Webview /     │───────▶│   VibeProxy Daemon     │───────▶│ Cloud Providers       │
│  Agent Loop (OpenAI)    │◀───────│ (http://127.0.0.1:8390)│◀───────│ (Claude, ChatGPT, etc)│
└─────────────────────────┘  SSE   └────────────────────────┘  REST  └───────────────────────┘
                                       - Multi-account pooling
                                       - OAuth token refresh
                                       - Rate-limit auto-failover
```

- **Native App / Daemon**: VibeProxy runs locally on macOS (default port `8390` or configured port) managing browser sessions and OAuth tokens for Claude, ChatGPT, Gemini, and GLM.
- **Standard Interface**: Exposes a standard OpenAI-compatible `/v1` endpoint (`http://127.0.0.1:8390/v1`).

---

## 3. Integration Architecture for Clank

We define a **Hybrid 3-Tier Integration Architecture**:

```
                                  CLANK EXTENSION
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                        Settings UI (Providers Tab)                      │   │
│   │  Presets: [OpenAI] [Freebuff (Built-in)] [VibeProxy] [Ollama] [OpenRouter]│   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                       │                                         │
│                                       ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                        Provider Bridge & Router                         │   │
│   │  - Resolves active profile                                              │   │
│   │  - Auto-discovers models on save/connect                                │   │
│   │  - Monitors proxy health (Online / Offline / Auth Failed)               │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                         │                               │                       │
│                         ▼                               ▼                       │
│             ┌───────────────────────┐       ┌───────────────────────┐           │
│             │  Direct Native Client │       │   OpenAI Compatible   │           │
│             │   (Freebuff Engine)   │       │   (VibeProxy / Ext)   │           │
│             └───────────────────────┘       └───────────────────────┘           │
└─────────────────────────┼───────────────────────────────┼───────────────────────┘
                          │                               │
                          ▼                               ▼
                 https://codebuff.com            http://127.0.0.1:8390/v1
```

### Tier 1: Built-In 1-Click Presets in Clank UI
In the Providers settings view (`renderProvidersTab`), provide instant 1-click configuration buttons:
1. **`Freebuff (Local Proxy)`**:
   - URL: `http://127.0.0.1:8080/v1`
   - Default Model: `gpt-5.6-luna`
   - Pre-populated model list: `gpt-5.6-luna`, `deepseek-v4-flash`, `minimax-m3`, `mimo-2.5`, `glm-5.3-flash`, `gemini-3.1-flash-lite`
   - Quick help: "Run Freebuff2API docker/binary or paste your Freebuff Auth Token".
2. **`Freebuff (Direct Native)`**:
   - URL: `https://codebuff.com` (or internal native handler)
   - API Key Field: Prompts for Freebuff `authToken` (with direct link to `https://freebuff.llm.pm`)
   - Translates tool calls and chat completions natively in the extension runtime without external docker dependencies.
3. **`VibeProxy (macOS Local)`**:
   - URL: `http://127.0.0.1:8390/v1`
   - Default Model: Auto-discovered from active accounts in VibeProxy
   - Quick help: "Connects to your local VibeProxy app on port 8390".

### Tier 2: Real-Time Proxy Healthcheck & Status
- Each provider profile in settings displays a live status badge:
  - `● Online (6 models available)`: Endpoint is reachable, `/v1/models` succeeded.
  - `◌ Unreachable (Proxy not running)`: Shows quick launch tip with copyable terminal command.
  - `! Auth Expired / Rate Limited`: Actionable troubleshooting guidance.

### Tier 3: Native Freebuff Provider Adapter (`@freebuff/provider-freebuff`)
To give users the smoothest experience without requiring Go or Docker installation:
- Implement a lightweight native adapter in TypeScript that communicates directly with `https://codebuff.com` using the user's `authToken`.
- Handles streaming event transformation, tool call framing, and model parameter mapping directly within Node.js / VS Code Extension runtime.

---

## 4. Technical Specifications & Data Models

### 4.1 Preset Definitions

```typescript
export interface ProviderPreset {
  id: string;
  name: string;
  category: "builtin" | "local-proxy" | "cloud";
  baseUrl: string;
  defaultModel: string;
  models: Array<{ id: string; name: string; hint: string }>;
  authType: "api-key" | "session-token" | "none";
  helpUrl?: string;
  helpText?: string;
  dockerCommand?: string;
}

export const BUILTIN_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "freebuff-proxy",
    name: "Freebuff (Freebuff2API)",
    category: "local-proxy",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "gpt-5.6-luna",
    authType: "api-key",
    helpUrl: "https://freebuff.llm.pm",
    helpText: "Obtain your Freebuff authToken from freebuff.llm.pm and start Freebuff2API.",
    dockerCommand: "docker run -d -p 8080:8080 -e AUTH_TOKENS='<YOUR_TOKEN>' ghcr.io/quorinex/freebuff2api:latest",
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", hint: "default · tools · vision" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", hint: "fast coding · tools" },
      { id: "minimax-m3", name: "MiniMax M3", hint: "high-capacity reasoning" },
      { id: "mimo-2.5", name: "MiMo 2.5", hint: "unmetered coding · vision" },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", hint: "deep reasoning" },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", hint: "search · inspection" },
    ],
  },
  {
    id: "vibeproxy",
    name: "VibeProxy (Local Bridge)",
    category: "local-proxy",
    baseUrl: "http://127.0.0.1:8390/v1",
    defaultModel: "claude-3-5-sonnet-20241022",
    authType: "none",
    helpUrl: "https://github.com/automazeio/vibeproxy",
    helpText: "Bridges your existing subscriptions (Claude, ChatGPT, Gemini) via VibeProxy app on port 8390.",
    models: [],
  },
];
```

### 4.2 Error Handling & Fallback Strategy

1. **HTTP 429 Rate Limiting / Session Quota**:
   - Freebuff has peak-hour quotas on specific models (e.g. GLM 5.3 Flash or DeepSeek).
   - The provider wrapper intercepts 429 errors and provides an immediate suggestion or automated fallback to `mimo-2.5` or `gpt-5.6-luna`.
2. **Token Invalidation**:
   - When the session token expires, the UI displays a direct link to `https://freebuff.llm.pm` for instant 1-click token re-auth.
3. **Proxy Connection Downtime**:
   - If `http://127.0.0.1:8080` or `http://127.0.0.1:8390` is offline, Clank clearly informs the user with a copyable command to start the container or launch the VibeProxy app.

---

## 5. Phased Implementation Roadmap

### Phase 1: Built-in Presets & Model Discovery (Immediate)
- Add Freebuff and VibeProxy 1-click buttons to the Providers settings view.
- Pre-configure default ports (`8080` for Freebuff2API, `8390` for VibeProxy).
- Pre-seed the official Freebuff model catalog (`gpt-5.6-luna`, `deepseek-v4-flash`, etc.).
- Add quick-copy launch instructions for Docker and VibeProxy app.

### Phase 2: Live Proxy Healthchecks & Diagnostics
- Ping `/v1/models` in background to render real-time proxy status indicators (`● Online` / `○ Offline`).
- Auto-detect when VibeProxy or Freebuff2API comes online and automatically refresh the active model list.

### Phase 3: Native In-Extension Freebuff Engine (Zero-Docker)
- Implement direct TypeScript communication with Freebuff backend (`https://codebuff.com`) using `authToken` directly inside the extension, eliminating the need for Docker or local proxy binaries for users who just have a token.
