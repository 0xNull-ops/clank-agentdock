import type { DiffSummary } from "@freebuff/checkpoints";
import type { CheckpointSummaryCard } from "./protocol";

/** Convert the checkpoint package's internal diff shape into the stable webview contract. */
export function checkpointCardFromSummary(
  id: string,
  label: string,
  summary: DiffSummary,
  createdAt = Date.now(),
): CheckpointSummaryCard {
  return {
    id,
    label,
    createdAt,
    filesChanged: summary.filesChanged,
    additions: summary.additions,
    removals: summary.removals,
    files: summary.files.map((file) => ({
      path: file.path,
      status: file.status,
      binary: file.binary,
      linesAdded: file.linesAdded,
      linesRemoved: file.linesRemoved,
    })),
  };
}
