/**
 * Runtime Event Bus.
 *
 * Phase 1 responsibilities (the minimum needed by HTTP invoke + DAG run):
 *   - Persist every event to an `EventStore` *before* fan-out, so a
 *     transport that subscribes after a run completes can still replay via
 *     cursor (DoD: HTTP invoke returns final output for a simple flow).
 *   - Allow Phase 2 to add live SSE subscribers on top of the same bus
 *     without changing producers.
 *
 * The contract is intentionally narrow: a `publish(event)` that returns the
 * persisted `NodeEvent`, plus a `subscribe(runId, handler)` for live
 * delivery (the persistent log is the durable channel).
 */

import type { AppendEventInput, EventStore } from "./eventStore.js";
import { InMemoryEventStore } from "./eventStore.js";
import type { NodeEvent } from "./types.js";

export type EventHandler = (event: NodeEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: AppendEventInput): Promise<NodeEvent>;
  subscribe(runId: string, handler: EventHandler): Unsubscribe;
  /** Convenience accessor for cursor reads. */
  readonly store: EventStore;
}

export class InMemoryEventBus implements EventBus {
  readonly store: EventStore;
  private readonly subscribers = new Map<string, Set<EventHandler>>();
  /** Wildcard subscribers: notified for every run. Used by tests / debug. */
  private readonly globalSubscribers = new Set<EventHandler>();

  constructor(store?: EventStore) {
    this.store = store ?? new InMemoryEventStore();
  }

  async publish(event: AppendEventInput): Promise<NodeEvent> {
    const persisted = await this.store.append(event);
    await this.fanOut(persisted);
    return persisted;
  }

  subscribe(runId: string, handler: EventHandler): Unsubscribe {
    const key = runId === "*" ? undefined : runId;
    if (key === undefined) {
      this.globalSubscribers.add(handler);
      return () => this.globalSubscribers.delete(handler);
    }
    let bucket = this.subscribers.get(key);
    if (!bucket) {
      bucket = new Set();
      this.subscribers.set(key, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket!.delete(handler);
      if (bucket!.size === 0) this.subscribers.delete(key);
    };
  }

  private async fanOut(event: NodeEvent): Promise<void> {
    // We deliberately swallow handler errors so that one buggy subscriber
    // (e.g. a disconnected SSE stream) cannot break Run execution. They are
    // surfaced as `transport_error` events by the transport layer in
    // Phase 2.
    const targets: EventHandler[] = [];
    const bucket = this.subscribers.get(event.runId);
    if (bucket) targets.push(...bucket);
    if (this.globalSubscribers.size > 0) {
      targets.push(...this.globalSubscribers);
    }
    for (const handler of targets) {
      try {
        await handler(event);
      } catch {
        /* see comment above */
      }
    }
  }
}
