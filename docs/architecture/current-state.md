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
- `packages/agent-core`: modes, model resolution, permission resolution, tool registry, normalized messages/events, the multi-step loop, and bounded subagent scheduling.
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
- durable before/after checkpoints, persisted recent checkpoint descriptors,
  native virtual-document diffs, and guarded revert actions
- durable SQLite sessions, crash recovery, provider replay state, and restored UI transcripts
- searchable session history with rename, duplicate, delete, and safe export actions
- fixed/preferred/user-selectable model policies with provider availability fallback
- isolated subagent execution with per-turn concurrency/depth budgets, explicit write-spawn approval,
  serialized child writers, durable lifecycle records, cancellation, and restored activity cards
- host-owned custom-mode registry with built-in/global/project precedence, live reload,
  compatibility imports, diagnostics, managed Markdown CRUD, arbitrary persisted slugs,
  provider/model routing, prompt skills/default context/templates, and policy pattern enforcement
- host-owned installed-skill catalog covering project, Clank-global, `.agents`, and
  `.codex` roots; per-session selection; immutable turn snapshots; and bounded
  on-demand `load_skill` access
- configurable custom subagents from the same `.agent/agents/*.md` registry,
  dynamic parent allowlists, profile-scoped child provider/model routing, opt-in
  model overrides, controlled nested delegation, and expandable live activity trees
- editable OpenAI-compatible provider presets for VibeProxy (`8317`) and
  Freebuff2API (`8080`) with authoritative bounded `/models` discovery
- guarded workspace reads/search, atomic write/edit/patch tools, bounded shell execution,
  command classification, and dedicated Git read tools
- generated Forge CSS variables with VS Code dark, light, and high-contrast mappings
- formal Plan lifecycle: workspace/session-scoped durable plan rows with revision,
  status, content hash, and compact contract; Plan/Architect path-scoped artifact writes;
  artifact reconciliation; host-owned approve/revise/save/discard with optimistic
  revision checks and `approvedAt`/`approvedBy`; `plan-approved` mode transition;
  approved-contract handoff to Implement with IMPLEMENTING/COMPLETE transitions
- webview bundled as a classic script (blank-panel fix) with a visible
  startup-failure surface and correlation id

Deliberately deferred until the vertical slice is hardened:

- delete/move tools and a stronger command/network sandbox
- full visual editing of every advanced custom-mode permission and compatibility field
- isolated worktrees, MCP, semantic search, and workflow presets

## Invariants

1. A provider cannot invoke a tool that was not registered and advertised for the active mode.
2. Every tool call passes through the deterministic permission engine outside model control.
3. Credentials remain in VS Code SecretStorage and are never sent to the webview.
4. Workspace tools accept workspace-relative paths and reject traversal.
5. The extension UI consumes harness events, never raw provider SSE.
6. A read-only mode cannot gain mutation authority through delegation.
7. A subagent route resolves only through a configured profile; task input cannot
   provide endpoints, headers, credentials, or provider IDs.
8. Project skills and agents are unavailable outside the trusted workspace boundary.
