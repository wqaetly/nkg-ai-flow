/**
 * `FlowRunController` is the per-tab orchestrator that owns the run
 * state for a single flow inside the workbench.
 *
 * Responsibilities:
 *   - Render the floating run toolbar (top-left of the canvas) with
 *     Run / Stop affordances, plus the Sidebar / Console toggles that
 *     used to live in the workbench title bar.
 *   - Render the per-node right-click context menu when the canvas
 *     forwards a `nodeId` + screen coords.
 *   - Talk to the sidecar via `SidecarClient` and surface every event
 *     into the workbench's console panel via the injected `appendLog`
 *     callback.
 *
 * It deliberately does NOT mutate flow state \u2014 cancel / stop only
 * affects the run, never the underlying graph. Studio remains a pure
 * editor; runs are observable side-effects layered on top.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FlowGraph } from "@ai-native-flow/flow-ir";
import type { NodeEvent, NodeEventKind } from "@ai-native-flow/event-bus";
import {
  SidecarClient,
  type EnvOverrides,
  type RunHandle,
  type RuntimeEvent,
} from "./httpClient.js";
import {
  RuntimeEventsProvider,
  useRuntimeEventsPublisher,
} from "./runtimeEventsContext.js";

export type RunStatus = "idle" | "uploading" | "running" | "succeeded" | "failed" | "cancelled";

export interface FlowRunControllerProps {
  /** The flow currently displayed in the canvas; used to compile/upload. */
  graph: FlowGraph;
  /** Sidecar base URL chosen by the workbench. */
  sidecarUrl: string;
  /** Run-scoped environment variables/secrets chosen by the workbench. */
  envOverrides?: EnvOverrides;
  /** Workbench-supplied console sink; one line per call. */
  appendLog: (level: "info" | "warn" | "error" | "debug", message: string) => void;
  /** Toggle Sidebar from the floating toolbar (replaces the old titlebar btn). */
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  /** Toggle Console from the floating toolbar. */
  onToggleConsole: () => void;
  consoleOpen: boolean;
  /**
   * Save the current flow to disk (or wherever the workbench decides).
   * The browser shell wires this up to a JSON download. Optional so
   * stand-alone hosts that don't expose a save action can omit it.
   */
  onSave?: () => void;
  /**
   * Render-prop: the workbench wires the canvas to receive a
   * `headerSlot` from this controller (for the floating toolbar) and a
   * right-click `onNodeContextMenu` handler. Per-node running
   * decorations were intentionally removed — the existing
   * `.anf-node-status` dot already conveys state via color and the
   * sibling runtime timer renders ms duration underneath it.
   */
  children: (slots: {
    headerSlot: ReactNode;
    onNodeContextMenu: (nodeId: string, coords: { x: number; y: number }) => void;
  }) => ReactNode;
}

interface MenuState {
  nodeId: string;
  x: number;
  y: number;
}

/**
 * Local, dependency-free flow registration: Studio compiles the graph
 * to a FlowGraph and POSTs an upload via the sidecar's
 * `/flows/:id/register-and-promote` endpoint shim. The sidecar exposes
 * this convenience route so we don't need a separate registry handler
 * here \u2014 it just calls `runtime.registry.register({ ... })` then
 * `promote(id, version)` and returns 204.
 */
async function registerFlow(
  baseUrl: string,
  graph: FlowGraph,
): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/flows/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ graph }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 404 here almost always means the sidecar predates the
    // /flows/register route. Surface a hint instead of the bare
    // status — first-time users hit this constantly when they
    // forgot to restart the Node sidecar after pulling.
    if (res.status === 404) {
      throw new Error(
        `Register failed (404): the sidecar at ${baseUrl} does not expose ` +
          `POST /flows/register. Restart it (\`npm run dev:backend\`) so it picks ` +
          `up the new route.`,
      );
    }    throw new Error(`Register failed (${res.status}): ${text || res.statusText}`);
  }
}

/**
 * Public component. Wraps the actual controller in a
 * {@link RuntimeEventsProvider} so the canvas subtree (rendered via
 * the `children` render-prop) can subscribe to live runtime events
 * without any extra plumbing in the host workbench.
 */
export function FlowRunController(props: FlowRunControllerProps) {
  return (
    <RuntimeEventsProvider>
      <FlowRunControllerInner {...props} />
    </RuntimeEventsProvider>
  );
}

function FlowRunControllerInner({
  graph,
  sidecarUrl,
  envOverrides,
  appendLog,
  onToggleSidebar,
  sidebarOpen,
  onToggleConsole,
  consoleOpen,
  onSave,
  children,
}: FlowRunControllerProps) {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const handleRef = useRef<RunHandle | null>(null);

  // Per-run monotonic sequence for synthesised NodeEvents. The wire
  // protocol's `RuntimeEvent` doesn't carry `seq`, but downstream
  // consumers (createRunTimeline, deriveNodeStatusFromEvents) rely on
  // a stable ordering so we mint one ourselves. Reset on each new run
  // so replays start from 0 — matches the invariant the runtime would
  // emit if we asked the sidecar for the canonical NodeEvent stream.
  const seqRef = useRef(0);

  // Publisher into the canvas-side runtime events channel. Identity is
  // stable thanks to the context impl, so handleEvent's deps stay tidy.
  const publishEvents = useRuntimeEventsPublisher();

  // Reconstruct the client every time the URL changes so tests / users
  // who reconfigure the sidecar mid-session pick up the new endpoint.
  const client = useMemo(() => new SidecarClient({ baseUrl: sidecarUrl }), [sidecarUrl]);

  // Tear down any in-flight stream when this controller unmounts (tab
  // close, flow swap). Not cancelling here would leave an SSE socket
  // dangling and the run completing in the background unobserved.
  useEffect(() => {
    return () => {
      handleRef.current?.cancel().catch(() => undefined);
      handleRef.current = null;
    };
  }, []);

  /** Internal: bridge a runtime event into the workbench console + status. */
  const handleEvent = useCallback(
    (event: RuntimeEvent) => {
      // First, fan the event out to the canvas via the runtime-events
      // channel. We do this before the console / status switch so that
      // even if a future case below early-returns the canvas still
      // sees the event and can paint per-node status/timer correctly.
      const converted = toNodeEvent(event, graph, seqRef);
      if (converted) publishEvents([converted]);

      const node = event.nodeId ? `[${event.nodeId}] ` : "";
      switch (event.kind) {
        case "run_started":
          // New run begins → reset the synthetic seq counter so each
          // run's events form their own monotonic stream.
          seqRef.current = 0;
          appendLog("info", `${node}\u25B6 run ${event.runId} started`);
          setStatus("running");
          break;
        case "run_finished":
          appendLog(
            "info",
            `${node}\u2713 run ${event.runId} finished\u2003output=${formatPayload(event.payload, "output")}`,
          );
          setStatus("succeeded");
          setActiveNodeId(undefined);
          break;
        case "run_failed":
          appendLog(
            "error",
            `${node}\u2717 run ${event.runId} failed\u2003${formatPayload(event.payload, "error")}`,
          );
          setStatus("failed");
          setActiveNodeId(undefined);
          break;
        case "run_cancelled":
          appendLog("warn", `${node}run ${event.runId} cancelled`);
          setStatus("cancelled");
          setActiveNodeId(undefined);
          break;
        case "node_started":
          appendLog("debug", `${node}\u2192 starting`);
          break;
        case "node_finished": {
          // Surface the node's primary data output so users can see, for
          // example, the LLM `result` field even when the node is run
          // without `stream: true`. Falls back to a JSON dump for nodes
          // whose primary output is not a plain string (e.g. http body
          // objects, transform records).
          const output = (event.payload as { output?: unknown } | undefined)
            ?.output;
          let text = "";
          if (output && typeof output === "object") {
            const rec = output as Record<string, unknown>;
            if (typeof rec.result === "string") {
              text = rec.result;
            } else {
              try {
                text = JSON.stringify(rec);
              } catch {
                text = String(rec);
              }
            }
          } else if (output !== undefined && output !== null) {
            text = String(output);
          }
          if (text) {
            appendLog("info", `${node}\u2190 ${text}`);
          } else {
            appendLog("debug", `${node}\u2190 finished`);
          }
          break;
        }
        case "node_failed":
          appendLog("error", `${node}node failed: ${formatPayload(event.payload, "error")}`);
          break;
        case "node_log": {
          const level = (event.payload?.level as "info" | "warn" | "error" | "debug") ?? "info";
          const msg = (event.payload?.message as string) ?? "";
          appendLog(level, `${node}${msg}`);
          break;
        }
        // stream_delta / stream_open / stream_close / stream_usage are
        // intentionally quiet: the full aggregated text is already
        // surfaced via the `node_finished` branch above, so echoing
        // every token would just spam the Console with duplicates.
        default:
          break;
      }
    },
    [appendLog, graph, publishEvents],
  );

  const handleError = useCallback(
    (err: Error) => {
      appendLog("error", `[stream] ${err.message}`);
    },
    [appendLog],
  );

  /** Common path for both "Run flow" and "Run node". */
  const startRun = useCallback(
    async (mode: "flow" | "node", nodeId?: string) => {
      if (status === "running" || status === "uploading") return;
      try {
        setStatus("uploading");
        appendLog("info", `[studio] uploading flow ${graph.id}@${graph.version}\u2026`);
        await registerFlow(sidecarUrl, graph);
        if (mode === "node" && nodeId) setActiveNodeId(nodeId);
        else setActiveNodeId(undefined);

        const callbacks = { onEvent: handleEvent, onError: handleError };
        const handle =
          mode === "flow"
            ? client.streamFlow(graph.id, null, callbacks, undefined, envOverrides)
            : client.streamNode(graph.id, nodeId!, null, callbacks, undefined, envOverrides);
        handleRef.current = handle;
      } catch (err) {
        appendLog("error", `[studio] ${(err as Error).message}`);
        setStatus("failed");
        setActiveNodeId(undefined);
      }
    },
    [appendLog, client, envOverrides, graph, handleError, handleEvent, sidecarUrl, status],
  );

  const stop = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    appendLog("warn", "[studio] cancel requested");
    await handle.cancel();
    handleRef.current = null;
    // Status will flip to "cancelled" via the run_cancelled event; we
    // don't anticipate it here in case the server completes between the
    // POST cancel and the SSE close (a race we tolerate).
  }, [appendLog]);

  /* ----------------------------- UI fragments ----------------------------- */

  const headerSlot = (
    <div className="anf-run-toolbar" role="toolbar" aria-label="Run controls">
      <button
        type="button"
        className="anf-run-toolbar-btn"
        onClick={() => void startRun("flow")}
        disabled={status === "running" || status === "uploading"}
        title="Run this flow"
        aria-label="Run this flow"
      >
        <IconPlay />
      </button>
      <button
        type="button"
        className="anf-run-toolbar-btn"
        onClick={() => void stop()}
        disabled={status !== "running" && status !== "uploading"}
        title={status === "running" ? "Stop this run" : "No active run"}
        aria-label="Stop this run"
      >
        <IconStop />
      </button>
      {onSave ? (
        <button
          type="button"
          className="anf-run-toolbar-btn"
          onClick={onSave}
          title="Save flow as JSON"
          aria-label="Save flow as JSON"
        >
          <IconSave />
        </button>
      ) : null}
      <span className="anf-run-toolbar-sep" />
      <button
        type="button"
        className={`anf-run-toolbar-btn ${sidebarOpen ? "is-active" : ""}`}
        onClick={onToggleSidebar}
        title={sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
        aria-label={sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
      >
        <IconSidebarLeft />
      </button>
      <button
        type="button"
        className={`anf-run-toolbar-btn ${consoleOpen ? "is-active" : ""}`}
        onClick={onToggleConsole}
        title={consoleOpen ? "Hide Console" : "Show Console"}
        aria-label={consoleOpen ? "Hide Console" : "Show Console"}
      >
        <IconConsole />
      </button>
    </div>
  );

  const onNodeContextMenu = useCallback(
    (nodeId: string, coords: { x: number; y: number }) => {
      setMenu({ nodeId, x: coords.x, y: coords.y });
    },
    [],
  );

  // Close the menu on any outside click / Escape. We attach listeners
  // only while the menu is open to avoid global noise.
  //
  // Capture phase + DOM marker (data-anf-menu="node") so ReactFlow's
  // own pane/node mousedown handlers — some of which call
  // stopPropagation() — cannot accidentally swallow the event before
  // we see it. See the matching comment in ReactFlowStudio for the
  // add-node menu.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && target.closest("[data-anf-menu='node']")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  return (
    <>
      {children({ headerSlot, onNodeContextMenu })}
      {menu ? (
        <div
          className="anf-node-menu"
          role="menu"
          style={{ top: menu.y, left: menu.x }}
          // Marker for the parent's capture-phase outside-click
          // listener — see the matching useEffect above. We avoid
          // stopPropagation here on purpose so a left-click anywhere
          // (including on another node or the pane) is delivered
          // both to ReactFlow and to our closer.
          data-anf-menu="node"
        >
          <button
            type="button"
            role="menuitem"
            className="anf-node-menu-item"
            onClick={() => {
              const id = menu.nodeId;
              setMenu(null);
              void startRun("node", id);
            }}
            disabled={status === "running" || status === "uploading"}
          >
            <IconPlay /> <span>Run this node</span>
          </button>
        </div>
      ) : null}
    </>
  );
}



/**
 * Convert a wire-format `RuntimeEvent` into the canonical `NodeEvent`
 * shape understood by Studio's view-model layer (`createStudioViewModel`,
 * `deriveNodeStatusFromEvents`, `createRunTimeline`, etc.).
 *
 * The conversion synthesises the fields the SSE wire format omits
 * (`flowId`, `flowVersion`, monotonic `seq`, ISO timestamp) while
 * normalising kind aliases that older sidecar revisions still emit
 * (notably `node_failed` \u2192 `node_error`, since the canonical kind
 * union only contains `node_error`).
 *
 * Returns `undefined` for kinds the canvas doesn't model (currently
 * none, but kept as a safety hatch so unknown future kinds are simply
 * dropped instead of polluting `state.events` with garbage).
 */
function toNodeEvent(
  event: RuntimeEvent,
  graph: FlowGraph,
  seqRef: { current: number },
): NodeEvent | undefined {
  const kind = normaliseKind(event.kind);
  if (!kind) return undefined;
  const seq = seqRef.current;
  seqRef.current = seq + 1;

  // `RuntimeEvent.ts` is unix-millis; `NodeEvent.timestamp` is ISO-8601.
  // Fall back to "now" for transports that drop the field entirely.
  const tsMs = typeof event.ts === "number" && Number.isFinite(event.ts)
    ? event.ts
    : Date.now();

  return {
    eventId: event.eventId,
    runId: event.runId,
    flowId: graph.id,
    flowVersion: graph.version,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    seq,
    timestamp: new Date(tsMs).toISOString(),
    kind,
    payload: event.payload ?? {},
  };
}

/**
 * Map a wire `kind` string to the strict `NodeEventKind` union.
 *
 * Currently the only alias we need to absorb is `node_failed`, which
 * some sidecar versions emit as a friendlier synonym for `node_error`.
 * Keeping the alias table here (rather than fixing the wire) means
 * Studio remains backward-compatible without depending on a server
 * upgrade.
 */
function normaliseKind(kind: string): NodeEventKind | undefined {
  if (kind === "node_failed") return "node_error";
  // Trust any other kind \u2014 the union is open enough that runtime
  // additions land here transparently. We cast rather than enumerate
  // so this stays maintenance-free as the kind set evolves.
  return kind as NodeEventKind;
}

function formatPayload(
  payload: Record<string, unknown> | undefined,
  key: string,
): string {
  if (!payload) return "";
  const value = payload[key];
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------- icons --------------------------------- */

function IconPlay() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path d="M4 3l9 5-9 5z" fill="currentColor" />
    </svg>
  );
}
function IconStop() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}
function IconSave() {
  // Floppy-disk pictogram — conventional "save to disk" affordance.
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path
        d="M2.5 2.5h9L13.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V2.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <rect x="5" y="2.5" width="6" height="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="4" y="8.5" width="8" height="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function IconSidebarLeft() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function IconConsole() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <rect x="1.5" y="3" width="13" height="10" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <polyline points="4,6 7,8 4,10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
