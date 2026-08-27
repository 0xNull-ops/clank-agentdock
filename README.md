# Clank-Harness

> **Local-first, provider-agnostic coding agent harness for VS Code and Cursor/Antigravity IDEs.**

Clank-Harness is a high-performance, developer-first coding agent built with a replaceable model engine, robust sandbox permissions, multi-modal vision support, atomic workspace checkpoints, and custom subagent orchestration.

---

> [!IMPORTANT]
> **Marketplace Availability**: Clank-Harness is currently in active development and is **not yet published to the VS Code Marketplace**. You can install and use it right away by downloading or packaging the `.vsix` file!

---

## ⚡ Quick Start: Install via VSIX

### Method 1: Install from Terminal (Recommended)

If you have built or downloaded the `clank-harness.vsix` package:

```bash
# For standard VS Code
code --install-extension clank-harness.vsix

# For Cursor
cursor --install-extension clank-harness.vsix

# For Antigravity IDE
antigravity-ide --install-extension clank-harness.vsix
```

### Method 2: Install via VS Code GUI

1. Open VS Code (or your compatible IDE).
2. Open the **Extensions** view (`Cmd+Shift+X` on Mac, `Ctrl+Shift+X` on Windows/Linux).
3. Click the **`...`** (Views and More Actions) menu in the top-right corner of the Extensions pane.
4. Select **Install from VSIX…**.
5. Pick your downloaded `clank-harness.vsix` file.
6. Run **`Developer: Reload Window`** (`Cmd+Shift+P` → type `Reload Window`).
7. Click the **Clank** icon in your activity bar!

---

## 🚀 Key Features

### 1. ⚡ 1-Click Zero-Friction Providers
* **Freebuff Quick Connect**: Direct integration with Freebuff models (`gpt-5.6-luna`, `deepseek-v4-flash`, `minimax-m3`, `mimo-2.5`, `glm-5.3-flash`, `gemini-3.1-flash-lite`). Auto-spawns and manages the local sidecar proxy with zero Docker or terminal friction.
* **VibeProxy Quick Connect**: 1-click connect to local VibeProxy (port `8317`) to automatically pull live models for Claude Code, Codex, Gemini, Kimi, and Qwen.
* **OpenAI-Compatible & Local Endpoints**: Seamless support for OpenRouter, DeepSeek API, local Ollama, vLLM, LM Studio, and custom proxies.
* **Encrypted Secrets**: API keys and tokens are securely stored in VS Code `SecretStorage`.

### 2. 🖼️ Multi-Modal Vision & Direct Clipboard Paste
* **Direct Image Pasting**: Copy any screenshot or image to your clipboard and paste (`Cmd+V` / `Ctrl+V`) directly into the composer.
* **Image Attachments**: Attach multiple images via the `📷 image` button.
* **Thumbnail Previews**: Real-time thumbnail previews with quick delete buttons and transcript rendering.
* **Vision Model Routing**: Multi-modal payloads are formatted into standard `image_url` data structures and forwarded to vision-capable models.

### 3. 🤖 Custom Agents & Subagent Orchestration
* **Personalized Markdown Modes**: Define custom agents in `.agent/agents/*.md` (project) or `~/.config/freebuff-agent-harness/agents/*.md` (global).
* **Cross-Provider Subagents**: Main agent can delegate specialized tasks to other models or providers with bounded concurrency, depth control, and user approval for write-capable tasks.
* **Safety Boundaries**: Built-in read-only modes (Ask, Plan, Review) and write-capable execution (Implement, Architect, Orchestrate).

### 4. ✦ Dynamic Skills Discovery
* **Multi-Source Loading**: Automatically indexes skills from `~/.agents/skills`, `.agent/skills`, and user configuration directories.
* **Interactive Skill Picker**: Search and toggle skills on-the-fly per conversation, with clear visibility of origin folder paths (`📁 ~/.agents/skills/...`).
* **Auto-Dismissal**: Click anywhere outside the skills menu to smoothly close it.

### 5. 📋 Formal Plan Lifecycle & ↔ Atomic Checkpoints
* **Structured Plans**: Plan mode writes Markdown artifacts with strict contracts (`DRAFT → READY_FOR_APPROVAL → APPROVED → IMPLEMENTING → COMPLETE`).
* **Approve & Implement**: 1-click approval atomically switches to Implement mode and feeds the plan into the system prompt.
* **Turn Checkpoints**: Every write turn produces an atomic checkpoint card with file counts, additions/removals, and native VS Code virtual-diff revert scheme.

---

## 🛠️ Building from Source

### Prerequisites
* Node.js `>= 20`
* [Bun](https://bun.sh) (for running tests)
* Go `>= 1.22` (optional, for Freebuff native sidecar compilation)

### Clone & Build

```bash
# Clone the repository
git clone https://github.com/0xNull-ops/agentdock.git
cd agentdock

# Install extension dependencies
npm install --prefix apps/vscode-extension

# Run full quality check (tests, typecheck, design tokens, bundle smoke)
npm run check

# Package VSIX
cd apps/vscode-extension
npx @vscode/vsce package --no-dependencies -o ../../clank-harness.vsix --allow-missing-repository
```

---

## 📜 License

MIT © [0xNull-ops](https://github.com/0xNull-ops)
