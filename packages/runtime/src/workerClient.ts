import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { ExecuteResult } from "./runManager.js";
import type { RunRecord } from "./types.js";
import {
  RUNTIME_WORKER_PROTOCOL_VERSION,
  isRuntimeWorkerMessage,
  type PromoteFlowPayload,
  type RegisterFlowPayload,
  type RuntimeWorkerClientApi,
  type RuntimeWorkerCommand,
  type RuntimeWorkerRequest,
  type RuntimeWorkerResponse,
  type StartedWorkerRun,
  type WorkerInvokeArgs,
  type WorkerInvokeNodeArgs,
} from "./workerProtocol.js";
import type { RuntimeWorkerEndpoint } from "./workerHost.js";

export type { RuntimeWorkerEndpoint } from "./workerHost.js";

export interface RuntimeWorkerClientOptions {
  endpoint: RuntimeWorkerEndpoint;
  generateRequestId?: () => string;
}

type EventSubscriber = (event: NodeEvent) => void;
type Completion = { resolve: (value: ExecuteResult) => void; reject: (error: Error) => void };

export class RuntimeWorkerClient implements RuntimeWorkerClientApi {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly completions = new Map<string, Completion>();
  private readonly earlyCompletions = new Map<string, ExecuteResult>();
  private readonly subscribers = new Set<EventSubscriber>();
  private nextId = 0;
  private readonly listener: (event: { data: unknown }) => void;

  constructor(private readonly options: RuntimeWorkerClientOptions) {
    this.listener = (event) => this.receive(event.data);
    options.endpoint.addEventListener("message", this.listener);
  }

  async ready(): Promise<void> {
    await this.request("ping", {});
  }

  register(payload: RegisterFlowPayload): Promise<unknown> {
    return this.request("register", payload);
  }

  promote(payload: PromoteFlowPayload): Promise<unknown> {
    return this.request("promote", payload);
  }

  invoke(args: WorkerInvokeArgs): Promise<ExecuteResult> {
    return this.request("invoke", args) as Promise<ExecuteResult>;
  }

  invokeNode(args: WorkerInvokeNodeArgs): Promise<ExecuteResult> {
    return this.request("invokeNode", args) as Promise<ExecuteResult>;
  }

  start(args: WorkerInvokeArgs): Promise<StartedWorkerRun> {
    return this.startRequest("start", args);
  }

  startNode(args: WorkerInvokeNodeArgs): Promise<StartedWorkerRun> {
    return this.startRequest("startNode", args);
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    await this.request("cancel", { runId, ...(reason ? { reason } : {}) });
  }

  getRun(runId: string): Promise<RunRecord | undefined> {
    return this.request("getRun", { runId }) as Promise<RunRecord | undefined>;
  }

  getEvents(runId: string, cursor?: string, limit?: number): Promise<NodeEvent[]> {
    return this.request("getEvents", {
      runId,
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
    }) as Promise<NodeEvent[]>;
  }

  listRuns(flowId: string, limit?: number): Promise<RunRecord[]> {
    return this.request("listRuns", { flowId, ...(limit ? { limit } : {}) }) as Promise<RunRecord[]>;
  }

  subscribe(handler: EventSubscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  dispose(reason = "Runtime Worker client disposed"): void {
    this.options.endpoint.removeEventListener?.("message", this.listener);
    const error = new Error(reason);
    for (const pending of this.pending.values()) pending.reject(error);
    for (const completion of this.completions.values()) completion.reject(error);
    this.pending.clear();
    this.completions.clear();
    this.earlyCompletions.clear();
    this.subscribers.clear();
  }

  private async startRequest(
    command: "start" | "startNode",
    payload: WorkerInvokeArgs | WorkerInvokeNodeArgs,
  ): Promise<StartedWorkerRun> {
    const runRecord = await this.request(command, payload) as RunRecord;
    const early = this.earlyCompletions.get(runRecord.runId);
    if (early) {
      this.earlyCompletions.delete(runRecord.runId);
      return { runRecord, completed: Promise.resolve(early) };
    }
    const completed = new Promise<ExecuteResult>((resolve, reject) => {
      this.completions.set(runRecord.runId, { resolve, reject });
    });
    return { runRecord, completed };
  }

  private request(command: RuntimeWorkerCommand, payload: unknown): Promise<unknown> {
    const requestId = this.options.generateRequestId?.() ?? `worker_request_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.options.endpoint.postMessage({
        protocol: RUNTIME_WORKER_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        command,
        payload,
      } satisfies RuntimeWorkerRequest);
    });
  }

  private receive(value: unknown): void {
    if (!isRuntimeWorkerMessage(value)) return;
    if (value.kind === "response") {
      const pending = this.pending.get(value.requestId);
      if (!pending) return;
      this.pending.delete(value.requestId);
      if (value.ok) pending.resolve(value.value);
      else pending.reject(toError(value));
      return;
    }
    if (value.kind !== "event") return;
    if (value.event === "node_event") {
      for (const subscriber of this.subscribers) subscriber(value.value);
      return;
    }
    const runId = value.value.runRecord.runId;
    const completion = this.completions.get(runId);
    if (completion) {
      this.completions.delete(runId);
      completion.resolve(value.value);
    } else {
      this.earlyCompletions.set(runId, value.value);
    }
  }
}

function toError(response: RuntimeWorkerResponse): Error {
  const error = new Error(response.error?.message ?? "Runtime Worker request failed");
  error.name = response.error?.name ?? "RuntimeWorkerError";
  if (response.error?.code) Object.assign(error, { code: response.error.code });
  return error;
}
