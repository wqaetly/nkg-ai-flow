/**
 * Deterministic JSON serialisation.
 *
 * `dump()` must produce byte-identical output for the same builder
 * construction sequence. This file isolates the canonicalisation logic so
 * the same canonical form can also be used by Graph Operation diff and by
 * future Artifact hashing.
 *
 * Rules (Phase 0):
 *   - Object keys are emitted in a fixed schema-defined order, never sorted
 *     alphabetically. Sorting alphabetically would put `description`
 *     before `id`, which produces unreadable JSON; the schema order
 *     mirrors the spec's example.
 *   - Arrays preserve insertion order. Insertion order is owned by the
 *     Builder; users who want deterministic output must add nodes / edges
 *     in deterministic order (no `Math.random()`, no `Date.now()`).
 *   - `undefined` keys are omitted, never serialised as `null`.
 *   - Pure JSON primitive types only: number, string, boolean, null, array,
 *     plain object. Functions, Maps, Sets, Dates etc. are rejected.
 */

import type {
  EdgeDefinition,
  FlowGraph,
  NodeInstance,
  PortDefinition,
} from "@ai-native-flow/flow-ir";

/* -------------------------------------------------------------------------- */
/* Field orders                                                                */
/* -------------------------------------------------------------------------- */

const FLOW_FIELD_ORDER = [
  "id",
  "version",
  "schemaVersion",
  "label",
  "description",
  "inputSchema",
  "outputSchema",
  "nodes",
  "edges",
  "viewport",
] as const;

const NODE_FIELD_ORDER = [
  "id",
  "type",
  "typeVersion",
  "label",
  "position",
  "size",
  "ports",
  "config",
  "ui",
] as const;

const PORT_FIELD_ORDER = [
  "id",
  "direction",
  "kind",
  "label",
  "schema",
  "required",
  "multiple",
  "dynamic",
] as const;

const EDGE_FIELD_ORDER = ["id", "from", "to", "condition", "ui"] as const;

const PORT_REF_FIELD_ORDER = ["nodeId", "portId"] as const;

const POSITION_FIELD_ORDER = ["x", "y"] as const;

const SIZE_FIELD_ORDER = ["width", "height"] as const;

const VIEWPORT_FIELD_ORDER = ["x", "y", "zoom"] as const;

const CONFIG_FIELD_ORDER = [
  "baseUrl",
  "base_url",
  "apiKey",
  "api_key",
  "model",
  "temperature",
  "maxTokens",
  "max_tokens",
] as const;

/* -------------------------------------------------------------------------- */
/* Canonicalisation                                                            */
/* -------------------------------------------------------------------------- */

/** Build a canonical, deeply-ordered representation of a FlowGraph. */
export function canonicalizeFlow(flow: FlowGraph): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FLOW_FIELD_ORDER) {
    const value = (flow as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "nodes") {
      out[key] = (value as NodeInstance[]).map(canonicalizeNode);
    } else if (key === "edges") {
      out[key] = (value as EdgeDefinition[]).map(canonicalizeEdge);
    } else if (key === "viewport") {
      out[key] = orderObject(value as Record<string, unknown>, VIEWPORT_FIELD_ORDER);
    } else if (key === "inputSchema" || key === "outputSchema") {
      out[key] = canonicalizeArbitrary(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function canonicalizeNode(node: NodeInstance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of NODE_FIELD_ORDER) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "position") {
      out[key] = orderObject(value as Record<string, unknown>, POSITION_FIELD_ORDER);
    } else if (key === "size") {
      out[key] = orderObject(value as Record<string, unknown>, SIZE_FIELD_ORDER);
    } else if (key === "ports") {
      out[key] = (value as PortDefinition[]).map(canonicalizePort);
    } else if (key === "config") {
      out[key] = canonicalizeArbitrary(value, CONFIG_FIELD_ORDER);
    } else if (key === "ui") {
      out[key] = canonicalizeArbitrary(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function canonicalizePort(port: PortDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PORT_FIELD_ORDER) {
    const value = (port as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "schema") {
      out[key] = canonicalizeArbitrary(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function canonicalizeEdge(edge: EdgeDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EDGE_FIELD_ORDER) {
    const value = (edge as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "from" || key === "to") {
      out[key] = orderObject(value as Record<string, unknown>, PORT_REF_FIELD_ORDER);
    } else if (key === "ui") {
      out[key] = canonicalizeArbitrary(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Pick a fixed key order from a plain object. */
function orderObject(
  value: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (value[key] !== undefined) {
      out[key] = value[key];
    }
  }
  return out;
}

/**
 * Canonicalise arbitrary user-supplied JSON (config, schema, ui).
 *
 * For these payloads we sort keys deterministically so two semantically
 * equal objects always serialise identically regardless of the builder
 * code's property assignment order. Node `config` may pass a preferred
 * top-level key order for UI-critical fields, then remaining keys are
 * sorted alphabetically.
 */
function canonicalizeArbitrary(
  value: unknown,
  preferredOrder: readonly string[] = [],
): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeArbitrary(item));
  }
  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new Error(
        "dump() only accepts plain JSON values (no Date/Map/Set/Function)",
      );
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const preferred = preferredOrder.filter((key) => keys.includes(key));
    const sortedKeys = [
      ...preferred,
      ...keys
        .filter((key) => !preferred.includes(key))
        .sort(),
    ];
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = canonicalizeArbitrary(v);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(
      "dump() only accepts plain JSON values (no Function/Symbol)",
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  // `Object.prototype.toString` reliably distinguishes plain objects from
  // host / built-in objects (Date, Map, Set, RegExp, ArrayBuffer, ...) under
  // both Node. Comparing prototypes alone is fragile across realms.
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Stringify a FlowGraph with stable indentation and key order. */
export function stringifyFlow(flow: FlowGraph): string {
  const canonical = canonicalizeFlow(flow);
  // 2-space indentation matches the spec's JSON examples and keeps diffs
  // human-readable. Final newline is intentional for POSIX-friendly files.
  return JSON.stringify(canonical, null, 2) + "\n";
}
