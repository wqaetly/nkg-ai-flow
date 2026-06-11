import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  addStudioNode,
  appendStudioEvents,
  applyStudioOperations,
  removeStudioEdge,
  removeStudioNode,
  selectStudioEdge,
  selectStudioNode,
  updateStudioNodeConfig,
} from "./editor.js";
import { createStudioViewModel } from "./viewModel.js";
import {
  getMovedNodePositions,
  reactFlowConnectionToStudioEdgeDraft,
  toReactFlowGraph,
  createEdgeId,
  deriveStudioInputPorts,
  VIRTUAL_PORT_FLAG,
  type ReactFlowStudioEdge,
  type ReactFlowStudioNode,
  type ReactFlowStudioNodeData,
} from "./reactFlowAdapter.js";
import type { GraphOperation, PortDefinition, StudioPaletteItem, StudioState, StudioViewModel } from "./types.js";
import { NodeFieldsPanel } from "./fields/index.js";
import { EnvVarsProvider, type EnvVarEntry } from "./fields/envContext.js";
import { useRuntimeEventsSubscription } from "./runtimeEventsContext.js";

export interface ReactFlowStudioProps {
  initialState: StudioState;
  title?: string;
  onStateChange?: (state: StudioState, view: StudioViewModel) => void;
  /**
   * Right-click on a node fires this with screen coordinates. The host
   * (StudioWorkbench) owns the menu UI — the canvas only forwards the
   * intent and lets the host decide which actions are available given
   * the current run state.
   */
  onNodeContextMenu?: (
    nodeId: string,
    coords: { x: number; y: number },
  ) => void;
  /**
   * Header slot rendered to the right of the validation pill. Used by
   * StudioWorkbench to inject the floating run-toolbar so it overlays
   * the canvas without ReactFlowStudio needing to know what "running"
   * means.
   */
  headerSlot?: React.ReactNode;
  /**
   * Optional palette override. When provided, it replaces the palette
   * embedded in `initialState` for the purposes of the canvas
   * right-click “Add node” menu. Useful when the host wants to surface
   * a richer registry than the one carried by the flow itself.
   */
  palette?: StudioPaletteItem[];
  /**
   * Environment variables surfaced to the in-node “insert variable”
   * picker. The workbench owns the source of truth (the `Env` panel)
   * and threads its rows down here so authors can paste values into
   * fields without retyping. Empty / undefined disables the picker
   * entry on every field.
   */
  envEntries?: EnvVarEntry[];
}

const nodeTypes = {
  studioNode: StudioNodeCard,
};

const edgeTypes = {
  studioCircuit: StudioCircuitEdge,
} satisfies EdgeTypes;

export function ReactFlowStudio(props: ReactFlowStudioProps) {
  return (
    <ReactFlowProvider>
      <ReactFlowStudioInner {...props} />
    </ReactFlowProvider>
  );
}

function ReactFlowStudioInner({
  initialState,
  title = "AI Native Flow Studio",
  onStateChange,
  onNodeContextMenu,
  headerSlot,
  palette,
  envEntries,
}: ReactFlowStudioProps) {
  const [state, setState] = useState(initialState);

  /**
   * “Add node” menu state. When the user right-clicks an empty patch
   * of the canvas we capture both the screen coords (for menu
   * positioning) and the equivalent flow-space coords (for the new
   * node's `position`). The two are computed once at open time so the
   * inserted node lands exactly where the click occurred regardless
   * of any pan/zoom that happens while the menu is open.
   */
  const [addMenu, setAddMenu] = useState<{
    screen: { x: number; y: number };
    flow: { x: number; y: number };
  } | null>(null);
  const reactFlow = useReactFlow();

  const view = useMemo(() => createStudioViewModel(state), [state]);
  const projected = useMemo(() => toReactFlowGraph(view), [view]);

  const [nodes, setNodes] = useState<ReactFlowStudioNode[]>(() => projected.nodes);
  const [edges, setEdges] = useState<ReactFlowStudioEdge[]>(() => projected.edges);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(() =>
    view.selectedNodeId ? [view.selectedNodeId] : [],
  );

  const topologyKeyRef = useRef(topologyKey(state));
  useEffect(() => {
    const nextKey = topologyKey(state);
    if (nextKey !== topologyKeyRef.current) {
      topologyKeyRef.current = nextKey;
      setNodes(projected.nodes);
      setEdges(projected.edges);
    }
  }, [projected.nodes, projected.edges, state]);

  const commitState = useCallback((updater: (prev: StudioState) => StudioState) => {
    setState((prev) => {
      const next = updater(prev);
      if (next === prev) return prev;
      onStateChange?.(next, createStudioViewModel(next));
      return next;
    });
  }, [onStateChange]);

  /**
   * Live runtime events from `FlowRunController` land here. We fold
   * them into `state.events` so the view-model's
   * `deriveNodeStatusFromEvents` / `deriveNodeRuntime` paint the
   * correct per-node `status` and timer. This is the *only* path by
   * which run-time signals reach node cards \u2014 there is no other
   * channel.
   *
   * We deliberately don't dedup eventIds here: the producer
   * (`FlowRunController.handleEvent`) is the single source per run,
   * and the channel is bounded to the controller's lifetime.
   */
  useRuntimeEventsSubscription(useCallback((events) => {
    if (events.length === 0) return;
    commitState((prev) => appendStudioEvents(prev, events));
  }, [commitState]));

  /**
   * Sync per-node *runtime decorations* (`data.status`, `data.runtime`)
   * from the projected view into the live ReactFlow `nodes` array
   * without disturbing position / selection / measured size.
   *
   * The sibling `topologyKey` effect above only re-projects on
   * structural changes (add/remove node-or-edge); status / timer
   * changes are intentionally *not* topological so they don't trigger
   * full re-projection. This effect closes that gap by patching just
   * the two affected fields, leaving everything else intact.
   *
   * The early-bail `same` check keeps this cheap: most state updates
   * won't flip status/runtime, so we re-render only when there's
   * actually something new to paint on the canvas.
   */
  useEffect(() => {
    setNodes((current) => {
      let changed = false;
      const next = current.map((rfNode) => {
        const projectedNode = projected.nodes.find((n) => n.id === rfNode.id);
        if (!projectedNode) return rfNode;
        const nextStatus = projectedNode.data.status;
        const nextRuntime = projectedNode.data.runtime;
        const same =
          rfNode.data.status === nextStatus &&
          shallowRuntimeEqual(rfNode.data.runtime, nextRuntime);
        if (same) return rfNode;
        changed = true;
        return {
          ...rfNode,
          data: {
            ...rfNode.data,
            status: nextStatus,
            // Preserve the optional-field shape: omit the key entirely
            // when there's no runtime info, matching the adapter.
            ...(nextRuntime ? { runtime: nextRuntime } : { runtime: undefined }),
          },
        };
      });
      return changed ? next : current;
    });
  }, [projected.nodes]);

  const onNodesChange = useCallback((changes: NodeChange<ReactFlowStudioNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));

    const moved = getMovedNodePositions(changes);
    const removed = changes.flatMap((change) => (change.type === "remove" ? [change.id] : []));
    if (moved.length === 0 && removed.length === 0) return;

    commitState((prev) => {
      let next = prev;
      if (moved.length > 0) {
        try {
          next = applyStudioOperations(next, moved.map((item) => ({
            op: "set_node_position" as const,
            nodeId: item.nodeId,
            position: item.position,
          }))).state;
        } catch (error) {
          console.warn("[Studio] move rejected", error);
        }
      }
      for (const nodeId of removed) {
        try {
          next = removeStudioNode(next, nodeId).state;
        } catch (error) {
          console.warn("[Studio] remove node rejected", error);
        }
      }
      return next;
    });
  }, [commitState]);

  const onEdgesChange = useCallback((changes: EdgeChange<ReactFlowStudioEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));

    const removed = changes.flatMap((change) => (change.type === "remove" ? [change.id] : []));
    if (removed.length === 0) return;

    commitState((prev) => {
      let next = prev;
      for (const edgeId of removed) {
        try {
          next = removeStudioEdge(next, edgeId).state;
        } catch (error) {
          console.warn("[Studio] remove edge rejected", error);
        }
      }
      return next;
    });
  }, [commitState]);

  const onConnect = useCallback((connection: Connection) => {
    const draft = reactFlowConnectionToStudioEdgeDraft(connection);
    if (!draft) return;
    commitState((prev) => {
      if (prev.graph.edges.some((edge) => edge.id === draft.id)) return prev;
      try {
        // If the target endpoint is a *virtual* port (one synthesised
        // from a config field that the node author didn't declare in
        // `defaultPorts`), persist it into `node.ports` first so the
        // validator and runtime see a regular input port. The
        // `add_port` op is emitted in the same `applyStudioOperations`
        // call as `add_edge`, so the validator sees the post-state.
        const ops: GraphOperation[] = [];
        const targetNode = prev.graph.nodes.find((n) => n.id === draft.to.nodeId);
        const alreadyDeclared = targetNode?.ports.some(
          (p) => p.id === draft.to.portId && p.direction === "input",
        );
        if (targetNode && !alreadyDeclared) {
          const fields = findFieldsForNode(prev, targetNode.type, targetNode.typeVersion);
          const enriched = deriveStudioInputPorts(
            targetNode.ports.filter((p) => p.direction === "input"),
            fields,
          );
          const virtual = enriched.find(
            (p) => p.id === draft.to.portId && p[VIRTUAL_PORT_FLAG],
          );
          if (virtual) {
            // Strip the `__virtual` marker before persisting — the IR
            // contract doesn't carry that flag.
            const persisted: PortDefinition = {
              id: virtual.id,
              direction: virtual.direction,
              kind: virtual.kind,
              label: virtual.label,
              required: virtual.required,
            };
            ops.push({ op: "add_port", nodeId: targetNode.id, port: persisted });
          }
        }
        ops.push({
          op: "add_edge",
          edge: {
            id: draft.id,
            from: { ...draft.from },
            to: { ...draft.to },
            condition: draft.condition,
          },
        });
        return applyStudioOperations(prev, ops).state;
      } catch (error) {
        console.warn("[Studio] connect rejected", error);
        return prev;
      }
    });
  }, [commitState]);

  /**
   * Pre-flight connection validation. Returning `false` here makes React Flow
   * refuse to drop the connection at all — the dragged line snaps back rather
   * than producing a post-hoc error toast.
   *
   * Rules mirror what `addStudioEdge` would otherwise reject:
   *   1. Both endpoints must exist; no self-loops.
   *   2. The source endpoint must be an `output` port and the target must be
   *      an `input` port on their respective nodes.
   *   3. Port `kind`s must match (control↔control, data↔data, …).
   *   4. The synthesised edge id must not already exist.
   *
   * Virtual config-field ports (those promoted into `data.inputs` by
   * `deriveStudioInputPorts` but not yet present in `node.ports`) are
   * treated as legal targets — `onConnect` will materialise them via
   * an `add_port` op when the connection is committed.
   */
  const isValidConnection = useCallback((connection: Connection | ReactFlowStudioEdge): boolean => {
    const source = connection.source;
    const target = connection.target;
    const sourceHandle = connection.sourceHandle;
    const targetHandle = connection.targetHandle;
    if (!source || !target || !sourceHandle || !targetHandle) return false;
    if (source === target) return false;

    const sourceNode = state.graph.nodes.find((n) => n.id === source);
    const targetNode = state.graph.nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) return false;

    const sourcePort = sourceNode.ports.find((p) => p.id === sourceHandle);
    if (!sourcePort) return false;

    // The target may be a virtual port (config-field-derived, not yet
    // in `node.ports`). Look it up via the enriched input list instead
    // of the raw ports array.
    const targetFields = findFieldsForNode(state, targetNode.type, targetNode.typeVersion);
    const enrichedInputs = deriveStudioInputPorts(
      targetNode.ports.filter((p) => p.direction === "input"),
      targetFields,
    );
    const targetPort = enrichedInputs.find((p) => p.id === targetHandle);
    if (!targetPort) return false;
    if (sourcePort.direction !== "output") return false;
    if (targetPort.direction !== "input") return false;
    if (sourcePort.kind !== targetPort.kind) return false;

    const candidateId = createEdgeId({
      source,
      sourceHandle,
      target,
      targetHandle,
    });
    if (state.graph.edges.some((edge) => edge.id === candidateId)) return false;

    return true;
  }, [state]);

  const onSelectionChange = useCallback((params: OnSelectionChangeParams<ReactFlowStudioNode, ReactFlowStudioEdge>) => {
    const nodeIds = params.nodes.map((node) => node.id);
    setSelectedNodeIds((prev) => stringArraysEqual(prev, nodeIds) ? prev : nodeIds);

    // Multi-selection changes can fire continuously while a marquee is being
    // dragged. Keep those transient sets local to React Flow; only single
    // selection updates the Studio state used by inspectors/hosts.
    if (params.nodes.length > 1 || params.edges.length > 1) return;

    const nodeId = params.nodes[0]?.id;
    const edgeId = nodeId ? undefined : params.edges[0]?.id;
    commitState((prev) => {
      const prevNode = prev.selection.nodeId;
      const prevEdge = prev.selection.edgeId;
      if (prevNode === nodeId && prevEdge === edgeId) return prev;
      if (nodeId) return selectStudioNode(prev, nodeId);
      if (edgeId) return selectStudioEdge(prev, edgeId);
      if (prevNode || prevEdge) return { ...prev, selection: {} };
      return prev;
    });
  }, [commitState]);

  /** Double-clicking an edge deletes it (works regardless of keyboard focus). */
  const onEdgeDoubleClick = useCallback((_event: ReactMouseEvent, edge: ReactFlowStudioEdge) => {
    setEdges((current) => current.filter((item) => item.id !== edge.id));
    commitState((prev) => {
      try {
        return removeStudioEdge(prev, edge.id).state;
      } catch (error) {
        console.warn("[Studio] remove edge rejected", error);
        return prev;
      }
    });
  }, [commitState]);

  /**
   * Forward right-click on the canvas's node body to the host. Memoised
   * with `onNodeContextMenu` so we don't reattach handlers on each
   * render. The native event has its `preventDefault()` called so the
   * browser context menu doesn't compete with ours.
   */
  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: ReactFlowStudioNode) => {
      if (!onNodeContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      onNodeContextMenu(node.id, { x: event.clientX, y: event.clientY });
    },
    [onNodeContextMenu],
  );

  /**
   * Right-click on an empty area of the canvas opens the hierarchical
   * “Add node” picker (Unreal-Engine style). We translate the screen
   * coordinates into flow-space here so the inserted node lands
   * exactly where the cursor was.
   */
  const handlePaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault();
      const screenX = (event as ReactMouseEvent).clientX;
      const screenY = (event as ReactMouseEvent).clientY;
      const flowPos = reactFlow.screenToFlowPosition({ x: screenX, y: screenY });
      setAddMenu({ screen: { x: screenX, y: screenY }, flow: flowPos });
    },
    [reactFlow],
  );

  /**
   * Insert a new node at the menu's recorded flow-space position from
   * the chosen palette entry. Node ids must be unique within the
   * graph; we derive a short, human-readable id by suffixing the type
   * with the smallest free counter.
   */
  const handleAddNodeFromPalette = useCallback(
    (item: StudioPaletteItem) => {
      const menu = addMenu;
      if (!menu) return;
      setAddMenu(null);
      commitState((prev) => {
        const id = generateNodeId(prev, item.type);
        try {
          return addStudioNode(prev, {
            id,
            type: item.type,
            typeVersion: item.typeVersion,
            label: item.title,
            position: menu.flow,
            ports: item.defaultPorts.map((port) => ({ ...port })),
          }).state;
        } catch (error) {
          console.warn("[Studio] add node rejected", error);
          return prev;
        }
      });
    },
    [addMenu, commitState],
  );

  // Close the add-node menu on outside click or Escape. Listeners are
  // attached only while the menu is open to avoid global noise.
  //
  // We listen in the *capture* phase: ReactFlow attaches its own
  // mousedown handlers on the pane and on each node, several of which
  // call `stopPropagation()` — that would silently break a bubbling
  // window-level listener. Capture-phase events fire from the window
  // downwards, before any descendant has a chance to stop them, so we
  // reliably observe every click. We then ignore clicks that landed
  // inside the menu itself by walking up the DOM looking for the
  // `data-anf-menu` marker the menu's root element carries.
  useEffect(() => {
    if (!addMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && target.closest("[data-anf-menu='add-node']")) return;
      setAddMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddMenu(null);
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [addMenu]);

  // Resolve the palette to use for the add-node menu. Prefer the
  // host-supplied prop so a workbench can hand in a richer registry
  // than the one stored in the initial state snapshot.
  const effectivePalette = useMemo<StudioPaletteItem[]>(
    () => (palette && palette.length > 0 ? palette : state.palette ?? []),
    [palette, state.palette],
  );

  const validation = view.validation;

  // Stable callback so node cards (e.g. `text_input`'s inline textarea)
  // can patch a node's config and have it round-trip through the graph
  // operation log just like any other edit. The closure captures only
  // `commitState`, which is itself memoised, so the function identity
  // changes only when `onStateChange` does.
  const updateNodeConfigValue = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      commitState((prev) => {
        try {
          return updateStudioNodeConfig(prev, nodeId, patch).state;
        } catch (error) {
          console.warn("[Studio] update_node_config rejected", error);
          return prev;
        }
      });
    },
    [commitState],
  );

  // Inject the per-card config-update callback into each node's `data`
  // so React Flow's memoisation correctly invalidates a single card
  // when the closure changes, instead of re-rendering the whole graph.
  const decoratedNodes = useMemo<ReactFlowStudioNode[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          __updateConfig: updateNodeConfigValue,
        },
      })),
    [nodes, updateNodeConfigValue],
  );

  const selectedNodeIdSet = useMemo(
    () => new Set(selectedNodeIds),
    [selectedNodeIds],
  );
  const decoratedEdges = useMemo<ReactFlowStudioEdge[]>(
    () =>
      edges.map((edge) => {
        const relatedToSelectedNode =
          selectedNodeIdSet.has(edge.source) || selectedNodeIdSet.has(edge.target);
        const explicitlySelected = Boolean(edge.selected);
        const hasSelection = selectedNodeIdSet.size > 0 || explicitlySelected;
        const active = Boolean(explicitlySelected || relatedToSelectedNode);
        return {
          ...edge,
          selected: explicitlySelected,
          type: "studioCircuit",
          data: {
            ...edge.data,
            kind: edge.data?.kind ?? "unknown",
            active,
            dimmed: hasSelection && !active,
          },
        };
      }),
    [edges, selectedNodeIdSet],
  );

  const loopHighlights = useMemo(
    () => deriveLoopHighlights(nodes, edges),
    [nodes, edges],
  );

  // Stable identity for the env list so the provider only re-renders
  // when the workbench actually mutates the rows.
  const envList = useMemo<EnvVarEntry[]>(
    () => envEntries ?? [],
    [envEntries],
  );

  return (
    <EnvVarsProvider entries={envList}>
    <div className="anf-studio-root">
      <header className="anf-studio-header">
        <div className="anf-studio-header-text">
          <p className="anf-studio-kicker">Browser Studio</p>
          <h1>{title}</h1>
          <p className="anf-studio-subtitle">{view.flow.description ?? "Visual graph editing with live validation."}</p>
        </div>
        <div className={validation.ok ? "anf-studio-pill ok" : "anf-studio-pill error"}>
          <span className="anf-studio-pill-dot" />
          {validation.ok ? "Graph valid" : `${validation.errors.length} issue${validation.errors.length === 1 ? "" : "s"}`}
        </div>
      </header>

      <main className="anf-studio-canvas">
        {/*
         * The host-injected toolbar (headerSlot) is rendered INSIDE the
         * canvas container, not the title header — this matters because
         * (a) the workbench shell hides `.anf-studio-header` entirely
         * and (b) the toolbar is `position: absolute` so it must
         * resolve against the canvas, not a hidden header. Keeping it
         * here also means the toolbar overlays React Flow rather than
         * stealing layout space at the top.
         */}
        {headerSlot ?? null}
        <ReactFlow<ReactFlowStudioNode, ReactFlowStudioEdge>
          nodes={decoratedNodes}
          edges={decoratedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onSelectionChange={onSelectionChange}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onNodeContextMenu={handleNodeContextMenu}
          onPaneContextMenu={handlePaneContextMenu}
          deleteKeyCode={["Backspace", "Delete"]}
          selectionMode={SelectionMode.Partial}
          selectionKeyCode="Control"
          multiSelectionKeyCode="Control"
          panOnDrag
          fitView
          // Wider zoom envelope than ReactFlow's defaults (0.5\u20132): the
          // upper bound lets users dive into a single node's labels,
          // and the lower bound (down to 5%) makes the bird's-eye view
          // of a large flow practical without leaving the canvas.
          minZoom={0.05}
          maxZoom={4}
          // Cap the initial fit-view zoom so newly opened flows render
          // a bit smaller than ReactFlow would otherwise pick \u2014 a
          // tighter starting frame leaves room around the graph and
          // matches the user's preference for a less zoomed-in default.
          fitViewOptions={{ padding: 0.25, minZoom: 0.05, maxZoom: 0.6 }}
          defaultEdgeOptions={{ type: "studioCircuit", animated: false }}
          proOptions={{ hideAttribution: true }}
          style={{ width: "100%", height: "100%" }}
        >
          <LoopBodyHighlights highlights={loopHighlights} />
          <Background
            color="var(--anf-bg-dot, #d8def0)"
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.4}
          />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => statusColor((node as ReactFlowStudioNode).data.status)}
            nodeStrokeColor="transparent"
            // No inline maskColor / background: lets the host theme (dark
            // workbench or stand-alone light shell) drive the look via CSS.
          />
          {!validation.ok && validation.errors.length > 0 ? (
            <ValidationOverlay errors={validation.errors} />
          ) : null}
        </ReactFlow>
        {addMenu ? (
          <AddNodeMenu
            x={addMenu.screen.x}
            y={addMenu.screen.y}
            palette={effectivePalette}
            onPick={handleAddNodeFromPalette}
            onClose={() => setAddMenu(null)}
          />
        ) : null}
      </main>
    </div>
    </EnvVarsProvider>
  );
}

function ValidationOverlay({ errors }: { errors: StudioViewModel["validation"]["errors"] }) {
  return (
    <div className="anf-validation-overlay">
      <div className="anf-validation-overlay-title">
        <span className="anf-validation-dot" />
        Validation issues
      </div>
      <ul>
        {errors.slice(0, 5).map((error, index) => (
          <li key={`${error.code}-${index}`}>
            <strong>{error.code}</strong>
            <span>{error.message}</span>
          </li>
        ))}
        {errors.length > 5 ? <li className="anf-validation-more">+{errors.length - 5} more…</li> : null}
      </ul>
    </div>
  );
}

function topologyKey(state: StudioState): string {
  const nodeIds = state.graph.nodes.map((n) => n.id).sort().join(",");
  const edgeIds = state.graph.edges.map((e) => e.id).sort().join(",");
  return `${nodeIds}|${edgeIds}`;
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Shallow equality for the optional `runtime` field on a node card.
 *
 * Used by the runtime-decoration sync effect so we don't churn the
 * `nodes` array (and re-render every card) on every event when the
 * underlying timing didn't actually change \u2014 e.g. `node_progress`
 * frames that don't carry new `startedAt` / `durationMs` values.
 */
function shallowRuntimeEqual(
  a: ReactFlowStudioNodeData["runtime"],
  b: ReactFlowStudioNodeData["runtime"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startedAt === b.startedAt && a.durationMs === b.durationMs;
}

interface LoopHighlight {
  id: string;
  points: Point[];
  bounds: Rect;
  kind: "foreach" | "for" | "loop";
}

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LOOP_BEGIN_TO_END: Record<string, { endType: string; kind: LoopHighlight["kind"] }> = {
  foreach_begin: { endType: "foreach_end", kind: "foreach" },
  for_begin: { endType: "for_end", kind: "for" },
  loop_begin: { endType: "loop_end", kind: "loop" },
};

const LOOP_HIGHLIGHT_PADDING = 34;

function LoopBodyHighlights({ highlights }: { highlights: LoopHighlight[] }) {
  if (highlights.length === 0) return null;
  return (
    <ViewportPortal>
      <div className="anf-loop-highlight-layer" aria-hidden>
        {highlights.map((highlight) => (
          <svg
            key={highlight.id}
            className={`anf-loop-highlight anf-loop-highlight--${highlight.kind}`}
            style={{
              left: highlight.bounds.x,
              top: highlight.bounds.y,
              width: highlight.bounds.width,
              height: highlight.bounds.height,
            }}
            viewBox={`0 0 ${fmt(highlight.bounds.width)} ${fmt(highlight.bounds.height)}`}
            preserveAspectRatio="none"
          >
            <polygon
              className="anf-loop-highlight-shape"
              points={highlight.points
                .map((point) => `${fmt(point.x - highlight.bounds.x)},${fmt(point.y - highlight.bounds.y)}`)
                .join(" ")}
            />
          </svg>
        ))}
      </div>
    </ViewportPortal>
  );
}

function deriveLoopHighlights(
  nodes: ReactFlowStudioNode[],
  edges: ReactFlowStudioEdge[],
): LoopHighlight[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const outEdges = new Map<string, ReactFlowStudioEdge[]>();
  for (const edge of edges) {
    const list = outEdges.get(edge.source) ?? [];
    list.push(edge);
    outEdges.set(edge.source, list);
  }

  return nodes.flatMap((beginNode) => {
    const loop = LOOP_BEGIN_TO_END[beginNode.data.type];
    if (!loop) return [];

    const bodyNodeIds = new Set<string>();
    const pending: string[] = [];
    let endNodeId: string | undefined;

    for (const edge of outEdges.get(beginNode.id) ?? []) {
      if (edge.sourceHandle !== "body") continue;
      const target = nodesById.get(edge.target);
      if (!target) continue;
      if (target.data.type === loop.endType) {
        endNodeId = target.id;
        continue;
      }
      pending.push(target.id);
    }

    while (pending.length > 0) {
      const nodeId = pending.shift()!;
      if (bodyNodeIds.has(nodeId) || nodeId === beginNode.id) continue;
      const node = nodesById.get(nodeId);
      if (!node) continue;
      if (node.data.type === loop.endType) {
        endNodeId = node.id;
        continue;
      }

      bodyNodeIds.add(nodeId);
      for (const edge of outEdges.get(nodeId) ?? []) {
        if ((edge.data?.kind ?? "unknown") !== "control") continue;
        const target = nodesById.get(edge.target);
        if (!target) continue;
        if (target.data.type === loop.endType) {
          endNodeId = target.id;
          continue;
        }
        pending.push(target.id);
      }
    }

    if (!endNodeId || bodyNodeIds.size === 0) return [];

    const highlightNodeIds = [beginNode.id, ...bodyNodeIds, endNodeId];
    const rects = highlightNodeIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is ReactFlowStudioNode => Boolean(node))
      .map(nodeBounds)
      .filter((rect): rect is Rect => Boolean(rect));
    if (rects.length < 2) return [];

    const points = convexHull(rects.flatMap(rectCorners));
    if (points.length < 3) return [];
    const bounds = boundsForPoints(points);
    return [{
      id: `${beginNode.id}__${endNodeId}`,
      points,
      bounds,
      kind: loop.kind,
    }];
  });
}

function nodeBounds(node: ReactFlowStudioNode): Rect | undefined {
  const width = node.measured?.width ?? node.width ?? node.data?.width;
  const height = node.measured?.height ?? node.height ?? node.data?.height;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  return {
    x: node.position.x - LOOP_HIGHLIGHT_PADDING,
    y: node.position.y - LOOP_HIGHLIGHT_PADDING,
    width: width + LOOP_HIGHLIGHT_PADDING * 2,
    height: height + LOOP_HIGHLIGHT_PADDING * 2,
  };
}

function rectCorners(rect: Rect): Point[] {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return [
    { x: rect.x, y: rect.y },
    { x: x2, y: rect.y },
    { x: x2, y: y2 },
    { x: rect.x, y: y2 },
  ];
}

function convexHull(points: Point[]): Point[] {
  const unique = Array.from(
    new Map(points.map((point) => [`${point.x}:${point.y}`, point])).values(),
  ).sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length <= 1) return unique;

  const lower: Point[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function boundsForPoints(points: Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

const CIRCUIT_EDGE_STUB = 32;

function StudioCircuitEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  selected,
  data,
  style,
}: EdgeProps<ReactFlowStudioEdge>) {
  const points = circuitPoints(
    { x: sourceX, y: sourceY },
    sourcePosition,
    { x: targetX, y: targetY },
    targetPosition,
  );
  const path = circuitPath(points);
  const kind = typeof data?.kind === "string" ? data.kind : "unknown";
  const active = Boolean(selected || data?.active);
  const dimmed = Boolean(data?.dimmed);
  const classes = [
    "anf-edge",
    `anf-edge--${kind}`,
    active ? "anf-edge--active" : "",
    dimmed ? "anf-edge--dimmed" : "",
  ].filter(Boolean).join(" ");

  return (
    <g className={classes}>
      <path
        className="react-flow__edge-path anf-edge-hit"
        d={path}
        fill="none"
      />
      <path
        id={id}
        className="react-flow__edge-path anf-edge-path"
        d={path}
        fill="none"
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
      />
    </g>
  );
}

function circuitPoints(
  source: Point,
  sourcePosition: Position,
  target: Point,
  targetPosition: Position,
): [Point, Point, Point, Point] {
  return [
    source,
    extendPoint(source, sourcePosition, CIRCUIT_EDGE_STUB),
    extendPoint(target, targetPosition, CIRCUIT_EDGE_STUB),
    target,
  ];
}

function extendPoint(point: Point, position: Position, distance: number): Point {
  switch (position) {
    case Position.Left:
      return { x: point.x - distance, y: point.y };
    case Position.Right:
      return { x: point.x + distance, y: point.y };
    case Position.Top:
      return { x: point.x, y: point.y - distance };
    case Position.Bottom:
      return { x: point.x, y: point.y + distance };
    default:
      return { x: point.x + distance, y: point.y };
  }
}

function circuitPath(
  points: [Point, Point, Point, Point],
): string {
  return [
    `M ${fmt(points[0].x)} ${fmt(points[0].y)}`,
    `L ${fmt(points[1].x)} ${fmt(points[1].y)}`,
    `L ${fmt(points[2].x)} ${fmt(points[2].y)}`,
    `L ${fmt(points[3].x)} ${fmt(points[3].y)}`,
  ].join(" ");
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function StudioNodeCard({ id, data, selected }: NodeProps<ReactFlowStudioNode>) {
  const status = data.status ?? "idle";
  const initial = (data.label || data.type || "?").trim().charAt(0).toUpperCase() || "?";

  // Host-injected callback for in-card config edits (e.g. the inline
  // textarea on `text_input` nodes). The card never mutates state
  // directly — every keystroke round-trips through the standard
  // `update_node_config` graph operation.
  const updateConfig = (data as ReactFlowStudioNodeData & {
    __updateConfig?: (nodeId: string, patch: Record<string, unknown>) => void;
  }).__updateConfig;

  // Resolve the set of port ids on this node that are wired to at least
  // one edge. We hand it to the field panel and the data-port row so
  // pins paint as filled-with-gap when used and hollow when free —
  // matching Unreal-Engine's blueprint convention. Stored as an array
  // on `data` for React Flow's shallow-equality memoisation; we lift it
  // into a `Set` here for O(1) lookups inside this card.
  const connectedPortIds = useMemo(
    () => new Set(data.connectedPortIds ?? []),
    [data.connectedPortIds],
  );

  // Split flow-control ports out from the rest. UE renders them as
  // dedicated pins along the top edge of every node, with the
  // execution input on the left and the execution output on the right.
  const controlInputs = data.inputs.filter((p) => p.kind === "control");
  const controlOutputs = data.outputs.filter((p) => p.kind === "control");

  // The remaining input data ports — those NOT consumed by the field
  // panel as a same-named field — are surfaced in a small data-port
  // strip below the field rows. Output data/error ports are rendered
  // on the right side of that strip regardless of whether a same-named
  // input exists.
  const visibleFieldNames = new Set(
    (data.configFields ?? []).filter((f) => !f.hidden).map((f) => f.name),
  );
  const inputDataPorts = data.inputs.filter((p) => p.kind !== "control");
  const orphanInputDataPorts = inputDataPorts.filter(
    (p) => !visibleFieldNames.has(p.id),
  );
  const outputDataPorts = data.outputs.filter((p) => p.kind !== "control");

  // Pair the orphan inputs with outputs row-by-row so the section reads
  // like a UE blueprint: each row has an input pin on the left and an
  // output pin on the right.
  const dataRowCount = Math.max(orphanInputDataPorts.length, outputDataPorts.length);
  const dataRows = Array.from({ length: dataRowCount }, (_, idx) => ({
    input: orphanInputDataPorts[idx],
    output: outputDataPorts[idx],
  }));

  const hasFlowRow = controlInputs.length > 0 || controlOutputs.length > 0;
  const hasDataRows = dataRows.length > 0;
  const hasFields = (data.configFields?.length ?? 0) > 0 && Boolean(updateConfig);

  // The Node Field Inspector takes over the legacy `text_input` fallback
  // as soon as the type registers a `value` field via `fieldMeta`.
  const fieldsHandleTextInput =
    data.type === "text_input" && visibleFieldNames.has("value");

  return (
    <div className={`anf-node ${selected ? "anf-node--selected" : ""} anf-node--${status}`}>
      {/*
        Right-top corner stack: status dot on top, ms-level runtime
        timer directly below it. Both used to live in separate
        positions (dot inline in the title row, timer absolutely
        positioned at top:22 right:8) which made longer timer values
        overrun the dot. Folding them into a single absolutely
        positioned column keeps them perfectly aligned regardless of
        timer width and never disturbs the title-row flex layout.
      */}
      <div className="anf-node-corner" aria-hidden={false}>
        <span
          className={`anf-node-status anf-node-status--${status}`}
          title={status}
        />
        <NodeRuntimeTimer status={status} runtime={data.runtime} />
      </div>
      {/*
        Single-line head: icon + label + (type@version) all flow on
        one row. The previous two-row layout (`.anf-node-titles` with
        a separate subtitle line) wasted ~24px of vertical space on
        every card; folding into a single row keeps the same info
        density without forcing the canvas to scroll. The trailing
        right-padding on `.anf-node-head` reserves room for the
        absolutely-positioned `.anf-node-corner` (status dot + timer)
        so the type label never gets clipped by it.
      */}
      <div className="anf-node-head">
        <div className={`anf-node-icon anf-node-icon--${kindForType(data.type)}`} aria-hidden>
          {initial}
        </div>
        <strong className="anf-node-title">{data.label}</strong>
      </div>

      {hasFlowRow ? (
        <div className="anf-node-flow-row">
          <div className="anf-flow-cell anf-flow-cell--input">
            {controlInputs.map((port) => (
              <PortPin
                key={`control-in-${port.id}`}
                port={port}
                side="input"
                connected={connectedPortIds.has(port.id)}
                variant="flow"
              />
            ))}
          </div>
          <div className="anf-flow-cell anf-flow-cell--output">
            {controlOutputs.map((port) => (
              <PortPin
                key={`control-out-${port.id}`}
                port={port}
                side="output"
                connected={connectedPortIds.has(port.id)}
                variant="flow"
              />
            ))}
          </div>
        </div>
      ) : null}

      {hasFields ? (
        <NodeFieldsPanel
          nodeId={id}
          nodeType={data.type}
          fields={data.configFields}
          config={data.config}
          inputDataPorts={inputDataPorts}
          connectedPortIds={connectedPortIds}
          onChange={updateConfig!}
          disabled={status === "running" || status === "streaming"}
        />
      ) : null}

      {hasDataRows ? (
        <div className="anf-node-ports">
          {dataRows.map((row, idx) => (
            <div className="anf-port-pair" key={`pair-${idx}`}>
              <div className="anf-port-cell anf-port-cell--input">
                {row.input ? (
                  <PortPin
                    port={row.input}
                    side="input"
                    connected={connectedPortIds.has(row.input.id)}
                    variant="data"
                  />
                ) : null}
              </div>
              <div className="anf-port-cell anf-port-cell--output">
                {row.output ? (
                  <PortPin
                    port={row.output}
                    side="output"
                    connected={connectedPortIds.has(row.output.id)}
                    variant="data"
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!hasFlowRow && !hasDataRows && !hasFields ? (
        <div className="anf-node-empty">没有声明端口。</div>
      ) : null}

      {data.type === "text_input" && !fieldsHandleTextInput ? (
        <TextInputEditor
          nodeId={id}
          value={typeof data.config.value === "string" ? (data.config.value as string) : ""}
          onChange={(next) => updateConfig?.(id, { value: next })}
          disabled={!updateConfig}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline textarea rendered inside `text_input` node cards. The wrapper
 * stops React Flow's drag/zoom/select interactions from swallowing
 * keyboard events while the user is typing, and uses the `nodrag` /
 * `nopan` class hooks the canvas already respects.
 */
function TextInputEditor({
  nodeId,
  value,
  onChange,
  disabled,
}: {
  nodeId: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="anf-node-text-input nodrag nopan nowheel"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label className="anf-node-text-input-label" htmlFor={`text-input-${nodeId}`}>
        输入文本
      </label>
      <textarea
        id={`text-input-${nodeId}`}
        className="anf-node-text-input-area"
        value={value}
        placeholder="输入提示词..."
        rows={3}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function PortPin({
  port,
  side,
  connected,
  variant,
}: {
  port: PortDefinition;
  side: "input" | "output";
  connected: boolean;
  variant: "flow" | "data";
}) {
  const label = port.label ?? port.id;
  const showLabel = variant !== "flow";
  const handleType = side === "input" ? "target" : "source";
  const position = side === "input" ? Position.Left : Position.Right;
  const tooltip = portTooltip(port);
  const handleClasses = [
    "anf-handle",
    `anf-handle--${side}`,
    `anf-handle--${port.kind}`,
    `anf-handle--${variant}`,
    connected ? "anf-handle--connected" : "anf-handle--free",
  ].join(" ");

  return (
    <div
      className={[
        "anf-port",
        `anf-port--${side}`,
        `anf-port--${port.kind}`,
        `anf-port--${variant}`,
        connected ? "anf-port--connected" : "anf-port--free",
      ].join(" ")}
      title={tooltip}
    >
      <Handle
        id={port.id}
        type={handleType}
        position={position}
        className={handleClasses}
      />
      {showLabel ? (
        <span className="anf-port-label">
          {label}
          {port.required ? <span className="anf-port-required" aria-hidden>*</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function portTooltip(port: PortDefinition): string {
  const name = port.label ?? port.id;
  const required = port.required ? " · 必填" : "";
  const multi = port.multiple ? " · 可多连" : "";
  return `${name}\n类型：${port.kind}${required}${multi}`;
}

/**
 * Look up the reflected `FieldDescriptor[]` for a node type from the
 * Studio palette, falling back to the version-agnostic entry. Used by
 * `onConnect` / `isValidConnection` to decide whether a target handle
 * id maps to a virtual config-field port.
 */
function findFieldsForNode(
  state: StudioState,
  type: string,
  typeVersion: string,
): import("@ai-native-flow/flow-ir").FieldDescriptor[] {
  const palette = state.palette ?? [];
  const exact = palette.find(
    (item) => item.type === type && item.typeVersion === typeVersion,
  );
  if (exact?.configFields && exact.configFields.length > 0) {
    return exact.configFields;
  }
  const anyVersion = palette.find((item) => item.type === type);
  return anyVersion?.configFields ?? [];
}

function kindForType(type: string): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("start") || t.includes("trigger")) return "start";
  if (t.includes("end") || t.includes("output")) return "end";
  if (t === "text_input" || t.includes("input") || t.includes("prompt")) return "input";
  if (t.includes("llm") || t.includes("chat") || t.includes("model")) return "model";
  if (t.includes("transform") || t.includes("map") || t.includes("filter")) return "transform";
  if (t.includes("tool")) return "tool";
  if (t.includes("http") || t.includes("api")) return "io";
  return "default";
}

function statusColor(status: ReactFlowStudioNodeData["status"]): string {
  if (status === "failed") return "#ef4444";
  if (status === "running") return "#0ea5e9";
  if (status === "succeeded") return "#22c55e";
  if (status === "streaming") return "#a855f7";
  return "#94a3b8";
}

/**
 * Tiny ms-level timer rendered directly under the node's status dot.
 *
 * - `idle`                       → not rendered (kept invisible).
 * - `running` / `streaming`      → ticks at ~10 fps from `runtime.startedAt`.
 * - `succeeded` / `failed`       → frozen final readout from
 *   `runtime.durationMs` (with a `runtime.startedAt` fallback for
 *   replays where the runtime didn't echo the duration).
 *
 * Kept as a self-contained component so the parent `StudioNodeCard`
 * doesn't pay the re-render cost of the interval when no run is in
 * flight on this node.
 */
function NodeRuntimeTimer({
  status,
  runtime,
}: {
  status: NonNullable<ReactFlowStudioNodeData["status"]>;
  runtime: ReactFlowStudioNodeData["runtime"];
}) {
  const isLive = status === "running" || status === "streaming";
  const startedAt = runtime?.startedAt;
  const finalMs = runtime?.durationMs;

  // Live re-render driver: only mounts an interval while the node is
  // actually running, so idle / settled nodes don't repaint every tick.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isLive || startedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [isLive, startedAt]);

  let text: string | null = null;
  if (isLive && startedAt !== undefined) {
    text = `${Math.max(0, now - startedAt)} ms`;
  } else if (
    (status === "succeeded" || status === "failed") &&
    finalMs !== undefined
  ) {
    text = `${Math.max(0, Math.round(finalMs))} ms`;
  } else if (
    (status === "succeeded" || status === "failed") &&
    startedAt !== undefined
  ) {
    // Best-effort fallback when the runtime didn't surface durationMs.
    text = `${Math.max(0, Date.now() - startedAt)} ms`;
  }

  if (!text) return null;
  return (
    <span
      className={`anf-node-runtime-timer anf-node-runtime-timer--${status}`}
      title="最近一次执行耗时"
    >
      {text}
    </span>
  );
}

/**
 * Pick the smallest free `${type}_${n}` id for a new node. We avoid
 * `crypto.randomUUID()` style ids on purpose so the canvas keeps the
 * compact "human-readable" identifiers the rest of the codebase
 * already uses (see `apps/studio`'s `node_start`,
 * `node_transform`, etc.).
 */
function generateNodeId(state: StudioState, type: string): string {
  const safe = type.replace(/[^a-zA-Z0-9_]/g, "_") || "node";
  const used = new Set(state.graph.nodes.map((n) => n.id));
  let i = 1;
  while (used.has(`${safe}_${i}`)) i++;
  return `${safe}_${i}`;
}

/* =====================================================================
 * Add-node menu (pane right-click) — Unreal-Engine blueprint style.
 * ===================================================================== */

interface AddNodeMenuProps {
  x: number;
  y: number;
  palette: StudioPaletteItem[];
  onPick: (item: StudioPaletteItem) => void;
  onClose: () => void;
}

interface NodeCategoryGroup {
  /** Category label ("流程控制", "数据", ...). */
  name: string;
  items: StudioPaletteItem[];
}

/**
 * Bucket a palette item into a coarse, UE-flavoured category. Built-in
 * types follow a stable naming convention (`start`, `end`, `llm`,
 * `tool`, `http`, `condition`, `transform`, …) so a string-based
 * heuristic stays accurate without needing a registry-side schema
 * change. Custom node types fall through to "其他".
 */
function categorizePaletteItem(item: StudioPaletteItem): string {
  const t = item.type.toLowerCase();
  if (t === "start" || t === "end") return "流程控制";
  if (t === "condition" || t.includes("branch") || t.includes("switch")) return "流程控制";
  if (t === "text_input" || t.includes("input") || t.includes("prompt")) return "输入";
  if (t === "llm" || t.includes("chat") || t.includes("model")) return "AI";
  if (t === "tool" || t.includes("agent")) return "AI";
  if (t === "http" || t.includes("api") || t.includes("request")) return "接口";
  if (t === "transform" || t.includes("map") || t.includes("filter") || t.includes("reduce")) return "数据";
  if (t.includes("variable") || t.includes("store") || t.includes("memory")) return "数据";
  return "其他";
}

/** Order categories in UE-style: flow > input > AI > data > API > other. */
const CATEGORY_ORDER = ["流程控制", "输入", "AI", "数据", "接口", "其他"];

function groupPaletteByCategory(palette: StudioPaletteItem[]): NodeCategoryGroup[] {
  const buckets = new Map<string, StudioPaletteItem[]>();
  for (const item of palette) {
    const key = categorizePaletteItem(item);
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries())
    .map(([name, items]) => ({
      name,
      items: [...items].sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.name);
      const bi = CATEGORY_ORDER.indexOf(b.name);
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
}

function AddNodeMenu({ x, y, palette, onPick }: AddNodeMenuProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Auto-focus the search field on open so power users can keyboard
  // straight from right-click → typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep all categories collapsed by default (matching UE) but open
  // them automatically while a search query is live so matches are
  // instantly visible.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupPaletteByCategory(palette), [palette]);
  const trimmed = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!trimmed) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (it) =>
            it.title.toLowerCase().includes(trimmed) ||
            it.type.toLowerCase().includes(trimmed) ||
            (it.description?.toLowerCase().includes(trimmed) ?? false),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, trimmed]);

  const isSearching = trimmed.length > 0;

  // Pin the menu inside the viewport so it never spills off-screen on
  // right-clicks near the edges. The numbers are intentionally rough —
  // a precise measurement would require an effect after layout, which
  // adds a frame of jank for negligible gain.
  const MENU_WIDTH = 280;
  const MENU_HEIGHT = 360;
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8);

  return (
    <div
      className="anf-add-node-menu"
      role="menu"
      style={{ left, top }}
      // The `data-anf-menu` marker lets the parent's capture-phase
      // outside-click listener tell "clicked inside the menu" apart
      // from "clicked elsewhere" via Element.closest(), without
      // needing to hoist a DOM ref. We avoid stopPropagation here on
      // purpose — letting the event bubble means dispatching a click
      // on a node or on the canvas reliably gets routed to ReactFlow.
      data-anf-menu="add-node"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* No explicit close button — clicking outside the menu (handled
       * by the parent's window mousedown listener) or pressing Escape
       * dismisses the picker. Keeps the surface compact, matching UE's
       * blueprint Add-Node experience. */}
      <div className="anf-add-node-menu-search">
        <input
          ref={inputRef}
          type="search"
          placeholder="搜索节点..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="anf-add-node-menu-body">
        {filteredGroups.length === 0 ? (
          <div className="anf-add-node-menu-empty">
            {palette.length === 0 ? "没有可创建的节点类型。" : `没有匹配“${query}”的节点。`}
          </div>
        ) : (
          filteredGroups.map((group) => {
            const open = isSearching || openGroups[group.name] !== false;
            return (
              <div key={group.name} className="anf-add-node-group">
                <button
                  type="button"
                  className="anf-add-node-group-header"
                  onClick={() =>
                    setOpenGroups((prev) => ({
                      ...prev,
                      [group.name]:
                        prev[group.name] === undefined ? false : !prev[group.name],
                    }))
                  }
                >
                  <span
                    className="anf-add-node-group-chevron"
                    style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
                    aria-hidden
                  >
                    ▶
                  </span>
                  <span className="anf-add-node-group-name">{group.name}</span>
                  <span className="anf-add-node-group-count">{group.items.length}</span>
                </button>
                {open ? (
                  <ul className="anf-add-node-group-list">
                    {group.items.map((item) => (
                      <li key={`${item.type}@${item.typeVersion}`}>
                        <button
                          type="button"
                          role="menuitem"
                          className="anf-add-node-item"
                          onClick={() => onPick(item)}
                          title={item.description ?? item.title}
                        >
                          <span className={`anf-add-node-item-dot anf-add-node-item-dot--${kindForType(item.type)}`} aria-hidden />
                          <span className="anf-add-node-item-text">
                            <span className="anf-add-node-item-title">{item.title}</span>
                            <span className="anf-add-node-item-type">
                              {item.type}@{item.typeVersion}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
