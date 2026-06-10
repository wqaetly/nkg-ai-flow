/**
 * Port-level validation for a single node instance.
 *
 * Rules enforced here (per `docs/specs/flow-graph-schema.md` §6.2):
 *   - Each port id is unique inside the node (one direction at a time can
 *     reuse the same id, but two same-direction ports cannot).
 *   - `error` ports cannot be inputs (errors flow outward from a node).
 *   - `stream` ports cannot be inputs (streams are produced by nodes; in
 *     Phase 0 we do not yet model stream consumers as ports).
 *   - `multiple: false` is the default; this is enforced at edge level in
 *     `validateGraph`.
 */

import {
  createRuntimeError,
  type NodeInstance,
  type PortDefinition,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";

export function validatePortsForNode(node: NodeInstance): RuntimeError[] {
  const errors: RuntimeError[] = [];

  const seen = new Map<string, PortDefinition>();
  for (const port of node.ports) {
    const key = `${port.direction}:${port.id}`;
    const prior = seen.get(key);
    if (prior) {
      errors.push(
        createRuntimeError({
          code: "validator.duplicate_port_id",
          kind: "validation",
          category: "author",
          message: `node ${node.id}: duplicate ${port.direction} port id "${port.id}"`,
          source: { module: "validator", nodeId: node.id },
          context: { nodeId: node.id, portId: port.id, direction: port.direction },
        }),
      );
      continue;
    }
    seen.set(key, port);

    if (port.kind === "error" && port.direction === "input") {
      errors.push(
        createRuntimeError({
          code: "validator.invalid_port_direction",
          kind: "validation",
          category: "author",
          message: `node ${node.id}: error ports must be outputs`,
          source: { module: "validator", nodeId: node.id },
          context: { nodeId: node.id, portId: port.id, kind: port.kind },
        }),
      );
    }
    if (port.kind === "stream" && port.direction === "input") {
      errors.push(
        createRuntimeError({
          code: "validator.invalid_port_direction",
          kind: "validation",
          category: "author",
          message: `node ${node.id}: stream ports must be outputs in Phase 0`,
          source: { module: "validator", nodeId: node.id },
          context: { nodeId: node.id, portId: port.id, kind: port.kind },
        }),
      );
    }
  }

  return errors;
}

/**
 * Determine whether two ports can be connected.
 *
 * Phase 0 rules:
 *   - From port must be an `output`, to port must be an `input`.
 *   - `control` only connects to `control`.
 *   - `data` connects to `data`.
 *   - `event` connects to `event`.
 *   - `stream` connects to `stream` (input side allowed in later phases; in
 *     Phase 0 stream inputs are still rejected at port-level above, so this
 *     branch is never reached for now).
 *   - `error` (output) connects to `data` or `error` inputs - downstream
 *     handlers may receive a RuntimeError as data, or model an explicit
 *     error input port.
 */
export function arePortKindsCompatible(
  from: PortDefinition,
  to: PortDefinition,
): boolean {
  if (from.direction !== "output" || to.direction !== "input") return false;
  if (from.kind === to.kind) return true;
  if (from.kind === "error" && to.kind === "data") return true;
  return false;
}
