import { describe, expect, it } from "vitest";
import { planRunRetention } from "../src/retention.js";

const NOW = Date.parse("2026-07-21T00:00:00.000Z");

describe("run retention planner", () => {
  it("applies age, count and byte quotas while protecting active runs", () => {
    const plan = planRunRetention([
      entry("running", 0, 1_000, "running"),
      entry("new", 1, 700),
      entry("middle", 2, 700),
      entry("old", 40, 100),
    ], {
      maxAgeMs: 30 * 86_400_000,
      maxRuns: 2,
      maxBytes: 1_900,
    }, NOW);

    expect(plan.keep).toEqual(["running", "new"]);
    expect(plan.delete).toEqual([
      { runId: "middle", reason: "max_bytes" },
      { runId: "old", reason: "max_age" },
    ]);
    expect(plan.retainedBytes).toBe(1_700);
  });

  it("uses newest-first maxRuns semantics", () => {
    const plan = planRunRetention([
      entry("new", 1, 1),
      entry("middle", 2, 1),
      entry("old", 3, 1),
    ], { maxAgeMs: Number.MAX_SAFE_INTEGER, maxRuns: 2, maxBytes: Number.MAX_SAFE_INTEGER }, NOW);
    expect(plan.delete).toEqual([{ runId: "old", reason: "max_runs" }]);
  });
});

function entry(
  runId: string,
  daysAgo: number,
  bytes: number,
  status: "succeeded" | "running" = "succeeded",
) {
  return {
    runId,
    createdAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    status,
    bytes,
  };
}
