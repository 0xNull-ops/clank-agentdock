import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(repositoryRoot, "apps/vscode-extension/dist");
const bundle = await readFile(resolve(dist, "extension.js"), "utf8");
const forbidden = [
  /require\(["']@freebuff\//,
  /require\(["']sql\.js["']\)/,
];
for (const pattern of forbidden) {
  if (pattern.test(bundle)) throw new Error(`Extension bundle retains a runtime dependency: ${pattern}`);
}
if (!/require\(["']vscode["']\)/.test(bundle)) throw new Error("VS Code must remain the extension host external.");
const wasm = await stat(resolve(dist, "sql-wasm.wasm"));
if (wasm.size < 100_000) throw new Error("Bundled sql.js WASM is missing or truncated.");
await Promise.all([
  stat(resolve(dist, "webview/main.js")),
  stat(resolve(dist, "webview/styles.css")),
  stat(resolve(dist, "webview/generated-tokens.css")),
]);
console.log("VS Code bundle smoke passed.");
