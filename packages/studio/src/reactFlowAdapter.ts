import type { Connection, Edge, Node, NodeChange } from "@xyflow/react";
import type { FieldDescriptor, PortDefinition } from "@ai-native-flow/flow-ir";
import type { StudioCanvasNode, StudioEdgeDraft, StudioViewModel } from "./types.js";

/**
 * Mark used by the Studio to remember that a port was synthesised from
 * a config field rather than declared by the node author. Stored as a
 * `__virtual` flag on the in-memory `PortDefinition` only — never
 * serialised to the FlowGraph IR (the field is intentionally left off
 * the IR's PortDefinition contract).
 */
export const VIRTUAL_PORT_FLAG = "__virtual";

/**
 * Augmented `PortDefinition` shape used inside the Studio. The base IR
 * type is preserved (so the value remains a valid PortDefinition for
 * downstream consumers), but we tack on `__virtual` to signal that the
 * port hasn't been written to `node.ports` yet — `onConnect` uses this
 * flag to decide whether it must emit an `add_port` op alongside the
 * `add_edge` op.
 */
export type StudioPortDefinition = PortDefinition & {
  /** True when the port was synthesised from a config field. */
  [VIRTUAL_PORT_FLAG]?: true;
};

/**
 * Synthesize a `data` input port for every visible config field that
 * doesn't already match a declared input port id. The result is the
 * concatenation of (a) the node's declared inputs and (b) virtual
 * inputs derived from the config schema — preserving declaration order
 * for (a) and `FieldDescriptor` order (already sorted by `order`) for
 * (b).
 */
export function deriveStudioInputPorts(
  declaredInputs: ReadonlyArray<PortDefinition>,
  fields: ReadonlyArray<FieldDescriptor>,
): StudioPortDefinition[] {
  const out: StudioPortDefinition[] = declaredInputs.map((p) => ({ ...p }));
  const taken = new Set(declaredInputs.map((p) => p.id));
  for (const field of fields) {
    if (field.hidden) continue;
    if (taken.has(field.name)) continue;
    out.push({
      id: field.name,
      direction: "input",
      kind: "data",
      label: field.label ?? field.name,
      required: !field.optional,
      [VIRTUAL_PORT_FLAG]: true,
    });
    taken.add(field.name);
  }
  return out;
}

export interface ReactFlowStudioNodeData extends Record<string, unknown> {
  label: string;
  type: string;
  typeVersion: string;
  status: StudioCanvasNode["status"];
  /**
   * Optional execution timing snapshot pulled from the run-event
   * stream. Mirrors `StudioCanvasNode.runtime` and is consumed by the
   * node card to render a small ms-level timer below the status dot.
   */
  runtime?: StudioCanvasNode["runtime"];
  inputs: StudioCanvasNode["inputs"];
  outputs: StudioCanvasNode["outputs"];
  config: StudioCanvasNode["config"];
  /**
   * Reflected config field descriptors (Node Field Inspector) resolved
   * from the palette entry that matches `(type, typeVersion)`. Empty
   * when the node type doesn't expose a Zod-described `config`.
   */
  configFields: FieldDescriptor[];
  /**
   * Set of port ids on this node that are referenced by at least one
   * edge (either as `from` or `to`). The Studio uses this to
   *   1. paint the UE-style flow pin as filled-with-gap when wired,
   *      hollow when free, and
   *   2. hide the inline editor for an input data field whose
   *      same-named port is already wired (the upstream value wins).
   * Stored as a string array (rather than a Set) so it survives the
   * shallow-clone React Flow does on the data object.
   */
  connectedPortIds: string[];
}

export type ReactFlowStudioNode = Node<ReactFlowStudioNodeData, "studioNode">;
export interface ReactFlowStudioEdgeData extends Record<string, unknown> {
  kind: string;
  condition?: string;
  active?: boolean;
  dimmed?: boolean;
}

export type ReactFlowStudioEdge = Edge<ReactFlowStudioEdgeData>;

export interface ReactFlowGraphProjection {
  nodes: ReactFlowStudioNode[];
  edges: ReactFlowStudioEdge[];
}

export function toReactFlowGraph(view: StudioViewModel): ReactFlowGraphProjection {
  const fieldsByType = new Map<string, FieldDescriptor[]>();
  for (const item of view.palette) {
    if (item.configFields && item.configFields.length > 0) {
      fieldsByType.set(`${item.type}@${item.typeVersion}`, item.configFields);
      // Also register a version-agnostic fallback so newly-added nodes
      // pick up fields even when their `typeVersion` lags behind the
      // palette's latest entry.
      if (!fieldsByType.has(item.type)) {
        fieldsByType.set(item.type, item.configFields);
      }
    }
  }

  // Pre-compute which (nodeId, portId) pairs participate in at least one
  // edge. Storing as `Map<nodeId, Set<portId>>` keeps the per-node lookup
  // O(1) without scanning the edge list per render.
  const connectedByNode = new Map<string, Set<string>>();
  const noteConnection = (nodeId: string, portId: string) => {
    let set = connectedByNode.get(nodeId);
    if (!set) {
      set = new Set();
      connectedByNode.set(nodeId, set);
    }
    set.add(portId);
  };
  for (const edge of view.edges) {
    const src = splitEndpoint(edge.from);
    const dst = splitEndpoint(edge.to);
    if (src.portId) noteConnection(src.nodeId, src.portId);
    if (dst.portId) noteConnection(dst.nodeId, dst.portId);
  }

  return {
    nodes: view.nodes.map((node) => {
      const fields =
        fieldsByType.get(`${node.type}@${node.typeVersion}`) ??
        fieldsByType.get(node.type) ??
        [];
      // Promote every visible config field that doesn't already shadow
      // a declared port into a `data` input port. The field panel and
      // the data-row strip read from this enriched list, so users get
      // a wireable handle next to every parameter — UE-blueprint-style.
      const enrichedInputs = deriveStudioInputPorts(node.inputs, fields);
      return {
        id: node.id,
        type: "studioNode",
        position: { ...node.position },
        width: node.size.width,
        height: node.size.height,
        selected: view.selectedNodeId === node.id,
        data: {
          label: node.label,
          type: node.type,
          typeVersion: node.typeVersion,
          status: node.status,
          ...(node.runtime ? { runtime: node.runtime } : {}),
          inputs: enrichedInputs,
          outputs: node.outputs.map((port) => ({ ...port })),
          config: { ...node.config },
          configFields: fields,
          connectedPortIds: Array.from(connectedByNode.get(node.id) ?? []),
        },
      };
    }),
    edges: view.edges.map((edge) => {
      const source = splitEndpoint(edge.from);
      const target = splitEndpoint(edge.to);
      return {
        id: edge.id,
        type: "studioCircuit",
        source: source.nodeId,
        sourceHandle: source.portId,
        target: target.nodeId,
        targetHandle: target.portId,
        selected: view.selectedEdgeId === edge.id,
        data: {
          kind: edge.kind,
          condition: edge.condition,
        },
      } satisfies ReactFlowStudioEdge;
    }),
  };
}

export function reactFlowConnectionToStudioEdgeDraft(connection: Connection, edgeId = createEdgeId(connection)): StudioEdgeDraft | undefined {
  if (!connection.source || !connection.sourceHandle || !connection.target || !connection.targetHandle) return undefined;
  return {
    id: edgeId,
    from: {
      nodeId: connection.source,
      portId: connection.sourceHandle,
    },
    to: {
      nodeId: connection.target,
      portId: connection.targetHandle,
    },
  };
}

export function getMovedNodePositions(changes: NodeChange<ReactFlowStudioNode>[]): Array<{ nodeId: string; position: { x: number; y: number } }> {
  return changes.flatMap((change) => {
    if (change.type !== "position" || !change.position || change.dragging) return [];
    return [{ nodeId: change.id, position: { ...change.position } }];
  });
}

export function createEdgeId(connection: Pick<Connection, "source" | "sourceHandle" | "target" | "targetHandle">): string {
  return [connection.source, connection.sourceHandle, connection.target, connection.targetHandle]
    .map((part) => part ?? "unknown")
    .join("__");
}

function splitEndpoint(endpoint: string): { nodeId: string; portId: string } {
  const dotIndex = endpoint.lastIndexOf(".");
  if (dotIndex === -1) return { nodeId: endpoint, portId: "" };
  return {
    nodeId: endpoint.slice(0, dotIndex),
    portId: endpoint.slice(dotIndex + 1),
  };
}
