import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(repositoryRoot, "apps/vscode-extension/dist");
const bundle = await readFile(resolve(dist, "extension.js"), "utf8");
const forbidden = [
  /require\(["']@freebuff\//,
  /require\(["']sql\.js["]\)/,
];
for (const pattern of forbidden) {
  if (pattern.test(bundle)) throw new Error(`Extension bundle retains a runtime dependency: ${pattern}`);
}
if (!/require\(["']vscode["']\)/.test(bundle)) throw new Error("VS Code must remain the extension host external.");
const wasm = await stat(resolve(dist, "sql-wasm.wasm"));
if (wasm.size < 100_000) throw new Error("Bundled sql.js WASM is missing or truncated.");

// The webview HTML shell loads dist/webview/main.js with a classic <script src>
// tag under a strict nonce CSP. It must therefore be a self-contained classic
// script: any top-level import/export (tsc's ES-module emit) makes the browser
// throw "Cannot use import statement outside a module" and leaves the panel
// blank. This is the regression check for the blank-view defect.
const webview = await readFile(resolve(dist, "webview/main.js"), "utf8");
if (/^\s*(import|export)\s/m.test(webview)) throw new Error("Webview bundle is not a classic script: top-level module syntax would blank the panel.");
if (/require\(/m.test(webview)) throw new Error("Webview bundle must not reference Node require.");
if (!/acquireVsCodeApi/.test(webview)) throw new Error("Webview bundle lost the VS Code API bridge.");
if (!webview.includes("startup-")) throw new Error("Webview bundle lost the startup-failure surface.");

await Promise.all([
  stat(resolve(dist, "webview/styles.css")),
  stat(resolve(dist, "webview/generated-tokens.css")),
]);
console.log("VS Code bundle smoke passed.");
