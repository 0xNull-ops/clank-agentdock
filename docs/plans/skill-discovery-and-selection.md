# Goal

Make installed skills automatically discoverable by Clank, expose them through a
searchable multi-select dropdown, and load their full instructions only when a
user, mode, or model explicitly activates them.

# Current State

Modes already contain `skills` and `skillsMode` fields. At run start the extension
looks up only those named skills in a few fixed locations and copies their complete
Markdown into the system prompt. Project, compatibility, and one global directory
are supported by name, but there is no catalog, metadata parsing, discovery,
diagnostics, file watching, user selection, or `load_skill` tool.

The current loader also performs path probing inside the runtime bridge, which
mixes discovery, precedence, file access, prompt budgeting, and execution setup.
The webview protocol has no skill state and the composer has no skill control.

# Scope

- Discover skill definitions from project, Clank-global, and known installed-skill
  roots.
- Parse bounded `name` and `description` metadata from `SKILL.md` frontmatter.
- Resolve duplicate names with deterministic precedence and diagnostics.
- Expose a safe skill catalog snapshot to the extension host and webview.
- Add a searchable multi-select dropdown to the composer.
- Show selected skills as removable chips and retain selection per session.
- Load full skill text when selected by the user or required by the active mode.
- Add a guarded `load_skill` tool so a model can activate an advertised skill on
  demand without receiving every full skill at session start.
- Refresh the catalog when skill files are added, changed, or removed.
- Apply the same catalog and activation rules to primary agents and subagents.
- Preserve prompt budgets, workspace trust, symlink containment, and safe UI data.

# Non-Goals

- Installing, updating, downloading, or publishing skills.
- Running arbitrary scripts bundled with a skill.
- A skill marketplace or remote registry.
- Automatically enabling every discovered skill.
- Sending absolute paths or complete skill bodies to the webview.
- Treating repository-provided skills as higher priority than system, mode, or user
  instructions.
- Compatibility with every third-party skill format in the first milestone.

# Proposed Changes

## Skill catalog module

Create a deep host-owned skill catalog with a small interface for refreshing,
listing safe metadata, resolving one canonical skill, and loading its bounded body.
The catalog hides filesystem enumeration, frontmatter parsing, precedence,
containment checks, diagnostics, and caching.

Each resolved skill contains a canonical ID, display name, bounded description,
scope, source kind, availability state, and host-only source URI. The webview sees
only the ID, name, description, scope, and diagnostic state.

Initial discovery roots are:

1. project `.agent/skills/<skill>/SKILL.md` and the existing single-file form;
2. project `.agents/skills/<skill>/SKILL.md` as a compatibility source;
3. Clank global `~/.config/freebuff-agent-harness/skills/<skill>/SKILL.md`;
4. installed `~/.agents/skills/<skill>/SKILL.md`;
5. installed `~/.codex/skills/<skill>/SKILL.md`; and
6. optional user-configured additional roots, disabled by default until explicitly
   added.

Precedence is project native, project compatibility, Clank global, `.agents`, then
`.codex`. Higher-precedence definitions shadow lower ones with a visible warning.
Canonical identity comes from validated frontmatter `name`, falling back to the
directory name only when it is a valid slug.

Project skills are unavailable while workspace trust is absent. All sources have
file-count, file-size, metadata, and aggregate prompt limits. Symlinks must resolve
inside their declared root. A catalog refresh produces an immutable snapshot so a
turn is not affected by mid-run filesystem changes.

## Activation model

Separate discovery from activation:

- **Available:** metadata is advertised in a bounded catalog summary.
- **Selected:** the user chose the skill in the composer; its full text is loaded
  for the turn/session after host validation.
- **Mandatory:** the active mode or subagent definition declares the skill; its
  full text is loaded automatically.
- **On demand:** the model calls `load_skill` using an advertised canonical ID.

Mode-mandatory and user-selected skills are deduplicated. Project precedence is
resolved before selection, so a saved selection follows the effective definition
and cannot forge a host path.

Only name and description are placed in the initial available-skills summary. Full
text is bounded and loaded for active skills. The prompt labels skill instructions
with their source and precedence while making clear that they cannot override
higher-priority safety, permission, mode, or user instructions.

## Model tool

Add a read-only, low-risk `load_skill` tool. Its schema advertises only canonical
IDs available to the active run. Execution revalidates the ID against the immutable
turn snapshot and returns one bounded skill body. Unknown, shadowed, untrusted, or
oversized skills fail with structured errors.

The tool does not execute referenced scripts, recursively load arbitrary files, or
accept a path. Supporting auxiliary skill resources can be designed later through
an explicit resource interface.

## Composer and session experience

Add a Skills dropdown near the mode/model controls or context controls. It supports
search, keyboard navigation, multi-selection, scope labels, descriptions, and a
refresh action. Selected skills appear as removable chips in the composer.

The dropdown distinguishes mandatory mode skills from user selections. Mandatory
skills are visible but cannot be removed for that turn. Missing saved skills show a
warning chip and are omitted from execution until restored or removed.

Selections are stored per session and included by canonical ID in `sendMessage`.
The host treats webview IDs as untrusted and resolves them against the current
catalog snapshot. Session duplication copies selections; a new session starts with
no user-selected skills while still inheriting mode-mandatory skills.

## Refresh and diagnostics

Use scoped file watchers for project roots and bounded refreshes for user roots.
Serialize refresh operations and replace the complete catalog snapshot atomically.
Post a `skillsChanged` event containing safe metadata. Diagnostics cover malformed
frontmatter, invalid IDs, duplicates, shadowing, oversized files, inaccessible
sources, trust failures, and symlink escapes.

# Files / Components

- A new skill catalog module in the extension runtime, with pure parsing and
  precedence helpers placed in agent-core only if they are reusable outside VS
  Code.
- Runtime bridge prompt construction and tool registration.
- Shared host/webview protocol and session persistence coordination.
- Composer and settings webview rendering, state, and styles.
- Custom-mode/agent structured editor skill selector.
- Existing prompt composition types and tests.
- Architecture and extension documentation.

# Data / API Changes

- Add safe `SkillOption` and `SkillDiagnostic` protocol records.
- Include available, selected, and mandatory skill IDs in initialization and session
  restore messages.
- Include selected canonical IDs in the send-message command.
- Add `skillsChanged` and optional selection-update messages.
- Persist selected skill IDs as bounded session preferences, not skill bodies or
  absolute paths.
- Extend prompt composition with available-skill metadata separately from active
  skill instruction sources.
- Register `load_skill` only when at least one on-demand skill is available and the
  active mode permits it.

# Step-by-Step Implementation

1. Characterize current named-skill loading and prompt-budget behavior with focused
   tests before changing production code.
2. Add pure bounded frontmatter parsing and canonical skill metadata types.
3. Implement catalog discovery for the existing project and Clank-global roots.
4. Add `.agents` and `.codex` installed-skill adapters and deterministic precedence.
5. Enforce workspace trust, symlink containment, file bounds, and atomic snapshots.
6. Replace runtime-bridge path probing with catalog resolution while keeping
   mode-declared skill behavior unchanged.
7. Add available-skill metadata to prompt composition without loading full bodies.
8. Add the guarded `load_skill` tool and execution-time snapshot validation.
9. Extend session state and the host/webview protocol with safe skill options and
   selected IDs.
10. Add the searchable multi-select dropdown and selection chips.
11. Persist, restore, duplicate, and clear per-session skill selections.
12. Add watchers, serialized refresh, diagnostics, and missing-selection handling.
13. Use the same turn snapshot and active skills when constructing subagent prompts.
14. Extend the custom agent/mode editor with discovered skill selection.
15. Add integration, webview, restore, security, and regression coverage.
16. Update architecture and user documentation.

# Tests

- Discovery returns valid project/global/installed skills with correct precedence.
- Invalid frontmatter, duplicate IDs, symlink escapes, and oversized definitions
  produce bounded diagnostics without preventing unrelated skills from loading.
- Untrusted workspaces do not expose or load project skills.
- Initial prompts contain bounded metadata but not every full skill body.
- User-selected and mode-mandatory skills load once with deterministic ordering.
- `load_skill` accepts only advertised canonical IDs and never accepts filesystem
  paths.
- Forged webview selections are rejected host-side.
- Session restore and duplication preserve selected IDs without persisting bodies.
- Removed skills render a warning and do not crash a run.
- Subagents receive only their effective selected/mandatory skills.
- The dropdown is keyboard accessible, searchable, and updates without remounting
  the chat transcript.

# Validation

- Place distinct test skills in every supported root and confirm scope/precedence
  labels in the dropdown.
- Select multiple skills, send a turn, and inspect the provider request to confirm
  only selected/mandatory full bodies are present.
- Ask the model to use an advertised but unselected skill and confirm `load_skill`
  loads it through a tool call.
- Remove or corrupt a selected skill during a session and confirm an actionable
  diagnostic on the next turn.
- Toggle workspace trust and confirm project skills unload/reload safely.
- Restart the extension and confirm session selection and catalog state restore.
- Run the complete repository check and extension bundle smoke test.

# Risks / Edge Cases

- Large installed catalogs can inflate prompt metadata; cap advertised entries and
  characters, prioritize selected/mode-relevant skills, and expose the full list
  only in the UI.
- Different ecosystems may use incompatible frontmatter; treat unsupported fields
  as diagnostics and keep the core metadata contract deliberately small.
- Duplicate skill names can change meaning after a new project skill appears; show
  source scope and shadowing clearly and resolve a stable turn snapshot.
- File watchers may emit bursts; debounce and serialize refreshes.
- Skill content may contain hostile instructions; it remains below system safety,
  permission, mode, and user instructions and never grants tools or authority.
- Installed skills may reference assets or scripts; v1 loads only `SKILL.md` text.

# Rollback

Keep an adapter that resolves only mode-declared skills through the catalog. The
dropdown, installed roots, and `load_skill` tool can each be feature-gated while the
existing `skills` field continues working. Persisted selections are optional and
can be ignored by an older runtime without affecting sessions or messages.

# Acceptance Criteria

- Installed skills from supported roots appear automatically in a searchable
  dropdown without manual name entry.
- Users can select several skills and see removable chips before sending.
- Modes and subagents can declare mandatory skills from the same catalog.
- The initial prompt contains only bounded available-skill metadata plus full text
  for active skills.
- Models can load an advertised skill on demand through a guarded tool.
- Absolute paths and full inactive skill bodies never reach the webview.
- Trust, containment, precedence, bounds, and forged-ID checks fail closed.
- Selection restores per session and works identically for primary and subagent
  runs.
- Existing named mode skills remain compatible.
