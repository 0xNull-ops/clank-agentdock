# Forge Agent Harness

Forge is a local-first, provider-agnostic coding-agent harness whose first client is a VS Code extension. The model endpoint is replaceable; modes, permissions, tools, sessions, and UI belong to the harness.

The current milestone provides:

- a typed provider-independent agent loop
- deterministic mode and permission policies
- an OpenAI-compatible streaming adapter
- a VS Code sidebar chat shell built from the Forge design tokens
- a runtime bridge for configured OpenAI-compatible endpoints

See [`specs/freebuff_vscode_agent_harness_full_spec.md`](specs/freebuff_vscode_agent_harness_full_spec.md) for the product specification and [`docs/architecture/current-state.md`](docs/architecture/current-state.md) for the implemented architecture.

## Development

The repository is organized as independent TypeScript packages under `packages/` and the VS Code client under `apps/vscode-extension/`. Package-specific commands are documented in each package while the root workspace scripts provide aggregate checks.

```sh
npm install --prefix apps/vscode-extension
npm run check
```

To try the extension, open `apps/vscode-extension` in VS Code and launch an Extension Development Host. Configure `agentdock.provider.baseUrl` and `agentdock.provider.model`, then use **Agent Harness: Set API Key** if the endpoint requires one.
