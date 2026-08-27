import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const vsix = resolve(process.argv[2] ?? "/tmp/forge-agent-harness.vsix");
const root = await mkdtemp(resolve(tmpdir(), "forge-vsix-smoke-"));

try {
  execFileSync("unzip", ["-q", vsix, "-d", root], { stdio: "inherit" });
  const extensionRoot = resolve(root, "extension");
  const manifest = JSON.parse(await readFile(resolve(extensionRoot, "package.json"), "utf8"));
  if (manifest.main !== "./dist/extension.js") throw new Error(`Unexpected VSIX entrypoint: ${String(manifest.main)}`);

  const wasm = await stat(resolve(extensionRoot, "dist/sql-wasm.wasm"));
  if (wasm.size < 100_000) throw new Error("VSIX sql.js WASM is missing or truncated.");

  // The webview HTML shell loads dist/webview/main.js as a classic script under
  // a strict nonce CSP. Reject the package if the shipped bundle retained ES
  // module syntax (the blank-panel defect) or Node-only requires.
  const webview = await readFile(resolve(extensionRoot, "dist/webview/main.js"), "utf8");
  if (/^\s*(import|export)\s/m.test(webview)) throw new Error("VSIX webview bundle is not a classic script; the panel would stay blank.");
  if (/require\(/m.test(webview)) throw new Error("VSIX webview bundle must not reference Node require.");
  await Promise.all([
    stat(resolve(extensionRoot, "dist/webview/styles.css")),
    stat(resolve(extensionRoot, "dist/webview/generated-tokens.css")),
  ]);

  const stubRoot = resolve(root, "host-stub/node_modules/vscode");
  await mkdir(stubRoot, { recursive: true });
  await writeFile(resolve(stubRoot, "index.js"), "module.exports = {};\n", "utf8");
  const entrypoint = resolve(extensionRoot, manifest.main);
  const imported = spawnSync(process.execPath, ["-e", "require(process.argv[1])", entrypoint], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: resolve(root, "host-stub/node_modules") },
  });
  if (imported.status !== 0) throw new Error(`VSIX extension import failed:\n${imported.stderr || imported.stdout}`);
  console.log(`VSIX smoke passed: ${vsix}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
