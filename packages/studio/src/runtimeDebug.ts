import type { StudioNodeStatus } from "./types.js";

/**
 * Structural runtime event contract shared by Studio's canonical NodeEvent
 * stream and hosts that forward the same wire payload through a wider
 * `kind: string` transport type.
 */
export interface RuntimeDebugEvent {
  nodeId?: string;
  kind: string;
  timestamp: string;
  payload: unknown;
}

export interface RuntimeDebugNodeState {
  status: StudioNodeStatus;
  runtime?: {
    startedAt?: number;
    durationMs?: number;
  };
}

/**
 * Project one node's full event stream into the same status/timing model used
 * by the Studio canvas. Non-lifecycle events intentionally keep a started node
 * active instead of resetting it to idle.
 */
export function deriveRuntimeDebugNodeState(
  events: ReadonlyArray<RuntimeDebugEvent>,
  nodeId: string,
): RuntimeDebugNodeState {
  const nodeEvents = events.filter((event) => event.nodeId === nodeId);
  const status = deriveStatus(nodeEvents);
  const runtime = deriveRuntime(nodeEvents);
  return {
    status,
    ...(runtime ? { runtime } : {}),
  };
}

function deriveStatus(nodeEvents: ReadonlyArray<RuntimeDebugEvent>): StudioNodeStatus {
  for (let index = nodeEvents.length - 1; index >= 0; index -= 1) {
    const kind = nodeEvents[index]!.kind;
    if (kind === "node_error" || kind === "node_failed") return "failed";
    if (kind === "node_finished") return "succeeded";
    if (kind.startsWith("stream_")) return "streaming";
    if (
      kind === "node_started"
      || kind === "node_progress"
      || kind === "node_log"
      || kind === "node_warning"
      || kind.startsWith("tool_call_")
    ) {
      return "running";
    }
  }
  return "idle";
}

function deriveRuntime(
  nodeEvents: ReadonlyArray<RuntimeDebugEvent>,
): RuntimeDebugNodeState["runtime"] {
  if (nodeEvents.length === 0) return undefined;
  let startedAt: number | undefined;
  let durationMs: number | undefined;
  for (let index = nodeEvents.length - 1; index >= 0; index -= 1) {
    const event = nodeEvents[index]!;
    if (
      durationMs === undefined
      && (event.kind === "node_finished" || event.kind === "node_error" || event.kind === "node_failed")
    ) {
      const payload = event.payload as { durationMs?: number } | undefined;
      if (typeof payload?.durationMs === "number") durationMs = payload.durationMs;
    }
    if (event.kind === "node_started") {
      const timestamp = Date.parse(event.timestamp);
      if (Number.isFinite(timestamp)) startedAt = timestamp;
      break;
    }
  }
  if (durationMs === undefined && startedAt !== undefined) {
    const last = nodeEvents.at(-1)!;
    if (last.kind === "node_finished" || last.kind === "node_error" || last.kind === "node_failed") {
      const finishedAt = Date.parse(last.timestamp);
      if (Number.isFinite(finishedAt)) durationMs = Math.max(0, finishedAt - startedAt);
    }
  }
  if (startedAt === undefined && durationMs === undefined) return undefined;
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
