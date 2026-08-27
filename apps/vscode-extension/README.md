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

Run `Agent Harness: Manage Providers` to add one or more OpenAI-compatible
profiles, choose defaults, maintain manual model metadata, and test or fetch the
provider's model catalog. A mode may pin a provider profile and fixed/preferred
model. API keys are stored only in VS Code SecretStorage. Legacy
`agentdock.provider.*` settings are imported without deleting their original
values.

## Personalized agents and modes

Run `Agent Harness: Manage Agents / Modes` to create, duplicate, edit, reset,
delete, import, or export executable Markdown modes. Global definitions live in
`~/.config/freebuff-agent-harness/agents/*.md`; project definitions live in
`.agent/agents/*.md`. The extension also reads `.opencode/agents/*.md` and
`.kilo/agents/*.md` as compatibility sources but never edits those files.

Definitions are resolved as built-in → global → project and update live. A
custom mode can select tools, permissions, file/command/MCP patterns, skills,
default editor context, response shape, provider/model policy, step budget, and
delegation authority. Project definitions are ignored until the workspace is
trusted. If a persisted mode becomes missing or invalid, the session is blocked
until the user explicitly selects an installed mode; it never silently runs as
Ask.

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

## Formal plan lifecycle

Plan mode writes Markdown artifacts under `.agent/plans/*.md` (with all
required headings). After each Plan-mode run the extension host scans those
artifacts, reconciles them with durable workspace/session-scoped plan rows in
SQLite, and surfaces a sanitized plan card: title, status, and revision only —
Markdown bodies, absolute paths, and provider frames never reach the webview.

Statuses follow `DRAFT → READY_FOR_APPROVAL → APPROVED → IMPLEMENTING →
COMPLETE` (with `BLOCKED` and `SUPERSEDED` side paths). When a plan is
`READY_FOR_APPROVAL` the card offers **Save Plan**, **Revise Plan**, **Discard**,
and **Approve & Implement**. Approve & Implement atomically persists the
approval (recording `approvedAt`/`approvedBy`), switches to Implement while
preserving the conversation, and records a `plan-approved` mode transition.
Implement turns then load only the approved plan's compact contract into the
system prompt and mark the plan `IMPLEMENTING`; a clean run marks it `COMPLETE`,
while errors and cancellations never claim completion. The webview only ever
sends `planId` plus `revision` — plan body, path, and content are host-owned
and validated against the current revision so stale actions fail closed.

## Webview bundle and startup safety

The webview is bundled by esbuild into a single classic script loaded from a
strict nonce CSP (`default-src 'none'`). Keeping the output free of ES-module
syntax is load-bearing: the shell uses a plain `<script src>` tag, so module
syntax would throw and leave the panel blank. The bundle smoke and the
`webview-mount` test both assert this invariant. A visible startup-failure
surface with a correlation id renders if the webview ever fails before its
first paint, instead of showing a silent blank panel.

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
