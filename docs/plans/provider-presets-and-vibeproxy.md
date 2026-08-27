# Goal

Add safe one-click provider presets, authoritative model discovery, and actionable
health diagnostics for VibeProxy and Freebuff2API while preserving the existing
provider-profile and OpenAI-compatible adapter architecture.

# Current State

Clank already supports multiple persisted provider profiles, per-profile secrets,
manual/discovered models, compatibility flags, connection testing, and model
refresh. The runtime bridge directly constructs the OpenAI-compatible adapter from
the selected profile.

The reviewed VibeProxy integration specification proposes presets, health checks,
and a native Freebuff adapter. Its general direction fits the project, but parts of
the draft are stale or too broad for one milestone:

- Current VibeProxy documentation uses port `8317`, not `8390`.
- VibeProxy model availability changes with connected accounts and releases, so a
  hard-coded default model is unreliable.
- Freebuff model catalogs and identifiers also change and should be discovered when
  the proxy is reachable rather than treated as permanent product constants.
- Direct native Freebuff access depends on a private, reverse-engineered upstream
  protocol and needs a separate adapter/security decision.
- Automatic fallback after a rate limit can silently change model behavior and
  cost/quota semantics; v1 should offer an explicit retry suggestion instead.

# Scope

- Introduce a provider-preset registry independent of the provider adapters.
- Ship editable presets for VibeProxy and Freebuff2API.
- Use the existing OpenAI-compatible adapter for both presets.
- Use current default local endpoints: VibeProxy `http://127.0.0.1:8317/v1` and
  Freebuff2API `http://127.0.0.1:8080/v1`.
- Discover models from `/v1/models` and treat successful discovery as authoritative.
- Display bounded online, offline, authentication, rate-limit, and incompatible
  endpoint status.
- Provide actionable setup/help links and safe copyable launch guidance.
- Feed preset-created profiles into the execution router used by primary agents and
  cross-provider subagents.
- Keep all profile endpoints editable because local ports and proxy configurations
  may differ.

# Non-Goals

- Bundling, downloading, launching, or supervising VibeProxy or Freebuff2API.
- Reading VibeProxy OAuth credential files.
- Reading Freebuff/Manicode credentials automatically.
- Shipping a native direct-to-Freebuff adapter in this milestone.
- Browser automation for login or auth-token extraction.
- Token rotation inside the extension.
- Hard-coding a permanent VibeProxy model catalog.
- Automatically switching models after 429, authentication, or compatibility
  failures.
- Supporting arbitrary remote preset downloads.

# Proposed Changes

## Provider preset registry

Create a pure preset registry containing safe templates rather than live profile
state. A preset provides a stable ID, display name, category, editable base URL,
optional default model hint, initial compatibility settings, authentication
expectation, help URL/text, and optional setup command template.

Applying a preset creates an ordinary provider profile through the existing
validated profile store. It never bypasses URL validation, secret storage, profile
ID uniqueness, or compatibility normalization. Presets contain no credentials.

VibeProxy starts without a fixed default model. After profile creation, Clank tests
the endpoint and selects a discovered model only with an explicit user choice or a
clearly presented recommended first result. Freebuff2API may show documented model
hints while still replacing them with live discovery when available.

## Provider resolver

Extract provider construction and profile/model resolution from the runtime bridge
into the same host-owned execution resolver planned for cross-provider subagents.
The resolver constructs an `LLMProvider` from a validated profile and returns safe
route metadata. Initially every preset maps to the OpenAI-compatible adapter.

This creates a real seam for later adapters: the current OpenAI-compatible adapter,
an eventual native Freebuff adapter, and possible proxy-specific adapters can all
satisfy the existing `LLMProvider` interface without changing sessions, modes,
subagents, permissions, or UI event handling.

## Health and model discovery

Separate health checks from chat execution. A bounded probe calls configuration
validation and `/v1/models` with cancellation and a short timeout, then normalizes
the result into UI-safe states:

- online with discovered model count;
- reachable but authentication failed;
- reachable but rate limited;
- reachable but protocol-incompatible;
- unreachable or timed out; and
- untested.

Probe on explicit test, profile save, provider settings open, and a conservative
foreground refresh while the settings view remains open. Do not create a permanent
background polling loop. Debounce duplicate probes and prevent stale responses from
overwriting newer profile state.

Successful discovery updates the cached model list for that profile. An empty list
is represented distinctly from a failed request. Manual models remain available but
are labeled as manual when not present in the latest discovered catalog.

## Diagnostics and user experience

Add preset cards at the top of the Providers tab. Applying one opens an editable
profile form prefilled with the local URL and compatibility values. The user reviews
and saves before any profile becomes active.

Provider rows show a status badge, last checked time, discovered model count, and an
actionable message. VibeProxy offline guidance links to its installation/release
instructions and tells the user to launch the app. Freebuff2API guidance provides a
copyable command template with a placeholder, never an actual token from
SecretStorage.

Authentication failures point to the relevant proxy/app flow. Rate-limit errors
suggest waiting or selecting another configured model/profile; they do not silently
retry another model. The UI must make clear that these are third-party local tools
and that Clank does not manage their accounts or processes.

## Native Freebuff adapter decision gate

Treat the draft's direct native Freebuff engine as a later, separate plan. Before it
is approved, verify terms and protocol stability, document the authentication and
fingerprint behavior, define replay/tool compatibility fixtures, decide whether the
maintenance and account risk is acceptable, and implement it as its own provider
package behind the execution resolver.

The initial preset milestone provides the desired user flow without embedding a
private upstream protocol in the extension.

# Files / Components

- Provider preset and health modules in the extension runtime.
- Provider profile store validation and safe view mapping.
- Provider execution resolver shared with cross-provider subagents.
- Shared host/webview provider status and preset protocol records.
- Providers settings rendering, handlers, and styles.
- OpenAI-compatible adapter error normalization and model-discovery tests where
  current distinctions are insufficient.
- Extension and architecture documentation.

# Data / API Changes

- Add `ProviderPresetView` with safe template metadata.
- Add `ProviderHealthView` with state, message, checked timestamp, and discovered
  model count.
- Extend settings state with presets and per-profile health.
- Add an apply-preset message carrying only the preset ID.
- Keep health as cacheable host state rather than durable session data; persist only
  model caches and normal profile configuration.
- Preserve SecretStorage as the sole credential store.
- Keep provider/model run identity as the atomic route used by subagents and
  persistence.

# Step-by-Step Implementation

1. Add provider-profile behavioral tests for applying validated template inputs and
   preserving secret isolation.
2. Introduce the pure preset registry with VibeProxy and Freebuff2API definitions.
3. Add host-side preset application that produces an editable unsaved profile form.
4. Render preset cards and profile-form help without changing runtime execution.
5. Extract current OpenAI-compatible construction into the provider execution
   resolver and route primary runs through it unchanged.
6. Define normalized health states and classify validation/model-list failures.
7. Add cancellable, deduplicated explicit health probes with short timeouts.
8. Probe on save/test/settings-open and publish safe status updates.
9. Make successful `/v1/models` results authoritative for the profile cache while
   retaining labeled manual entries.
10. Add status badges, last-checked details, retry actions, and actionable offline,
    auth, rate-limit, and protocol diagnostics.
11. Connect preset-created profiles to the cross-provider execution resolver.
12. Add fixture-based VibeProxy and Freebuff2API compatibility tests using mock HTTP
    transports, including streaming and tool calls.
13. Perform manual tests against locally running current versions of both proxies.
14. Update the reviewed draft specification or mark its stale port/model/native
    assumptions as superseded by this plan.

# Tests

- Applying a preset cannot store credentials outside SecretStorage.
- Preset URLs remain editable and pass the same loopback/HTTPS validation as manual
  profiles.
- VibeProxy uses port 8317 by default and does not assume a fixed model.
- Freebuff2API uses port 8080 and can operate with or without a client-facing API
  key according to the user's proxy configuration.
- Online, offline, timeout, 401/403, 429, malformed JSON, empty models, and protocol
  incompatibility normalize to distinct UI states.
- A stale slow probe cannot overwrite a newer result.
- Model discovery is profile-scoped and model-name collisions do not cross profiles.
- Tool-call streaming and provider replay behavior remain normalized before reaching
  agent-core.
- Safe settings messages never contain API keys, session tokens, or secret headers.
- A VibeProxy profile can be selected as a cross-provider subagent route.

# Validation

- Install and launch current VibeProxy, create the preset profile, and confirm model
  discovery against `127.0.0.1:8317`.
- Stop and restart VibeProxy while the Providers view is open and confirm explicit or
  foreground refresh changes the diagnostic without affecting other profiles.
- Run current Freebuff2API on port 8080 with a test account/token configured in the
  proxy, apply the preset, discover models, and complete a streaming tool-call turn.
- Configure the parent on one profile and a read-only subagent on the other and
  confirm route labels and endpoint traffic.
- Verify copyable setup guidance contains placeholders only.
- Run the full repository check and extension bundle smoke test.

# Risks / Edge Cases

- Upstream model names and capabilities change frequently; discovery is
  authoritative and hints are clearly non-authoritative.
- VibeProxy can expose both OpenAI- and Anthropic-shaped routes. V1 uses its
  OpenAI-compatible `/v1` path; native Anthropic routing requires a later adapter.
- Localhost endpoints may be occupied by another process. Health checks validate
  protocol shape, not merely TCP reachability.
- Local proxies may be configured with client authentication even when defaults use
  none. The ordinary profile secret flow remains available.
- Frequent probes can consume resources or trigger auth refresh. Probe only on
  user-visible lifecycle events and deduplicate requests.
- Third-party subscription proxies can carry provider account-policy risk. UI copy
  should identify the integration as third-party and avoid claiming official
  provider approval.
- A native Freebuff adapter would couple Clank to private protocol behavior; it must
  remain outside this milestone until explicitly accepted.

# Rollback

Preset-created profiles are ordinary profiles and remain usable if preset UI is
disabled. The health module is advisory and can be feature-gated without affecting
chat execution. The execution resolver retains an OpenAI-compatible adapter for all
current profiles, allowing the runtime bridge to fall back to inherited routing.

# Acceptance Criteria

- Users can create editable VibeProxy and Freebuff2API profiles from one-click
  presets.
- VibeProxy defaults to `127.0.0.1:8317` and discovers its current models.
- Freebuff2API defaults to `127.0.0.1:8080` and discovers models when reachable.
- Provider rows display accurate, actionable, bounded health states.
- Model discovery is authoritative and scoped to the selected profile.
- Credentials and tokens remain exclusively in SecretStorage or the external proxy.
- Preset profiles work for primary and cross-provider subagent execution.
- No proxy process management, credential-file reading, silent model fallback, or
  native Freebuff protocol translation ships in this milestone.

