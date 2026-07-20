/**
 * Server-Sent Events helpers for the Phase 2 streaming endpoints.
 *
 * SSE was chosen as the MVP streaming transport per
 * `docs/specs/transports.md` §8.1 and `docs/decisions/observability-model.md`
 * because:
 *
 *   - SSE has zero handshake overhead and works through every reverse
 *     proxy / browser without polyfill;
 *   - the framing matches `NodeEvent` 1:1: every event carries an
 *     `eventId` (used as the SSE `id:` field for native browser
 *     `EventSource` resume support), a `kind` (used as `event:`) and a
 *     JSON payload (used as `data:`);
 *   - the EventBus already exposes a `subscribe(runId, handler)` /
 *     `store.read(runId, { sinceEventId })` pair, so the SSE handler is
 *     a thin adapter that drains the cursor first then bridges live
 *     events.
 *
 * Two endpoints are wired in `handler.ts`:
 *
 *   GET /flows/:flowId/stream         - start a Run and stream its events;
 *                                       returns the runId on the very
 *                                       first SSE frame so the client can
 *                                       reconnect / cancel.
 *   GET /runs/:runId/events/stream    - subscribe to an existing Run
 *                                       (live + replay from cursor).
 *
 * Both honour `?cursor=<eventId>` for resume and the standard
 * `Last-Event-ID` request header (browser EventSource auto-resume).
 */

import type { EventBus, NodeEvent } from "@ai-native-flow/event-bus";

export interface SsePushOptions {
  /** Optional cursor to start *after*; defaults to "send everything". */
  cursor?: string;
  /** Cancellation hook (e.g. wired to `request.signal`). */
  signal?: AbortSignal;
  /** Heartbeat interval in ms; 0 disables. Defaults to 15000. */
  heartbeatMs?: number;
  /**
   * Stop streaming once the run reaches a terminal kind. Set to false to
   * keep the connection open for "live tail" debugging. Defaults to
   * true so a finished invoke closes its SSE response cleanly.
   */
  closeOnTerminal?: boolean;
  /** Called synchronously when response stream construction begins. */
  onStart?: () => void;
  /** Called after replay is drained and the live subscription is active. */
  onSubscribed?: () => void;
}

const TERMINAL_KINDS = new Set<NodeEvent["kind"]>([
  "run_finished",
  "run_failed",
  "run_cancelled",
]);

/**
 * Build a `Response` whose body is a `text/event-stream` of `NodeEvent`s.
 *
 * The function returns immediately with a streaming response; the actual
 * delivery happens asynchronously inside the ReadableStream's `start`.
 * That means HTTP frameworks (Node fetch-compatible handlers) get a fully formed
 * `Response` they can pipe to the socket without further glue.
 */
export function streamRunEvents(
  bus: EventBus,
  runId: string,
  options: SsePushOptions = {},
): Response {
  const closeOnTerminal = options.closeOnTerminal !== false;
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A newly created run must be active before the Response and its
      // x-nkg-run-id header become visible. Events emitted before the live
      // subscription are recovered by the replay and catch-up reads below.
      options.onStart?.();
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Controller closed underneath us (client disconnect).
          closed = true;
        }
      };
      const stopHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };
      const closeOnce = (): void => {
        if (closed) return;
        closed = true;
        if (unsubscribe) unsubscribe();
        stopHeartbeat();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      let lastSentEventId = options.cursor ?? "";
      const sendEvent = (event: NodeEvent): void => {
        if (closed) return;
        // Lexicographic ordering of `runId:000123` event ids matches
        // numeric ordering thanks to `formatEventId` (see eventStore).
        if (event.eventId <= lastSentEventId) return;
        lastSentEventId = event.eventId;
        const lines = [
          `id: ${event.eventId}`,
          `event: ${event.kind}`,
          `data: ${JSON.stringify(event)}`,
          "",
          "",
        ];
        safeEnqueue(encoder.encode(lines.join("\n")));
        if (closeOnTerminal && TERMINAL_KINDS.has(event.kind)) {
          closeOnce();
        }
      };

      // 1. Drain the persistent log first.
      const replay = await bus.store.read(runId, {
        ...(options.cursor !== undefined ? { sinceEventId: options.cursor } : {}),
      });
      for (const ev of replay) {
        sendEvent(ev);
        if (closed) return;
      }

      // 2. Switch to live delivery. Events that landed *between* the
      // store read and the subscribe call are picked up after subscribe
      // by the catch-up read below.
      unsubscribe = bus.subscribe(runId, (ev) => {
        sendEvent(ev);
      });
      options.onSubscribed?.();

      // 3. Heartbeat: SSE comments keep proxies from idling out and
      // give the client a way to detect a dead connection.
      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          safeEnqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        }, heartbeatMs);
      }

      const onAbort = (): void => closeOnce();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      // After replay we want to make sure we did not miss any events
      // that landed between `store.read` and `subscribe`. Re-read once
      // and forward anything past `lastSentEventId`.
      const catchUp = await bus.store.read(runId, {
        sinceEventId: lastSentEventId || undefined,
      });
      for (const ev of catchUp) {
        sendEvent(ev);
        if (closed) return;
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-nkg-run-id": runId,
      "access-control-expose-headers": "x-nkg-run-id",
    },
  });
}

/**
 * Pick the resume cursor from query string OR the `Last-Event-ID`
 * request header (which the browser `EventSource` auto-populates after
 * a reconnect).
 */
export function pickCursor(request: Request, url: URL): string | undefined {
  return (
    url.searchParams.get("cursor") ??
    request.headers.get("last-event-id") ??
    undefined
  );
}
