import { createHash } from "node:crypto";
import { validatePlanMarkdown, type PlanContract } from "@freebuff/agent-core";
import type { PlanRecord } from "@freebuff/agent-storage";
import type { PlanStatus, PlanView } from "../shared/protocol";

/** Plan statuses the chat card should still surface for a session. */
export const VISIBLE_PLAN_STATUSES: readonly PlanStatus[] = [
  "DRAFT",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "IMPLEMENTING",
  "BLOCKED",
  "COMPLETE",
];

/** The statuses an artifact upsert may mutate in place. */
const MUTABLE_PLAN_STATUSES: readonly PlanStatus[] = ["DRAFT", "READY_FOR_APPROVAL"];

/** How the host should reconcile one freshly scanned plan artifact. */
export type PlanArtifactDecision =
  | { action: "skip" }
  | { action: "create"; status: "DRAFT" | "READY_FOR_APPROVAL" }
  | { action: "update"; status: "DRAFT" | "READY_FOR_APPROVAL" }
  | { action: "supersede"; status: "DRAFT" | "READY_FOR_APPROVAL" };

export interface PlanArtifactCandidate {
  /** Trusted workspace-relative path below `.agent/plans`. */
  artifactPath: string;
  content: string;
}

export interface PlanArtifactOutcome {
  plan: PlanRecord;
  changed: boolean;
}

export function contentHashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Sanitized metadata for the webview; Markdown and absolute paths stay host-side. */
export function planViewFromRecord(record: PlanRecord): PlanView {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    revision: record.revision,
    artifactLabel: record.artifactPath ?? "plan artifact",
    updatedAt: record.updatedAt,
  };
}

/**
 * The newest plan a session should display, ignoring discarded/superseded
 * rows. Newest is by updatedAt (ties broken by id) rather than caller order so
 * the host can never surface a stale plan card from an unsorted list.
 */
export function planViewForSession(plans: readonly PlanRecord[]): PlanView | undefined {
  const visible = plans.filter((plan) => VISIBLE_PLAN_STATUSES.includes(plan.status));
  visible.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return visible[0] ? planViewFromRecord(visible[0]) : undefined;
}

/** Derive a bounded, human-friendly title from the validated contract. */
export function planTitleFromMarkdown(markdown: string, fallback: string): string {
  const validation = validatePlanMarkdown(markdown);
  const goal = validation.ok ? validation.contract?.goal : undefined;
  const fromGoal = goal?.split(/\r?\n/)[0]?.trim();
  const title = (fromGoal && fromGoal.length ? fromGoal : fallback.trim()).replace(/^#\s*/, "");
  return [...title].slice(0, 80).join("") || "Untitled plan";
}

/** Parse (or re-derive) the compact contract stored with a durable plan. */
export function planContractOf(record: Pick<PlanRecord, "content" | "contractJson">): PlanContract | undefined {
  if (record.contractJson) {
    try {
      const parsed = JSON.parse(record.contractJson) as PlanContract;
      if (parsed && typeof parsed === "object" && typeof parsed.goal === "string") return parsed;
    } catch {
      // Fall through to re-deriving the contract from the stored Markdown.
    }
  }
  const validation = validatePlanMarkdown(record.content);
  return validation.ok ? validation.contract : undefined;
}

/**
 * Decide how a scanned artifact reconciles with the durable plan row for the
 * same path. Approved and later lifecycle states are immutable: a changed
 * artifact supersedes the old row and starts a fresh DRAFT.
 */
export function decideArtifactPlanAction(
  existing: PlanRecord | undefined,
  candidate: PlanArtifactCandidate,
  validationOk: boolean,
): PlanArtifactDecision {
  const status: "DRAFT" | "READY_FOR_APPROVAL" = validationOk ? "READY_FOR_APPROVAL" : "DRAFT";
  if (!existing) return { action: "create", status };
  if (existing.contentHash === contentHashOf(candidate.content)) return { action: "skip" };
  if (MUTABLE_PLAN_STATUSES.includes(existing.status)) return { action: "update", status };
  return { action: "supersede", status };
}

/**
 * Validate webview-supplied plan action payloads. Only planId plus revision
 * are accepted: anything else (Markdown, paths, contract data) fails closed so
 * the webview can never steer plan body or scope.
 */
export function isPlanActionPayload(value: unknown): value is { planId: string; revision: number } {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes("planId") || !keys.includes("revision")) return false;
  return typeof payload.planId === "string"
    && payload.planId.length > 0
    && payload.planId.length <= 256
    && typeof payload.revision === "number"
    && Number.isSafeInteger(payload.revision)
    && payload.revision >= 1
    && payload.revision <= 1_000_000;
}
