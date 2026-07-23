import { describe, expect, it } from "vitest";
import type { FlowPreviewGraph } from "../src/FlowPreview.js";
import { createFlowPreviewElements } from "../src/FlowPreview.js";

const graph: FlowPreviewGraph = {
  id: "preview_test",
  version: "1.0.0",
  schemaVersion: "flow.graph.v1",
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      ports: [{ id: "out", direction: "output", kind: "control", label: "下一步" }],
      config: {},
    },
    {
      id: "model",
      type: "llm",
      typeVersion: "1.0.0",
      position: { x: 400, y: 0 },
      ports: [{ id: "in", direction: "input", kind: "control", label: "输入" }],
      config: {},
    },
  ],
  edges: [{
    id: "start-model",
    from: { nodeId: "start", portId: "out" },
    to: { nodeId: "model", portId: "in" },
  }],
};

describe("FlowPreview projection", () => {
  it("preserves graph positions, port handles, labels, and runtime states", () => {
    const projection = createFlowPreviewElements(graph, [
      { kind: "node_started", nodeId: "start", timestamp: "2026-07-23T10:00:00.000Z", payload: {} },
      { kind: "node_finished", nodeId: "start", timestamp: "2026-07-23T10:00:00.020Z", payload: { durationMs: 20 } },
      { kind: "node_started", nodeId: "model", timestamp: "2026-07-23T10:00:00.021Z", payload: {} },
      { kind: "stream_delta", nodeId: "model", timestamp: "2026-07-23T10:00:00.022Z", payload: { delta: "你" } },
    ]);

    expect(projection.nodes).toHaveLength(2);
    expect(projection.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(projection.nodes[0]).toMatchObject({ width: 220, height: 80 });
    expect(projection.nodes[1]).toMatchObject({ width: 220, height: 80 });
    expect(projection.nodes[0]?.data.label).toBe("开始");
    expect(projection.nodes[1]?.data.label).toBe("大模型调用");
    expect(projection.nodes[0]?.data.status).toBe("succeeded");
    expect(projection.nodes[0]?.data.runtime?.durationMs).toBe(20);
    expect(projection.nodes[1]?.data.status).toBe("streaming");
    expect(projection.edges[0]).toMatchObject({
      source: "start",
      sourceHandle: "out",
      target: "model",
      targetHandle: "in",
      type: "smoothstep",
    });
  });
});
