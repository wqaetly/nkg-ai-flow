/**
 * Flow Graph IR types.
 *
 * The IR is the single source of truth for every other package. Builder,
 * Validator and Runtime must import their types from here and never redefine
 * them locally (see `docs/implementation/ai-implementation-guide.md`).
 *
 * The contracts mirror `docs/specs/flow-graph-schema.md`. JSON schema is
 * exported alongside via Zod (see `./schema.ts`).
 */

import type { FlowGraphSchemaVersion } from "./schemaVersion.js";

/** Allowed kinds of ports. */
export type PortKind = "control" | "data" | "event" | "stream" | "error";

/** Port direction. */
export type PortDirection = "input" | "output";

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * A port attached to a node instance. In Phase 0 the runtime payload is
 * declarative only; runtime semantics are added in later phases.
 */
export interface PortDefinition {
  id: string;
  direction: PortDirection;
  kind: PortKind;
  label?: string;
  /**
   * Optional schema for `data` ports. Stored as a JSON-Schema-compatible
   * structure so the IR remains language-agnostic; Builder may accept Zod
   * and convert via `zod-to-json-schema` in later phases. For Phase 0 we
   * accept arbitrary JSON to avoid pulling in a heavy converter.
   */
  schema?: unknown;
  required?: boolean;
  multiple?: boolean;
  dynamic?: boolean;
}

/** A single node instance placed on the canvas. */
export interface NodeInstance {
  id: string;
  type: string;
  typeVersion: string;
  label?: string;
  position: Position;
  size?: Size;
  ports: PortDefinition[];
  config: Record<string, unknown>;
  /** Free-form UI state (collapsed, color, etc.); never affects execution. */
  ui?: Record<string, unknown>;
}

/** An endpoint of an edge: a specific port on a specific node instance. */
export interface PortRef {
  nodeId: string;
  portId: string;
}

/** A directed edge connecting two ports. */
export interface EdgeDefinition {
  id: string;
  from: PortRef;
  to: PortRef;
  /**
   * Optional condition expression for conditional edges. Phase 0 stores it
   * as an opaque string; semantics are evaluated in later phases.
   */
  condition?: string;
  ui?: Record<string, unknown>;
}

/** Flow-level viewport metadata stored alongside the graph. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** The canonical Flow Graph JSON contract. */
export interface FlowGraph {
  /** Stable, business-meaningful flow id, e.g. "research-flow". */
  id: string;
  /** Business version of the flow (managed by the user / registry). */
  version: string;
  /**
   * IR-level schema version, e.g. "flow.graph.v1". Different from
   * `version`. See `docs/decisions/schema-versioning.md`.
   */
  schemaVersion: FlowGraphSchemaVersion;
  /** Optional human-readable label. */
  label?: string;
  /** Optional description (Markdown allowed). */
  description?: string;
  /** Optional flow-level input schema (JSON-Schema-compatible). */
  inputSchema?: unknown;
  /** Optional flow-level output schema (JSON-Schema-compatible). */
  outputSchema?: unknown;
  nodes: NodeInstance[];
  edges: EdgeDefinition[];
  viewport?: Viewport;
}

/** Definition of a reusable node type, registered in the Node Type Registry. */
export interface NodeTypeDefinition {
  type: string;
  typeVersion: string;
  title: string;
  description?: string;
  defaultPorts: PortDefinition[];
  /** JSON-Schema-compatible structure describing config shape. */
  configSchema?: NodeConfigSchema | unknown;
  runtime: "builtin" | "plugin" | "sandbox";
}

/** Capabilities advertised by a node type. */
export interface NodeCapabilities {
  streaming: boolean;
  dynamicPorts: boolean;
  idempotent: boolean;
  supportsCancel: boolean;
  supportsCheckpoint: boolean;
  requiredPermissions: string[];
  requiredSecrets?: string[];
}

/**
 * Visual-classification of a config field, used by the Studio's
 * reflective field renderer ("Node Field Inspector"). Mirrors the kinds
 * the Zod-reflection layer in `node-sdk` can recognise; downstream UI
 * picks a default control per kind.
 */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string[]"
  | "record"
  | "object"
  | "unknown";

/**
 * Lightweight constraint hints derived from Zod refinements (`.min()`,
 * `.max()`, `.regex()`, `.email()`, `.url()`, ...). The IR keeps them
 * as plain JSON so the Studio remains free of any Zod dependency.
 */
export interface FieldConstraints {
  min?: number;
  max?: number;
  pattern?: string;
  /** Symbolic format hint, e.g. `"email" | "url" | "uuid"`. */
  format?: string;
}

/**
 * Author-authored UI hints layered on top of the reflected schema.
 * These never affect runtime semantics; they purely tweak how Studio
 * renders the field. Matches `DefineNodeSpec.fieldMeta[fieldName]`.
 */
export interface FieldMeta {
  /** Override the human-readable label (defaults to the field name). */
  label?: string;
  /** Inline help text shown next to / under the control. */
  description?: string;
  /** Placeholder for text-like inputs. */
  placeholder?: string;
  /** Hide the field from the node card entirely (still kept in `config`). */
  hidden?: boolean;
  /** Mark string fields as secret — Studio renders a masked input. */
  secret?: boolean;
  /** Sort key (ascending). Unspecified fields keep their declared order. */
  order?: number;
  /**
   * Force a specific control. Overrides the kind-based default.
   * `"json"` remains in the serialized type for historical descriptors;
   * first-party Studio renderers no longer provide a dedicated JSON control.
   */
  control?:
    | "input"
    | "textarea"
    | "select"
    | "switch"
    | "number"
    | "json"
    | "password";
  /** Explicit dropdown options (overrides Zod-derived enum values). */
  enumOptions?: ReadonlyArray<{ label: string; value: string | number }>;
}

/**
 * A single, fully-resolved field descriptor consumed by the Studio
 * node-field renderer. Produced by `defineNode` from Zod + `fieldMeta`.
 */
export interface FieldDescriptor extends FieldMeta {
  /** Field name as it appears in `node.config`. */
  name: string;
  kind: FieldKind;
  optional: boolean;
  nullable: boolean;
  /** Default value pulled from `.default(...)` (if any). */
  default?: unknown;
  /** Refinement-derived constraints (min/max/pattern/format). */
  constraints?: FieldConstraints;
  /**
   * For `kind === "object"`: nested descriptors (one level only in
   * Phase 1; deeper objects use the generic `unknown` rendering).
   */
  children?: FieldDescriptor[];
}

/**
 * Structured shape used in `NodeTypeDefinition.configSchema` once the
 * Node Field Inspector is enabled. Older definitions that only carry
 * `{ "x-zod": true, typeName }` are still considered valid (consumers
 * default `fields` to `[]`).
 */
export interface NodeConfigSchema {
  "x-zod"?: boolean;
  typeName?: string;
  fields?: FieldDescriptor[];
  [k: string]: unknown;
}
