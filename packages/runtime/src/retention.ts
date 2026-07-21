import type { RunStatus } from "./types.js";

export interface RunRetentionEntry {
  runId: string;
  createdAt: string;
  status: RunStatus;
  bytes: number;
}

export interface RunRetentionPolicy {
  maxAgeMs: number;
  maxRuns: number;
  maxBytes: number;
}

export interface RunRetentionDecision {
  runId: string;
  reason: "max_age" | "max_runs" | "max_bytes";
}

export interface RunRetentionPlan {
  keep: string[];
  delete: RunRetentionDecision[];
  retainedBytes: number;
}

export const DEFAULT_RUN_RETENTION_POLICY: RunRetentionPolicy = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxRuns: 500,
  maxBytes: 25 * 1024 * 1024,
};

/** Pure, deterministic planner. Active runs are never selected for deletion. */
export function planRunRetention(
  entries: readonly RunRetentionEntry[],
  policy: RunRetentionPolicy = DEFAULT_RUN_RETENTION_POLICY,
  now = Date.now(),
): RunRetentionPlan {
  assertPolicy(policy);
  const sorted = [...entries].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const active = sorted.filter((entry) => entry.status === "queued" || entry.status === "running");
  const terminal = sorted.filter((entry) => entry.status !== "queued" && entry.status !== "running");
  const decisions = new Map<string, RunRetentionDecision["reason"]>();

  for (const entry of terminal) {
    const created = Date.parse(entry.createdAt);
    if (Number.isFinite(created) && now - created > policy.maxAgeMs) {
      decisions.set(entry.runId, "max_age");
    }
  }
  const eligible = terminal.filter((entry) => !decisions.has(entry.runId));
  for (const entry of eligible.slice(policy.maxRuns)) {
    decisions.set(entry.runId, "max_runs");
  }
  let retainedBytes = active.reduce((sum, entry) => sum + normalizedBytes(entry.bytes), 0)
    + eligible
      .filter((entry) => !decisions.has(entry.runId))
      .reduce((sum, entry) => sum + normalizedBytes(entry.bytes), 0);
  const quotaCandidates = eligible
    .filter((entry) => !decisions.has(entry.runId))
    .reverse();
  for (const entry of quotaCandidates) {
    if (retainedBytes <= policy.maxBytes) break;
    decisions.set(entry.runId, "max_bytes");
    retainedBytes -= normalizedBytes(entry.bytes);
  }
  return {
    keep: sorted.filter((entry) => !decisions.has(entry.runId)).map((entry) => entry.runId),
    delete: sorted
      .filter((entry) => decisions.has(entry.runId))
      .map((entry) => ({ runId: entry.runId, reason: decisions.get(entry.runId)! })),
    retainedBytes,
  };
}

function normalizedBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function assertPolicy(policy: RunRetentionPolicy): void {
  if (
    !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
    !Number.isInteger(policy.maxRuns) || policy.maxRuns < 0 ||
    !Number.isFinite(policy.maxBytes) || policy.maxBytes < 0
  ) throw new Error("Run retention limits must be finite non-negative values");
}
