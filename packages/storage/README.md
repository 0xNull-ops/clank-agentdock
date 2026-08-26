# `@freebuff/agent-storage`

Durable local session storage for the Forge agent harness. `SessionStore` uses
[`sql.js`](https://github.com/sql-js/sql.js), a JavaScript/WASM SQLite build, so
the extension host does not need a native SQLite add-on.

```ts
const store = await SessionStore.open({
  filePath: context.storageUri.fsPath + "/sessions.sqlite",
});

await store.createSession(session);
await store.appendMessage(session.id, { role: "user", content: prompt });
const history = await store.openSession(session.id);

// Pass the workspace guard whenever a workspace-scoped caller mutates a
// session. A mismatched guard is a no-op and does not expose that session.
await store.renameSession(session.id, "A clearer title", { workspaceId: session.workspaceId });
await store.deleteSession(session.id, { workspaceId: session.workspaceId });
```

Every write is serialized and persisted as an fsynced temporary SQLite file
followed by an atomic rename. The database has an explicit `PRAGMA user_version`
and migration table. On open, sessions left `running` or
`waiting_for_approval` by a host crash are changed to `cancelled`; pending
approvals are denied and exposed through `lastRecovery`.

`openSession` is for trusted internal replay and includes opaque provider
transcript entries. `exportSession` is bounded and omits provider entries and
provider frames unless explicitly requested with the host-only
`includeProviderMessages` and `includeProviderFrames` options. Pass
`workspaceId` to `openSession` or `exportSession` when the caller has a
workspace scope. API keys are not accepted by this package and should remain
in VS Code `SecretStorage`.

The package intentionally does not provide a JSON fallback: a missing `sql.js`
dependency is a deployment error, not a reason to weaken durability semantics.
