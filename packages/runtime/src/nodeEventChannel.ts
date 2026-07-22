/**
 * Node Event Channel.
 *
 * Phase 2 introduces a single ingress for *every* event a node logic wants
 * to surface: lifecycle markers (node_started / node_finished /
 * node_error), structured logs (node_log), token streams
 * (stream_open / stream_delta / stream_close), tool calls and arbitrary
 * artifacts (stream_artifact / stream_usage). The channel is the only
 * authority that:
 *
 *   - assigns the per-(node, attempt) `seq`,
 *   - records the `streamId` for each in-flight stream so the engine can
 *     guarantee one `stream_close` per `stream_open`,
 *   - applies per-stream backpressure via a `highWaterMark`,
 *   - blocks node logic that emits faster than downstream subscribers can
 *     persist events (see `docs/specs/streaming-and-node-communication.md`
 *     §"背压、取消与恢复").
 *
 * The channel is internal to the Runtime package; nodes interact with it
 * only through the slimmer `NodeContext.emit` / `NodeContext.stream`
 * surface defined in `nodeContext.ts`. Transports keep consuming the
 * `EventBus` exactly as they did in Phase 1 - the channel writes events
 * via `eventBus.publish` and never bypasses persistence.
 */

import type { AppendEventInput, EventBus, NodeEvent, NodeEventKind } from "@ai-native-flow/event-bus";

/**
 * Bag of identity fields that every event the channel publishes shares.
 * The execution engine constructs one channel per (node, attempt) and
 * passes the rest of the metadata in.
 */
export interface NodeEventChannelOptions {
  eventBus: EventBus;
  runId: string;
  flowId: string;
  flowVersion: string;
  traceId?: string;
  nodeId: string;
  nodeVersion: string;
  attempt: number;
  /**
   * Reserved seq numbers consumed by the engine itself. The engine emits
   * `node_started` with seq 1 and either `node_finished` or `node_error`
   * with seq 2, so user-visible events start at 3 by default. Pass a
   * higher value if the engine ever reserves more slots.
   */
  initialSeq?: number;
  /**
   * Per-stream backpressure threshold. Once this many `stream_delta`
   * frames are in flight (queued for persistence) on a single stream,
   * `write()` resolves only when the queue drains under the threshold.
   * Defaults to 64 which is conservative but enough for token streams.
   */
  defaultHighWaterMark?: number;
  /** Called after a node event is durably published, for timeout activity tracking. */
  onActivity?: (event: { kind: NodeEventKind; payload?: unknown }) => void;
}

/** Options accepted by `ctx.stream("portId", options)`. */
export interface NodeStreamOptions {
  /** Optional explicit stream id; defaults to `<portId>-<seq>`. */
  streamId?: string;
  /** MIME-like content-type tag for downstream renderers. */
  contentType?: string;
  /** Free-form metadata included on `stream_open`. */
  metadata?: Record<string, unknown>;
  /** Override the channel's `defaultHighWaterMark` for this stream. */
  highWaterMark?: number;
  /** Optional `traceId` propagated onto every chunk. */
  traceId?: string;
}

/**
 * Public stream handle returned to node logic. Mirrors the contract in
 * `docs/specs/streaming-and-node-communication.md` §"Node SDK 流接口".
 */
export interface NodeOutputStream {
  readonly id: string;
  readonly portId: string;
  /** Send a single `stream_delta` chunk. */
  write(chunk: unknown): Promise<void>;
  /** Close the stream with an optional final payload. */
  close(finalPayload?: unknown): Promise<void>;
  /**
   * Close the stream with an error. Emits `stream_close` with a `failed`
   * marker; the engine still wraps the surrounding `node_error` event.
   */
  fail(error: unknown): Promise<void>;
}

/**
 * Subset of `NodeEvent` a node logic is allowed to emit explicitly. The
 * channel forbids overriding `seq`, identity fields and timestamp because
 * those are channel-owned.
 */
export type NodeEmitInput = Omit<
  AppendEventInput,
  | "runId"
  | "flowId"
  | "flowVersion"
  | "nodeId"
  | "nodeVersion"
  | "attempt"
  | "seq"
  | "timestamp"
  | "eventId"
>;

/**
 * Internal helper: a Promise + resolver pair, used to express
 * "downstream is ready to accept more chunks".
 */
interface Pending {
  promise: Promise<void>;
  resolve: () => void;
}

interface StreamState {
  id: string;
  portId: string;
  inFlight: number;
  highWaterMark: number;
  drainWaiters: Pending[];
  closed: boolean;
}

/**
 * Concrete channel used by the ExecutionEngine to back `ctx.emit` /
 * `ctx.stream`. Tests should generally use the engine end-to-end rather
 * than instantiate this directly, but it can be unit-tested in isolation
 * (see `runtime.streaming.test.ts`).
 */
export class NodeEventChannel {
  private seqCounter: number;
  private readonly streams = new Map<string, StreamState>();
  private readonly defaultHighWaterMark: number;

  constructor(private readonly options: NodeEventChannelOptions) {
    this.seqCounter = options.initialSeq ?? 3;
    this.defaultHighWaterMark = options.defaultHighWaterMark ?? 64;
  }

  /** True once every opened stream has been closed via `close()` / `fail()`. */
  get allStreamsClosed(): boolean {
    for (const s of this.streams.values()) if (!s.closed) return false;
    return true;
  }

  /** Snapshot of the still-open stream ids (for diagnostics in error paths). */
  openStreamIds(): string[] {
    const ids: string[] = [];
    for (const [, s] of this.streams) if (!s.closed) ids.push(s.id);
    return ids;
  }

  /**
   * Direct `emit` for arbitrary node events (e.g. `tool_call_*`,
   * `stream_artifact`, `node_warning`).
   */
  async emit(event: NodeEmitInput): Promise<NodeEvent> {
    return this.publishWithSeq(this.nextSeq(), event);
  }

  /**
   * Open a new output stream. Emits `stream_open` synchronously (well,
   * asynchronously - the caller awaits the persistence) and returns a
   * handle that produces `stream_delta` / `stream_close` events.
   */
  async stream(portId: string, options: NodeStreamOptions = {}): Promise<NodeOutputStream> {
    const seq = this.nextSeq();
    const streamId = options.streamId ?? `${portId}-${seq}`;
    if (this.streams.has(streamId)) {
      throw new Error(`stream ${streamId} already open on node ${this.options.nodeId}`);
    }
    const state: StreamState = {
      id: streamId,
      portId,
      inFlight: 0,
      highWaterMark: options.highWaterMark ?? this.defaultHighWaterMark,
      drainWaiters: [],
      closed: false,
    };
    this.streams.set(streamId, state);

    await this.publishWithSeq(seq, {
      kind: "stream_open",
      portId,
      streamId,
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      payload: {
        contentType: options.contentType ?? "application/octet-stream",
        metadata: options.metadata ?? {},
      },
    });

    const channel = this;
    const handle: NodeOutputStream = {
      id: streamId,
      portId,
      async write(chunk: unknown): Promise<void> {
        if (state.closed) {
          throw new Error(`stream ${streamId} is already closed`);
        }
        // Backpressure: when `inFlight` exceeds the HWM, hold the writer
        // until the persistence queue drains. The engine still services
        // other deltas serially; this only slows the producing node.
        if (state.inFlight >= state.highWaterMark) {
          await channel.waitForDrain(state);
        }
        state.inFlight += 1;
        try {
          await channel.publishWithSeq(channel.nextSeq(), {
            kind: "stream_delta",
            portId,
            streamId,
            payload: chunk,
          });
        } finally {
          state.inFlight -= 1;
          channel.notifyDrain(state);
        }
      },
      async close(finalPayload?: unknown): Promise<void> {
        if (state.closed) return;
        state.closed = true;
        await channel.publishWithSeq(channel.nextSeq(), {
          kind: "stream_close",
          portId,
          streamId,
          payload: { final: finalPayload ?? null, status: "ok" },
        });
        channel.releaseDrainWaiters(state);
      },
      async fail(cause: unknown): Promise<void> {
        if (state.closed) return;
        state.closed = true;
        const message = cause instanceof Error ? cause.message : String(cause);
        await channel.publishWithSeq(channel.nextSeq(), {
          kind: "stream_close",
          portId,
          streamId,
          payload: { status: "failed", error: { message } },
        });
        channel.releaseDrainWaiters(state);
      },
    };
    return handle;
  }

  /**
   * Force-close every still-open stream. Called by the engine when the
   * node logic returned without closing its streams: the engine emits a
   * `stream_close` with `status: "auto"` so transports do not hang on
   * partial state.
   */
  async closeOpenStreams(reason: "auto" | "cancelled" | "errored"): Promise<void> {
    for (const state of this.streams.values()) {
      if (state.closed) continue;
      state.closed = true;
      await this.publishWithSeq(this.nextSeq(), {
        kind: "stream_close",
        portId: state.portId,
        streamId: state.id,
        payload: { status: reason },
      });
      this.releaseDrainWaiters(state);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                               */
  /* ---------------------------------------------------------------------- */

  private nextSeq(): number {
    return this.seqCounter++;
  }

  private async publishWithSeq(
    seq: number,
    event: { kind: NodeEventKind } & Omit<NodeEmitInput, "kind">,
  ): Promise<NodeEvent> {
    const published = await this.options.eventBus.publish({
      ...event,
      runId: this.options.runId,
      flowId: this.options.flowId,
      flowVersion: this.options.flowVersion,
      ...(this.options.traceId !== undefined ? { traceId: this.options.traceId } : {}),
      nodeId: this.options.nodeId,
      nodeVersion: this.options.nodeVersion,
      attempt: this.options.attempt,
      seq,
    });
    this.options.onActivity?.({ kind: event.kind, payload: event.payload });
    return published;
  }

  private waitForDrain(state: StreamState): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    state.drainWaiters.push({ promise, resolve });
    return promise;
  }

  private notifyDrain(state: StreamState): void {
    if (state.inFlight >= state.highWaterMark) return;
    const next = state.drainWaiters.shift();
    if (next) next.resolve();
  }

  private releaseDrainWaiters(state: StreamState): void {
    for (const waiter of state.drainWaiters) waiter.resolve();
    state.drainWaiters.length = 0;
  }
}
