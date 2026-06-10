/**
 * The typed Flow Builder.
 *
 * Construction-time API that:
 *   - allocates stable, deterministic node and edge ids,
 *   - clones the registry's default ports onto each node instance,
 *   - rejects illegal connections at the moment they are made (cheap
 *     fast-feedback for AI agents and humans),
 *   - delegates the final, exhaustive structural / semantic check to the
 *     `flow-validator` before emitting JSON via `dump()`.
 *
 * See `docs/specs/flow-builder.md` for the contract.
 */

import {
  FLOW_GRAPH_SCHEMA_VERSION,
  IdAllocator,
  RuntimeErrorException,
  createDefaultRegistry,
  createRuntimeError,
  isValidId,
  type EdgeDefinition,
  type FlowGraph,
  type NodeInstance,
  type NodeTypeRegistry,
  type PortDefinition,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import {
  arePortKindsCompatible,
  validateGraph,
  type ValidationResult,
} from "@ai-native-flow/flow-validator";
import { stringifyFlow } from "./dump.js";
import { applyAutoLayout } from "./autoLayout.js";
import type {
  ConnectOptions,
  CreateNodeOptions,
  DefineFlowOptions,
  EdgeHandle,
  InputPortHandle,
  NodeHandle,
  OutputPortHandle,
} from "./nodeHandle.js";

/** Public Builder contract. Returned by `defineFlow(...)`. */
export interface FlowBuilder {
  readonly id: string;
  readonly version: string;
  readonly registry: NodeTypeRegistry;

  node(type: string, options?: CreateNodeOptions): NodeHandle;
  connect(
    from: OutputPortHandle,
    to: InputPortHandle,
    options?: ConnectOptions,
  ): EdgeHandle;
  removeNode(nodeId: string): void;
  removeEdge(edgeId: string): void;

  /** Validate without serialising. */
  validate(): ValidationResult;

  /**
   * Serialise to a deterministic Flow JSON string.
   * Throws `RuntimeErrorException` (`builder.invalid_flow`) if the graph
   * does not pass validation.
   */
  dump(): string;

  /** Return a structured `FlowGraph` snapshot (already validated). */
  toFlowGraph(): FlowGraph;
}

/** Entry point. */
export function defineFlow(options: DefineFlowOptions): FlowBuilder {
  return new FlowBuilderImpl(options);
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

class FlowBuilderImpl implements FlowBuilder {
  readonly id: string;
  readonly version: string;
  readonly registry: NodeTypeRegistry;

  private readonly label: string | undefined;
  private readonly description: string | undefined;
  private readonly inputSchema: unknown;
  private readonly outputSchema: unknown;

  private readonly nodes = new Map<string, NodeInstance>();
  private readonly edges = new Map<string, EdgeDefinition>();
  /**
   * Insertion order is preserved separately because Map preserves insertion
   * order in modern JS engines, but we want explicit control to support
   * `removeNode` + re-add scenarios deterministically.
   */
  private readonly nodeOrder: string[] = [];
  private readonly edgeOrder: string[] = [];
  private readonly explicitPositionNodeIds = new Set<string>();

  private readonly idAlloc = new IdAllocator();
  private readonly edgeIdAlloc = new IdAllocator();

  constructor(options: DefineFlowOptions) {
    this.id = ensureValidId(options.id, "flow.id");
    this.version = nonEmpty(options.version, "flow.version");
    this.registry = options.registry ?? createDefaultRegistry();
    this.label = options.label;
    this.description = options.description;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
  }

  node(type: string, options: CreateNodeOptions = {}): NodeHandle {
    const def = this.registry.tryGet(type, options.typeVersion);
    if (!def) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "builder.unknown_node_type",
          kind: "validation",
          category: "author",
          message: options.typeVersion
            ? `unknown node type ${type}@${options.typeVersion}`
            : `unknown node type ${type}`,
          source: { module: "builder", flowId: this.id },
          context: { type, typeVersion: options.typeVersion },
        }),
      );
    }

    const id = this.allocateNodeId(type, options);
    const ports = composePorts(def.defaultPorts, options.ports, options.extraPorts);
    const node: NodeInstance = {
      id,
      type: def.type,
      typeVersion: def.typeVersion,
      position: options.position ?? { x: 0, y: 0 },
      ports,
      config: { ...(options.config ?? {}) },
    };
    if (options.label !== undefined) node.label = options.label;
    if (options.size !== undefined) node.size = options.size;
    if (options.ui !== undefined) node.ui = { ...options.ui };

    this.nodes.set(id, node);
    this.nodeOrder.push(id);
    if (options.position !== undefined) {
      this.explicitPositionNodeIds.add(id);
    }

    return this.makeHandle(id);
  }

  connect(
    from: OutputPortHandle,
    to: InputPortHandle,
    options: ConnectOptions = {},
  ): EdgeHandle {
    const fromNode = this.nodes.get(from.nodeId);
    const toNode = this.nodes.get(to.nodeId);
    if (!fromNode) {
      throw exception("builder.unknown_node", `unknown node ${from.nodeId}`, this.id, {
        nodeId: from.nodeId,
      });
    }
    if (!toNode) {
      throw exception("builder.unknown_node", `unknown node ${to.nodeId}`, this.id, {
        nodeId: to.nodeId,
      });
    }
    const fromPort = findPort(fromNode, from.portId, "output");
    const toPort = findPort(toNode, to.portId, "input");
    if (!fromPort) {
      throw exception(
        "builder.unknown_port",
        `output port "${from.portId}" not found on node ${fromNode.id}`,
        this.id,
        { nodeId: fromNode.id, portId: from.portId },
      );
    }
    if (!toPort) {
      throw exception(
        "builder.unknown_port",
        `input port "${to.portId}" not found on node ${toNode.id}`,
        this.id,
        { nodeId: toNode.id, portId: to.portId },
      );
    }
    if (!arePortKindsCompatible(fromPort, toPort)) {
      throw exception(
        "builder.port_kind_incompatible",
        `cannot connect ${fromPort.kind} output to ${toPort.kind} input`,
        this.id,
        {
          fromKind: fromPort.kind,
          toKind: toPort.kind,
          fromNodeId: fromNode.id,
          toNodeId: toNode.id,
        },
      );
    }
    if (
      from.nodeId === to.nodeId &&
      from.portId === to.portId
    ) {
      throw exception(
        "builder.self_loop",
        `port "${from.portId}" cannot connect to itself`,
        this.id,
        { nodeId: from.nodeId, portId: from.portId },
      );
    }

    const id = this.allocateEdgeId(options.id);
    const edge: EdgeDefinition = {
      id,
      from: { nodeId: from.nodeId, portId: from.portId },
      to: { nodeId: to.nodeId, portId: to.portId },
    };
    if (options.condition !== undefined) edge.condition = options.condition;
    if (options.ui !== undefined) edge.ui = { ...options.ui };

    this.edges.set(id, edge);
    this.edgeOrder.push(id);
    return { id };
  }

  removeNode(nodeId: string): void {
    if (!this.nodes.delete(nodeId)) return;
    this.explicitPositionNodeIds.delete(nodeId);
    const idx = this.nodeOrder.indexOf(nodeId);
    if (idx >= 0) this.nodeOrder.splice(idx, 1);
    // Cascade: remove edges referencing the node.
    const orphans: string[] = [];
    for (const [id, edge] of this.edges) {
      if (edge.from.nodeId === nodeId || edge.to.nodeId === nodeId) {
        orphans.push(id);
      }
    }
    for (const id of orphans) this.removeEdge(id);
  }

  removeEdge(edgeId: string): void {
    if (!this.edges.delete(edgeId)) return;
    const idx = this.edgeOrder.indexOf(edgeId);
    if (idx >= 0) this.edgeOrder.splice(idx, 1);
  }

  validate(): ValidationResult {
    const flow = this.snapshot();
    return validateGraph(flow, { registry: this.registry });
  }

  toFlowGraph(): FlowGraph {
    const flow = this.snapshot();
    const result = validateGraph(flow, { registry: this.registry });
    if (!result.ok) {
      throw new RuntimeErrorException(invalidFlowError(this.id, result.errors));
    }
    return flow;
  }

  dump(): string {
    return stringifyFlow(this.toFlowGraph());
  }

  /* ----------------------------- internals ----------------------------- */

  private snapshot(): FlowGraph {
    const flow: FlowGraph = {
      id: this.id,
      version: this.version,
      schemaVersion: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: this.nodeOrder.map((id) => cloneNode(this.nodes.get(id)!)),
      edges: this.edgeOrder.map((id) => cloneEdge(this.edges.get(id)!)),
    };
    if (this.label !== undefined) flow.label = this.label;
    if (this.description !== undefined) flow.description = this.description;
    if (this.inputSchema !== undefined) flow.inputSchema = this.inputSchema;
    if (this.outputSchema !== undefined) flow.outputSchema = this.outputSchema;
    return applyAutoLayout(flow, {
      registry: this.registry,
      explicitPositionNodeIds: this.explicitPositionNodeIds,
    });
  }

  private allocateNodeId(type: string, options: CreateNodeOptions): string {
    if (options.id !== undefined) {
      if (!isValidId(options.id)) {
        throw exception(
          "builder.invalid_id",
          `invalid node id "${options.id}"`,
          this.id,
          { nodeId: options.id },
        );
      }
      if (this.idAlloc.has(options.id)) {
        throw exception(
          "builder.duplicate_node_id",
          `duplicate node id "${options.id}"`,
          this.id,
          { nodeId: options.id },
        );
      }
      this.idAlloc.reserveExplicit(options.id);
      return options.id;
    }
    return this.idAlloc.allocate("node", type);
  }

  private allocateEdgeId(explicit: string | undefined): string {
    if (explicit !== undefined) {
      if (!isValidId(explicit)) {
        throw exception(
          "builder.invalid_id",
          `invalid edge id "${explicit}"`,
          this.id,
          { edgeId: explicit },
        );
      }
      if (this.edgeIdAlloc.has(explicit)) {
        throw exception(
          "builder.duplicate_edge_id",
          `duplicate edge id "${explicit}"`,
          this.id,
          { edgeId: explicit },
        );
      }
      this.edgeIdAlloc.reserveExplicit(explicit);
      return explicit;
    }
    return this.edgeIdAlloc.allocate("edge");
  }

  private makeHandle(nodeId: string): NodeHandle {
    const self = this;
    return {
      get id() {
        return nodeId;
      },
      get type() {
        return self.nodes.get(nodeId)!.type;
      },
      get typeVersion() {
        return self.nodes.get(nodeId)!.typeVersion;
      },
      in(portId: string): InputPortHandle {
        const node = self.nodes.get(nodeId)!;
        const port = findPort(node, portId, "input");
        if (!port) {
          throw exception(
            "builder.unknown_port",
            `input port "${portId}" not found on node ${nodeId}`,
            self.id,
            { nodeId, portId },
          );
        }
        return {
          nodeId,
          portId,
          direction: "input",
          kind: port.kind,
        };
      },
      out(portId: string): OutputPortHandle {
        const node = self.nodes.get(nodeId)!;
        const port = findPort(node, portId, "output");
        if (!port) {
          throw exception(
            "builder.unknown_port",
            `output port "${portId}" not found on node ${nodeId}`,
            self.id,
            { nodeId, portId },
          );
        }
        return {
          nodeId,
          portId,
          direction: "output",
          kind: port.kind,
        };
      },
      setConfig(patch) {
        const node = self.nodes.get(nodeId)!;
        node.config = { ...node.config, ...patch };
        return this;
      },
      addPort(port) {
        const node = self.nodes.get(nodeId)!;
        const exists = node.ports.find(
          (p) => p.id === port.id && p.direction === port.direction,
        );
        if (exists) {
          throw exception(
            "builder.duplicate_port_id",
            `node ${nodeId} already has ${port.direction} port "${port.id}"`,
            self.id,
            { nodeId, portId: port.id, direction: port.direction },
          );
        }
        node.ports.push({ ...port });
        return this;
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function composePorts(
  defaults: ReadonlyArray<PortDefinition>,
  override: ReadonlyArray<PortDefinition> | undefined,
  extras: ReadonlyArray<PortDefinition> | undefined,
): PortDefinition[] {
  const base = override ? [...override] : defaults.map(clonePort);
  const out = base.map(clonePort);
  if (extras) {
    for (const p of extras) {
      out.push(clonePort(p));
    }
  }
  return out;
}

function clonePort(p: PortDefinition): PortDefinition {
  return { ...p };
}

function cloneNode(n: NodeInstance): NodeInstance {
  const out: NodeInstance = {
    id: n.id,
    type: n.type,
    typeVersion: n.typeVersion,
    position: { ...n.position },
    ports: n.ports.map(clonePort),
    config: deepClone(n.config) as Record<string, unknown>,
  };
  if (n.label !== undefined) out.label = n.label;
  if (n.size !== undefined) out.size = { ...n.size };
  if (n.ui !== undefined) out.ui = deepClone(n.ui) as Record<string, unknown>;
  return out;
}

function cloneEdge(e: EdgeDefinition): EdgeDefinition {
  const out: EdgeDefinition = {
    id: e.id,
    from: { ...e.from },
    to: { ...e.to },
  };
  if (e.condition !== undefined) out.condition = e.condition;
  if (e.ui !== undefined) out.ui = deepClone(e.ui) as Record<string, unknown>;
  return out;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return (value.map((v) => deepClone(v)) as unknown) as T;
  }
  // Preserve non-plain objects (Date, Map, etc.) by reference so that the
  // dump-time validator can reject them with a clear error. Cloning them
  // into plain `{}` would silently strip data, which is much worse.
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepClone(v);
  }
  return out as T;
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

function ensureValidId(id: string, fieldName: string): string {
  if (!isValidId(id)) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "builder.invalid_id",
        kind: "validation",
        category: "author",
        message: `${fieldName} "${id}" is not a valid identifier`,
        source: { module: "builder" },
        context: { field: fieldName, value: id },
      }),
    );
  }
  return id;
}

function nonEmpty(value: string, fieldName: string): string {
  if (!value || typeof value !== "string") {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "builder.invalid_field",
        kind: "validation",
        category: "author",
        message: `${fieldName} must be a non-empty string`,
        source: { module: "builder" },
        context: { field: fieldName },
      }),
    );
  }
  return value;
}

function exception(
  code: string,
  message: string,
  flowId: string,
  context: Record<string, unknown>,
): RuntimeErrorException {
  return new RuntimeErrorException(
    createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "builder", flowId },
      context,
    }),
  );
}

function invalidFlowError(flowId: string, errors: RuntimeError[]): RuntimeError {
  return createRuntimeError({
    code: "builder.invalid_flow",
    kind: "validation",
    category: "author",
    message: `flow ${flowId} failed validation with ${errors.length} error(s)`,
    source: { module: "builder", flowId },
    context: { errors },
  });
}
