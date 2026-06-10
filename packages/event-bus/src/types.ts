/**
 * NodeEvent and Run lifecycle event types.
 *
 * Phase 1 only writes a subset of the full Phase 2 event surface; we still
 * model every kind here so downstream packages (HTTP transport, future
 * Studio) do not have to re-declare the union when streaming is added.
 *
 * Per `docs/decisions/schema-versioning.md`, NodeEvent's schemaVersion is
 * carried on the Event Store stream header rather than on every event.
 */

import type { RuntimeError } from "@ai-native-flow/flow-ir";

export const NODE_EVENT_SCHEMA_VERSION = "node.event.v1" as const;
export type NodeEventSchemaVersion = typeof NODE_EVENT_SCHEMA_VERSION;

/**
 * Full set of NodeEvent kinds. Phase 1 emits the lifecycle subset:
 * `node_started`, `node_finished`, `node_error`, `node_log`,
 * `run_started`, `run_finished`, `run_failed`, `run_cancelled`. The
 * `stream_*` and `tool_call_*` kinds are introduced in Phase 2.
 */
export type NodeEventKind =
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "run_cancelled"
  | "node_started"
  | "node_progress"
  | "stream_open"
  | "stream_delta"
  | "stream_artifact"
  | "stream_usage"
  | "stream_close"
  | "tool_call_started"
  | "tool_call_delta"
  | "tool_call_finished"
  | "node_log"
  | "node_warning"
  | "node_error"
  | "transport_error"
  | "node_finished";

/**
 * The canonical event shape.
 *
 * `runId` and `flowId` are required for every kind; `nodeId` /
 * `nodeVersion` / `attempt` are required for `node_*` kinds, but optional
 * for `run_*` kinds (which describe Run-level lifecycle).
 */
export interface NodeEvent {
  /** Globally unique cursor; assigned by the Event Store at append time. */
  eventId: string;
  runId: string;
  flowId: string;
  flowVersion: string;
  nodeId?: string;
  nodeVersion?: string;
  attempt?: number;
  /** Monotonic per-(runId, nodeId, attempt) sequence number. */
  seq: number;
  timestamp: string;
  kind: NodeEventKind;
  portId?: string;
  streamId?: string;
  traceId?: string;
  parentEventId?: string;
  payload: unknown;
}

/**
 * Convenience payload typings for the kinds Phase 1 emits.
 *
 * These are documentation-only TypeScript helpers; the wire format keeps
 * `payload: unknown` so that future Adapter / Provider events can extend it
 * without breaking existing consumers.
 */
export interface RunStartedPayload {
  input: unknown;
}
export interface RunFinishedPayload {
  output: unknown;
}
export interface RunFailedPayload {
  error: RuntimeError;
}
export interface RunCancelledPayload {
  reason?: string;
}
export interface NodeStartedPayload {
  input: Record<string, unknown>;
}
export interface NodeFinishedPayload {
  output: Record<string, unknown>;
  durationMs: number;
}
export interface NodeErrorPayload {
  error: RuntimeError;
  durationMs: number;
}
export interface NodeLogPayload {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}
