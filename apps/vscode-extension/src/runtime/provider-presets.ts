import type { OpenAICompatibility } from "@freebuff/provider-openai-compatible";
import type { ProviderType } from "./provider-profiles";

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: "cloud" | "local" | "proxy";
  readonly type: ProviderType;
  readonly baseUrl: string;
  readonly defaultModel?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly compatibility: Readonly<OpenAICompatibility>;
  readonly helpUrl?: string;
  readonly helpText?: string;
}

const DEFAULT_COMPATIBILITY: Readonly<OpenAICompatibility> = Object.freeze({
  supportsDeveloperRole: true,
  supportsParallelToolCalls: true,
  requiresAssistantReasoningReplay: false,
  requiresAssistantFrameReplay: false,
  sendMaxTokensAs: "max_tokens",
});

const PRESETS: readonly ProviderPreset[] = Object.freeze([
  preset({ id: "openai", name: "OpenAI", description: "OpenAI API", category: "cloud", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o" }),
  preset({ id: "openrouter", name: "OpenRouter", description: "Multi-provider API gateway", category: "cloud", baseUrl: "https://openrouter.ai/api/v1" }),
  preset({ id: "ollama", name: "Ollama", description: "Local OpenAI-compatible server", category: "local", baseUrl: "http://127.0.0.1:11434/v1" }),
  preset({ id: "vllm", name: "vLLM", description: "Local high-throughput inference", category: "local", baseUrl: "http://127.0.0.1:8000/v1" }),
  preset({ id: "deepseek", name: "DeepSeek", description: "DeepSeek API", category: "cloud", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" }),
  preset({
    id: "vibeproxy",
    name: "VibeProxy",
    description: "Third-party local subscription proxy; Clank does not manage its accounts or process.",
    category: "proxy",
    baseUrl: "http://127.0.0.1:8317/v1",
    helpUrl: "https://github.com/automazeio/vibeproxy",
    helpText: "Launch VibeProxy, connect an account, then fetch its live model catalog.",
  }),
  preset({
    id: "aihubmix",
    name: "AI HubMix",
    description: "Inferera API multi-model gateway (Claude, GPT, DeepSeek, Qwen)",
    category: "cloud",
    baseUrl: "https://api.inferera.com/v1",
    defaultModel: "claude-3-7-sonnet",
    helpUrl: "https://aihubmix.com",
    helpText: "Enter your AI HubMix API key to discover and access hundreds of models.",
  }),
  preset({
    id: "freebuff2api",
    name: "Freebuff2API",
    description: "Third-party local Freebuff-compatible proxy; credentials remain in the proxy.",
    category: "proxy",
    baseUrl: "http://127.0.0.1:8080/v1",
    helpText: "Launch Freebuff2API with its own credentials, then fetch its live model catalog.",
  }),
]);

export function providerPresets(): readonly ProviderPreset[] {
  return PRESETS;
}

export function providerPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((item) => item.id === id.trim().toLowerCase());
}

function preset(input: Omit<ProviderPreset, "type" | "headers" | "compatibility">): ProviderPreset {
  return Object.freeze({
    ...input,
    type: "openai-compatible",
    headers: Object.freeze({}),
    compatibility: DEFAULT_COMPATIBILITY,
  });
}
