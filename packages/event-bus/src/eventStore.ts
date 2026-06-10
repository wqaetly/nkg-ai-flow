/**
 * Persistent Event Store abstraction.
 *
 * The Event Store is the source of truth for a Run's event history. Per
 * `docs/specs/storage.md`, transports never touch node processes - they
 * subscribe to the bus or read from the store via cursor. The store
 * therefore owns:
 *   - assignment of the global `eventId` cursor (monotonic per runId),
 *   - append-only persistence,
 *   - cursor-based read (`since` / `cursor`),
 *   - optional schema version tagging (per-Run, written once at Run
 *     creation time, see `docs/decisions/schema-versioning.md` §3).
 *
 * Phase 1 ships an in-memory implementation that is sufficient for tests
 * and the HTTP transport MVP. A SQLite-backed implementation lives in the
 * `runtime` package's `storage/` module.
 */

import type { NodeEvent } from "./types.js";

export interface AppendEventInput
  extends Omit<NodeEvent, "eventId" | "timestamp"> {
  /** Optional pre-assigned timestamp (defaults to `new Date().toISOString()`). */
  timestamp?: string;
}

export interface EventStore {
  /**
   * Append a single event. The store assigns `eventId` and (if missing)
   * `timestamp`. Returns the persisted event.
   */
  append(event: AppendEventInput): Promise<NodeEvent>;

  /**
   * Read all events for a run, optionally starting *after* a given cursor.
   * Results must be ordered by ascending `eventId`.
   */
  read(runId: string, options?: { sinceEventId?: string; limit?: number }): Promise<NodeEvent[]>;

  /** Total number of events stored for a run. */
  size(runId: string): Promise<number>;
}

/**
 * Pure in-memory implementation. Cursors are zero-padded counters per run
 * so that lexicographic ordering matches numeric ordering, which is what
 * the SSE `cursor=` query parameter relies on later.
 */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, NodeEvent[]>();
  private readonly counters = new Map<string, number>();

  async append(event: AppendEventInput): Promise<NodeEvent> {
    const next = (this.counters.get(event.runId) ?? 0) + 1;
    this.counters.set(event.runId, next);
    const eventId = formatEventId(event.runId, next);
    const persisted: NodeEvent = {
      ...event,
      eventId,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    let bucket = this.events.get(event.runId);
    if (!bucket) {
      bucket = [];
      this.events.set(event.runId, bucket);
    }
    bucket.push(persisted);
    return persisted;
  }

  async read(
    runId: string,
    options: { sinceEventId?: string; limit?: number } = {},
  ): Promise<NodeEvent[]> {
    const bucket = this.events.get(runId) ?? [];
    let start = 0;
    if (options.sinceEventId) {
      const idx = bucket.findIndex((e) => e.eventId === options.sinceEventId);
      start = idx < 0 ? bucket.length : idx + 1;
    }
    const slice = bucket.slice(start);
    return options.limit ? slice.slice(0, options.limit) : slice;
  }

  async size(runId: string): Promise<number> {
    return this.events.get(runId)?.length ?? 0;
  }
}

/**
 * Format an event id as `<runId>:<seq6>`. The 6-digit zero-padded suffix
 * keeps lexicographic and numeric ordering aligned for the first one
 * million events of a run, which is far beyond the MVP needs.
 */
export function formatEventId(runId: string, seq: number): string {
  return `${runId}:${seq.toString().padStart(6, "0")}`;
}

/** Parse the numeric seq part of an event id; returns NaN on failure. */
export function parseEventIdSeq(eventId: string): number {
  const colon = eventId.lastIndexOf(":");
  if (colon < 0) return Number.NaN;
  return Number.parseInt(eventId.slice(colon + 1), 10);
}
