# Goal

Deliver the smallest reliable VS Code agent-chat loop against a user-configured OpenAI-compatible endpoint.

# Current State

Core, provider transport, and UI shell exist as separate typed modules. The remaining work is integration, hardening, and packaging.

# Scope

- wire provider settings and SecretStorage to the runtime bridge
- stream assistant output into the sidebar
- expose capability-gated read-only workspace tools
- route approval and cancellation events
- provide repeatable build, type-check, and test commands

# Non-Goals

SQLite persistence, filesystem mutation, shell execution, checkpoints, subagents, MCP, and semantic search are not part of this first vertical slice.

# Proposed Changes

Keep the extension host as the composition root. It constructs the provider, selects a built-in mode, registers VS Code-backed tools, and forwards normalized core events to the webview protocol.

# Files / Components

- `apps/vscode-extension/src/runtime/bridge.ts`
- `apps/vscode-extension/src/extension.ts`
- `apps/vscode-extension/src/shared/protocol.ts`
- `packages/agent-core`
- `packages/providers/openai-compatible`

# Data / API Changes

Provider base URL and model are ordinary VS Code settings. API keys use SecretStorage. UI messages remain a discriminated union.

# Step-by-Step Implementation

1. Validate and package the workspace modules.
2. Resolve provider configuration without exposing secrets to the webview.
3. Start/cancel an agent run from UI commands.
4. Translate normalized agent events into UI events.
5. Register safe workspace reads and diagnostics.
6. Add mock transport and permission tests.
7. Build the extension and review the emitted artifact.

# Tests

Unit tests cover permission matching, modes, agent-loop tool handling, SSE chunking, provider wire requests, replay metadata, and provider errors. Type-check and compile the VS Code client.

# Validation

Run the aggregate repository test, type-check, and build commands, then launch the extension development host and configure a local OpenAI-compatible endpoint for a manual smoke test.

# Risks / Edge Cases

- compatible endpoints vary in SSE and reasoning fields
- model IDs are endpoint-specific
- cancellation may occur while waiting for approval
- multi-root workspaces need explicit target selection in a later milestone

# Rollback

The runtime bridge is isolated behind the existing UI protocol and can be disabled without changing core or webview components.

# Acceptance Criteria

- the sidebar opens without provider configuration
- missing configuration produces an actionable error
- a configured endpoint streams text into the chat
- registered read tools can complete a multi-step provider turn
- mode permissions prevent writes in read-only modes
- cancellation stops the active provider request
- all automated checks pass
