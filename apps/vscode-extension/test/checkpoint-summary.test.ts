import { describe, expect, test } from "bun:test";
import { checkpointCardFromSummary } from "../src/shared/checkpoints";

describe("checkpoint UI mapping", () => {
  test("keeps compact file statuses and line counts", () => {
    const card = checkpointCardFromSummary("checkpoint-1", "Implement turn", {
      files: [{
        path: "src/example.ts",
        status: "modified",
        binary: false,
        linesAdded: 4,
        linesRemoved: 2,
      }],
      filesChanged: 1,
      additions: 4,
      removals: 2,
    }, 123);

    expect(card).toEqual({
      id: "checkpoint-1",
      label: "Implement turn",
      createdAt: 123,
      filesChanged: 1,
      additions: 4,
      removals: 2,
      files: [{ path: "src/example.ts", status: "modified", binary: false, linesAdded: 4, linesRemoved: 2 }],
    });
  });
});
