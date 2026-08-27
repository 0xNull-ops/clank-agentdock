import type { ModeDefinition, ModelPolicy } from "./types";

/** The precedence layer that supplied a resolved model. */
export type ModelResolutionSource = "turn" | "session" | "mode" | "profile" | "global";

export interface ModelResolutionMode {
  /** A mode's pinned or preferred model. */
  model?: string | null;
  /** Omitted policies retain the historical user-selectable behavior. */
  modelPolicy?: ModelPolicy;
}

export type ModelAvailability = Iterable<string> | ReadonlySet<string> | ((modelId: string) => boolean);

/** Inputs used by the provider-independent model resolver. */
export interface ModelResolutionInput {
  /** A temporary override for this request. */
  turnOverride?: string | null;
  /** The model selected on the durable session. */
  sessionSelection?: string | null;
  /** The active mode's model and policy. */
  mode?: Pick<ModeDefinition, "model" | "modelPolicy"> | ModelResolutionMode;
  /** Convenience fields for callers that keep mode state separately. */
  modeModel?: string | null;
  modePolicy?: ModelPolicy;
  /** The active provider profile's default model. */
  profileDefault?: string | null;
  /** Final configured fallback when no profile default exists. */
  globalFallback?: string | null;
  /** Optional availability registry. Without one, configured models are assumed available. */
  availableModels?: ModelAvailability;
}

export interface ModelResolutionRejection {
  source: ModelResolutionSource;
  model: string;
  reason: string;
}

export interface ModelResolutionFallback {
  source: ModelResolutionSource;
  model: string;
  reason: string;
}

export interface ModelResolutionConsideration {
  source: ModelResolutionSource;
  model: string;
  available: boolean;
  selected: boolean;
}

/**
 * Result of resolving a model. `model` is retained as a concise alias for
 * `selectedModel` so callers can use the result directly in a provider request.
 */
export interface ModelResolution {
  selectedModel?: string;
  model?: string;
  source?: ModelResolutionSource;
  policy: ModelPolicy;
  /** False only when an availability registry explicitly rejects the result. */
  available: boolean;
  /** Overrides rejected by a fixed mode, or the missing fixed-model reason. */
  rejections: ModelResolutionRejection[];
  rejection?: ModelResolutionRejection;
  /** The higher-priority candidate that caused a lower-priority fallback. */
  fallback?: ModelResolutionFallback;
  considered: ModelResolutionConsideration[];
}

interface Candidate {
  source: ModelResolutionSource;
  model: string;
}

/**
 * Resolve one model without provider or VS Code dependencies.
 *
 * `user-selectable` follows turn > session > mode > profile > global. A
 * `preferred` mode takes its mode model when available and otherwise falls
 * through that same chain (excluding the unavailable preference). A `fixed`
 * mode always selects its mode model and reports turn/session overrides as
 * rejections; it never silently falls back to a different model.
 */
export function resolveModel(input: ModelResolutionInput): ModelResolution {
  const modeModel = clean(input.mode?.model ?? input.modeModel);
  const policy = input.mode?.modelPolicy ?? input.modePolicy ?? "user-selectable";
  const turn = candidate("turn", input.turnOverride);
  const session = candidate("session", input.sessionSelection);
  const mode = modeModel ? { source: "mode" as const, model: modeModel } : undefined;
  const profile = candidate("profile", input.profileDefault);
  const global = candidate("global", input.globalFallback);
  const isAvailable = memoizedAvailability(input.availableModels);

  if (policy === "fixed") {
    const rejections = [turn, session]
      .filter((value): value is Candidate => value !== undefined && value.model !== mode?.model)
      .map((value) => ({
        source: value.source as "turn" | "session",
        model: value.model,
        reason: mode
          ? `Rejected because mode fixes model '${mode.model}'.`
          : "Rejected because the fixed mode has no configured fixed model.",
      }));
    if (!mode) {
      const missing: ModelResolutionRejection = {
        source: "mode",
        model: "",
        reason: "The fixed mode has no configured fixed model.",
      };
      return { policy, available: false, rejections, rejection: missing, considered: [] };
    }
    const available = isAvailable(mode.model);
    const considered = [{ source: mode.source, model: mode.model, available, selected: true }];
    return {
      selectedModel: mode.model,
      model: mode.model,
      source: mode.source,
      policy,
      available,
      rejections,
      ...(rejections[0] ? { rejection: rejections[0] } : {}),
      considered,
    };
  }

  const normalCandidates = [turn, session, mode, profile, global].filter(
    (value): value is Candidate => value !== undefined,
  );
  const candidates = policy === "preferred" && mode
    ? [mode, ...[turn, session, profile, global].filter((value): value is Candidate => value !== undefined)]
    : normalCandidates;
  const selected = candidates.find((value) => isAvailable(value.model)) ?? candidates[0];
  const considered = candidates.map((value) => ({
    source: value.source,
    model: value.model,
    available: isAvailable(value.model),
    selected: value === selected,
  }));
  if (!selected) {
    return { policy, available: false, rejections: [], considered };
  }

  const selectedAvailable = isAvailable(selected.model);
  const first = candidates[0];
  const fallback = first && selected !== first && !isAvailable(first.model)
    ? {
      source: first.source,
      model: first.model,
      reason: policy === "preferred"
        ? `Preferred model '${first.model}' is unavailable.`
        : `Higher-priority model '${first.model}' is unavailable.`,
    }
    : undefined;
  return {
    selectedModel: selected.model,
    model: selected.model,
    source: selected.source,
    policy,
    available: selectedAvailable,
    rejections: [],
    ...(fallback ? { fallback } : {}),
    considered,
  };
}

/** Descriptive alias for callers that prefer the domain term. */
export const resolveModelSelection = resolveModel;

function candidate(source: ModelResolutionSource, value: string | null | undefined): Candidate | undefined {
  const model = clean(value);
  return model ? { source, model } : undefined;
}

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  return model || undefined;
}

function memoizedAvailability(value: ModelAvailability | undefined): (modelId: string) => boolean {
  if (value === undefined) return () => true;
  const checked = new Map<string, boolean>();
  const check = typeof value === "function"
    ? value
    : (() => {
      const available = new Set<string>();
      for (const model of value) {
        const normalized = clean(model);
        if (normalized) available.add(normalized);
      }
      return (modelId: string) => available.has(modelId);
    })();
  return (modelId) => {
    const previous = checked.get(modelId);
    if (previous !== undefined) return previous;
    const result = check(modelId);
    checked.set(modelId, result);
    return result;
  };
}
