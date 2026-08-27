# Clank-Harness — VS Code & IDE Extension

> **Local-first, provider-agnostic coding agent harness for VS Code and compatible IDEs.**

Clank-Harness provides a rich, responsive sidebar chat interface with multi-modal vision, 1-click provider connections, customizable subagent routing, dynamic skills discovery, atomic checkpoints, and formal plan management.

---

> [!NOTE]
> **Marketplace Notice**: Clank-Harness is not on the VS Code Marketplace yet. Install it directly using the instructions below.

---

## 📦 Installation via VSIX

### Fast Install via CLI:
```bash
# Standard VS Code
code --install-extension clank-harness.vsix

# Cursor
cursor --install-extension clank-harness.vsix

# Antigravity IDE
antigravity-ide --install-extension clank-harness.vsix
```

### Install via UI:
1. Open the Extensions pane (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Click the **`...`** (Views and More Actions) menu in the top right.
3. Select **Install from VSIX…** and select `clank-harness.vsix`.
4. Run **Developer: Reload Window** from the Command Palette (`Cmd+Shift+P`).

---

## ⚙️ Providers & Setup

Open **Settings (⚙) → Providers** in the Clank sidebar panel:

### 1. Freebuff Quick Connect (1-Click)
* Click **`🌐 1. Open Freebuff Login (freebuff.llm.pm)`** to get your token.
* Paste the `authToken` into the input and click **`🚀 Connect & Auto-Start`**.
* Clank automatically manages the local sidecar proxy, securely stores your token in VS Code `SecretStorage`, and discovers all available models (`gpt-5.6-luna`, `deepseek-v4-flash`, `minimax-m3`, `mimo-2.5`, `glm-5.3-flash`, `gemini-3.1-flash-lite`).

### 2. VibeProxy Quick Connect (1-Click)
* If you run VibeProxy locally on port `8317`, click **`🚀 Connect VibeProxy & Pull Live Models`**.
* Automatically detects and lists live models from your connected accounts (Claude Code, Codex, Gemini, Kimi, Qwen, etc.).

### 3. Custom OpenAI-Compatible & Local Engines
* Use the preset buttons or click **`＋ Add Provider Profile`** for OpenAI, OpenRouter, DeepSeek, Ollama (`http://localhost:11434/v1`), vLLM (`http://localhost:8000/v1`), LM Studio, or custom gateways.

---

## 🌟 Core Workflows

* **🖼️ Multi-Modal Vision**: Paste screenshots directly (`Cmd+V` / `Ctrl+V`) into the chat composer, or click `📷 image` to attach image files.
* **✦ Skills Selection**: Click `✦ skills` to choose and inspect active skills loaded from your workspace (`.agent/skills`) or global folders (`~/.agents/skills`), with origin folder paths clearly labeled.
* **🤖 Custom Agents & Modes**: Create project-scoped (`.agent/agents/*.md`) or global (`~/.config/freebuff-agent-harness/agents/*.md`) agent definitions with tailored prompts, tools, step limits, and subagent routing.
* **📋 Plan & Implement**: Use **Plan** mode to draft architectural solutions. Once reviewed, click **Approve & Implement** to execute the plan with dedicated tools and real-time step budgets.
* **↔ Checkpoints & Diff Revert**: Every write turn is checkpointed. Review file diffs or revert changes safely without losing session context.

---

## 💻 Development

```bash
# Run tests
npm test

# Typecheck and compile
npm run typecheck
npm run compile

# Smoke test the classic webview bundle
npm run smoke:bundle
```
