import { describe, expect, it } from "vitest";
import {
  RuntimeErrorException,
  createDefaultRegistry,
  type NodeTypeDefinition,
  type NodeTypeRegistry,
} from "@ai-native-flow/flow-ir";
import {
  applyOps,
  assertAiPatchPromotable,
  canonicalizeFlow,
  createAiPatchApprovalRecord,
  defineFlow,
  diffFlow,
  previewAiPatch,
  stringifyFlow,
} from "../src/index.js";

/**
 * Minimal `transform` definition used by tests in this file. The IR-
 * level `createDefaultRegistry()` only ships the pseudo-nodes; every
 * real built-in is now authored via `defineNode` in the `runtime`
 * package and arrives through `createRuntime()`. These tests don't
 * need that pipeline, so we declare the minimum surface they exercise.
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

function testRegistry(): NodeTypeRegistry {
  const r = createDefaultRegistry();
  r.register(TRANSFORM_DEF);
  return r;
}

function buildHello() {
  const flow = defineFlow({
    id: "hello_flow",
    version: "1.0.0",
    label: "Hello Flow",
    registry: testRegistry(),
  });
  const start = flow.node("start", { id: "node_start_01" });
  const transform = flow.node("transform", {
    id: "node_transform_01",
    config: { expression: "1 + 1" },
  });
  const end = flow.node("end", { id: "node_end_01" });
  flow.connect(start.out("out"), transform.in("in"));
  flow.connect(transform.out("out"), end.in("in"));
  return flow;
}

describe("builder / construction", () => {
  it("produces stable explicit IDs", () => {
    const flow = buildHello();
    const json = flow.toFlowGraph();
    expect(json.nodes.map((n) => n.id)).toEqual([
      "node_start_01",
      "node_transform_01",
      "node_end_01",
    ]);
  });

  it("allocates deterministic IDs when ID is omitted", () => {
    const flow = defineFlow({ id: "f", version: "1.0.0", registry: testRegistry() });
    const a = flow.node("transform");
    const b = flow.node("transform");
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith("node_transform_")).toBe(true);
  });

  it("rejects duplicate node IDs", () => {
    const flow = defineFlow({ id: "f", version: "1.0.0" });
    flow.node("start", { id: "n1" });
    expect(() => flow.node("end", { id: "n1" })).toThrow(RuntimeErrorException);
  });

  it("rejects connecting to a missing port", () => {
    const flow = defineFlow({ id: "f", version: "1.0.0" });
    const start = flow.node("start", { id: "s" });
    expect(() => start.out("missing")).toThrow(RuntimeErrorException);
  });

  it("rejects port kind mismatch (control -> data)", () => {
    const flow = defineFlow({ id: "f", version: "1.0.0", registry: testRegistry() });
    const start = flow.node("start", { id: "s" });
    const t = flow.node("transform", { id: "t" });
    expect(() => flow.connect(start.out("out"), t.in("input"))).toThrow(
      RuntimeErrorException,
    );
  });

  it("rejects unknown node type", () => {
    const flow = defineFlow({ id: "f", version: "1.0.0" });
    expect(() => flow.node("nope")).toThrow(RuntimeErrorException);
  });

  it("removeNode cascades to edges", () => {
    const flow = buildHello();
    flow.removeNode("node_transform_01");
    const graph = flow.toFlowGraph();
    expect(graph.nodes.find((n) => n.id === "node_transform_01")).toBeUndefined();
    expect(graph.edges.length).toBe(0);
  });
});

describe("builder / dump determinism", () => {
  it("produces byte-identical JSON across two builds", () => {
    const a = stringifyFlow(buildHello().toFlowGraph());
    const b = stringifyFlow(buildHello().toFlowGraph());
    expect(a).toBe(b);
  });

  it("sorts arbitrary config keys alphabetically", () => {
    const f = defineFlow({ id: "f", version: "1.0.0", registry: testRegistry() });
    f.node("transform", {
      id: "n1",
      config: { z: 1, a: 2, m: 3 },
    });
    const canonical = canonicalizeFlow(f.toFlowGraph());
    const node = (canonical.nodes as Array<Record<string, unknown>>)[0]!;
    const cfgKeys = Object.keys(node.config as Record<string, unknown>);
    expect(cfgKeys).toEqual(["a", "m", "z"]);
  });

  it("emits LLM config keys before other config keys in provider order", () => {
    const f = defineFlow({ id: "f", version: "1.0.0", registry: testRegistry() });
    f.node("transform", {
      id: "n1",
      config: {
        z: 1,
        model: "m",
        api_key: "k",
        max_tokens: 4096,
        base_url: "u",
        temperature: 0,
      },
    });
    const canonical = canonicalizeFlow(f.toFlowGraph());
    const node = (canonical.nodes as Array<Record<string, unknown>>)[0]!;
    const cfgKeys = Object.keys(node.config as Record<string, unknown>);
    expect(cfgKeys).toEqual([
      "base_url",
      "api_key",
      "model",
      "temperature",
      "max_tokens",
      "z",
    ]);
  });

  it("keeps top-level field order: id, version, schemaVersion, ...", () => {
    const json = stringifyFlow(buildHello().toFlowGraph());
    const idIdx = json.indexOf("\"id\"");
    const versionIdx = json.indexOf("\"version\"");
    const schemaIdx = json.indexOf("\"schemaVersion\"");
    expect(idIdx).toBeLessThan(versionIdx);
    expect(versionIdx).toBeLessThan(schemaIdx);
  });

  it("auto-sizes and lays out generated nodes that would otherwise overlap at origin", () => {
    const graph = buildHello().toFlowGraph();
    expect(graph.nodes.every((node) => node.size?.width && node.size.height)).toBe(true);
    expect(graph.nodes.map((node) => node.position.x)).toEqual([0, 450, 900]);
    expect(new Set(graph.nodes.map((node) => `${node.position.x},${node.position.y}`)).size).toBe(3);
  });

  it("keeps non-overlapping explicit positions while still filling missing size", () => {
    const flow = defineFlow({ id: "f", version: "1.0.0", registry: testRegistry() });
    flow.node("start", { id: "s", position: { x: 20, y: 30 } });
    flow.node("end", { id: "e", position: { x: 500, y: 30 } });
    const graph = flow.toFlowGraph();
    expect(graph.nodes.map((node) => node.position)).toEqual([
      { x: 20, y: 30 },
      { x: 500, y: 30 },
    ]);
    expect(graph.nodes.every((node) => node.size?.width && node.size.height)).toBe(true);
  });

  it("rejects non-JSON values (Date) inside config", () => {
    const f = defineFlow({ id: "f", version: "1.0.0", registry: testRegistry() });
    f.node("transform", { id: "n", config: { d: new Date() } });
    expect(() => stringifyFlow(f.toFlowGraph())).toThrow();
  });
});

describe("builder / Graph Operations", () => {
  it("applies add_node + add_edge", () => {
    const base = buildHello().toFlowGraph();
    const next = applyOps(base, [
      {
        op: "add_node",
        node: {
          id: "node_log_01",
          type: "transform",
          typeVersion: "1.0.0",
          position: { x: 700, y: 160 },
          ports: [
            { id: "in", direction: "input", kind: "control" },
            { id: "out", direction: "output", kind: "control" },
          ],
          config: { expression: "console.log(input)" },
        },
      },
    ]);
    expect(next.nodes.map((n) => n.id)).toContain("node_log_01");
  });

  it("rejects add_node when ID already exists", () => {
    const base = buildHello().toFlowGraph();
    expect(() =>
      applyOps(
        base,
        [
          {
            op: "add_node",
            node: {
              id: "node_start_01",
              type: "start",
              typeVersion: "1.0.0",
              position: { x: 0, y: 0 },
              ports: [{ id: "out", direction: "output", kind: "control" }],
              config: {},
            },
          },
        ],
        { validate: false },
      ),
    ).toThrow(RuntimeErrorException);
  });

  it("remove_node cascades to edges", () => {
    const base = buildHello().toFlowGraph();
    const next = applyOps(base, [
      { op: "remove_node", nodeId: "node_transform_01" },
    ]);
    expect(next.edges.length).toBe(0);
  });

  it("update_node_config merges keys", () => {
    const base = buildHello().toFlowGraph();
    const next = applyOps(base, [
      {
        op: "update_node_config",
        nodeId: "node_transform_01",
        patch: { foo: "bar" },
      },
    ]);
    const node = next.nodes.find((n) => n.id === "node_transform_01")!;
    expect(node.config.foo).toBe("bar");
    expect(node.config.expression).toBe("1 + 1");
  });
});

describe("builder / diffFlow", () => {
  it("reports added, removed and changed nodes / edges", () => {
    const before = buildHello().toFlowGraph();
    const after = applyOps(before, [
      {
        op: "add_node",
        node: {
          id: "node_extra_01",
          type: "transform",
          typeVersion: "1.0.0",
          position: { x: 1000, y: 0 },
          ports: [
            { id: "in", direction: "input", kind: "control" },
            { id: "out", direction: "output", kind: "control" },
          ],
          config: {},
        },
      },
      {
        op: "update_node_config",
        nodeId: "node_transform_01",
        patch: { expression: "2 + 2" },
      },
      { op: "remove_edge", edgeId: before.edges[1]!.id },
    ]);
    const diff = diffFlow(before, after);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(["node_extra_01"]);
    expect(diff.changedNodes.map((c) => c.nodeId)).toEqual(["node_transform_01"]);
    expect(diff.removedEdges.map((e) => e.id)).toEqual([before.edges[1]!.id]);
  });
});

describe("builder / AI Patch Preview and Approval", () => {
  it("creates a patch preview summary for Graph Operations", () => {
    const base = buildHello().toFlowGraph();
    const preview = previewAiPatch(base, {
      id: "patch-1",
      source: "ai_graph_operation",
      title: "Tune transform expression",
      author: "ai-agent",
      createdAt: "2026-05-29T00:00:00.000Z",
      operations: [
        {
          op: "update_node_config",
          nodeId: "node_transform_01",
          patch: { expression: "3 + 3" },
        },
      ],
    });

    expect(preview.validation.ok).toBe(true);
    expect(preview.summary).toMatchObject({
      operationCount: 1,
      changedNodes: ["node_transform_01"],
      canApply: true,
    });
  });

  it("detects forbidden operations, permissions and secrets", () => {
    const base = buildHello().toFlowGraph();
    const preview = previewAiPatch(
      base,
      {
        id: "patch-2",
        source: "ai_graph_operation",
        title: "Remove start",
        author: "ai-agent",
        createdAt: "2026-05-29T00:00:00.000Z",
        operations: [{ op: "remove_node", nodeId: "node_start_01" }],
        requestedPermissions: ["runtime:core:write"],
        requiredSecrets: ["OPENAI_API_KEY"],
      },
      {
        allowedOperations: ["update_node_config"],
        allowedPermissions: ["flow:write"],
        allowedSecrets: [],
      },
    );

    expect(preview.summary.canApply).toBe(false);
    expect(preview.policyErrors.map((error) => error.code)).toEqual([
      "builder.ai_patch_forbidden_operation",
      "builder.ai_patch_forbidden_permission",
      "builder.ai_patch_forbidden_secret",
    ]);
  });

  it("requires dry run and approval before production promotion", () => {
    const base = buildHello().toFlowGraph();
    const preview = previewAiPatch(base, {
      id: "patch-3",
      source: "ai_graph_operation",
      title: "Tune transform expression",
      author: "ai-agent",
      createdAt: "2026-05-29T00:00:00.000Z",
      operations: [
        {
          op: "update_node_config",
          nodeId: "node_transform_01",
          patch: { expression: "4 + 4" },
        },
      ],
    });

    expect(() => assertAiPatchPromotable(preview, {}, { production: true })).toThrow(RuntimeErrorException);

    const approval = createAiPatchApprovalRecord({
      proposalId: "patch-3",
      decision: "approved",
      reviewer: "human-reviewer",
      decidedAt: "2026-05-29T00:01:00.000Z",
      dryRunId: "dry-run-1",
    });

    expect(() => assertAiPatchPromotable(preview, {}, { production: true, approval })).not.toThrow();
  });
});
