/**
 * Graph Operation contract and apply / diff helpers.
 *
 * Per `docs/specs/graph-operations.md`, AI agents and Studio express small
 * mutations as discrete `GraphOperation`s rather than rewriting the full
 * Flow JSON. This file defines the operation tagged-union, an `applyOps`
 * function that produces a new `FlowGraph` (validated), and a `diffFlow`
 * function that compares two FlowGraphs and reports the structural delta
 * for Patch Preview.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  type EdgeDefinition,
  type FlowGraph,
  type NodeInstance,
  type NodeTypeRegistry,
  type PortDefinition,
} from "@ai-native-flow/flow-ir";
import { validateGraph } from "@ai-native-flow/flow-validator";

/* -------------------------------------------------------------------------- */
/* Operation tagged union                                                      */
/* -------------------------------------------------------------------------- */

export interface AddNodeOp {
  op: "add_node";
  node: NodeInstance;
}

export interface RemoveNodeOp {
  op: "remove_node";
  nodeId: string;
}

export interface UpdateNodeConfigOp {
  op: "update_node_config";
  nodeId: string;
  /** Shallow-merged into the existing config. */
  patch: Record<string, unknown>;
}

export interface SetNodePositionOp {
  op: "set_node_position";
  nodeId: string;
  position: { x: number; y: number };
}

export interface AddPortOp {
  op: "add_port";
  nodeId: string;
  port: PortDefinition;
}

export interface RemovePortOp {
  op: "remove_port";
  nodeId: string;
  portId: string;
  direction: "input" | "output";
}

export interface AddEdgeOp {
  op: "add_edge";
  edge: EdgeDefinition;
}

export interface RemoveEdgeOp {
  op: "remove_edge";
  edgeId: string;
}

export type GraphOperation =
  | AddNodeOp
  | RemoveNodeOp
  | UpdateNodeConfigOp
  | SetNodePositionOp
  | AddPortOp
  | RemovePortOp
  | AddEdgeOp
  | RemoveEdgeOp;

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

export interface ApplyOptions {
  registry?: NodeTypeRegistry;
  /** When true (default), the result is validated; throws on invalid graph. */
  validate?: boolean;
}

/**
 * Apply a sequence of operations to a base flow and return the new flow.
 *
 * Operations are applied in order. On structural error (unknown node, etc.)
 * the function throws a `RuntimeErrorException`; callers should treat that
 * as the AI patch being malformed and surface the error code to the user.
 */
export function applyOps(
  base: FlowGraph,
  ops: ReadonlyArray<GraphOperation>,
  options: ApplyOptions = {},
): FlowGraph {
  const next: FlowGraph = {
    ...base,
    nodes: base.nodes.map((n) => ({ ...n, ports: n.ports.map((p) => ({ ...p })), config: { ...n.config } })),
    edges: base.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })),
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    applyOne(next, op, i);
  }

  if (options.validate !== false) {
    const result = validateGraph(next, { registry: options.registry });
    if (!result.ok) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "builder.invalid_patch",
          kind: "validation",
          category: "author",
          message: `graph operation patch produced an invalid flow (${result.errors.length} error(s))`,
          source: { module: "builder", flowId: next.id },
          context: { errors: result.errors },
        }),
      );
    }
  }

  return next;
}

function applyOne(flow: FlowGraph, op: GraphOperation, index: number): void {
  switch (op.op) {
    case "add_node": {
      if (flow.nodes.some((n) => n.id === op.node.id)) {
        throw patchError(
          "builder.duplicate_node_id",
          `op #${index}: node ${op.node.id} already exists`,
          { nodeId: op.node.id },
        );
      }
      flow.nodes.push({
        ...op.node,
        ports: op.node.ports.map((p) => ({ ...p })),
        config: { ...op.node.config },
      });
      return;
    }
    case "remove_node": {
      const idx = flow.nodes.findIndex((n) => n.id === op.nodeId);
      if (idx < 0) {
        throw patchError(
          "builder.unknown_node",
          `op #${index}: node ${op.nodeId} not found`,
          { nodeId: op.nodeId },
        );
      }
      flow.nodes.splice(idx, 1);
      // Cascade-remove edges referencing the node.
      flow.edges = flow.edges.filter(
        (e) => e.from.nodeId !== op.nodeId && e.to.nodeId !== op.nodeId,
      );
      return;
    }
    case "update_node_config": {
      const node = flow.nodes.find((n) => n.id === op.nodeId);
      if (!node) {
        throw patchError(
          "builder.unknown_node",
          `op #${index}: node ${op.nodeId} not found`,
          { nodeId: op.nodeId },
        );
      }
      node.config = { ...node.config, ...op.patch };
      return;
    }
    case "set_node_position": {
      const node = flow.nodes.find((n) => n.id === op.nodeId);
      if (!node) {
        throw patchError(
          "builder.unknown_node",
          `op #${index}: node ${op.nodeId} not found`,
          { nodeId: op.nodeId },
        );
      }
      node.position = { ...op.position };
      return;
    }
    case "add_port": {
      const node = flow.nodes.find((n) => n.id === op.nodeId);
      if (!node) {
        throw patchError(
          "builder.unknown_node",
          `op #${index}: node ${op.nodeId} not found`,
          { nodeId: op.nodeId },
        );
      }
      if (
        node.ports.some(
          (p) => p.id === op.port.id && p.direction === op.port.direction,
        )
      ) {
        throw patchError(
          "builder.duplicate_port_id",
          `op #${index}: node ${op.nodeId} already has ${op.port.direction} port ${op.port.id}`,
          {
            nodeId: op.nodeId,
            portId: op.port.id,
            direction: op.port.direction,
          },
        );
      }
      node.ports.push({ ...op.port });
      return;
    }
    case "remove_port": {
      const node = flow.nodes.find((n) => n.id === op.nodeId);
      if (!node) {
        throw patchError(
          "builder.unknown_node",
          `op #${index}: node ${op.nodeId} not found`,
          { nodeId: op.nodeId },
        );
      }
      const before = node.ports.length;
      node.ports = node.ports.filter(
        (p) => !(p.id === op.portId && p.direction === op.direction),
      );
      if (node.ports.length === before) {
        throw patchError(
          "builder.unknown_port",
          `op #${index}: ${op.direction} port ${op.portId} not found on node ${op.nodeId}`,
          { nodeId: op.nodeId, portId: op.portId, direction: op.direction },
        );
      }
      // Cascade-invalidate edges that referenced the removed port.
      flow.edges = flow.edges.filter((e) => {
        if (op.direction === "output" && e.from.nodeId === op.nodeId && e.from.portId === op.portId) {
          return false;
        }
        if (op.direction === "input" && e.to.nodeId === op.nodeId && e.to.portId === op.portId) {
          return false;
        }
        return true;
      });
      return;
    }
    case "add_edge": {
      if (flow.edges.some((e) => e.id === op.edge.id)) {
        throw patchError(
          "builder.duplicate_edge_id",
          `op #${index}: edge ${op.edge.id} already exists`,
          { edgeId: op.edge.id },
        );
      }
      flow.edges.push({
        ...op.edge,
        from: { ...op.edge.from },
        to: { ...op.edge.to },
      });
      return;
    }
    case "remove_edge": {
      const idx = flow.edges.findIndex((e) => e.id === op.edgeId);
      if (idx < 0) {
        throw patchError(
          "builder.unknown_edge",
          `op #${index}: edge ${op.edgeId} not found`,
          { edgeId: op.edgeId },
        );
      }
      flow.edges.splice(idx, 1);
      return;
    }
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = op;
      void _exhaustive;
      throw patchError(
        "builder.unknown_operation",
        `op #${index}: unknown operation`,
        { index },
      );
    }
  }
}

function patchError(
  code: string,
  message: string,
  context: Record<string, unknown>,
): RuntimeErrorException {
  return new RuntimeErrorException(
    createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "builder" },
      context,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Diff / preview                                                              */
/* -------------------------------------------------------------------------- */

export interface NodeChange {
  nodeId: string;
  /** Field-level changes; only changed fields are listed. */
  fields: string[];
}

export interface EdgeChange {
  edgeId: string;
  fields: string[];
}

export interface FlowDiff {
  addedNodes: NodeInstance[];
  removedNodes: NodeInstance[];
  changedNodes: NodeChange[];

  addedEdges: EdgeDefinition[];
  removedEdges: EdgeDefinition[];
  changedEdges: EdgeChange[];
}

/**
 * Compute a structural diff between two FlowGraphs.
 *
 * Used by Studio Patch Preview and by AI loops that want to confirm that an
 * operation list does what they intended before promoting it.
 */
export function diffFlow(prev: FlowGraph, next: FlowGraph): FlowDiff {
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n] as const));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n] as const));
  const prevEdges = new Map(prev.edges.map((e) => [e.id, e] as const));
  const nextEdges = new Map(next.edges.map((e) => [e.id, e] as const));

  const addedNodes: NodeInstance[] = [];
  const removedNodes: NodeInstance[] = [];
  const changedNodes: NodeChange[] = [];
  const addedEdges: EdgeDefinition[] = [];
  const removedEdges: EdgeDefinition[] = [];
  const changedEdges: EdgeChange[] = [];

  for (const [id, node] of nextNodes) {
    const prior = prevNodes.get(id);
    if (!prior) {
      addedNodes.push(node);
      continue;
    }
    const fields = compareNode(prior, node);
    if (fields.length > 0) changedNodes.push({ nodeId: id, fields });
  }
  for (const [id, node] of prevNodes) {
    if (!nextNodes.has(id)) removedNodes.push(node);
  }

  for (const [id, edge] of nextEdges) {
    const prior = prevEdges.get(id);
    if (!prior) {
      addedEdges.push(edge);
      continue;
    }
    const fields = compareEdge(prior, edge);
    if (fields.length > 0) changedEdges.push({ edgeId: id, fields });
  }
  for (const [id, edge] of prevEdges) {
    if (!nextEdges.has(id)) removedEdges.push(edge);
  }

  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
  };
}

function compareNode(a: NodeInstance, b: NodeInstance): string[] {
  const changed: string[] = [];
  if (a.type !== b.type) changed.push("type");
  if (a.typeVersion !== b.typeVersion) changed.push("typeVersion");
  if (a.label !== b.label) changed.push("label");
  if (!sameJson(a.position, b.position)) changed.push("position");
  if (!sameJson(a.size, b.size)) changed.push("size");
  if (!sameJson(a.ports, b.ports)) changed.push("ports");
  if (!sameJson(a.config, b.config)) changed.push("config");
  if (!sameJson(a.ui, b.ui)) changed.push("ui");
  return changed;
}

function compareEdge(a: EdgeDefinition, b: EdgeDefinition): string[] {
  const changed: string[] = [];
  if (!sameJson(a.from, b.from)) changed.push("from");
  if (!sameJson(a.to, b.to)) changed.push("to");
  if (a.condition !== b.condition) changed.push("condition");
  if (!sameJson(a.ui, b.ui)) changed.push("ui");
  return changed;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
