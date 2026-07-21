import type { FlowGraph } from "@ai-native-flow/flow-ir";
import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { InvokeArgs, InvokeNodeArgs } from "./invocationRouter.js";
import type { ExecuteResult } from "./runManager.js";
import type { RunRecord } from "./types.js";

export const RUNTIME_WORKER_PROTOCOL_VERSION = "runtime.worker.v1" as const;

export type RuntimeWorkerCommand =
  | "ping"
  | "register"
  | "promote"
  | "invoke"
  | "invokeNode"
  | "start"
  | "startNode"
  | "cancel"
  | "getRun"
  | "listRuns";

export interface RuntimeWorkerRequest {
  protocol: typeof RUNTIME_WORKER_PROTOCOL_VERSION;
  kind: "request";
  requestId: string;
  command: RuntimeWorkerCommand;
  payload: unknown;
}

export interface RuntimeWorkerError {
  name: string;
  message: string;
  code?: string;
}

export interface RuntimeWorkerResponse {
  protocol: typeof RUNTIME_WORKER_PROTOCOL_VERSION;
  kind: "response";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: RuntimeWorkerError;
}

export type RuntimeWorkerEvent =
  | {
      protocol: typeof RUNTIME_WORKER_PROTOCOL_VERSION;
      kind: "event";
      event: "node_event";
      value: NodeEvent;
    }
  | {
      protocol: typeof RUNTIME_WORKER_PROTOCOL_VERSION;
      kind: "event";
      event: "run_completed";
      value: ExecuteResult;
    };

export type RuntimeWorkerMessage =
  | RuntimeWorkerRequest
  | RuntimeWorkerResponse
  | RuntimeWorkerEvent;

export interface RegisterFlowPayload {
  graph: FlowGraph;
  json?: string;
  sourceHash?: string;
}

export interface PromoteFlowPayload {
  flowId: string;
  flowVersion: string;
}

export interface CancelRunPayload {
  runId: string;
  reason?: string;
}

export interface ListRunsPayload {
  flowId: string;
  limit?: number;
}

export interface StartedWorkerRun {
  runRecord: RunRecord;
  completed: Promise<ExecuteResult>;
}

export type WorkerInvokeArgs = Omit<InvokeArgs, "variables" | "secrets">;
export type WorkerInvokeNodeArgs = Omit<InvokeNodeArgs, "variables" | "secrets">;

export interface RuntimeWorkerClientApi {
  register(payload: RegisterFlowPayload): Promise<unknown>;
  promote(payload: PromoteFlowPayload): Promise<unknown>;
  invoke(args: WorkerInvokeArgs): Promise<ExecuteResult>;
  invokeNode(args: WorkerInvokeNodeArgs): Promise<ExecuteResult>;
  start(args: WorkerInvokeArgs): Promise<StartedWorkerRun>;
  startNode(args: WorkerInvokeNodeArgs): Promise<StartedWorkerRun>;
  cancel(runId: string, reason?: string): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(flowId: string, limit?: number): Promise<RunRecord[]>;
}

export function isRuntimeWorkerMessage(value: unknown): value is RuntimeWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { protocol?: unknown; kind?: unknown };
  return candidate.protocol === RUNTIME_WORKER_PROTOCOL_VERSION &&
    ["request", "response", "event"].includes(String(candidate.kind));
}
