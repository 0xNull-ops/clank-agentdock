# Goal

Evolve Forge's existing bounded subagent runtime into a configurable, observable,
cross-provider orchestration system. A primary agent must be able to delegate a
bounded task to a user-defined subagent whose provider profile and model differ
from the primary agent, while the host retains control of routing, credentials,
permissions, budgets, persistence, and UI visibility.

# Current State

Forge already has the difficult safety and lifecycle primitives:

- a provider-neutral agent loop and `LLMProvider` interface;
- a model-callable `task` tool;
- a bounded subagent scheduler with concurrency, total-run, and depth limits;
- authority inheritance and explicit approval for write-capable children;
- cancellation propagation and serialized child writers;
- isolated child prompts that do not copy the parent transcript;
- durable subagent lifecycle/result records with parent-run identifiers; and
- live/restored subagent activity cards in the VS Code webview.

The current implementation has four constraints:

1. The six subagent slugs and their definitions are compiled into agent-core.
2. The `task` tool advertises a fixed enum instead of the effective user-defined
   allowlist.
3. The extension host constructs one provider for the primary run and passes that
   same provider instance to every child. A child can request another model name,
   but cannot select another configured provider profile.
4. The core execution context supports nested spawning, but the VS Code executor
   disables delegation for every child and does not expose that spawn function to
   a child model.

Current activity cards communicate lifecycle and final summaries, but child tool
events are flat and do not form an expandable delegation tree.

# Scope

- Resolve built-in and custom subagents through a provider-neutral catalog.
- Treat existing custom modes with `type: subagent` or `type: all` as executable
  subagent definitions.
- Support project and global agent definitions through the existing Markdown and
  YAML-frontmatter registry and editor.
- Route each child through a configured OpenAI-compatible provider profile.
- Allow a definition to fix or prefer a provider profile and model.
- Permit task-level provider/model overrides only when the selected definition
  explicitly allows them and only within host-resolved configured profiles.
- Dynamically advertise only subagents allowed for the active parent.
- Enable nested delegation for definitions that explicitly allow it.
- Render concise live child activity with expandable details and final output.
- Persist the resolved route and enough hierarchy/lifecycle data to restore the
  delegation tree.
- Preserve existing permission, approval, checkpoint, cancellation, and budget
  behavior.

# Non-Goals

- Native Anthropic, Gemini, Bedrock, or other new transport adapters.
- Allowing a model to submit base URLs, credentials, headers, or arbitrary
  provider identifiers.
- Cloud orchestration or remote Forge workers.
- Concurrent write agents in the same workspace.
- Git worktree creation, merging, or conflict resolution.
- Sharing the full parent transcript with children.
- Displaying hidden chain-of-thought or raw provider-private frames.
- Durable storage of an unlimited child transcript or unbounded tool output.
- Workflow DAG editors, reusable workflow templates, or a marketplace.

# Proposed Design

## Subagent catalog

Introduce one deep catalog module as the source of truth for executable subagents.
It combines protected built-ins with the existing resolved custom-mode snapshot and
provides a small interface for resolving a slug and listing the agents available to
a particular parent.

The catalog owns:

- canonical slug validation;
- adaptation from `ModeDefinition` to an executable subagent definition;
- built-in/global/project precedence;
- filtering by `type`, parent `allowedAgents`, and delegation policy;
- maximum authority validation;
- provider/model routing declarations; and
- diagnostics for invalid, missing, disabled, or shadowed definitions.

Agent-core must stop treating subagent slugs as a closed TypeScript union. Slugs are
bounded canonical strings. Built-in slugs may remain a convenience type, but runtime
validation must use the injected catalog rather than a global set.

The `task` tool is generated from the catalog's effective allowlist. Its model-facing
description includes each available slug and bounded description. A disallowed
agent is omitted from the advertised tool and is still rejected deterministically
if a forged call reaches execution.

## Execution routing

Introduce a host-owned execution router. Given an authorized subagent definition,
the parent route, and an optional permitted task override, it returns a resolved
execution containing:

- provider profile identity;
- selected model identity;
- an instantiated `LLMProvider` adapter;
- capability/model-resolution inputs; and
- safe display metadata for events and persistence.

Credentials remain inside the provider profile store and execution router. Neither
the task input, agent prompt, webview protocol, trace events, nor persisted safe
results contain credentials, secret headers, or raw provider configuration.

Route precedence is:

1. an explicit task override when the definition enables that override;
2. the subagent definition's fixed or preferred route;
3. the parent route when inheritance is allowed; and
4. the active profile and configured fallback model.

A provider and model are resolved as an atomic route. A model must be checked
against the selected profile's discovered/manual availability, rather than against
the parent's profile. Missing profiles, unavailable fixed models, and prohibited
overrides return structured routing errors before a scheduler slot is consumed.

The first implementation uses the existing OpenAI-compatible adapter for every
profile. Later provider adapters plug into the execution router without changing
the catalog, scheduler, task tool, or UI protocol.

## Nested delegation

The VS Code executor must accept the complete subagent execution context. When a
child definition permits delegation, its tools include a child `task` tool backed
by the scheduler context's `spawn` function.

Every nested request inherits:

- parent run identity and depth;
- workspace identity;
- cancellation signal;
- effective authority ceiling;
- remaining total/concurrency budget; and
- parent permission constraints.

The child's allowlist is resolved from its own definition. A child without explicit
delegation permission receives no `task` tool. Route inheritance does not imply
authority inheritance beyond the existing least-authority rules.

## Observability

Add a sanitized subagent activity event envelope with stable run identity, parent
run identity, depth, agent slug, provider/profile label, model label, lifecycle
state, timestamps, usage, and an optional bounded current-action summary.

Child agent events are projected into operational activity rather than exposing raw
reasoning. Useful live events include:

- queued and started;
- provider route resolved;
- ordinary assistant progress text, bounded for display;
- tool started, output preview, and completed;
- usage updated;
- approval requested;
- child spawned;
- completed, failed, rejected, and cancelled.

The webview presents a tree ordered by parent/child relationship. A collapsed card
shows agent, provider/model, state, elapsed time, and current action. Expanding it
shows bounded progress entries, tool summaries, usage, inspected/changed files,
follow-ups, and the complete retained final result. No raw provider frame or hidden
reasoning event crosses the host/webview seam.

Lifecycle and final results remain durable. Persist only bounded trace summaries
needed for restoration; do not turn the session database into an unlimited log.

## Configuration experience

Extend the existing mode/agent management surface rather than create a second
configuration format. The structured editor should support:

- primary, subagent, or all execution type;
- description and instructions;
- provider profile;
- model and fixed/preferred/inherited policy;
- whether task-level route overrides are allowed;
- authority ceiling;
- tools and permission rules;
- whether delegation is allowed; and
- allowed child agents.

Raw Markdown remains the advanced editing path. Provider selectors contain only
configured profiles, and deleting a referenced profile leaves the definition
diagnosable but non-runnable until repaired.

# Data and Interface Changes

- Generalize subagent identity fields from a closed built-in union to a bounded
  canonical slug.
- Add an injected catalog to the scheduler or its request-validation seam.
- Add route policy and route override policy to executable definitions.
- Add provider profile override to task input only when at least one advertised
  definition permits it. Validate it against that definition at execution time.
- Carry the resolved provider profile and model on the accepted task/run identity,
  rather than inferring them later from the parent configuration.
- Add parent run identity and safe route/activity fields to the UI activity model.
- Add bounded activity-detail messages or snapshots to the host/webview protocol.
- Reuse existing durable provider/model columns; migrate only if additional route
  policy or bounded trace-detail columns are required.
- Preserve safe export behavior: provider-private replay frames and credentials are
  excluded.

# Incremental Commit Plan

Each commit must leave tests, type-checking, and the extension build green.

1. **Characterize existing provider inheritance.** Add a bridge-level test seam or
   extracted pure test demonstrating that children currently inherit the parent's
   provider and model configuration. Make no production behavior change.

2. **Generalize subagent identities.** Change public task, result, event, and
   persistence-facing types to use bounded canonical slugs while retaining aliases
   for built-in names. Keep the built-in lookup as the only catalog temporarily.

3. **Extract the subagent catalog.** Move built-in resolution and effective
   allowlist logic behind an injected catalog interface. Supply a default built-in
   catalog so current callers behave identically.

4. **Adapt custom mode snapshots into the catalog.** Include valid `subagent` and
   `all` entries, apply current source precedence, and report invalid or missing
   definitions without destabilizing other agents.

5. **Generate the task contract dynamically.** Build the model-facing agent list
   and description from the effective catalog allowlist. Preserve execution-time
   validation for forged or stale calls.

6. **Extract provider construction from the runtime bridge.** Introduce a resolver
   that can construct the current primary provider from a profile. Route the
   existing primary path through it without changing behavior.

7. **Resolve child routes independently.** Select a child provider profile and
   model from its definition, instantiate the corresponding adapter, and pass the
   resolved route into child execution. Initially allow only configured
   OpenAI-compatible profiles.

8. **Enforce route override policy.** Accept optional provider/model overrides only
   for definitions that explicitly permit them. Reject unknown profiles,
   unavailable models, fixed-policy conflicts, and forged overrides before
   scheduling.

9. **Persist and restore actual child routes.** Record the resolved child provider
   and model rather than the parent's defaults. Add migration/reopen and safe-export
   assertions.

10. **Enable controlled nested delegation.** Pass the scheduler execution context
    into child execution and advertise a nested task tool only for definitions that
    allow it. Preserve authority intersection, global budgets, write approval,
    writer serialization, and cancellation propagation.

11. **Introduce sanitized child activity events.** Project child agent-loop events
    into bounded operational updates with hierarchy and route metadata. Do not send
    reasoning deltas or provider-private frames.

12. **Render the expandable activity tree.** Replace flat subagent cards with
    parent-aware cards showing concise live status and expandable tool/progress/final
    details. Retain restored-session behavior and accessibility semantics.

13. **Extend the structured agent editor.** Add provider, model policy, route
    override, delegation, and allowed-child controls backed by the existing
    Markdown representation.

14. **Add integration and regression coverage.** Cover cross-profile execution,
    dynamic allowlists, nested cancellation, authority failures, missing profiles,
    restore, safe export, and the original same-provider behavior.

15. **Update architecture and product documentation.** Describe the catalog and
    execution-router seams, the operational trace contract, configuration examples,
    security invariants, and the later native-adapter extension point.

# Testing

Tests should exercise observable behavior through the catalog, scheduler, execution
router, persistence, and UI protocol interfaces. They should not assert internal
maps, queue implementation details, or specific provider-construction mechanics.

## Agent-core

- built-ins remain available through the default catalog;
- custom canonical slugs resolve and participate in allowlists;
- project/global precedence matches the existing mode registry;
- disabled, unknown, or disallowed agents fail before execution;
- authority and nesting rules remain unchanged; and
- task schemas contain only currently allowed agents.

## Extension host

- parent profile A can run a child on configured profile B;
- child fixed/preferred/inherited model resolution is profile-correct;
- prohibited overrides and deleted profiles fail closed;
- no credential or secret header enters task arguments or UI events;
- nested child spawning uses the same scheduler budgets and cancellation tree; and
- write children retain approval, policy intersection, checkpoint, and serialization
  behavior.

## Storage

- the resolved provider/model and parent run survive reopen;
- interrupted queued/running descendants recover as cancelled;
- session deletion cascades child records;
- bounded activity/result fields reject oversized payloads; and
- safe exports exclude secrets and provider-private frames.

## Webview

- concurrent root children render independently;
- nested children attach beneath the correct parent even when events arrive out of
  order;
- concise cards update in place;
- expanded details show bounded progress and full retained final output;
- cancellation and failure are distinguishable; and
- restored trees render without requiring live runtime objects.

# Validation

- Run the complete repository test suite, type-check, package build, and extension
  bundle smoke check after every incremental commit.
- Manually configure two OpenAI-compatible profiles with distinct models.
- Run a primary Orchestrate session on profile A that delegates parallel read-only
  work to agents pinned to profiles A and B.
- Confirm both provider endpoints receive only their respective child requests.
- Expand child cards during execution and after completion.
- Cancel the parent while one child is running and another is queued.
- Restart the extension host and confirm the completed/cancelled tree restores with
  accurate provider/model labels.
- Attempt forged agent, provider, model, authority, and nesting inputs and confirm
  they fail without consuming an execution slot.

# Risks and Edge Cases

- **Stale definitions during a run:** capture an immutable catalog snapshot at turn
  start. Reloaded definitions apply to the next turn.
- **Provider profile deletion during a run:** resolved running providers may finish;
  queued children must revalidate the route immediately before starting.
- **Model-name collisions across profiles:** always identify models by the atomic
  provider-profile/model pair.
- **Out-of-order UI events:** upsert activities by stable run ID and attach orphans
  when their parent arrives.
- **Nested write deadlocks:** retain one workspace-level serialized writer lane and
  never hold a scheduler slot while waiting for a prior writer lock if that would
  prevent its ancestor from settling.
- **Prompt growth:** advertise bounded descriptions and selected context only.
- **Provider rate limits:** concurrency limits remain global initially; per-profile
  limits can be added later behind the execution router.
- **Cost surprises:** show provider/model before start and in approval cards; later
  budgets can be added without changing task identity.

# Rollback

The catalog ships with a built-in-only adapter and the execution router preserves
parent-route inheritance. A feature flag can keep custom and cross-profile routing
disabled while retaining the extracted modules. Existing persisted runs remain
readable because provider/model fields already exist and new activity details are
optional. Rolling back the UI tree can fall back to current flat cards using the
same lifecycle events.

# Acceptance Criteria

- A primary model can choose only from the effective configured subagent allowlist.
- Users can define project/global subagents through the existing Markdown format.
- A custom subagent can run on a different configured provider profile and model
  from its parent.
- The host, not the model, resolves endpoints and credentials.
- Route overrides work only when explicitly enabled by the selected definition.
- Authorized subagents may spawn authorized descendants within shared depth,
  concurrency, total-run, authority, and cancellation limits.
- The UI shows a concise live delegation tree and expandable retained details.
- Restored sessions display accurate hierarchy, provider/model, state, and result.
- Write delegation remains explicitly approved, checkpointed, policy-intersected,
  and serialized.
- Existing single-provider built-in subagent flows remain compatible.
- All automated checks and the two-profile manual validation pass.

# Decisions

- V1 routes only to configured OpenAI-compatible provider profiles.
- Native and proxy-specific adapters are future execution-router adapters.
- Existing `.agent/agents/*.md` and global agent Markdown remain the configuration
  source of truth.
- Activity is concise by default with expandable bounded details and full retained
  final output.
- Agents own their default provider/model routes.
- Task-level route overrides are opt-in per agent and restricted to configured
  profiles and available models.
- Manager-style delegation remains the primary pattern: the root agent incorporates
  child results into the final user-facing response.

# Related Plans and Delivery Order

- `skill-discovery-and-selection.md` introduces the skill catalog consumed by both
  primary and custom subagent definitions. Its catalog work can land before or in
  parallel with the subagent catalog extraction.
- `provider-presets-and-vibeproxy.md` adds safe provider presets, health status, and
  authoritative model discovery. Its provider resolver should land before the
  cross-profile child-routing commits in this plan.
- Recommended order is: skill catalog foundation, provider resolver/presets,
  subagent catalog, cross-profile execution, nested delegation, then hierarchical
  observability and configuration polish.
