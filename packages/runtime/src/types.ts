/**
 * Runtime-internal types: RunRecord, RunStatus, scheduler-facing inputs and
 * Flow Version pointers.
 *
 * Per `docs/decisions/schema-versioning.md`, RunRecord carries its own
 * `schemaVersion` so that Replay always uses the schema active at Run
 * creation time, even after a Runtime upgrade.
 */

import type { FlowGraph, RuntimeError } from "@ai-native-flow/flow-ir";

export const RUN_RECORD_SCHEMA_VERSION = "run.record.v1" as const;
export type RunRecordSchemaVersion = typeof RUN_RECORD_SCHEMA_VERSION;

/**
 * Run lifecycle states. Mirrors the Flow Execution Semantics in
 * `docs/specs/runtime-execution.md` §5.6.
 */
export type RunStatus =
  | "queued"      // created, not yet started
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunRecord {
  schemaVersion: RunRecordSchemaVersion;
  runId: string;
  flowId: string;
  /** Pinned at Run creation; never tracks Registry promotions afterwards. */
  flowVersion: string;
  /** Hex content hash of the pinned Flow Artifact. */
  flowArtifactHash: string;
  status: RunStatus;
  /** Original invocation input (must already pass `inputSchema`). */
  input: unknown;
  /** Final output, populated when status is `succeeded`. */
  output?: unknown;
  /** Final error, populated when status is `failed`. */
  error?: RuntimeError;
  /** ISO-8601 timestamp of Run creation. */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Optional human-supplied trace id for correlating across services. */
  traceId?: string;
  /** Depth of nested subflow invocation; root manual invocations are 0. */
  subflowDepth?: number;
}

/** A single FlowVersion entry in the Runtime Registry. */
export interface FlowVersionRef {
  flowId: string;
  version: string;
  artifactHash: string;
  status: "staging" | "active" | "draining" | "archived";
  /** Resolved Flow graph; kept in-memory after load for fast Run creation. */
  graph: FlowGraph;
  /** ISO-8601 timestamp of registration. */
  registeredAt: string;
}
