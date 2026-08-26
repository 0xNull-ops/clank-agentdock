import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "specs/forge-agent-design-tokens.json");
const outputPath = resolve(repositoryRoot, "apps/vscode-extension/src/webview/generated-tokens.css");
const document = JSON.parse(await readFile(sourcePath, "utf8"));
const tokens = [];

walk(document, []);
const variables = new Map();
for (const token of tokens) {
  const name = `--forge-${token.path.map(kebab).join("-")}`;
  if (variables.has(name)) throw new Error(`Duplicate generated token name: ${name}`);
  variables.set(name, cssValue(resolveValue(token.value, new Set([token.path.join(".")]))));
}

const lines = [
  "/* Generated from specs/forge-agent-design-tokens.json. Do not edit by hand. */",
  ":root {",
  ...[...variables].map(([name, value]) => `  ${name}: ${value};`),
  "}",
  ...themeMapping("body.vscode-dark", "dark"),
  ...themeMapping("body.vscode-light", "light"),
  ...themeMapping("body.vscode-high-contrast, body.vscode-high-contrast-light", "dark"),
  "",
];
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, lines.join("\n"), "utf8");
console.log(`Generated ${variables.size} Forge CSS variables at ${outputPath}`);

function themeMapping(selector, colorScheme) {
  return [
    `${selector} {`,
    `  color-scheme: ${colorScheme};`,
    "  --forge-theme-bg-canvas: var(--vscode-sideBar-background, var(--forge-color-semantic-bg-canvas));",
    "  --forge-theme-bg-surface: var(--vscode-editor-background, var(--forge-color-semantic-bg-surface));",
    "  --forge-theme-bg-raised: var(--vscode-input-background, var(--forge-color-semantic-bg-surface-raised));",
    "  --forge-theme-text-primary: var(--vscode-foreground, var(--forge-color-semantic-text-primary));",
    "  --forge-theme-text-secondary: var(--vscode-descriptionForeground, var(--forge-color-semantic-text-secondary));",
    "  --forge-theme-border: var(--vscode-widget-border, var(--forge-color-semantic-border-subtle));",
    "}",
  ];
}

function walk(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (Object.hasOwn(value, "$value")) {
    tokens.push({ path, value: value.$value });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$") || key === "meta") continue;
    walk(child, [...path, key]);
  }
}

function resolveValue(value, seen) {
  if (typeof value !== "string") return value;
  const match = /^\{([^}]+)\}$/.exec(value);
  if (!match) return value;
  const reference = match[1];
  if (seen.has(reference)) throw new Error(`Circular design-token reference: ${[...seen, reference].join(" -> ")}`);
  let target = document;
  for (const segment of reference.split(".")) target = target?.[segment];
  if (!target || typeof target !== "object" || !Object.hasOwn(target, "$value")) throw new Error(`Broken design-token reference: ${reference}`);
  return resolveValue(target.$value, new Set([...seen, reference]));
}

function cssValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();
}
