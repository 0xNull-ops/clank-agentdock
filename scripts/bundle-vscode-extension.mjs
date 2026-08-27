import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(repositoryRoot, "apps/vscode-extension");
const outputDirectory = resolve(extensionRoot, "dist");
const extensionRequire = createRequire(resolve(extensionRoot, "package.json"));
const { build } = extensionRequire("esbuild");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(extensionRoot, "src/extension.ts")],
  outfile: resolve(outputDirectory, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
});

await copyFile(extensionRequire.resolve("sql.js/dist/sql-wasm.wasm"), resolve(outputDirectory, "sql-wasm.wasm"));

// The webview must be a single classic script: the HTML shell loads it with a
// plain <script src> tag and a strict nonce CSP, so ES module syntax (what tsc
// emits for the webview target) would throw "Cannot use import statement outside
// a module" and leave the panel blank. Bundle it so ../shared/protocol is
// inlined and the output contains no top-level import/export.
await build({
  entryPoints: [resolve(extensionRoot, "src/webview/main.ts")],
  outfile: resolve(outputDirectory, "webview/main.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  logLevel: "warning",
});

await copyFile(resolve(extensionRoot, "src/webview/styles.css"), resolve(outputDirectory, "webview/styles.css"));
await copyFile(resolve(extensionRoot, "src/webview/generated-tokens.css"), resolve(outputDirectory, "webview/generated-tokens.css"));

try {
  await copyFile(resolve(extensionRoot, "resources/Freebuff2API"), resolve(outputDirectory, "Freebuff2API"));
} catch {
  // ignore
}

console.log("Bundled self-contained VS Code extension host, sql.js WASM, and webview.");
