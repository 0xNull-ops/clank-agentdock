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

The extension host is bundled with esbuild so local `file:` workspace packages
do not remain as broken monorepo symlinks in an installed VSIX. `vscode` is the
only external module. The build copies `sql-wasm.wasm` to `dist`, and
`SessionPersistenceCoordinator` supplies an absolute `extensionUri/dist`
`locateFile` path to the storage package.

Do not replace the WASM database with a JSON fallback. A packaging smoke must
verify that the VSIX contains `dist/extension.js` and `dist/sql-wasm.wasm`, has
no runtime `@freebuff/*` imports, and can import the extension bundle with only
the VS Code API externalized.
