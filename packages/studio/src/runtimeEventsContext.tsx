/**
 * Runtime events channel — a tiny, generic pub/sub bridge between the
 * runtime-side controller (`FlowRunController`, the SSE producer) and
 * the canvas-side state (`ReactFlowStudio`, which folds events into
 * `state.events` so per-node `status` / `runtime` derive correctly).
 *
 * Why a context+subscriber pattern instead of props/refs?
 *
 *   - The two parties are already nested via the workbench's render-prop
 *     wiring (`<FlowRunController>{() => <ReactFlowStudio/>}</>`),
 *     so a Provider naturally covers the right subtree without any
 *     plumbing in `StudioWorkbench`.
 *   - Imperative refs would force the host to forwardRef + manage a
 *     handle; an `onEvents` prop would push the responsibility onto
 *     the host to merge into state. Both leak runtime concerns into
 *     editor code.
 *   - Pub/sub is broadcast by construction: any future runtime-aware
 *     companion (Outline panel, stream inspector tab, mini-map
 *     decorator) can subscribe to the same channel without further
 *     wiring.
 *
 * The channel carries pre-converted `NodeEvent`s so consumers don't
 * need to know about the SSE wire format (`RuntimeEvent`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { NodeEvent } from "@ai-native-flow/event-bus";

export type RuntimeEventsListener = (events: ReadonlyArray<NodeEvent>) => void;

export interface RuntimeEventsChannel {
  /** Push a batch of events to all current subscribers. */
  publish: (events: ReadonlyArray<NodeEvent>) => void;
  /** Register a listener; returns a disposer. */
  subscribe: (listener: RuntimeEventsListener) => () => void;
}

const RuntimeEventsContext = createContext<RuntimeEventsChannel | null>(null);

/**
 * Provider that owns the listener set. Identity-stable across renders
 * so consumers' `useEffect` subscriptions don't churn.
 */
export function RuntimeEventsProvider({ children }: { children: ReactNode }) {
  const listenersRef = useRef(new Set<RuntimeEventsListener>());

  const publish = useCallback((events: ReadonlyArray<NodeEvent>) => {
    if (events.length === 0) return;
    // Snapshot before iterating so a listener that unsubscribes
    // synchronously during dispatch can't mutate the live set.
    for (const listener of [...listenersRef.current]) {
      try {
        listener(events);
      } catch (err) {
        // Listener bugs must not break the publisher; surface and continue.
        console.error("[runtime-events] listener threw", err);
      }
    }
  }, []);

  const subscribe = useCallback((listener: RuntimeEventsListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const channel = useMemo<RuntimeEventsChannel>(
    () => ({ publish, subscribe }),
    [publish, subscribe],
  );

  return (
    <RuntimeEventsContext.Provider value={channel}>
      {children}
    </RuntimeEventsContext.Provider>
  );
}

/**
 * Producer-side hook. Returns a stable `publish` callback. When no
 * provider is mounted (e.g. ReactFlowStudio used standalone outside
 * the workbench) this is a no-op so callers don't need to guard.
 */
export function useRuntimeEventsPublisher(): (events: ReadonlyArray<NodeEvent>) => void {
  const channel = useContext(RuntimeEventsContext);
  return useCallback(
    (events: ReadonlyArray<NodeEvent>) => {
      channel?.publish(events);
    },
    [channel],
  );
}

/**
 * Consumer-side hook. Subscribes for the lifetime of the calling
 * component. The listener identity is captured per-render via a ref
 * so callers can pass inline closures without re-subscribing.
 */
export function useRuntimeEventsSubscription(listener: RuntimeEventsListener): void {
  const channel = useContext(RuntimeEventsContext);
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    if (!channel) return;
    return channel.subscribe((events) => ref.current(events));
  }, [channel]);
}
