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

The first vertical slice registers read-only workspace tools (`read_file`,
`list_directory`, `glob`, and `get_diagnostics`) and runs them through the
provider-independent permission engine. Ask/Plan/Review modes stay read-only;
write tools will only be advertised once their VS Code adapters and approval
flows are implemented. An untrusted VS Code workspace continues to support
read-only chat and blocks mutation-capable tools.

## Runtime seam

The shell sends `UiToExtensionMessage` commands (`sendMessage`, mode/model
changes, approval decisions, and context changes). `src/runtime/bridge.ts`
adapts those commands to `runAgent` and `OpenAICompatibleProvider`, forwarding
streamed text, tool activity, approvals, usage, cancellation, and normalized
provider errors as `ExtensionToUiMessage` events. Keeping this seam explicit
means a future CLI or alternate UI can reuse the same session protocol without
depending on Webview APIs.
