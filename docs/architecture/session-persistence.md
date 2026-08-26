# VS Code session persistence

`SessionPersistenceCoordinator` is the extension-host lifecycle adapter for
`@freebuff/agent-storage`. It opens `sessions.sqlite` below
`ExtensionContext.globalStorageUri`, so the database is not written into the
workspace or repository. Initialization is one shared promise; event writes
are then serialized in arrival order before reaching the serialized SQLite
store.

## Bridge contract

```ts
const persistence = await SessionPersistenceCoordinator.open(context);
const restored = await persistence.restore(sessionId); // UI-safe messages
const replay = await persistence.replayMessages(sessionId); // host only
const providerFrames = await persistence.replayProviderTranscript(sessionId); // host only

await persistence.startSession(session);
const result = await runAgent({
  // ...
  onEvent: persistence.eventSink,
});
await persistence.recordRun(session, result);
await persistence.decideApproval(approvalId, "allow"); // after user approval

await persistence.close();
```

`restore` strips `providerFrames`. `replayMessages` and
`replayProviderTranscript` are intentionally extension-host APIs for provider
continuation and must never be sent across the webview protocol. Complete
normalized messages are written once the run returns; streaming deltas are not
stored as separate messages, which prevents partial and duplicate assistant
history.

## VSIX/sql.js packaging contract

The extension package must add `@freebuff/agent-storage` as a runtime
dependency and build it after `@freebuff/agent-core` has produced its
declarations. `sql.js` is a transitive runtime dependency, but its WASM file
must be present in the installed extension. The extension packaging step must
therefore either:

1. preserve `node_modules/sql.js/dist/sql-wasm.wasm` (and the matching
   `sql-wasm.js`) in the VSIX and let the storage package's `locateFile` resolve
   it; or
2. inject `SessionPersistenceOptions.sqlJs` with an initializer whose
   `locateFile` returns an absolute path to a copied `sql-wasm.wasm` asset.

Do not replace the WASM database with a JSON fallback. Keep `sql.js` and the
WASM asset in the extension's runtime dependency/package allow-list, and run a
fresh `npm install` after adding the local storage dependency so the lockfile
and VSIX dependency tree agree.
