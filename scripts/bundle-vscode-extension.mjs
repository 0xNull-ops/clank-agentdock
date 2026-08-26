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
console.log("Bundled self-contained VS Code extension host and sql.js WASM.");
