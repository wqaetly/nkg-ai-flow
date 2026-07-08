import type { NodeEvent } from "@ai-native-flow/event-bus";
import type {
  ExecuteResult,
  InvokeArgs,
  InvokeNodeArgs,
  ResumeFromPointArgs,
  RunRecord,
  Runtime,
  StartedRun,
} from "@ai-native-flow/runtime";

export interface CreateFlowSdkClientOptions {
  runtime: Runtime;
}

export interface SdkInvokeOptions {
  flowVersion?: string;
  traceId?: string;
}

export interface SdkStreamOptions extends SdkInvokeOptions {
  /** Start reading events after this event id. Mostly useful for resume tests. */
  cursor?: string;
  /** Abort local iteration. By default this also cancels the active run. */
  signal?: AbortSignal;
  /** Defaults to true when `signal` aborts. */
  cancelOnAbort?: boolean;
}

export interface SdkReadEventsOptions {
  cursor?: string;
  limit?: number;
}

export interface SdkReplayRunOptions extends SdkReadEventsOptions {}

export interface SdkWatchEventsOptions extends SdkReadEventsOptions {
  signal?: AbortSignal;
}

export interface SdkStartedRun {
  runRecord: RunRecord;
  completed: Promise<ExecuteResult>;
  events(options?: SdkWatchEventsOptions): AsyncIterable<NodeEvent>;
  cancel(reason?: string): Promise<void>;
}

export function createFlowSdkClient(
  options: CreateFlowSdkClientOptions,
): FlowSdkClient {
  return new FlowSdkClient(options.runtime);
}

/**
 * TypeScript SDK transport.
 *
 * This client is intentionally thin: it delegates invocation, cancellation,
 * inspection and event streaming to the same Runtime APIs used by HTTP. It
 * does not duplicate scheduler, ordering, or node-stream semantics.
 */
export class FlowSdkClient {
  constructor(private readonly runtime: Runtime) {}

  async invoke(
    flowId: string,
    input: unknown,
    options: SdkInvokeOptions = {},
  ): Promise<ExecuteResult> {
    return this.runtime.invocationRouter.invoke(
      toInvokeArgs(flowId, input, options),
    );
  }

  /**
   * Sub-graph ("sink-node") synchronous invocation. Runs the upstream
   * closure of `nodeId` and returns the sink's primary data output.
   * Mirrors `runtime.invocationRouter.invokeNode`; see its docblock
   * for the schema-bypass / flow-pin semantics.
   */
  async invokeNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: SdkInvokeOptions = {},
  ): Promise<ExecuteResult> {
    return this.runtime.invocationRouter.invokeNode(
      toInvokeNodeArgs(flowId, nodeId, input, options),
    );
  }

  async start(
    flowId: string,
    input: unknown,
    options: SdkInvokeOptions = {},
  ): Promise<SdkStartedRun> {
    const started = await this.runtime.invocationRouter.start(
      toInvokeArgs(flowId, input, options),
    );
    return this.wrapStartedRun(started);
  }

  /**
   * Two-phase sub-graph counterpart of `start()`. Returns the
   * `runRecord` synchronously (so callers can subscribe to events
   * before the engine emits anything) plus a `completed` promise.
   */
  async startNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: SdkInvokeOptions = {},
  ): Promise<SdkStartedRun> {
    const started = await this.runtime.invocationRouter.startNode(
      toInvokeNodeArgs(flowId, nodeId, input, options),
    );
    return this.wrapStartedRun(started);
  }

  /**
   * Resume a flow from a durable `resume_point` marker. The runtime
   * resolves the marker's target node and snapshot; callers only name
   * the flow and marker.
   */
  async resumeFromPoint(
    flowId: string,
    resumePointName: string,
    options: SdkInvokeOptions = {},
  ): Promise<ExecuteResult> {
    return this.runtime.invocationRouter.resumeFromPoint(
      toResumeFromPointArgs(flowId, resumePointName, options),
    );
  }

  async startFromPoint(
    flowId: string,
    resumePointName: string,
    options: SdkInvokeOptions = {},
  ): Promise<SdkStartedRun> {
    const started = await this.runtime.invocationRouter.startFromPoint(
      toResumeFromPointArgs(flowId, resumePointName, options),
    );
    return this.wrapStartedRun(started);
  }

  async *stream(
    flowId: string,
    input: unknown,
    options: SdkStreamOptions = {},
  ): AsyncIterable<NodeEvent> {
    const started = await this.start(flowId, input, options);
    yield* this.iterateStartedRun(started, options);
  }

  /**
   * Sub-graph variant of `stream()`. Starts a Run terminating at
   * `nodeId` and yields its events as they arrive, including the
   * terminal `run_finished` / `run_failed` / `run_cancelled` event.
   */
  async *streamNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: SdkStreamOptions = {},
  ): AsyncIterable<NodeEvent> {
    const started = await this.startNode(flowId, nodeId, input, options);
    yield* this.iterateStartedRun(started, options);
  }

  async *streamFromPoint(
    flowId: string,
    resumePointName: string,
    options: SdkStreamOptions = {},
  ): AsyncIterable<NodeEvent> {
    const started = await this.startFromPoint(flowId, resumePointName, options);
    yield* this.iterateStartedRun(started, options);
  }

  /**
   * Shared abort-aware iteration used by `stream()` and `streamNode()`.
   * Wires the caller's optional `signal` to `started.cancel()` (when
   * `cancelOnAbort` is true, the default) and ensures `completed`
   * resolves before iteration returns so callers cannot leak the
   * underlying engine task.
   */
  private async *iterateStartedRun(
    started: SdkStartedRun,
    options: SdkStreamOptions,
  ): AsyncIterable<NodeEvent> {
    let removeAbortListener: (() => void) | undefined;

    if (options.signal) {
      const cancelOnAbort = options.cancelOnAbort ?? true;
      const onAbort = () => {
        if (!cancelOnAbort) return;
        void started.cancel("sdk stream aborted").catch(() => {
          /* The run may already be terminal. */
        });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        options.signal?.removeEventListener("abort", onAbort);
    }

    try {
      yield* started.events({
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } finally {
      removeAbortListener?.();
      await started.completed.catch(() => undefined);
    }
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runtime.runManager.get(runId);
  }

  async events(
    runId: string,
    options: SdkReadEventsOptions = {},
  ): Promise<NodeEvent[]> {
    return this.runtime.eventBus.store.read(runId, {
      ...(options.cursor !== undefined ? { sinceEventId: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  async replayRun(
    runId: string,
    options: SdkReplayRunOptions = {},
  ): Promise<NodeEvent[]> {
    return this.events(runId, options);
  }

  async *watchRunEvents(
    runId: string,
    options: SdkWatchEventsOptions = {},
  ): AsyncIterable<NodeEvent> {
    const seen = new Set<string>();
    const queue: NodeEvent[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;

    const signal = options.signal;
    const wakeIterator = () => {
      wake?.();
      wake = undefined;
    };
    const stop = () => {
      stopped = true;
      wakeIterator();
    };

    if (signal?.aborted) return;
    signal?.addEventListener("abort", stop, { once: true });

    const unsubscribe = this.runtime.eventBus.subscribe(runId, (event) => {
      queue.push(event);
      wakeIterator();
    });

    try {
      const history = await this.events(runId, options);
      for (const event of history) {
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        yield event;
        if (isTerminalEvent(event)) return;
      }

      while (!stopped) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

        while (queue.length > 0) {
          const event = queue.shift()!;
          if (seen.has(event.eventId)) continue;
          seen.add(event.eventId);
          yield event;
          if (isTerminalEvent(event)) return;
        }
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", stop);
    }
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    await this.runtime.runManager.cancel(runId, reason);
  }

  private wrapStartedRun(started: StartedRun): SdkStartedRun {
    const runId = started.runRecord.runId;
    return {
      runRecord: started.runRecord,
      completed: started.completed,
      events: (options?: SdkWatchEventsOptions) =>
        this.watchRunEvents(runId, options),
      cancel: (reason?: string) => this.cancel(runId, reason),
    };
  }
}

export function isTerminalEvent(event: NodeEvent): boolean {
  return (
    event.kind === "run_finished" ||
    event.kind === "run_failed" ||
    event.kind === "run_cancelled"
  );
}

function toInvokeArgs(
  flowId: string,
  input: unknown,
  options: SdkInvokeOptions,
): InvokeArgs {
  return {
    flowId,
    input,
    ...(options.flowVersion !== undefined
      ? { flowVersion: options.flowVersion }
      : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
  };
}

function toInvokeNodeArgs(
  flowId: string,
  nodeId: string,
  input: unknown,
  options: SdkInvokeOptions,
): InvokeNodeArgs {
  return {
    flowId,
    nodeId,
    input,
    ...(options.flowVersion !== undefined
      ? { flowVersion: options.flowVersion }
      : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
  };
}

function toResumeFromPointArgs(
  flowId: string,
  resumePointName: string,
  options: SdkInvokeOptions,
): ResumeFromPointArgs {
  return {
    flowId,
    resumePointName,
    ...(options.flowVersion !== undefined
      ? { flowVersion: options.flowVersion }
      : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
  };
}
