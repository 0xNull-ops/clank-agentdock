# Freebuff Agent Harness — VS Code shell

This package is the VS Code-facing shell for the harness. It intentionally
does not own provider or tool execution logic. The extension host is a thin
adapter around the typed UI boundary in `src/shared/protocol.ts`; the agent
runtime can be connected later by forwarding normalized events to
`ExtensionToUiMessage`.

## Local development

From this directory, install the package dependencies and run:

```sh
npm run typecheck
npm run compile
npm test
```

The extension contributes an Agent Harness activity-bar view and the
`Agent Harness: Open Chat` command. Its webview uses the Forge design tokens
from `specs/forge-agent-design-tokens.json`, mapped to VS Code theme variables
where available so it remains legible in light and dark hosts.

## Configure a provider

Set `agentdock.provider.baseUrl` to the base URL of an OpenAI-compatible API
(for example `http://127.0.0.1:8000/v1`) and set
`agentdock.provider.model` to the model id accepted by that endpoint. The model
field may be left empty to use the model selected in the chat header. API keys
are never written to workspace or user settings: run `Agent Harness: Set API
Key` from the Command Palette to store one in VS Code SecretStorage. Use
`Agent Harness: Validate Provider` to check reachability, or
`Agent Harness: Clear API Key` to remove it.

The runtime registers guarded file/search tools, dedicated Git reads, VS Code
diagnostics, atomic writes/edits/patches, and bounded classified commands.
Ask/Plan/Review stay read-only; Implement exposes mutations through the
provider-independent permission and approval flow. An untrusted workspace can
still use read-only chat while mutation tools remain unavailable.

Sessions, provider replay frames, steps, usage, approvals, and tool results are
stored in SQLite below VS Code global storage. The header history control can
switch among recent workspace sessions without sending opaque replay state to
the webview.

Every primary runtime turn is bracketed by `CheckpointCoordinator.beginTurn`
and `completeTurn`; approved write-capable subagent turns are additionally
bracketed with `runWithCheckpoint`. Changed turns produce a checkpoint card with file-level counts and
native VS Code diff/revert actions. Snapshot content is served through the
`agentdock-checkpoint:` virtual-document scheme; revert refuses to overwrite
workspace drift and reports the affected paths in the chat.

## Runtime seam

The shell sends `UiToExtensionMessage` commands (`sendMessage`, mode/model
changes, approval decisions, and context changes). `src/runtime/bridge.ts`
adapts those commands to `runAgent` and `OpenAICompatibleProvider`, forwarding
streamed text, tool activity, approvals, usage, cancellation, and normalized
provider errors as `ExtensionToUiMessage` events. Keeping this seam explicit
means a future CLI or alternate UI can reuse the same session protocol without
depending on Webview APIs. The extension host is bundled into a self-contained
`dist/extension.js`; only the VS Code API remains external, and the sql.js WASM
is copied alongside it.
