/**
 * Deterministic fake adapter used by tests. Yields a fixed sequence of
 * `AiStreamEvent`s without any I/O.
 *
 * Useful for both `ai-stream` unit tests and any consumer (e.g. the
 * `runtime` package's streaming llm node) that needs a hermetic provider
 * to validate `stream_open` / `stream_delta` / `stream_close` ordering.
 */

import type {
  AiStreamAdapter,
  AiStreamAdaptOptions,
  AiStreamAsyncIterable,
  AiStreamEvent,
} from "./types.js";

export class FakeStreamAdapter implements AiStreamAdapter<AiStreamEvent[]> {
  readonly id = "fake-stream";

  adapt(source: AiStreamEvent[], options: AiStreamAdaptOptions = {}): AiStreamAsyncIterable {
    return iterate(source, options);
  }
}

async function* iterate(
  events: AiStreamEvent[],
  options: AiStreamAdaptOptions,
): AsyncGenerator<AiStreamEvent, void, unknown> {
  for (const event of events) {
    if (options.signal?.aborted) return;
    options.tap?.(event);
    yield event;
  }
  // Always terminate with `done` so consumers can rely on it.
  if (events.length === 0 || events[events.length - 1]?.kind !== "done") {
    const doneEvent: AiStreamEvent = { kind: "done" };
    options.tap?.(doneEvent);
    yield doneEvent;
  }
}

/**
 * Convenience helper that turns a plain string into a streamed sequence
 * of `text_delta` events, optionally split by a `chunkSize`. Mirrors what
 * the test suite needs ("emit 'Hello, World' as 4-char chunks").
 */
export function fakeTextStream(
  text: string,
  options: { chunkSize?: number; usage?: { totalTokens: number } } = {},
): AiStreamEvent[] {
  const size = Math.max(1, options.chunkSize ?? 4);
  const events: AiStreamEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    events.push({ kind: "text_delta", text: text.slice(i, i + size) });
  }
  if (options.usage) {
    events.push({
      kind: "usage",
      totalTokens: options.usage.totalTokens,
    });
  }
  events.push({ kind: "done", text, finishReason: "stop" });
  return events;
}
