/**
 * Public types and handles exposed by the Flow Builder.
 *
 * The Builder is a creation-time API. It owns the construction state and
 * produces a serialised `FlowGraph` via `dump()`. Runtime code never imports
 * this module - it only consumes the dumped JSON.
 */

import type {
  EdgeDefinition,
  NodeInstance,
  NodeTypeRegistry,
  PortDefinition,
  PortKind,
  Position,
  Size,
} from "@ai-native-flow/flow-ir";

/** Handle returned by `flow.node(...)`, used to reference ports later. */
export interface NodeHandle {
  /** The stable, allocated node id. */
  readonly id: string;
  /** The node type, e.g. "llm". */
  readonly type: string;
  /** The node typeVersion. */
  readonly typeVersion: string;
  /** Reference an input port by id. */
  in(portId: string): InputPortHandle;
  /** Reference an output port by id. */
  out(portId: string): OutputPortHandle;
  /** Replace the node config (merges over existing keys). */
  setConfig(patch: Record<string, unknown>): NodeHandle;
  /** Add or override a port (e.g. a dynamic port). */
  addPort(port: PortDefinition): NodeHandle;
}

export interface PortHandleBase {
  readonly nodeId: string;
  readonly portId: string;
  readonly direction: "input" | "output";
  readonly kind: PortKind;
}

export interface InputPortHandle extends PortHandleBase {
  readonly direction: "input";
}

export interface OutputPortHandle extends PortHandleBase {
  readonly direction: "output";
}

export interface EdgeHandle {
  readonly id: string;
}

/** Options accepted by `flow.node(type, options)`. */
export interface CreateNodeOptions {
  /** Optional explicit node id; otherwise the Builder allocates one. */
  id?: string;
  /** Optional node type version; defaults to the registry's latest. */
  typeVersion?: string;
  /** Optional human-readable label. */
  label?: string;
  position?: Position;
  size?: Size;
  /** Optional partial node config. Keys are merged into the registry default. */
  config?: Record<string, unknown>;
  /**
   * Override the default ports from the registry. If omitted, the registry's
   * `defaultPorts` are cloned. Custom ports may be merged via `extraPorts`.
   */
  ports?: PortDefinition[];
  /** Append additional ports to the default set. */
  extraPorts?: PortDefinition[];
  /** Free-form UI state; never affects execution. */
  ui?: Record<string, unknown>;
}

/** Options accepted by `flow.connect(from, to, options?)`. */
export interface ConnectOptions {
  /** Optional explicit edge id. */
  id?: string;
  /** Optional condition expression for conditional routing. */
  condition?: string;
  /** Free-form UI state. */
  ui?: Record<string, unknown>;
}

/** Options accepted by `defineFlow(options)`. */
export interface DefineFlowOptions {
  id: string;
  version: string;
  label?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Optional Node Type Registry; defaults to the built-in registry. */
  registry?: NodeTypeRegistry;
}

/** Internal builder state snapshot, used by `dump()`. */
export interface BuilderState {
  readonly nodes: ReadonlyArray<NodeInstance>;
  readonly edges: ReadonlyArray<EdgeDefinition>;
}
