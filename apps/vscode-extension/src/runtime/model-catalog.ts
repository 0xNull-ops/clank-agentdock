import type { ModelOption } from "../shared/protocol";
import { FREEBUFF_REAL_MODELS } from "./freebuff-sidecar";

/**
 * Narrow a provider's advertised catalogue to the models a chat turn can
 * actually use.
 *
 * The Freebuff sidecar's /v1/models lists every model across every internal
 * agent, including file-picker and editor helpers. Offering those in the picker
 * meant a user could select a model that routes to a non-chat agent, which is a
 * large part of why Freebuff "worked" but kept misbehaving. Other providers are
 * passed through untouched.
 */
export function curateDiscoveredModels(profileId: string, models: ModelOption[]): ModelOption[] {
  if (profileId !== "freebuff" && profileId !== "freebuff2api") return models;
  const curated = new Map(FREEBUFF_REAL_MODELS.map((model) => [model.id, model]));
  const chatModels = models.filter((model) => curated.has(model.id));
  // A sidecar that advertises none of the known chat models is misconfigured or
  // out of date; surface what it reported rather than an empty picker.
  if (chatModels.length === 0) return models;
  return chatModels.map((model) => {
    const definition = curated.get(model.id)!;
    return { id: model.id, label: definition.displayName, hint: definition.hint };
  });
}
