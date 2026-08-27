import { resolveModel, type ModeDefinition, type ModelResolutionInput } from "@freebuff/agent-core";
import type { ProviderProfile } from "./provider-profiles";

export type ProviderRouteResult =
  | { ok: true; providerId: string; model: string }
  | { ok: false; message: string };

/** Pure profile-scoped route selection shared by primary and child execution. */
export function resolveProviderRoute(input: {
  profile: ProviderProfile;
  mode: ModeDefinition;
  selectedModel?: string;
  discoveredModelIds?: readonly string[];
  globalFallback?: string;
}): ProviderRouteResult {
  const selected = input.selectedModel === "openai-compatible" ? "" : input.selectedModel?.trim() ?? "";
  const available = new Set([
    ...input.profile.manualModels.map((item) => item.id),
    ...(input.discoveredModelIds ?? []),
  ]);
  const modeWithProfileDefault = {
    ...input.mode,
    model: input.mode.modelPolicy === "fixed"
      ? input.mode.model
      : input.mode.model ?? input.profile.modeDefaults[input.mode.slug],
  };
  const resolutionInput: ModelResolutionInput = {
    sessionSelection: selected,
    mode: modeWithProfileDefault,
    profileDefault: input.profile.defaultModel,
    globalFallback: input.globalFallback?.trim(),
    ...(available.size ? { availableModels: available } : {}),
  };
  const resolution = resolveModel(resolutionInput);
  if (!resolution.selectedModel || !resolution.available) {
    return {
      ok: false,
      message: resolution.rejection?.reason
        ?? (resolution.selectedModel ? `Model '${resolution.selectedModel}' is unavailable for provider '${input.profile.id}'.` : `No model is configured for provider '${input.profile.id}'.`),
    };
  }
  return { ok: true, providerId: input.profile.id, model: resolution.selectedModel };
}
