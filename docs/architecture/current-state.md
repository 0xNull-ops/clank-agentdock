# Current Repository Architecture

## Baseline

The repository began as a greenfield workspace containing only the product specification and Forge design tokens. The first implementation slice now follows three explicit boundaries:

```text
VS Code webview
    ↓ typed UI commands/events
VS Code runtime bridge
    ↓ provider-independent contracts
Agent core ── permission engine ── registered workspace tools
    ↓ normalized provider events
OpenAI-compatible adapter
    ↓ HTTP + SSE
Freebuff2API / MiniMax / custom endpoint
```

## Ownership

- `apps/vscode-extension`: activation, settings, SecretStorage, workspace adapters, webview messaging, and presentation.
- `packages/agent-core`: modes, permission resolution, tool registry, normalized messages/events, and the multi-step tool loop.
- `packages/providers/openai-compatible`: HTTP/SSE transport, compatibility transforms, tool-call accumulation, and provider error normalization.
- `specs`: normative product behavior and source design tokens.

The core does not import VS Code. The webview does not receive credentials or direct filesystem access. Provider-specific response shapes are normalized by the adapter before reaching the core.

## Delta Against the Full Specification

Implemented in this milestone:

- core contracts and built-in mode profiles
- deterministic allow/ask/deny policies and hard safety checks
- streaming OpenAI-compatible transport
- fragmented and parallel tool-call reconstruction
- provider-independent agent loop and approval boundary
- VS Code sidebar shell, mode/model controls, streaming messages, and tool/approval cards
- initial workspace read tools and SecretStorage-backed provider configuration

Deliberately deferred until the vertical slice is hardened:

- durable SQLite sessions and crash recovery
- atomic edit tools, diffs, and checkpoint/revert
- shell execution and command classification
- plan approval artifacts
- custom-mode editor and full YAML validation
- subagents, worktrees, MCP, semantic search, and workflow presets

## Invariants

1. A provider cannot invoke a tool that was not registered and advertised for the active mode.
2. Every tool call passes through the deterministic permission engine outside model control.
3. Credentials remain in VS Code SecretStorage and are never sent to the webview.
4. Workspace tools accept workspace-relative paths and reject traversal.
5. The extension UI consumes harness events, never raw provider SSE.
6. A read-only mode cannot gain mutation authority through delegation.
