import { describe, expect, test } from "vitest";
import type { NodeEvent } from "@ai-native-flow/event-bus";
import { FLOW_GRAPH_SCHEMA_VERSION, type FlowGraph, type NodeTypeDefinition } from "@ai-native-flow/flow-ir";
import {
  addStudioEdge,
  addStudioNode,
  appendStudioEvents,
  createStudioState,
  createStudioViewModel,
  getMovedNodePositions,
  reactFlowConnectionToStudioEdgeDraft,
  renderStudioShell,
  toReactFlowGraph,
} from "../src/index.js";
import { previewAiPatch } from "@ai-native-flow/flow-builder";

const startPorts = [
  { id: "out", direction: "output", kind: "control", label: "next" },
] as const;

const transformPorts = [
  { id: "in", direction: "input", kind: "control", label: "in" },
  { id: "out", direction: "output", kind: "stream", label: "tokens" },
] as const;

const palette: NodeTypeDefinition[] = [
  {
    type: "start",
    typeVersion: "1.0.0",
    title: "Start",
    runtime: "builtin",
    defaultPorts: [...startPorts],
  },
  {
    type: "transform",
    typeVersion: "1.0.0",
    title: "Transform",
    runtime: "builtin",
    defaultPorts: [...transformPorts],
  },
];

function graph(): FlowGraph {
  return {
    id: "studio-flow",
    version: "1.0.0",
    schemaVersion: FLOW_GRAPH_SCHEMA_VERSION,
    label: "Studio Flow",
    nodes: [
      {
        id: "start-1",
        type: "start",
        typeVersion: "1.0.0",
        label: "Start",
        position: { x: 48, y: 80 },
        ports: [...startPorts],
        config: {},
      },
    ],
    edges: [],
  };
}

function event(overrides: Partial<NodeEvent>): NodeEvent {
  return {
    eventId: "evt-1",
    runId: "run-1",
    flowId: "studio-flow",
    flowVersion: "1.0.0",
    seq: 1,
    timestamp: "2026-05-27T12:00:00.000Z",
    kind: "run_started",
    payload: {},
    ...overrides,
  };
}

describe("studio", () => {
  test("represents graph edits as Graph Operations and projects canvas state", () => {
    const state = createStudioState({ graph: graph(), palette });
    const added = addStudioNode(state, {
      id: "transform-1",
      type: "transform",
      typeVersion: "1.0.0",
      label: "Stream Tokens",
      position: { x: 340, y: 96 },
      ports: [...transformPorts],
      config: { prompt: "Summarize" },
    });

    const connected = addStudioEdge(added.state, {
      id: "edge-1",
      from: { nodeId: "start-1", portId: "out" },
      to: { nodeId: "transform-1", portId: "in" },
    });

    expect(connected.state.operations.map((op) => op.op)).toEqual(["add_node", "add_edge"]);
    expect(connected.diff.addedEdges).toHaveLength(1);

    const view = createStudioViewModel(connected.state);
    expect(view.nodes).toHaveLength(2);
    expect(view.edges[0]).toMatchObject({ from: "start-1.out", to: "transform-1.in", kind: "control" });
    expect(view.palette.map((item) => item.title)).toEqual(["开始", "数据转换"]);
  });

  test("surfaces validation feedback for invalid Studio edits", () => {
    const state = createStudioState({ graph: graph(), palette });
    const result = addStudioEdge(state, {
      id: "bad-edge",
      from: { nodeId: "start-1", portId: "missing" },
      to: { nodeId: "ghost", portId: "in" },
    });

    const view = createStudioViewModel(result.state);
    expect(view.validation.ok).toBe(false);
    expect(view.validation.errors.length).toBeGreaterThan(0);
  });

  test("projects AI Patch Preview into the Studio view model", () => {
    const base = graph();
    const patchPreview = previewAiPatch(base, {
      id: "patch-studio-1",
      source: "ai_graph_operation",
      title: "AI adds transform node",
      author: "ai-agent",
      createdAt: "2026-05-29T00:00:00.000Z",
      operations: [
        {
          op: "add_node",
          node: {
            id: "transform-1",
            type: "transform",
            typeVersion: "1.0.0",
            label: "AI Transform",
            position: { x: 340, y: 96 },
            ports: [...transformPorts],
            config: { prompt: "Summarize" },
          },
        },
      ],
    });

    const view = createStudioViewModel(createStudioState({ graph: base, palette, patchPreview }));

    expect(view.patchPreview).toMatchObject({
      proposalId: "patch-studio-1",
      title: "AI adds transform node",
      addedNodes: ["transform-1"],
      operationCount: 1,
      canApply: true,
    });
  });

  test("renders timeline, trace, and stream inspector from NodeEvent records", () => {
    const state = createStudioState({ graph: graph(), palette });
    const withEvents = appendStudioEvents(state, [
      event({ eventId: "evt-1", kind: "run_started", seq: 1 }),
      event({ eventId: "evt-2", kind: "node_started", nodeId: "start-1", seq: 2 }),
      event({ eventId: "evt-3", kind: "stream_delta", nodeId: "start-1", portId: "out", streamId: "s1", seq: 3, payload: { delta: "hello " } }),
      event({ eventId: "evt-4", kind: "stream_delta", nodeId: "start-1", portId: "out", streamId: "s1", seq: 4, payload: { delta: "studio" } }),
      event({ eventId: "evt-5", kind: "node_finished", nodeId: "start-1", seq: 5 }),
    ]);

    const view = createStudioViewModel(withEvents);
    expect(view.runTimeline).toHaveLength(5);
    expect(view.traceViewer).toMatchObject({ eventCount: 5, nodeCount: 1, streamCount: 2 });
    expect(view.streamInspector.replayText).toBe("hello studio");
    expect(view.nodes[0]?.status).toBe("succeeded");
  });

  test("renders a dark flat card Browser Studio shell", () => {
    const state = createStudioState({ graph: graph(), palette });
    const html = renderStudioShell(createStudioViewModel(state));

    expect(html).toContain("AI Native Flow Studio");
    expect(html).toContain("Flow Canvas");
    expect(html).toContain("Run Timeline");
    expect(html).toContain("Stream Inspector");
    expect(html).toContain("--bg: #080b12");
    expect(html).toContain("border-radius: 18px");
  });

  test("projects Studio graph into React Flow nodes and edges", () => {
    const state = createStudioState({ graph: graph(), palette });
    const added = addStudioNode(state, {
      id: "transform-1",
      type: "transform",
      typeVersion: "1.0.0",
      label: "Stream Tokens",
      position: { x: 340, y: 96 },
      ports: [...transformPorts],
    });
    const connected = addStudioEdge(added.state, {
      id: "edge-1",
      from: { nodeId: "start-1", portId: "out" },
      to: { nodeId: "transform-1", portId: "in" },
    });

    const projection = toReactFlowGraph(createStudioViewModel(connected.state));

    expect(projection.nodes[0]).toMatchObject({ id: "start-1", type: "studioNode", position: { x: 48, y: 80 } });
    expect(projection.nodes[1]?.data.outputs[0]?.kind).toBe("stream");
    expect(projection.edges[0]).toMatchObject({
      id: "edge-1",
      source: "start-1",
      sourceHandle: "out",
      target: "transform-1",
      targetHandle: "in",
    });
  });

  test("converts React Flow edits into Studio operation inputs", () => {
    const draft = reactFlowConnectionToStudioEdgeDraft({
      source: "start-1",
      sourceHandle: "out",
      target: "transform-1",
      targetHandle: "in",
    });

    expect(draft).toEqual({
      id: "start-1__out__transform-1__in",
      from: { nodeId: "start-1", portId: "out" },
      to: { nodeId: "transform-1", portId: "in" },
    });

    expect(getMovedNodePositions([
      { id: "start-1", type: "position", position: { x: 120, y: 220 }, dragging: true },
      { id: "start-1", type: "position", position: { x: 144, y: 240 }, dragging: false },
    ])).toEqual([{ nodeId: "start-1", position: { x: 144, y: 240 } }]);
  });
});
