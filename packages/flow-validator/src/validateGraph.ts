/**
 * Graph-level validation. Run after `validateSchema` succeeds.
 *
 * Checks performed (per `docs/specs/flow-graph-schema.md` and Phase 0 DoD):
 *   - Node ids are unique inside the flow.
 *   - Edge ids are unique.
 *   - Each edge endpoint refers to an existing node and an existing port.
 *   - Edge directions are valid (output → input).
 *   - Port kinds are compatible (control↔control, data↔data, error→data/error).
 *   - `multiple: false` input ports may not be connected more than once.
 *   - Self-loops on a node's identical port are rejected.
 *   - When a `NodeTypeRegistry` is provided, node `type` / `typeVersion`
 *     must exist in the registry. Built-in port presence is also checked.
 *
 * Soft warnings (do not fail validation):
 *   - Orphan nodes (no incoming or outgoing edges) other than `start` /
 *     `end`.
 */

import {
  createRuntimeError,
  type EdgeDefinition,
  type FlowGraph,
  type NodeInstance,
  type NodeTypeRegistry,
  type PortDefinition,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import { emptyResult, type ValidationResult } from "./result.js";
import {
  arePortKindsCompatible,
  validatePortsForNode,
} from "./validatePorts.js";
import { validateSchema } from "./validateSchema.js";

export interface ValidateGraphOptions {
  /** Optional Node Type Registry for type / port presence checks. */
  registry?: NodeTypeRegistry;
}

export function validateGraph(
  flow: FlowGraph,
  options: ValidateGraphOptions = {},
): ValidationResult {
  const result = emptyResult();

  /* ---------------- Nodes ---------------- */
  const byId = new Map<string, NodeInstance>();
  for (const node of flow.nodes) {
    if (byId.has(node.id)) {
      result.errors.push(
        err(
          "validator.duplicate_node_id",
          `duplicate node id "${node.id}"`,
          { nodeId: node.id },
        ),
      );
      continue;
    }
    byId.set(node.id, node);

    // Per-node port validation.
    result.errors.push(...validatePortsForNode(node));

    // Optional registry checks.
    if (options.registry) {
      const def = options.registry.tryGet(node.type, node.typeVersion);
      if (!def) {
        result.errors.push(
          err(
            "validator.unknown_node_type",
            `unknown node type ${node.type}@${node.typeVersion}`,
            {
              nodeId: node.id,
              type: node.type,
              typeVersion: node.typeVersion,
            },
          ),
        );
      }
    }
  }

  /* ---------------- Edges ---------------- */
  const edgeIds = new Set<string>();
  /** Counts inbound edges per (nodeId, portId) for `multiple` enforcement. */
  const inboundCount = new Map<string, number>();
  /** Tracks nodes referenced by at least one edge (for orphan warnings). */
  const referenced = new Set<string>();

  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) {
      result.errors.push(
        err(
          "validator.duplicate_edge_id",
          `duplicate edge id "${edge.id}"`,
          { edgeId: edge.id },
        ),
      );
      continue;
    }
    edgeIds.add(edge.id);

    const fromNode = byId.get(edge.from.nodeId);
    const toNode = byId.get(edge.to.nodeId);
    if (!fromNode) {
      result.errors.push(
        err(
          "validator.edge_node_missing",
          `edge ${edge.id}: from node "${edge.from.nodeId}" does not exist`,
          { edgeId: edge.id, nodeId: edge.from.nodeId },
        ),
      );
    }
    if (!toNode) {
      result.errors.push(
        err(
          "validator.edge_node_missing",
          `edge ${edge.id}: to node "${edge.to.nodeId}" does not exist`,
          { edgeId: edge.id, nodeId: edge.to.nodeId },
        ),
      );
    }

    // Check ports independently: a missing port is a different error than a
    // missing node, and AI agents need both signals to self-repair.
    const fromPort = fromNode
      ? findPort(fromNode, edge.from.portId, "output")
      : undefined;
    const toPort = toNode
      ? findPort(toNode, edge.to.portId, "input")
      : undefined;

    if (fromNode) referenced.add(fromNode.id);
    if (toNode) referenced.add(toNode.id);

    if (fromNode && !fromPort) {
      result.errors.push(
        err(
          "validator.port_missing",
          `edge ${edge.id}: output port "${edge.from.portId}" not found on node "${fromNode.id}"`,
          { edgeId: edge.id, nodeId: fromNode.id, portId: edge.from.portId },
        ),
      );
    }
    if (toNode && !toPort) {
      result.errors.push(
        err(
          "validator.port_missing",
          `edge ${edge.id}: input port "${edge.to.portId}" not found on node "${toNode.id}"`,
          { edgeId: edge.id, nodeId: toNode.id, portId: edge.to.portId },
        ),
      );
    }

    // Skip downstream checks when either endpoint is missing.
    if (!fromNode || !toNode || !fromPort || !toPort) continue;

    if (fromPort.direction !== "output") {
      result.errors.push(
        err(
          "validator.invalid_port_direction",
          `edge ${edge.id}: from port "${fromPort.id}" must be output`,
          { edgeId: edge.id, portId: fromPort.id },
        ),
      );
    }
    if (toPort.direction !== "input") {
      result.errors.push(
        err(
          "validator.invalid_port_direction",
          `edge ${edge.id}: to port "${toPort.id}" must be input`,
          { edgeId: edge.id, portId: toPort.id },
        ),
      );
    }

    if (!arePortKindsCompatible(fromPort, toPort)) {
      result.errors.push(
        err(
          "validator.port_kind_incompatible",
          `edge ${edge.id}: cannot connect ${fromPort.kind} output to ${toPort.kind} input`,
          {
            edgeId: edge.id,
            fromKind: fromPort.kind,
            toKind: toPort.kind,
          },
        ),
      );
    }

    // Self-loop on the same port is always invalid.
    if (
      edge.from.nodeId === edge.to.nodeId &&
      edge.from.portId === edge.to.portId
    ) {
      result.errors.push(
        err(
          "validator.self_loop",
          `edge ${edge.id}: port "${edge.from.portId}" cannot connect to itself`,
          { edgeId: edge.id, nodeId: edge.from.nodeId, portId: edge.from.portId },
        ),
      );
    }

    // Track inbound count for `multiple` enforcement.
    const key = `${edge.to.nodeId}::${edge.to.portId}`;
    inboundCount.set(key, (inboundCount.get(key) ?? 0) + 1);
  }

  // Enforce `multiple: false` on input ports.
  for (const [key, count] of inboundCount) {
    if (count <= 1) continue;
    const sep = key.indexOf("::");
    const nodeId = key.slice(0, sep);
    const portId = key.slice(sep + 2);
    const node = byId.get(nodeId);
    const port = node ? findPort(node, portId, "input") : undefined;
    if (port && !port.multiple) {
      result.errors.push(
        err(
          "validator.port_multiple_violation",
          `node ${nodeId} input port "${portId}" received ${count} inbound edges but multiple=false`,
          { nodeId, portId, count },
        ),
      );
    }
  }

  /* ---------------- Soft warnings ---------------- */
  for (const node of flow.nodes) {
    if (node.type === "start" || node.type === "end") continue;
    if (!referenced.has(node.id)) {
      result.warnings.push(
        warn(
          "validator.orphan_node",
          `node ${node.id} (${node.type}) has no incoming or outgoing edges`,
          { nodeId: node.id, type: node.type },
        ),
      );
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

function findPort(
  node: NodeInstance,
  portId: string,
  direction: "input" | "output",
): PortDefinition | undefined {
  for (const p of node.ports) {
    if (p.id === portId && p.direction === direction) return p;
  }
  return undefined;
}

function err(
  code: string,
  message: string,
  context: Record<string, unknown>,
): RuntimeError {
  return createRuntimeError({
    code,
    kind: "validation",
    category: "author",
    message,
    source: { module: "validator" },
    context,
  });
}

function warn(
  code: string,
  message: string,
  context: Record<string, unknown>,
): RuntimeError {
  return createRuntimeError({
    code,
    kind: "validation",
    category: "author",
    message,
    retryable: false,
    source: { module: "validator" },
    context,
  });
}

/** Validate against schema *and* graph rules in one call. */
export function validateFlow(
  input: unknown,
  options: ValidateGraphOptions = {},
): { result: ValidationResult; flow?: FlowGraph } {
  const shape = validateSchema(input);
  if (!shape.flow) return shape;

  const graphResult = validateGraph(shape.flow, options);
  return {
    result: {
      ok: shape.result.ok && graphResult.ok,
      errors: [...shape.result.errors, ...graphResult.errors],
      warnings: [...shape.result.warnings, ...graphResult.warnings],
    },
    flow: graphResult.ok ? shape.flow : undefined,
  };
}
