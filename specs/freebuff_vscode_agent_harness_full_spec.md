# Freebuff VS Code Agent Harness
## Provider-Agnostic Product & Technical Specification

**Status:** Implementation-ready v1 specification
**Date:** 2026-08-25
**Primary client:** Visual Studio Code extension
**Core design:** Local-first, provider-agnostic coding-agent harness
**Initial providers:** Freebuff via user-configured Freebuff2API endpoint; arbitrary OpenAI-compatible APIs; direct MiniMax OpenAI-compatible API
**Future providers:** OpenAI Responses API, Anthropic-compatible Messages API, local OpenAI-compatible servers, OpenRouter-compatible gateways, LM Studio, Ollama-compatible bridges, other custom providers

---

# 1. Executive Summary

Build a VS Code coding-agent extension with a **first-party local agent harness** rather than a thin chat client.

The harness owns:

- agent/mode behavior
- prompts
- tool definitions
- tool execution
- permissions
- workspace context
- planning and implementation handoff
- subagents
- checkpoints
- session state
- context compaction
- provider selection
- model capability handling
- streaming
- approval UX
- diffs
- diagnostics
- terminal execution
- MCP integration
- custom modes

The LLM provider is replaceable.

Freebuff should be treated as one provider through an OpenAI-compatible endpoint such as `freebuff2api`; MiniMax or any other OpenAI-compatible API should plug into the exact same harness without changing the agent runtime.

The product should feel closer to Codex/Cline/Kilo/OpenCode than to a normal chatbot.

The core principle is:

> **Modes are executable agent profiles, not prompt presets.**

Each mode defines its own:

- role/system instructions
- preferred model
- tool availability
- per-tool permission policy
- shell policy
- file access policy
- subagent permissions
- planning behavior
- iteration budget
- reasoning budget
- context strategy
- optional skills
- optional MCP access

The default built-in primary modes should be:

1. **Ask**
2. **Plan**
3. **Architect**
4. **Implement**
5. **Debug**
6. **Review**
7. **Orchestrate**
8. **Custom**

The implementation must also support arbitrary project/global custom modes using Markdown + YAML frontmatter.

---

# 2. Product Goals

## 2.1 Primary Goals

### G1 — Full coding-agent behavior

The assistant must be able to autonomously:

- inspect a repository
- locate relevant code
- read files
- search text/symbols
- inspect diagnostics
- inspect Git changes
- create implementation plans
- edit files
- apply patches
- run commands
- run tests
- observe failures
- revise its work
- ask for user approval when required
- use subagents
- return a final result grounded in actual repository state

### G2 — Mode-specific behavior

Switching modes must materially change the agent's behavior and capability surface.

Example:

- Ask cannot edit.
- Plan can investigate but cannot implement.
- Architect focuses on system-level decisions.
- Implement can edit and execute.
- Debug follows a hypothesis-driven diagnosis loop.
- Review can inspect diffs but cannot silently modify them.
- Orchestrate delegates work to subagents.
- Custom mode can define any combination.

### G3 — Provider independence

The harness must support:

- Freebuff through an OpenAI-compatible proxy
- direct OpenAI-compatible APIs
- MiniMax
- local OpenAI-compatible inference servers
- custom base URLs
- custom headers
- custom model IDs

Provider code must never be mixed with workspace tool logic.

### G4 — Native VS Code experience

The extension must provide:

- sidebar chat
- model selector
- mode selector
- streaming responses
- tool-call cards
- approval buttons
- diff previews
- file context chips
- terminal output
- diagnostics
- plan display
- checkpoints/revert
- session history
- settings UI
- custom mode editor

### G5 — Safe autonomy

Every action must pass through a deterministic permission engine before execution.

The LLM cannot self-grant permissions.

---

# 3. Non-Goals for V1

V1 does not need to:

- train models
- host models
- build a proprietary LLM gateway
- implement cloud synchronization
- implement team billing
- provide a remote autonomous cloud agent service
- fully replace Git
- build a full IDE
- maintain a custom browser engine
- perform arbitrary unrestricted filesystem access outside the workspace
- bundle unofficial Freebuff reverse-engineering logic directly into the extension

The harness should expose extension points for future functionality without requiring it in V1.

---

# 4. Research-Informed Design Principles

The following patterns should be intentionally adopted.

## 4.1 Separate planning from execution

Cline's Plan/Act approach demonstrates the value of allowing repository exploration and planning without edits, then preserving conversation context when moving into execution.

Our product should go one step further by separating:

- Plan
- Architect
- Implement

instead of treating all non-editing work as one mode.

## 4.2 Modes should carry permissions

Kilo/OpenCode-style agents combine:

- instructions
- model
- tools
- permissions
- metadata
- step budget

This is preferable to merely prepending a different prompt.

## 4.3 Permissions use allow / ask / deny

Every sensitive action should resolve to one of:

- `allow`
- `ask`
- `deny`

The permission engine must support glob/pattern-specific rules.

## 4.4 Primary agents and subagents are distinct

A mode can be:

- `primary`
- `subagent`
- `all`

Subagents execute in isolated conversation contexts and return summarized results to the parent.

## 4.5 Checkpoints should be independent of the user's Git history

The harness should use a dedicated snapshot mechanism so users can revert AI actions without polluting their repository commits.

## 4.6 Long-running sessions require compaction

The harness must estimate context usage and compact older conversation/tool history before provider limits are exceeded.

## 4.7 OpenAI-compatible should be a protocol, not a provider

"OpenAI compatible" must be implemented as a transport adapter supporting configurable:

- `baseURL`
- API key
- headers
- model
- endpoint behavior
- capability overrides

This allows MiniMax, Freebuff2API, local servers, gateways, and other compatible endpoints to share one adapter.

---

# 5. High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         VS CODE                              │
│                                                              │
│  ┌──────────────────────── Agent Sidebar ─────────────────┐   │
│  │ Chat                                                   │   │
│  │ Mode selector                                         │   │
│  │ Provider/model selector                               │   │
│  │ Context chips                                         │   │
│  │ Tool cards                                            │   │
│  │ Approval UI                                           │   │
│  │ Plans / TODOs                                         │   │
│  │ Diff summaries                                        │   │
│  │ Checkpoints                                           │   │
│  └────────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────── Agent Core ─────────────────────────┐  │
│  │ Session Manager                                       │  │
│  │ Prompt Composer                                       │  │
│  │ Mode Manager                                          │  │
│  │ Context Manager                                       │  │
│  │ Agent Loop                                            │  │
│  │ Tool Registry                                         │  │
│  │ Permission Engine                                     │  │
│  │ Checkpoint Manager                                    │  │
│  │ Compaction Manager                                    │  │
│  │ Subagent Manager                                      │  │
│  │ Provider Router                                       │  │
│  └────────────────────────────────────────────────────────┘  │
│                         │                                    │
│         ┌───────────────┼────────────────────┐               │
│         ▼               ▼                    ▼               │
│   VS Code APIs      Local Process        MCP Clients         │
│   filesystem        shell/PTY            external tools      │
│   diagnostics       git                                     │
│   LSP               ripgrep                                 │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │    Provider Adapter    │
              └────────────────────────┘
                  │         │        │
         ┌────────┘         │        └──────────┐
         ▼                  ▼                   ▼
  Freebuff2API       MiniMax API         Custom OpenAI
  /v1/chat/...       /v1/chat/...        Compatible API
```

---

# 6. Recommended Repository Layout

```text
root/
├─ apps/
│  └─ vscode-extension/
│     ├─ src/
│     │  ├─ extension.ts
│     │  ├─ webview/
│     │  ├─ commands/
│     │  ├─ vscode-adapters/
│     │  └─ settings/
│     └─ package.json
│
├─ packages/
│  ├─ agent-core/
│  │  ├─ agent-loop/
│  │  ├─ prompts/
│  │  ├─ modes/
│  │  ├─ sessions/
│  │  ├─ context/
│  │  ├─ permissions/
│  │  ├─ compaction/
│  │  ├─ checkpoints/
│  │  └─ subagents/
│  │
│  ├─ providers/
│  │  ├─ provider-interface.ts
│  │  ├─ openai-compatible/
│  │  ├─ openai-responses/
│  │  └─ anthropic-compatible/
│  │
│  ├─ tools/
│  │  ├─ filesystem/
│  │  ├─ search/
│  │  ├─ shell/
│  │  ├─ git/
│  │  ├─ diagnostics/
│  │  ├─ lsp/
│  │  ├─ web/
│  │  ├─ workflow/
│  │  └─ mcp/
│  │
│  ├─ config/
│  ├─ schemas/
│  ├─ storage/
│  └─ shared/
│
├─ prompts/
│  ├─ core.md
│  └─ modes/
│
├─ docs/
└─ tests/
```

Use TypeScript end-to-end unless a strong implementation reason requires otherwise.

---

# 7. Agent Runtime

## 7.1 Core agent loop

The agent runtime owns the complete tool loop.

Pseudo-flow:

```text
User message
    ↓
Resolve session
    ↓
Resolve active mode
    ↓
Resolve provider + model
    ↓
Collect context
    ↓
Compose system prompt
    ↓
Advertise only permitted tools
    ↓
Call model
    ↓
Stream text/reasoning/tool calls
    ↓
Tool call?
  ┌───┴─────────┐
  no            yes
  │              ↓
  │        Validate schema
  │              ↓
  │        Permission engine
  │          ┌───┼────┐
  │        allow ask deny
  │          │    │    │
  │          │    │    └─ return denial result
  │          │    └──── request user approval
  │          ▼
  │        Execute tool
  │          ↓
  │        Record result
  │          ↓
  └──────────┴─> next model step
                 ↓
             Completion
```

## 7.2 Agent step

One "step" is:

1. create provider request
2. stream model output
3. collect zero or more tool calls
4. execute approved calls
5. append tool results
6. continue if required

A user turn may contain many steps.

## 7.3 Maximum steps

Every mode has `steps`.

Example defaults:

| Mode | Default max steps |
|---|---:|
| Ask | 12 |
| Plan | 20 |
| Architect | 24 |
| Implement | 40 |
| Debug | 50 |
| Review | 24 |
| Orchestrate | 60 |
| Custom | configurable |

When the limit is reached:

- no further tools are exposed
- the model gets a system message instructing it to summarize current state
- user can click **Continue**
- Continue starts a new step budget without losing session state

## 7.4 Cancellation

Every model request and tool execution must accept an abort signal.

Stop button behavior:

- cancel provider stream
- terminate active tool if safe
- terminate spawned shell child process
- persist partial conversation
- mark the step `cancelled`

---

# 8. Built-In Modes

The following modes are product requirements, not suggestions.

---

## 8.1 Ask Mode

### Purpose

Understand and explain without changing the project.

### Behavior

Ask should:

- answer questions
- inspect code
- search repository
- inspect symbols
- inspect diagnostics
- inspect Git history/diff
- optionally use web search/fetch
- explain architecture and behavior

Ask must not modify project files.

### Default permissions

```yaml
read: allow
glob: allow
grep: allow
semantic_search: allow
lsp: allow
diagnostics: allow
git_read: allow
webfetch: ask
websearch: ask
edit: deny
write: deny
apply_patch: deny
delete: deny
bash:
  safe_read_only: allow
  "*": deny
task: deny
mcp: ask
```

### Prompt characteristics

- concise technical explanations
- cite files and symbols used in conclusions
- never claim a code behavior without inspecting relevant code when workspace context is available
- distinguish facts from assumptions

---

## 8.2 Plan Mode

### Purpose

Produce an actionable implementation plan for a specific requested change.

### Key distinction from Architect

Plan is **task-oriented**.

Plan answers:

- What files need changing?
- In what order?
- What tests need updating?
- What risks/edge cases exist?
- What does "done" mean?

Architect answers:

- What should the system design be?
- Where should responsibilities live?
- What contracts/interfaces should exist?
- Which architectural tradeoff is preferred?

### Plan behavior

Plan may:

- deeply inspect repository
- run safe/read-only discovery commands
- inspect diagnostics
- inspect tests
- inspect package metadata
- write only dedicated plan artifacts

Plan must not implement production code.

### Plan artifact location

```text
.agent/plans/<timestamp>-<slug>.md
```

or configurable equivalent.

### Plan lifecycle

```text
DRAFT → READY_FOR_APPROVAL → APPROVED → IMPLEMENTING → COMPLETE
                             ↘ SUPERSEDED
```

### Default permissions

```yaml
read: allow
glob: allow
grep: allow
semantic_search: allow
lsp: allow
diagnostics: allow
git_read: allow
bash:
  safe_read_only: allow
  "*": ask
edit:
  ".agent/plans/**": allow
  "*": deny
write:
  ".agent/plans/**": allow
  "*": deny
apply_patch:
  ".agent/plans/**": allow
  "*": deny
webfetch: ask
websearch: ask
task: allow
mcp: ask
```

### Required plan format

Every formal plan should include:

```markdown
# Goal
# Current State
# Scope
# Non-Goals
# Proposed Changes
# Files / Components
# Data / API Changes
# Step-by-Step Implementation
# Tests
# Validation
# Risks / Edge Cases
# Rollback
# Acceptance Criteria
```

### UI

When a plan reaches `READY_FOR_APPROVAL`, show:

- **Approve & Implement**
- **Revise Plan**
- **Save Plan**
- **Discard**

Approve & Implement switches to Implement mode while retaining full conversation and referencing the approved plan.

---

## 8.3 Architect Mode

### Purpose

System-level design and technical decision-making.

### Behavior

Architect should prioritize:

- boundaries
- interfaces
- component ownership
- data flow
- state transitions
- concurrency
- security
- scalability
- compatibility
- migration strategy
- failure modes
- observability
- long-term maintainability

Architect should not start coding simply because it knows how.

### Architect output types

- architecture proposal
- ADR
- RFC
- API contract
- schema proposal
- state machine
- sequence diagram
- component diagram
- migration plan

### Allowed writes

By default only:

```text
.agent/architecture/**
docs/architecture/**
docs/adr/**
```

All other edits denied.

### Default permissions

Similar to Plan but with:

- higher reasoning budget
- more repository exploration
- web research enabled as `ask`
- subagents enabled
- no implementation writes

### Architect → Implement handoff

Architect may produce an **Implementation Contract** containing:

- selected design
- interfaces
- invariants
- files/components expected to own each responsibility
- prohibited shortcuts
- migration constraints

Implement mode should load this contract automatically if it exists.

---

## 8.4 Implement Mode

### Purpose

Make code changes and finish the task.

### Behavior

Implement should:

1. inspect relevant code
2. reuse an approved plan if present
3. make the smallest coherent edits
4. run targeted validation early
5. inspect failures
6. fix regressions
7. run final tests
8. summarize changes

### Default permissions

```yaml
read: allow
glob: allow
grep: allow
semantic_search: allow
lsp: allow
diagnostics: allow
git_read: allow

edit: ask
write: ask
apply_patch: ask
delete: ask

bash:
  safe_read_only: allow
  build_test_lint: allow
  dependency_install: ask
  destructive: deny

webfetch: ask
websearch: ask
task: allow
mcp: ask
```

Users may enable Auto mode to convert selected `ask` permissions to `allow`, but `deny` is never overridden.

### Implement discipline

Implement must not silently diverge from an approved plan when the deviation is architecturally significant.

If a major mismatch is discovered:

1. explain the mismatch
2. update plan status to `BLOCKED`
3. offer:
   - Revise Plan
   - Continue With Change
   - Return to Architect

Small tactical deviations do not require blocking.

---

## 8.5 Debug Mode

### Purpose

Diagnose and fix a defect using evidence.

### Required methodology

Debug follows:

```text
Observe
  ↓
Reproduce
  ↓
Gather evidence
  ↓
Form hypotheses
  ↓
Rank hypotheses
  ↓
Run smallest discriminating test
  ↓
Narrow
  ↓
Fix root cause
  ↓
Regression test
  ↓
Explain
```

### Debug-specific session state

```ts
interface DebugHypothesis {
  id: string
  statement: string
  evidenceFor: string[]
  evidenceAgainst: string[]
  confidence: number
  status: "open" | "rejected" | "confirmed"
}
```

### Default permissions

Full tool access subject to approval policy.

Debug gets a larger step budget than Implement because diagnosis may require iterations.

### UI

Optional "Hypotheses" collapsible card:

```text
1. Auth token expires before refresh      65%
2. Race in session cache                  25%
3. Incorrect URL normalization            10%
```

This is working-state metadata, not hidden chain-of-thought.

---

## 8.6 Review Mode

### Purpose

Review code without making unrequested modifications.

### Targets

Review can operate on:

- current working tree
- staged changes
- selected files
- branch vs base branch
- commit
- pull request diff if connector/tool available

### Default permissions

```yaml
read: allow
glob: allow
grep: allow
semantic_search: allow
lsp: allow
diagnostics: allow
git_read: allow
bash:
  safe_read_only: allow
  "*": deny
edit: deny
write: deny
apply_patch: deny
delete: deny
webfetch: ask
websearch: ask
task: allow
mcp: ask
```

### Finding schema

```ts
interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low" | "nit"
  category:
    | "correctness"
    | "security"
    | "performance"
    | "maintainability"
    | "testing"
    | "api"
    | "ux"
    | "style"
  file?: string
  lineStart?: number
  lineEnd?: number
  title: string
  explanation: string
  suggestedFix?: string
  confidence: number
}
```

### UI

Findings should be navigable to code.

Review may expose a **Fix selected findings** action that creates a new Implement turn rather than allowing Review mode to edit directly.

---

## 8.7 Orchestrate Mode

### Purpose

Coordinate complex work using isolated subagents.

Although some modern tools no longer require a dedicated orchestrator, we intentionally include one because explicit orchestration is useful for:

- large refactors
- independent research tasks
- frontend/backend parallelization
- test generation
- review + implementation loops
- repository mapping

### Orchestrator itself

Should prefer delegation over direct edits.

### Built-in subagents

#### Explore

Read-only codebase investigator.

#### General

Broad autonomous worker with most tools except recursive subagent creation.

#### Test

Focused on tests and validation.

#### Review

Read-only reviewer.

#### Research

Web/docs research.

#### Implementer

Can modify code in an isolated branch/worktree when allowed.

### Parallelism

Default max concurrent subagents: `3`.

Configurable range:

```text
1–8
```

### Context isolation

A subagent receives:

- task prompt
- selected relevant parent context
- workspace rules
- mode prompt
- tool permissions

It does **not** receive the entire parent conversation by default.

### Subagent result

```ts
interface SubagentResult {
  summary: string
  findings?: Finding[]
  filesInspected?: string[]
  filesChanged?: string[]
  commandsRun?: CommandResult[]
  artifacts?: string[]
  followups?: string[]
}
```

### Optional worktree mode

Subagents capable of editing should eventually support isolated Git worktrees.

V1 may ship subagents in the same workspace only if write subagents are serialized.

---

## 8.8 Custom Mode

Custom Mode is a first-class feature.

It must not be a single "custom prompt" textbox.

A custom mode defines:

- name
- slug
- description
- icon/color
- system instructions
- primary/subagent/all
- provider/model preference
- temperature
- top-p
- reasoning effort
- max output
- max agent steps
- tools
- permission policies
- file patterns
- command patterns
- MCP tool patterns
- skills
- whether delegation is allowed
- default context sources
- optional response template

Example custom mode:

```markdown
---
name: Database Specialist
description: PostgreSQL schema and query expert
type: all
model: minimax/MiniMax-M2.7
steps: 30
reasoningEffort: high
permission:
  read: allow
  glob: allow
  grep: allow
  lsp: allow
  edit:
    "db/**": ask
    "migrations/**": ask
    "*": deny
  bash:
    "psql *": ask
    "npm test *": allow
    "*": deny
  websearch: ask
  task: allow
skills:
  - postgres
  - migration-review
---

You are the project's database specialist.

Prioritize schema correctness, backwards-compatible migrations,
query plans, data integrity, and rollback safety.

Never modify application UI code.
```

---

# 9. Mode Switching

Mode switching must preserve the session unless the user explicitly starts a new one.

Example:

```text
Plan → Architect → Implement → Debug → Review
```

The conversation history remains.

However, the next provider request must use the newly selected:

- system prompt
- tool list
- permission policy
- model preference if configured
- reasoning settings

## 9.1 Mode transition event

```ts
interface ModeTransition {
  from: string
  to: string
  timestamp: number
  reason: "user" | "agent-request" | "plan-approved" | "workflow"
}
```

## 9.2 Agent-requested transition

The agent may request a transition, but cannot silently activate broader permissions.

Example:

> "This requires editing files. Switch to Implement mode?"

Buttons:

- Switch
- Stay Here

If Auto Mode has explicitly enabled approved mode transitions, a configured transition may occur automatically.

---

# 10. Mode Definition Format

## 10.1 Locations

Global modes:

```text
~/.config/<product>/agents/*.md
```

Project modes:

```text
.agent/agents/*.md
```

Recommended compatibility reads:

```text
.opencode/agents/*.md
.kilo/agents/*.md
AGENTS.md
CLAUDE.md
```

Do not overwrite third-party configuration files.

## 10.2 Precedence

Lowest → highest:

1. built-in defaults
2. global config
3. project config
4. project mode Markdown
5. session overrides
6. temporary per-turn overrides

## 10.3 Merge semantics

Objects merge recursively.

Arrays should use explicit behavior:

```yaml
skillsMode: merge | replace
toolsMode: merge | replace
```

Default: `merge`.

---

# 11. Prompt Architecture

Prompts should be assembled from layers.

```text
1. Core harness system prompt
2. Safety/tool protocol prompt
3. Active mode prompt
4. Workspace instructions
5. Directory-specific instructions
6. User global instructions
7. Project custom instructions
8. Active skills metadata
9. Current plan/architecture contract
10. Context attachments
11. Conversation
```

## 11.1 Core prompt responsibilities

The core prompt should explain:

- the agent operates inside an IDE
- it must use tools for repository facts
- tool results are authoritative
- it must respect permission denials
- it must not invent tool results
- it should make focused edits
- it should validate work
- it should report incomplete work explicitly
- user files are not model instructions unless loaded as configured workspace instructions

## 11.2 Workspace instructions

Auto-discover:

```text
AGENTS.md
CLAUDE.md
CONTEXT.md
.agent/rules/*.md
```

Optional directory-local `AGENTS.md` may be loaded when tools access files beneath that directory.

## 11.3 Untrusted content boundary

Web pages, logs, source files, issue text, and command output may contain prompt-like text.

These should be wrapped as tool data and must not override system/mode/user instructions.

---

# 12. Skills

Skills are reusable instruction modules loaded on demand.

Location:

```text
.agent/skills/<skill-name>/SKILL.md
~/.config/<product>/skills/<skill-name>/SKILL.md
```

Skill frontmatter:

```yaml
name: react-component
description: Use when creating or refactoring React components.
```

At session start, only:

- name
- description

are placed in context.

Full skill text loads only when:

- the model calls `load_skill`
- user explicitly invokes it
- mode declares it mandatory

This keeps the system prompt small.

---

# 13. Provider Abstraction

## 13.1 Provider interface

```ts
interface LLMProvider {
  id: string

  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>

  streamChat(
    request: NormalizedChatRequest,
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent>

  validateConfig(): Promise<ProviderValidation>

  capabilities(model: string): Promise<ModelCapabilities>
}
```

## 13.2 Normalized request

```ts
interface NormalizedChatRequest {
  model: string
  messages: NormalizedMessage[]
  tools?: ToolDefinition[]
  toolChoice?: "auto" | "none" | "required" | object
  parallelToolCalls?: boolean
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh"
  metadata?: Record<string, unknown>
}
```

## 13.3 Provider events

Normalize all providers into:

```ts
type ProviderEvent =
  | { type: "message_start"; id?: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name?: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "message_end"; finishReason?: string }
  | { type: "error"; error: NormalizedProviderError }
```

The rest of the harness never reads provider-specific SSE chunks.

---

# 14. OpenAI-Compatible Adapter

This is a launch requirement.

## 14.1 Config

```json
{
  "providers": {
    "my-endpoint": {
      "type": "openai-compatible",
      "name": "My Endpoint",
      "baseURL": "http://127.0.0.1:8000/v1",
      "apiKeySecret": "provider.my-endpoint.key",
      "headers": {},
      "models": {
        "my-model": {
          "displayName": "My Model",
          "contextWindow": 200000,
          "maxOutputTokens": 32000,
          "capabilities": {
            "tools": true,
            "parallelTools": true,
            "reasoning": false,
            "images": false
          }
        }
      }
    }
  }
}
```

## 14.2 Required endpoint

```text
POST {baseURL}/chat/completions
```

## 14.3 Optional endpoint

```text
GET {baseURL}/models
```

If `/models` is missing, manually configured models remain usable.

## 14.4 Streaming

Must support SSE:

```text
data: {...}
data: {...}
data: [DONE]
```

Tool-call arguments may arrive fragmented across chunks and must be accumulated by tool-call ID/index.

## 14.5 Tool-calling loop

The adapter must support standard OpenAI `tools` and assistant `tool_calls`.

When the model requests a tool:

1. retain the complete assistant message
2. execute tools
3. append assistant tool-call message
4. append one `tool` role result per call
5. send the full updated history

Never reconstruct a lossy assistant message if the provider returns provider-specific reasoning metadata that must be preserved.

## 14.6 Compatibility overrides

Because "OpenAI compatible" implementations differ, configuration must permit:

```json
{
  "compatibility": {
    "stripUnsupportedParams": true,
    "sendMaxTokensAs": "max_tokens",
    "supportsDeveloperRole": false,
    "reasoningField": "reasoning_content",
    "requiresAssistantReasoningReplay": true,
    "supportsParallelToolCalls": true,
    "streamUsage": false
  }
}
```

---

# 15. Freebuff Provider

## 15.1 Architecture

Do not integrate Freebuff-specific reverse-engineering into agent-core.

Use:

```text
agent-core
    ↓
openai-compatible adapter
    ↓
user-configured Freebuff2API endpoint
```

Example:

```json
{
  "providers": {
    "freebuff": {
      "type": "openai-compatible",
      "name": "Freebuff",
      "baseURL": "http://127.0.0.1:8000/v1",
      "modelsFromEndpoint": true
    }
  }
}
```

## 15.2 Why this boundary matters

It keeps:

- unofficial upstream behavior isolated
- provider breakage isolated
- AGPL code out of the extension unless intentionally adopted
- the harness usable even if Freebuff changes
- the extension architecture legally and technically cleaner

## 15.3 Current Freebuff2API capabilities relevant to the harness

The referenced `XxxXTeam/freebuff2api` exposes:

```text
GET /v1/models
POST /v1/chat/completions
GET /healthz
```

Its OpenAI compatibility layer currently forwards common fields including:

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- reasoning-related fields
- streaming

and reconstructs streamed tool calls.

Therefore the harness should treat Freebuff as an OpenAI-compatible endpoint, not as a special agent runtime.

## 15.4 Failure handling

Freebuff adapter UX should gracefully surface:

- unavailable proxy
- auth failure
- free session unavailable
- upstream model unavailable
- rate limit
- malformed tool calls
- provider protocol change

Do not disguise provider-specific failure as a workspace tool error.

---

# 16. MiniMax Provider

MiniMax can use the same OpenAI-compatible adapter.

Example:

```json
{
  "providers": {
    "minimax": {
      "type": "openai-compatible",
      "name": "MiniMax",
      "baseURL": "https://api.minimax.io/v1",
      "apiKeySecret": "provider.minimax.key",
      "models": {
        "MiniMax-M2.7": {
          "contextWindow": 204800,
          "capabilities": {
            "tools": true,
            "streaming": true,
            "reasoning": true
          }
        },
        "MiniMax-M2.5": {
          "contextWindow": 204800,
          "capabilities": {
            "tools": true,
            "streaming": true,
            "reasoning": true
          }
        }
      },
      "compatibility": {
        "requiresAssistantReasoningReplay": true
      }
    }
  }
}
```

Important implementation rule:

For MiniMax multi-turn tool calling, preserve the complete assistant response needed by the provider, including relevant reasoning fields/content required for continuity.

Do not normalize away provider-required metadata before storing the canonical provider transcript.

---

# 17. Provider Configuration UX

Settings → Providers.

Functions:

- Add Provider
- Edit Provider
- Delete Provider
- Test Connection
- Fetch Models
- Add Model Manually
- Set Default
- Set Mode Defaults

Fields:

```text
Display Name
Provider Type
Base URL
API Key
Headers
Model ID
Context Window
Max Output
Tool Calling
Parallel Tool Calling
Reasoning
Vision
Streaming
Temperature
Top P
Compatibility Overrides
```

Secrets must use VS Code SecretStorage or OS credential storage.

Never store API keys in workspace config by default.

---

# 18. Model Selection

Model selector should display:

```text
Provider / Model
Context window
Tool support
Reasoning support
Vision support
Configured cost if known
```

Model selection scopes:

- global default
- mode default
- session override
- one-turn override

Precedence:

```text
turn > session > mode > global
```

---

# 19. Capability Registry

Never assume every OpenAI-compatible model supports every OpenAI field.

```ts
interface ModelCapabilities {
  contextWindow?: number
  maxOutputTokens?: number
  streaming: boolean
  tools: boolean
  parallelTools: boolean
  reasoning: boolean
  vision: boolean
  jsonSchema: boolean
  temperature: boolean
}
```

Capabilities may come from:

1. built-in registry
2. provider model metadata
3. user override
4. safe probe

User overrides win.

---

# 20. Tool System

Every tool has:

```ts
interface AgentTool<I, O> {
  name: string
  description: string
  inputSchema: JSONSchema
  category: ToolCategory
  risk: ToolRisk
  execute(input: I, ctx: ToolContext): Promise<O>
}
```

Tool outputs should be structured JSON whenever practical.

---

# 21. Core Tools

## 21.1 File / Read

### `read_file`

Inputs:

```ts
{
  path: string
  startLine?: number
  endLine?: number
}
```

### `read_files`

Batch reads multiple files with output limits.

### `list_directory`

### `glob`

### `grep`

Prefer ripgrep for textual search.

### `tree`

Return bounded repository tree.

---

# 22. Edit Tools

## 22.1 `apply_patch`

Preferred mutation tool for precise changes.

Input:

```ts
{
  patch: string
}
```

Must validate:

- path is inside allowed workspace
- patch context matches
- no forbidden path
- file size limits

## 22.2 `edit_file`

Precise replacement operation.

## 22.3 `write_file`

Create/replace file.

## 22.4 `delete_file`

Separate high-risk tool.

## 22.5 `move_file`

Separate high-risk tool.

Do not hide delete/move inside generic shell execution.

---

# 23. Shell Tool

## 23.1 `run_command`

Inputs:

```ts
{
  command: string
  cwd?: string
  timeoutMs?: number
  purpose?: string
}
```

Outputs:

```ts
{
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
}
```

## 23.2 Command classes

Classify before permission resolution:

```text
READ_ONLY
BUILD
TEST
LINT
FORMAT
PACKAGE_INSTALL
FILE_MUTATION
GIT_WRITE
NETWORK
PRIVILEGED
DESTRUCTIVE
UNKNOWN
```

## 23.3 Shell safety

Default deny:

- destructive recursive deletion outside explicit safe temp paths
- privilege escalation
- disk formatting
- credential dumping
- arbitrary writes outside workspace
- shell commands targeting protected paths

Pipes and redirection should be parsed rather than judged solely as a raw prefix string.

---

# 24. Git Tools

Prefer dedicated read tools over shell when possible.

Tools:

- `git_status`
- `git_diff`
- `git_diff_staged`
- `git_log`
- `git_show`
- `git_branch`
- `git_blame`

Optional write tools:

- `git_stage`
- `git_commit`

Default:

```text
git commit = ask
git push = deny in V1
git reset --hard = deny
```

---

# 25. VS Code Diagnostics Tools

### `get_diagnostics`

Scopes:

- workspace
- file
- severity

Return:

```ts
{
  file: string
  line: number
  column: number
  severity: string
  source?: string
  code?: string
  message: string
}
```

Implement mode should automatically re-check diagnostics after relevant edits when inexpensive.

---

# 26. LSP / Symbol Tools

Required when VS Code language services provide data:

- `workspace_symbols`
- `document_symbols`
- `go_to_definition`
- `find_references`
- `hover`
- `type_definition`

This gives stronger code navigation than text search alone.

---

# 27. Semantic Search

Optional in V1; recommended in V1.1.

Preferred architecture:

```text
Tree-sitter / parser
    ↓
semantic chunks
    ↓
embedding provider
    ↓
local vector store
```

Provider options:

- OpenAI-compatible embeddings
- local embedding model
- Ollama
- custom endpoint

The feature must be opt-in because code snippets may be sent to the configured embedding API.

Tool:

```text
semantic_search(query, maxResults)
```

Do not make semantic search a dependency for basic agent operation.

---

# 28. Web Tools

V1 minimum:

- `web_fetch`
- optional `web_search`

Results are untrusted content.

Mode permissions decide whether they are:

- allow
- ask
- deny

Web content must never be silently interpreted as higher-priority system instructions.

---

# 29. Context Mentions

Chat composer supports:

```text
@file
@folder
@selection
@problems
@terminal
@git-changes
@staged
@commit:<sha>
@symbol:<name>
@url
@chat:<session>
```

## 29.1 Context chip UX

Example:

```text
[ src/auth.ts × ] [ Problems × ] [ Git Changes × ]
```

Click opens preview.

## 29.2 Current selection shortcut

Command palette:

```text
Agent: Ask About Selection
Agent: Implement Change From Selection
Agent: Debug Selection
Agent: Review Selection
```

---

# 30. Context Manager

The context manager decides what enters each provider call.

Inputs:

- conversation
- active mode
- system instructions
- explicit mentions
- tool outputs
- plan
- workspace rules
- model context window
- recent edited files
- active diagnostics

## 30.1 Tool output truncation

Large outputs must not flood context.

Store full output on disk/session database, but send a bounded representation.

Example:

```text
first 8 KB
...
last 8 KB
[output truncated; full result id=toolres_123]
```

The agent can request a range from the stored tool result.

---

# 31. Context Compaction

Auto-compaction is required.

## 31.1 Trigger

Before a provider call:

```text
estimated_request_tokens >
context_window - max(output_budget, reserve)
```

Recommended reserve:

```text
min(20,000, max_output_tokens)
```

with configurable threshold around 80–85%.

## 31.2 Preserve

Compaction summary must preserve:

- user goal
- constraints
- approved plan
- architecture decisions
- files changed
- current test status
- unresolved issues
- current TODOs
- permissions explicitly granted for session
- important provider/model quirks
- next step

## 31.3 Recent tail

Keep recent turns verbatim.

Recommended:

```text
2–4 user turns
or 4k–8k tokens
```

## 31.4 Tool pruning

Old completed tool outputs should be replaced in active context with references:

```text
[Older tool result removed from active context: toolres_123]
```

Durable history remains available.

---

# 32. Session Persistence

Use SQLite.

## 32.1 Core tables

```text
sessions
messages
provider_messages
steps
tool_calls
tool_results
approvals
mode_transitions
plans
checkpoints
todos
subagent_runs
usage
artifacts
```

## 32.2 Session fields

```ts
interface Session {
  id: string
  workspaceId: string
  title: string
  createdAt: number
  updatedAt: number
  activeMode: string
  providerId: string
  modelId: string
  status:
    | "idle"
    | "running"
    | "waiting_for_approval"
    | "cancelled"
    | "error"
}
```

## 32.3 Two transcripts

Maintain:

### Normalized transcript

Provider-independent agent history.

### Provider transcript

Exact provider-specific messages required to continue a tool/reasoning chain.

This is especially important for providers that require their own reasoning payload to be replayed.

---

# 33. Checkpoints / Snapshots

Required.

## 33.1 Recommended implementation

Dedicated Git object repository stored outside the user's normal `.git`.

Capture at least:

- before a mutating agent turn
- after a mutating agent turn

Optional:

- each mutating step

## 33.2 UI

Each agent turn that changed files shows:

```text
3 files changed  +84 -21
[View Diff] [Revert]
```

## 33.3 Revert options

- Revert Workspace
- Revert Conversation
- Revert Both

Workspace revert should not rewrite normal Git commit history.

## 33.4 Exclusions

Respect:

- `.gitignore`
- agent ignore file
- configured protected paths
- secrets

---

# 34. Diff UX

When agent edits a file:

1. record pre-edit content
2. apply edit after approval
3. show compact diff card
4. clicking opens native VS Code side-by-side diff

Optional per-edit controls:

- Keep
- Revert File

User should not need to review every edit if policy allows automatic editing, but all edits remain inspectable.

---

# 35. Permission Engine

Permissions are deterministic and evaluated outside the model.

## 35.1 Effects

```text
ALLOW
ASK
DENY
```

## 35.2 Precedence

Highest priority:

1. hard safety rule
2. explicit user/session deny
3. project policy
4. mode policy
5. global policy
6. tool default

`DENY` from hard safety cannot be overridden.

## 35.3 Pattern rules

Example:

```yaml
permission:
  edit:
    "*": ask
    "src/**": allow
    ".env*": deny
    "infra/prod/**": deny

  bash:
    "*": ask
    "npm test*": allow
    "npm run lint*": allow
    "git status*": allow
    "git diff*": allow
    "git push*": deny
```

Use ordered rules with clear documented precedence.

## 35.4 Approval dialog

Must show:

```text
Agent wants to run:

npm install zod

Reason:
Needed for runtime schema validation.

Workspace:
my-project

[Allow Once]
[Allow Similar This Session]
[Deny]
```

## 35.5 Never allow model-written permission policy

The model may request approval.

It cannot directly mutate active permission rules.

---

# 36. Auto Mode

Auto Mode is a user setting, not an agent mode.

Options:

### Conservative

- reads automatic
- edits ask
- commands ask
- MCP ask

### Coding

- reads automatic
- edits automatic
- build/test/lint automatic
- package install ask
- destructive denied

### YOLO / Full Auto

- convert eligible `ask` to `allow`
- explicit `deny` remains denied
- hard safety remains enforced

Show a visible warning when Full Auto is active.

---

# 37. Protected Files

Default sensitive patterns:

```text
.env
.env.*
**/*.pem
**/*.key
**/id_rsa
**/id_ed25519
**/credentials*
**/secrets*
```

Policy:

- reading = ask
- writing = deny by default
- displaying secret content in chat = redact known credential patterns where possible

Allow `.env.example`.

---

# 38. Workspace Trust

If VS Code marks a workspace untrusted:

Disable by default:

- shell execution
- file writes
- hooks
- MCP server launch
- project skills that execute code
- project scripts

Read-only Ask should continue to work.

---

# 39. MCP

MCP support should be part of the harness architecture.

## 39.1 Config

Global and project MCP servers.

```json
{
  "mcp": {
    "github": {
      "transport": "stdio",
      "command": "..."
    }
  }
}
```

## 39.2 Tool namespace

```text
mcp_<server>_<tool>
```

## 39.3 Permissions

Pattern-based.

```yaml
permission:
  "mcp_github_*": ask
  "mcp_docs_search": allow
```

## 39.4 Prompt footprint

Do not inject full tool descriptions from every disabled MCP server.

Only advertise enabled tools available to the current mode.

---

# 40. TODO / Task System

Built-in tools:

- `todo_write`
- `todo_read`

Data:

```ts
interface Todo {
  id: string
  text: string
  status: "pending" | "in_progress" | "done" | "blocked"
  parentId?: string
}
```

UI shows a live task list in Plan/Implement/Debug/Orchestrate modes.

The model should update TODOs during long tasks.

---

# 41. Formal Plan Handoff

Approved plan should become persistent structured context.

Example metadata:

```json
{
  "planId": "plan_123",
  "status": "APPROVED",
  "approvedAt": 1787690000000,
  "approvedBy": "user"
}
```

Implement prompt gets:

```text
You are implementing approved plan plan_123.
Follow it unless new repository evidence requires a deviation.
For material deviations, surface the reason before proceeding.
```

The plan file itself should not be duplicated into every turn if a compact structured version is available.

---

# 42. Subagent Runtime

## 42.1 Spawn tool

```ts
task({
  agent: "explore",
  prompt: "Map the authentication flow and identify all session refresh paths.",
  contextRefs: ["src/auth", "src/session"]
})
```

## 42.2 Parent restrictions

Parent can only spawn subagents allowed by its mode policy.

## 42.3 Recursion

Default:

```text
max subagent nesting depth = 1
```

Orchestrate may allow depth `2`.

Prevent uncontrolled recursive spawning.

## 42.4 Concurrency budget

```text
max concurrent subagents = 3
max total subagents per turn = 8
```

Configurable.

## 42.5 Provider/model override

A subagent may declare:

```yaml
model: cheap-provider/fast-model
```

Use cases:

- Explore → cheaper/faster model
- Architect → stronger reasoning model
- Review → dedicated review model

---

# 43. Worktree-Based Parallel Agents

Phase 2.

For independent implementation tasks:

```text
main workspace
   ├─ worktree agent-1
   ├─ worktree agent-2
   └─ worktree agent-3
```

Each has:

- own branch
- own session
- own terminal
- own checkpoint state

Agent Manager UI can show:

```text
Task             Status      Files      Tests
Auth refactor    Running     4          ...
UI settings      Done        7          pass
Tests            Review      3          pass
```

User chooses what to merge.

---

# 44. VS Code UI Specification

## 44.1 Activity Bar

Add one activity icon.

Views:

- Agent
- Sessions
- Plans
- optional Agents

## 44.2 Sidebar Header

```text
[Mode: Implement ▼]  [MiniMax / M2.7 ▼]
```

Secondary:

```text
Context 42%     Auto: Coding     $/tokens if known
```

## 44.3 Chat message rendering

Assistant message can contain blocks:

- text
- reasoning summary indicator
- file read
- search
- edit
- command
- diagnostics
- web
- subagent
- TODO
- plan
- approval
- diff
- error

Tool blocks are collapsible.

---

# 45. Composer

Features:

- multiline
- `@` mention autocomplete
- attach files/images when model supports them
- mode shortcut
- model shortcut
- slash commands
- stop button during run

Recommended slash commands:

```text
/new
/mode
/model
/plan
/implement
/architect
/debug
/review
/compact
/context
/checkpoint
/revert
/agents
/providers
/settings
```

---

# 46. Custom Mode UI

Settings → Agents / Modes.

List built-ins + customs.

Actions:

- New Mode
- Duplicate
- Edit
- Delete custom
- Reset built-in override
- Export
- Import

Editor fields:

```text
Name
Slug
Description
Color/Icon
Primary/Subagent/All
System Instructions
Provider
Model
Reasoning
Temperature
Max Steps
Tools
Permission matrix
Path rules
Command rules
MCP rules
Skills
Default context
```

Advanced view shows raw Markdown.

---

# 47. Provider UI

Provider card:

```text
MiniMax
Connected

Base URL: https://api.minimax.io/v1
Models: 4
Default: MiniMax-M2.7

[Test] [Fetch Models] [Edit]
```

Freebuff example:

```text
Freebuff
Connected via OpenAI Compatible

Base URL: http://127.0.0.1:8000/v1
Health: OK
Models: fetched from /models
```

---

# 48. Session History

Searchable by:

- title
- date
- mode
- provider
- model
- workspace
- files changed

Session row:

```text
Fix auth refresh race
Implement · MiniMax-M2.7
18 min ago · 5 files changed
```

Actions:

- Open
- Rename
- Duplicate
- Delete
- Export Markdown/JSON

---

# 49. Context Meter

Show estimated usage:

```text
Context 68%
```

Click reveals:

```text
System prompts       6.1k
Conversation        42.8k
Tool results        19.4k
Attached context     8.2k
Available           78.0k
Reserved output     20.0k
```

Values may be approximate.

---

# 50. Error Handling

Normalize errors:

```ts
type ErrorKind =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "provider_unavailable"
  | "model_not_found"
  | "unsupported_parameter"
  | "malformed_tool_call"
  | "tool_execution"
  | "permission_denied"
  | "workspace"
  | "cancelled"
  | "unknown"
```

UI should distinguish provider errors from tool errors.

Retry behavior:

- transient network: exponential backoff
- 429: respect retry headers
- context overflow: compact then retry once
- unsupported parameter: compatibility retry after stripping optional unsupported field when configured
- auth: do not loop

---

# 51. Tool-Call Reliability

## 51.1 Invalid JSON arguments

If tool-call args are malformed:

1. attempt safe incremental parse after full stream
2. if still invalid, return a structured tool protocol error to model
3. allow one repair attempt
4. do not guess destructive arguments

## 51.2 Unknown tool

Return:

```json
{
  "error": "UNKNOWN_TOOL",
  "availableTools": ["read_file", "grep", "..."]
}
```

## 51.3 Duplicate tool-call ID

Deduplicate and prevent accidental double execution.

## 51.4 Retry safety

Mutating tools must carry idempotency metadata.

Never automatically rerun a mutation merely because a provider connection broke after execution.

---

# 52. Parallel Tool Calls

Support when model capability says yes.

Parallelize only when calls are independent and safe.

Safe examples:

- multiple reads
- grep + symbols
- web searches

Serialize by default:

- file edits touching same file
- shell mutations
- Git writes
- dependency installs

---

# 53. Reasoning Handling

The harness may receive provider-specific reasoning fields.

Rules:

- preserve provider-required reasoning internally when needed for conversation continuity
- UI may show a summarized/reasoning indicator if permitted by provider/product behavior
- do not make product correctness depend on exposing raw hidden reasoning
- normalized agent state should store decisions, plans, hypotheses, and TODOs explicitly rather than relying on hidden chain-of-thought

---

# 54. Model-Agnostic Tool Descriptions

Tool schemas should be compact.

Avoid provider-specific syntax in the core tool definitions.

Good:

```text
read_file — Read a UTF-8 workspace file or selected line range.
```

Bad:

```text
When using Claude...
When using GPT...
When using MiniMax...
```

Provider quirks belong in adapters.

---

# 55. Ignore Files

Support:

```text
.agentignore
.gitignore
```

Optional compatibility:

```text
.clineignore
.kilocodeignore
```

Ignore affects:

- context discovery
- semantic index
- repository tree
- glob
- grep

Explicit user mention of an ignored file may trigger an approval prompt rather than silently bypassing policy.

---

# 56. Project Configuration

Recommended:

```text
.agent/config.jsonc
```

Example:

```jsonc
{
  "defaultMode": "implement",
  "defaultProvider": "minimax",
  "defaultModel": "MiniMax-M2.7",

  "instructions": [
    "AGENTS.md",
    ".agent/rules/*.md"
  ],

  "snapshot": true,

  "compaction": {
    "auto": true,
    "thresholdPercent": 82,
    "reservedTokens": 20000,
    "keepRecentTokens": 6000
  },

  "subagents": {
    "maxConcurrent": 3,
    "maxDepth": 1
  },

  "permission": {
    "read": "allow",
    "edit": "ask",
    "bash": {
      "*": "ask",
      "npm test*": "allow",
      "npm run lint*": "allow",
      "git status*": "allow",
      "git diff*": "allow",
      "git push*": "deny"
    }
  }
}
```

---

# 57. Global Configuration

Recommended:

```text
~/.config/<product>/config.jsonc
```

Contains:

- provider definitions excluding raw secrets
- global modes
- global rules
- default permissions
- MCP configuration
- UI preferences

Secrets stay in credential storage.

---

# 58. Import Compatibility

Nice-to-have, high-value feature.

Allow import from:

- OpenCode agents
- Kilo custom agents/modes
- generic Markdown/YAML mode file

Mapping:

```text
description → description
model → model
prompt/body → instructions
permission → permission
mode/type → primary/subagent/all
steps → steps
temperature → temperature
top_p → topP
```

Do not attempt perfect round-trip compatibility in V1.

---

# 59. Security Model

## 59.1 Trust boundaries

Untrusted:

- model output
- tool arguments
- repository contents
- terminal output
- web content
- MCP output

Trusted:

- permission engine
- schemas
- path validator
- secret store
- configured hard denies

## 59.2 Path validation

Before filesystem operations:

1. canonicalize path
2. resolve symlinks
3. verify path belongs to allowed workspace or explicit approved external directory
4. evaluate protected-file rules
5. execute

## 59.3 External directories

Default `ask`.

Approval must show actual resolved path.

## 59.4 Secret storage

Use VS Code `SecretStorage`.

No API keys in:

- model prompts
- logs
- session exports
- project configuration
- provider error telemetry

---

# 60. Logging

Local logs with levels:

```text
error
warn
info
debug
trace
```

Debug may log:

- provider timing
- tool timing
- response status
- event types

Never log API keys or Authorization headers.

Prompt/body logging should be opt-in.

---

# 61. Telemetry

If telemetry exists, it must be opt-in or clearly disclosed.

Never transmit:

- code contents
- prompt contents
- API keys
- terminal output

without explicit, separate user consent.

Useful anonymous metrics:

- mode use
- tool error rate
- provider error class
- latency
- crash diagnostics

---

# 62. Performance Targets

V1 targets:

| Operation | Target |
|---|---:|
| Extension activation | < 500 ms incremental |
| Open sidebar | < 200 ms perceived |
| Local file read tool overhead | < 50 ms |
| grep start | < 100 ms |
| permission decision | < 5 ms |
| first streamed UI update after provider chunk | < 50 ms |
| session open from local DB | < 200 ms |
| stop/cancel UI acknowledgement | < 150 ms |

Provider latency excluded.

---

# 63. Testing Strategy

## 63.1 Unit tests

Cover:

- permission matching
- mode merging
- prompt composition
- provider chunk parsing
- fragmented tool calls
- context estimation
- compaction selection
- path validation
- shell classification
- checkpoint metadata
- config precedence
- provider compatibility transforms

## 63.2 Provider contract tests

Mock OpenAI-compatible server scenarios:

- normal text
- streaming text
- tool call
- fragmented tool call args
- multiple parallel tools
- reasoning field
- 401
- 429
- 500
- dropped stream
- context overflow
- malformed SSE
- missing `/models`

## 63.3 Freebuff2API smoke test

User-configured integration test:

1. health endpoint
2. list models
3. simple streaming chat
4. read-only tool call
5. multi-turn tool result
6. second tool call
7. final answer

Do not make CI depend on Freebuff availability.

## 63.4 MiniMax smoke test

Optional secret-backed test:

1. fetch models
2. stream response
3. tool call
4. replay complete assistant response
5. tool result
6. final response

## 63.5 VS Code integration tests

Test:

- webview starts
- workspace selection
- @file
- mode switch
- provider switch
- approval action
- apply patch
- diff opens
- checkpoint restore
- diagnostics fetch

---

# 64. Golden Agent Scenarios

The harness is not ready until these pass consistently.

## Scenario A — Ask

Prompt:

```text
How does authentication refresh work in this repo?
```

Expected:

- agent searches/reads
- no writes
- cites relevant files
- no unnecessary shell mutation

## Scenario B — Plan

Prompt:

```text
Plan adding OAuth login.
```

Expected:

- investigates repository
- writes only plan file
- creates actionable implementation sequence
- shows Approve & Implement

## Scenario C — Architect

Prompt:

```text
Design how multi-tenant auth should work.
```

Expected:

- maps architecture
- defines contracts/tradeoffs
- does not edit app code
- optional ADR

## Scenario D — Implement

Prompt:

```text
Implement the approved plan.
```

Expected:

- edits files
- runs tests
- handles failures
- final diff summary

## Scenario E — Debug

Prompt:

```text
Tests intermittently hang after logout. Find and fix it.
```

Expected:

- forms hypotheses
- gathers evidence
- reproduces if possible
- root-cause fix
- regression validation

## Scenario F — Review

Prompt:

```text
Review my uncommitted changes.
```

Expected:

- git diff
- code context
- findings
- no edits

## Scenario G — Custom

Custom "Docs Writer" allows only Markdown edits.

Prompt asks to modify `src/server.ts`.

Expected:

```text
DENIED by mode permission
```

not an attempted edit.

## Scenario H — Provider swap

Run same task using:

- Freebuff endpoint
- MiniMax endpoint
- local OpenAI-compatible test server

The harness/tool behavior should remain unchanged.

---

# 65. Acceptance Criteria for V1

## Agent core

- [ ] Multi-step tool-calling loop works
- [ ] Streaming text works
- [ ] Streaming tool calls work
- [ ] Cancellation works
- [ ] Provider errors normalize correctly
- [ ] Session persists after restart

## Modes

- [ ] Ask
- [ ] Plan
- [ ] Architect
- [ ] Implement
- [ ] Debug
- [ ] Review
- [ ] Orchestrate
- [ ] Custom mode creation
- [ ] Mode switching retains conversation

## Providers

- [ ] OpenAI-compatible adapter
- [ ] Configurable base URL
- [ ] API key secret storage
- [ ] custom headers
- [ ] `/models` discovery
- [ ] manual model entry
- [ ] Freebuff2API works as endpoint
- [ ] MiniMax works directly

## Tools

- [ ] read
- [ ] list/glob
- [ ] grep
- [ ] edit/apply patch
- [ ] write
- [ ] shell
- [ ] Git read
- [ ] diagnostics
- [ ] LSP symbols
- [ ] TODO
- [ ] subagent task

## Safety

- [ ] allow/ask/deny
- [ ] file globs
- [ ] command patterns
- [ ] protected files
- [ ] external path approval
- [ ] hard denies
- [ ] Full Auto cannot override hard deny

## UX

- [ ] sidebar
- [ ] mode picker
- [ ] model picker
- [ ] context mentions
- [ ] tool cards
- [ ] approvals
- [ ] diffs
- [ ] checkpoints/revert
- [ ] session history
- [ ] context meter
- [ ] custom mode editor

---

# 66. Implementation Phases

## Phase 0 — Protocol spike

Goal: prove provider-independent tool loop.

Build CLI-only harness with:

- OpenAI-compatible adapter
- `read_file`
- `grep`
- `apply_patch`
- `run_command`
- allow/ask/deny
- MiniMax endpoint
- Freebuff2API endpoint

Pass one autonomous coding task against each provider.

Do not build polished UI yet.

---

## Phase 1 — Agent Core

Implement:

- event model
- session database
- prompt composer
- mode manager
- tool registry
- permission engine
- OpenAI-compatible provider
- streaming parser
- tool loop
- cancellation
- context manager
- basic compaction
- checkpoint manager

---

## Phase 2 — VS Code MVP

Implement:

- sidebar
- chat stream
- mode selector
- provider/model selector
- file mentions
- tool cards
- approval UI
- diffs
- diagnostics
- terminal execution
- session history

Built-in modes:

- Ask
- Plan
- Architect
- Implement
- Debug
- Review

---

## Phase 3 — Customization

Implement:

- custom mode Markdown
- mode editor
- global/project rules
- skills
- mode-specific model
- granular file/command permission editor
- config import

---

## Phase 4 — Advanced Agents

Implement:

- subagents
- Orchestrate
- parallel read/research
- TODO system
- formal plan approval/handoff
- Review findings
- Debug hypotheses

---

## Phase 5 — Power Features

Implement:

- MCP
- semantic indexing
- directory-specific instructions
- worktree agents
- agent manager
- custom tools/plugins
- OpenAI Responses adapter
- Anthropic-compatible adapter

---

# 67. Suggested V1 Technical Stack

## Extension

- TypeScript
- VS Code Extension API
- WebviewViewProvider
- React or lightweight webview UI framework
- state via simple store/Zustand-like pattern

## Core

- TypeScript
- Zod for runtime schemas
- SQLite (`better-sqlite3` or suitable VS Code-compatible package)
- `execa`/Node child process abstraction
- `ripgrep`
- Git CLI for snapshots and diffs
- JSONC parser for config
- YAML parser for mode frontmatter

## Provider

Prefer a thin in-house OpenAI-compatible HTTP adapter over coupling agent-core to a large provider SDK.

Reason:

- exact SSE control
- easier compatibility quirks
- easier reasoning/tool transcript preservation
- fewer assumptions about "OpenAI compatible"

A provider SDK may still be used internally if it does not constrain protocol handling.

---

# 68. Important Architectural Rule: Do Not Use OpenCode/Cline/Kilo as the Runtime

The goal is to own the harness.

We may borrow proven product patterns, but V1 architecture should not be:

```text
our extension → Cline CLI
```

or:

```text
our extension → OpenCode CLI
```

The product should be:

```text
our extension
    ↓
our agent runtime
    ↓
our provider abstraction
    ↓
any compatible model endpoint
```

This gives control over:

- modes
- prompts
- permissions
- context
- Freebuff integration
- MiniMax integration
- custom providers
- future UX

OpenCode can be used as a behavioral reference and interoperability target, not a dependency.

---

# 69. Freebuff2API Licensing / Product Boundary

The referenced `XxxXTeam/freebuff2api` repository is currently AGPL-3.0.

Therefore:

- do not copy its implementation into a closed-source extension without deliberate license review
- do not make agent-core depend on its internal Python modules
- treat it as an external user-configured OpenAI-compatible service
- communicate that the integration is unofficial and may break if the upstream protocol changes
- keep Freebuff-specific authentication/proxy behavior outside the generic provider layer

The extension can simply let the user configure:

```text
Provider Type: OpenAI Compatible
Base URL: http://127.0.0.1:8000/v1
```

No Freebuff reverse-engineering code is required inside the harness.

---

# 70. Product Differentiators

The product should not merely clone another agent.

The strongest differentiators are:

## 70.1 Separate Plan and Architect

Most tools collapse these.

Our model:

```text
Ask = understand
Plan = execution map
Architect = system design
Implement = build
Debug = diagnose
Review = critique
Orchestrate = delegate
```

This is intuitive and operationally meaningful.

## 70.2 Provider-agnostic by construction

A Freebuff user can switch the exact same session to MiniMax or another provider.

Example:

```text
Plan with MiniMax
Architect with stronger model
Implement with Freebuff
Review with another model
```

## 70.3 Per-mode provider defaults

Example:

```json
{
  "modeDefaults": {
    "ask": "freebuff/google/gemini-3.1-flash-lite-preview",
    "plan": "minimax/MiniMax-M2.7",
    "architect": "minimax/MiniMax-M2.7",
    "implement": "freebuff/openai/gpt-5.6-luna",
    "debug": "minimax/MiniMax-M2.7",
    "review": "freebuff/deepseek/deepseek-v4-pro"
  }
}
```

The provider router resolves this automatically.

## 70.4 Custom mode as real policy

A custom mode can enforce:

> "You may edit only `.md` files and may never execute Bash."

That is much more valuable than a personality prompt.

## 70.5 Explicit plan → implementation contract

User can approve a specific plan and know that Implement mode is executing against it.

---

# 71. Future Feature: Workflow Presets

Modes describe **who the agent is**.

Workflows describe **a sequence of agents**.

Example workflow:

```yaml
name: Feature
steps:
  - mode: plan
  - approval: required
  - mode: architect
    when: architecture_change
  - approval: required
  - mode: implement
  - mode: review
  - mode: implement
    when: review_findings
```

Other presets:

- Bug Fix
- Refactor
- New Feature
- Security Review
- Test Coverage
- Documentation
- Dependency Upgrade

Not required in V1 but the data model should not block it.

---

# 72. Future Feature: Custom Harness Tools

Allow project-defined tools via a controlled plugin API.

Example:

```ts
registerTool({
  name: "query_local_schema",
  description: "...",
  inputSchema: ...,
  execute: ...
})
```

Project tools must require trust/approval before loading executable code.

MCP is the preferred external integration format; local plugins are optional.

---

# 73. Future Feature: Agent Hooks

Potential lifecycle hooks:

```text
session_start
before_model
after_model
before_tool
after_tool
before_edit
after_edit
before_command
after_command
turn_complete
session_complete
```

Hooks are executable and therefore disabled in untrusted workspaces.

---

# 74. Data Types

## 74.1 Tool call

```ts
interface ToolCallRecord {
  id: string
  sessionId: string
  stepId: string
  toolName: string
  rawArguments: string
  parsedArguments?: unknown
  permissionDecision?: "allow" | "ask" | "deny"
  status:
    | "streaming"
    | "awaiting_approval"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "cancelled"
  startedAt?: number
  endedAt?: number
}
```

## 74.2 Message

```ts
interface AgentMessage {
  id: string
  sessionId: string
  role: "system" | "user" | "assistant" | "tool"
  content: ContentPart[]
  createdAt: number
  mode?: string
  providerId?: string
  modelId?: string
}
```

## 74.3 Content parts

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning_summary"; text: string }
  | { type: "context_ref"; ref: string }
  | { type: "tool_call"; callId: string }
  | { type: "tool_result"; resultId: string }
  | { type: "diff"; diffId: string }
  | { type: "plan"; planId: string }
  | { type: "approval"; approvalId: string }
```

---

# 75. Event Bus

Core emits events to any UI.

```ts
type AgentEvent =
  | SessionStarted
  | ModeChanged
  | ModelChanged
  | StepStarted
  | TextDelta
  | ReasoningDelta
  | ToolCallStarted
  | ToolApprovalRequired
  | ToolStarted
  | ToolOutputDelta
  | ToolCompleted
  | FilesChanged
  | CheckpointCreated
  | TodoChanged
  | SubagentStarted
  | SubagentCompleted
  | ContextCompacted
  | UsageUpdated
  | StepCompleted
  | SessionCompleted
  | AgentError
```

VS Code UI must consume this event model rather than provider events directly.

---

# 76. API Between VS Code UI and Core

Even if bundled in one extension, keep an explicit typed interface.

Commands:

```ts
startSession()
sendMessage()
cancelRun()
changeMode()
changeModel()
approveTool()
denyTool()
addContext()
removeContext()
restoreCheckpoint()
createMode()
updateMode()
deleteMode()
listSessions()
openSession()
compactSession()
```

This makes a future CLI or desktop client possible without rewriting the agent.

---

# 77. Optional CLI

The agent core should eventually support:

```bash
agent
agent --mode plan
agent --mode implement "fix the tests"
agent --provider minimax --model MiniMax-M2.7
agent --json
```

This is not required for the VS Code MVP, but the core should not depend on Webview APIs.

---

# 78. Definition of Done for First Public Alpha

A developer can:

1. install the extension
2. add either:
   - Freebuff2API base URL, or
   - MiniMax API key/base URL, or
   - another OpenAI-compatible endpoint
3. open a repository
4. choose Plan
5. ask for a feature
6. watch the agent inspect the repo
7. receive a plan
8. click Approve & Implement
9. watch Implement edit files
10. approve sensitive actions
11. see tests run
12. inspect diffs
13. revert the AI changes
14. switch to Review
15. receive review findings
16. create a custom Markdown-only Documentation mode
17. verify that mode cannot modify source files

If this flow is reliable, the alpha is successful.

---

# 79. Recommended Build Order for an Autonomous Coding Agent

If handing this spec to Codex/Claude Code/etc., instruct it to build in this exact order:

### Milestone 1 — Core contracts
- schemas
- event types
- provider interface
- tool interface
- permission types
- mode types

### Milestone 2 — OpenAI-compatible transport
- SSE parser
- text streaming
- tool-call accumulation
- full assistant/tool transcript handling
- errors
- cancellation

### Milestone 3 — Local tools
- read
- grep
- glob
- patch
- shell
- Git read
- diagnostics

### Milestone 4 — Agent loop
- tool calling
- approval state
- step limits
- retry logic
- session persistence

### Milestone 5 — Modes
- Ask
- Plan
- Architect
- Implement
- Debug
- Review
- mode switching

### Milestone 6 — VS Code shell
- activity view
- chat
- stream
- tool cards
- approvals
- mode/model selectors

### Milestone 7 — Plans and checkpoints
- plan artifact
- approval
- plan → implement
- snapshot Git
- diff/revert

### Milestone 8 — Custom modes
- Markdown/YAML
- editor
- permission rules
- per-mode model

### Milestone 9 — Subagents
- task tool
- Explore
- General
- Orchestrate

### Milestone 10 — Hardening
- compaction
- provider compatibility
- MiniMax integration tests
- Freebuff2API integration tests
- security validation
- performance

Do not start semantic indexing, worktrees, plugin marketplace, or cloud features until the basic autonomous edit/test/revise loop is reliable.

---

# 80. Final Product Principle

The system should be designed so this statement remains true:

> **The harness is the product; the model is a replaceable dependency.**

Freebuff, MiniMax, OpenAI-compatible servers, local models, and future providers should all operate through the same:

- modes
- tools
- permission engine
- context system
- planning system
- session state
- VS Code UI

That is the architecture that makes the extension durable instead of becoming a Freebuff-specific wrapper.

---

# 81. Research References

The architecture above is informed by current public behavior/documentation from:

1. Kilo Code — custom agents/modes, per-agent prompts/models/permissions/step limits, built-in Code/Ask/Plan/Debug agents, subagents, snapshots, context compaction, semantic indexing, and MCP.
   - https://kilo.ai/docs/customize/custom-modes
   - https://kilo.ai/docs/code-with-ai/agents/using-agents
   - https://kilo.ai/docs/customize/custom-subagents
   - https://kilo.ai/docs/code-with-ai/features/checkpoints
   - https://kilo.ai/docs/customize/context/context-condensing
   - https://kilo.ai/docs/customize/context/codebase-indexing

2. Cline — Plan/Act separation, checkpoints, context mentions, tool permissions, and agent SDK concepts.
   - https://docs.cline.bot/core-workflows/plan-and-act
   - https://docs.cline.bot/core-workflows/checkpoints
   - https://docs.cline.bot/core-workflows/working-with-files
   - https://docs.cline.bot/sdk/guides/permission-handling

3. OpenCode — primary/subagents, custom agent definitions, allow/ask/deny permissions, custom OpenAI-compatible providers, and model/provider separation.
   - https://opencode.ai/docs/agents/
   - https://opencode.ai/docs/permissions/
   - https://opencode.ai/docs/providers

4. MiniMax — official OpenAI-compatible API, streaming, tool use, and multi-turn reasoning/tool-call continuity requirements.
   - https://platform.minimax.io/docs/api-reference/text-openai-api
   - https://platform.minimax.io/docs/api-reference/text-ai-sdk
   - https://platform.minimax.io/docs/token-plan/other-tools

5. XxxXTeam/freebuff2api — OpenAI-compatible Freebuff proxy surface and current forwarding/streaming/tool-call handling.
   - https://github.com/XxxXTeam/freebuff2api
   - https://github.com/XxxXTeam/freebuff2api/blob/main/freebuff2api/openai_compat.py

---

# 82. Implementation Instruction to the Coding Agent

Treat this document as the source-of-truth product and architecture specification.

When implementation details conflict with the principles in this document:

1. preserve provider independence
2. preserve deterministic tool permissions
3. keep the agent core independent from VS Code UI
4. keep Freebuff-specific behavior outside agent-core
5. make modes first-class executable profiles
6. preserve session/tool state durably
7. prefer a small reliable tool loop over broad unfinished features

For unknown repository architecture, inspect the existing code first and adapt this design to the project instead of forcing a parallel framework.

Before major implementation, produce:

- current-repo architecture map
- delta against this specification
- milestone plan
- proposed file/module changes

Then implement milestone by milestone with tests.

---

# 83. Implementation Addendum (Normative)

This addendum resolves implementation ambiguities in this specification. Where it
conflicts with an earlier example, this section is authoritative.

## 83.1 Release scope and capability gating

The first reliable VS Code release is a vertical slice consisting of:

- sidebar/webview streaming chat
- the OpenAI-compatible adapter
- Ask, Plan, and Implement modes
- `read_file`, `glob`, `grep`, `apply_patch`, `run_command`, Git read tools, and diagnostics
- deterministic allow/ask/deny permissions
- workspace trust, protected paths, SecretStorage, approvals, diffs, and safe checkpoints
- durable sessions and provider contract tests

Debug, Review findings, Custom Mode, Orchestrate, subagents, MCP, semantic search,
worktrees, and executable custom tools are post-MVP unless a release checklist
explicitly promotes them.

A tool is advertised only when it is implemented and registered, enabled by the
active mode, supported by the selected model/provider capability registry, and
permitted by workspace trust and the permission engine. Unsupported tools are
omitted from the provider request and rejected with a structured error if called
anyway.

## 83.2 Permission and delegation authority

Permission evaluation is deterministic. Evaluate in this order:

1. hard safety rules
2. explicit user/session denies
3. highest policy layer
4. most-specific matching pattern
5. later declaration when specificity is tied

`deny` wins ties. Paths are workspace-relative canonical paths; commands are parsed
before matching. Raw string-prefix matching is not sufficient. Every approval stores
workspace identity, mode, tool, normalized target, policy revision, scope, expiry,
and workspace-trust state. Changing mode, trust, policy revision, or workspace
invalidates approvals outside their declared scope.

Every mode must declare `allowedAgents` and `delegationEffects`:

```ts
type DelegationEffects = "read-only" | "same-as-parent" | "write"
```

A parent can never delegate greater authority than it possesses. Ask, Plan,
Architect, and Review may spawn only read-only Explore/Research/Test agents. Only
Implement and Orchestrate may spawn write-capable agents, and each write-capable
spawn requires an approval whose scope covers the delegated task. Orchestrate is
read-only itself by default; delegation is its mutation path.

## 83.3 Provider replay contract

For each provider response, persist exactly one assistant message containing its
text, tool calls, finish reason, and opaque provider metadata. Append one tool-role
result per tool call, then send the resulting history. Do not append a second
assistant message for the same response.

Provider events may include an opaque provider frame:

```ts
type ProviderFrame = {
  providerId: string
  modelId: string
  sequence: number
  payload: unknown
}
```

Agent-core does not interpret provider frames, but the adapter must retain and replay
them whenever the provider requires reasoning or tool-call continuity. Provider
frames are excluded from normalized prompt text, UI rendering, logs, and exports
unless explicitly requested by the user.

## 83.4 Trust, mutation, and revert safety

Workspace trust is continuously enforced, not checked only at session start. When
trust is lost, cancel running commands, revoke outstanding approvals, block queued
writes, and unload project MCP servers, hooks, and executable skills.

Filesystem mutations must be atomic and must revalidate the canonical path,
symlink status, policy, and file precondition immediately before commit. Symlink
traversal is denied by default. Shell execution uses a process group, a bounded
timeout/output budget, a sanitized environment, and an explicit network policy.

Revert must not silently overwrite edits made after the agent checkpoint. If the
current file differs from the recorded post-edit snapshot, offer a three-way merge
or refuse the revert. Snapshot creation and restoration are atomic and record
untracked files, renames, binary files, and exclusions explicitly.

## 83.5 Fixed model policies

Modes may pin a model for user-required specialization (for example, a Luna-only
mode). Add:

```ts
type ModelPolicy = "fixed" | "preferred" | "user-selectable"
```

`fixed` rejects session and turn model overrides and reports the reason in the UI;
`preferred` falls back only when unavailable; `user-selectable` follows the normal
turn > session > mode > global precedence. A model selector must visibly indicate
when the active mode is fixed.

## 83.6 Token consumption contract

Design tokens are compiled to CSS custom properties with the `--forge-` prefix.
The webview uses VS Code theme variables as the first source of truth and Forge
semantic tokens as fallbacks. The token build must emit dark, light, and
high-contrast mappings and honor `prefers-reduced-motion`.

The extension must not assume that Inter is installed: UI typography falls back to
`--vscode-font-family`, and code typography falls back to
`--vscode-editor-font-family`. Semantic tokens must be used instead of hardcoded
component colors. Mode and status meaning must be conveyed by text/icon as well as
color. The token build validates the declared Design Tokens format in CI and emits
a generated CSS artifact consumed by the webview.
