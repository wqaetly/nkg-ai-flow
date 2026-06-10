import { describe, expect, it } from "vitest";
import {
  FLOW_GRAPH_SCHEMA_VERSION,
  createDefaultRegistry,
  type FlowGraph,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import {
  validateGraph,
  validateSchema,
  validateFlow,
  arePortKindsCompatible,
} from "../src/index.js";

/**
 * Minimal `transform` node-type definition used by the tests in this
 * file. The IR-level `createDefaultRegistry()` only ships the
 * pseudo-nodes (`start` / `end`); every real built-in (including
 * `transform`) is authored via `defineNode` in the `runtime` package
 * and registered into the runtime's `NodeTypeRegistry` by
 * `createRuntime()`. Validator tests don't need that full pipeline,
 * so we declare the minimum surface they exercise locally.
 */
const TRANSFORM_DEF: NodeTypeDefinition = {
  type: "transform",
  typeVersion: "1.0.0",
  title: "Transform",
  description: "Pure data transformation (test fixture).",
  defaultPorts: [
    { id: "in", direction: "input", kind: "control" },
    { id: "out", direction: "output", kind: "control" },
    { id: "input", direction: "input", kind: "data" },
    { id: "output", direction: "output", kind: "data" },
  ],
  runtime: "builtin",
};

function baseFlow(overrides: Partial<FlowGraph> = {}): FlowGraph {
  return {
    id: "f",
    version: "1.0.0",
    schemaVersion: FLOW_GRAPH_SCHEMA_VERSION,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

describe("validator / validateSchema", () => {
  it("accepts a valid empty flow", () => {
    const out = validateSchema(baseFlow());
    expect(out.result.ok).toBe(true);
    expect(out.flow).toBeDefined();
  });

  it("rejects unsupported schemaVersion with a dedicated code", () => {
    const out = validateSchema({
      ...baseFlow(),
      schemaVersion: "flow.graph.v999",
    });
    expect(out.result.ok).toBe(false);
    expect(out.result.errors[0]?.code).toBe(
      "validator.schema_version_unsupported",
    );
  });

  it("rejects malformed shape with validator.schema_invalid", () => {
    const out = validateSchema({ id: 123 });
    expect(out.result.ok).toBe(false);
    expect(
      out.result.errors.some((e) => e.code === "validator.schema_invalid"),
    ).toBe(true);
  });
});

describe("validator / validateGraph", () => {
  const registry = createDefaultRegistry();
  registry.register(TRANSFORM_DEF);

  it("rejects duplicate node IDs", () => {
    const flow = baseFlow({
      nodes: [
        {
          id: "n1",
          type: "start",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: [{ id: "out", direction: "output", kind: "control" }],
          config: {},
        },
        {
          id: "n1",
          type: "end",
          typeVersion: "1.0.0",
          position: { x: 100, y: 0 },
          ports: [{ id: "in", direction: "input", kind: "control" }],
          config: {},
        },
      ],
    });
    const r = validateGraph(flow, { registry });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "validator.duplicate_node_id")).toBe(
      true,
    );
  });

  it("rejects edges with missing nodes / ports", () => {
    const flow = baseFlow({
      nodes: [
        {
          id: "n1",
          type: "start",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: [{ id: "out", direction: "output", kind: "control" }],
          config: {},
        },
      ],
      edges: [
        {
          id: "e1",
          from: { nodeId: "n1", portId: "missing" },
          to: { nodeId: "ghost", portId: "in" },
        },
      ],
    });
    const r = validateGraph(flow, { registry });
    expect(r.ok).toBe(false);
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain("validator.port_missing");
    expect(codes).toContain("validator.edge_node_missing");
  });

  it("rejects connecting control output to data input", () => {
    const flow = baseFlow({
      nodes: [
        {
          id: "a",
          type: "start",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: [{ id: "out", direction: "output", kind: "control" }],
          config: {},
        },
        {
          id: "b",
          type: "transform",
          typeVersion: "1.0.0",
          position: { x: 100, y: 0 },
          ports: [
            { id: "in", direction: "input", kind: "control" },
            { id: "input", direction: "input", kind: "data" },
            { id: "output", direction: "output", kind: "data" },
            { id: "out", direction: "output", kind: "control" },
          ],
          config: {},
        },
      ],
      edges: [
        {
          id: "e1",
          from: { nodeId: "a", portId: "out" },
          to: { nodeId: "b", portId: "input" },
        },
      ],
    });
    const r = validateGraph(flow, { registry });
    expect(r.errors.some((e) => e.code === "validator.port_kind_incompatible")).toBe(
      true,
    );
  });

  it("rejects multiple inbound edges to a non-multiple input port", () => {
    const flow = baseFlow({
      nodes: [
        {
          id: "a",
          type: "start",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: [{ id: "out", direction: "output", kind: "control" }],
          config: {},
        },
        {
          id: "b",
          type: "start",
          typeVersion: "1.0.0",
          position: { x: 0, y: 100 },
          ports: [{ id: "out", direction: "output", kind: "control" }],
          config: {},
        },
        {
          id: "c",
          type: "end",
          typeVersion: "1.0.0",
          position: { x: 200, y: 0 },
          ports: [{ id: "in", direction: "input", kind: "control" }],
          config: {},
        },
      ],
      edges: [
        {
          id: "e1",
          from: { nodeId: "a", portId: "out" },
          to: { nodeId: "c", portId: "in" },
        },
        {
          id: "e2",
          from: { nodeId: "b", portId: "out" },
          to: { nodeId: "c", portId: "in" },
        },
      ],
    });
    const r = validateGraph(flow, { registry });
    expect(
      r.errors.some((e) => e.code === "validator.port_multiple_violation"),
    ).toBe(true);
  });

  it("warns about orphan nodes but does not fail", () => {
    const flow = baseFlow({
      nodes: [
        {
          id: "lonely",
          type: "transform",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: [
            { id: "in", direction: "input", kind: "control" },
            { id: "out", direction: "output", kind: "control" },
          ],
          config: {},
        },
      ],
    });
    const r = validateGraph(flow, { registry });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "validator.orphan_node")).toBe(true);
  });
});

describe("validator / port-kind compatibility", () => {
  it("matches kinds 1-to-1 for control / data / event / stream", () => {
    expect(
      arePortKindsCompatible(
        { id: "o", direction: "output", kind: "control" },
        { id: "i", direction: "input", kind: "control" },
      ),
    ).toBe(true);
    expect(
      arePortKindsCompatible(
        { id: "o", direction: "output", kind: "data" },
        { id: "i", direction: "input", kind: "control" },
      ),
    ).toBe(false);
  });

  it("allows error output to feed into a data input", () => {
    expect(
      arePortKindsCompatible(
        { id: "err", direction: "output", kind: "error" },
        { id: "data", direction: "input", kind: "data" },
      ),
    ).toBe(true);
  });

  it("rejects when from is not output or to is not input", () => {
    expect(
      arePortKindsCompatible(
        { id: "i", direction: "input", kind: "control" },
        { id: "i2", direction: "input", kind: "control" },
      ),
    ).toBe(false);
  });
});

describe("validator / validateFlow combined", () => {
  it("returns the validated flow on success", () => {
    const out = validateFlow(baseFlow(), { registry: createDefaultRegistry() });
    expect(out.flow).toBeDefined();
  });
});
