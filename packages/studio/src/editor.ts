import { applyOps, diffFlow, type GraphOperation } from "@ai-native-flow/flow-builder";
import { validateGraph } from "@ai-native-flow/flow-validator";
import type { StudioApplyResult, StudioEdgeDraft, StudioNodeDraft, StudioState } from "./types.js";

export function applyStudioOperations(state: StudioState, operations: ReadonlyArray<GraphOperation>): StudioApplyResult {
  const previous = state.graph;
  const graph = applyOps(previous, operations, { validate: false });
  const validation = validateGraph(graph);
  const nextState: StudioState = {
    ...state,
    graph,
    validation,
    operations: [...state.operations, ...operations],
  };

  return {
    state: nextState,
    diff: diffFlow(previous, graph),
  };
}

export function addStudioNode(state: StudioState, draft: StudioNodeDraft): StudioApplyResult {
  return applyStudioOperations(state, [
    {
      op: "add_node",
      node: {
        id: draft.id,
        type: draft.type,
        typeVersion: draft.typeVersion,
        label: draft.label,
        position: { ...draft.position },
        ports: draft.ports.map((port) => ({ ...port })),
        config: draft.config ?? {},
      },
    },
  ]);
}

export function removeStudioNode(state: StudioState, nodeId: string): StudioApplyResult {
  return applyStudioOperations(state, [{ op: "remove_node", nodeId }]);
}

export function moveStudioNode(state: StudioState, nodeId: string, position: { x: number; y: number }): StudioApplyResult {
  return applyStudioOperations(state, [{ op: "set_node_position", nodeId, position }]);
}

export function updateStudioNodeConfig(
  state: StudioState,
  nodeId: string,
  patch: Record<string, unknown>,
): StudioApplyResult {
  return applyStudioOperations(state, [{ op: "update_node_config", nodeId, patch }]);
}

export function addStudioEdge(state: StudioState, draft: StudioEdgeDraft): StudioApplyResult {
  return applyStudioOperations(state, [
    {
      op: "add_edge",
      edge: {
        id: draft.id,
        from: { ...draft.from },
        to: { ...draft.to },
        condition: draft.condition,
      },
    },
  ]);
}

export function removeStudioEdge(state: StudioState, edgeId: string): StudioApplyResult {
  return applyStudioOperations(state, [{ op: "remove_edge", edgeId }]);
}

export function selectStudioNode(state: StudioState, nodeId: string | undefined): StudioState {
  return {
    ...state,
    selection: nodeId ? { nodeId } : {},
  };
}

export function selectStudioEdge(state: StudioState, edgeId: string | undefined): StudioState {
  return {
    ...state,
    selection: edgeId ? { edgeId } : {},
  };
}

export function appendStudioEvents(state: StudioState, events: ReadonlyArray<StudioState["events"][number]>): StudioState {
  return {
    ...state,
    events: [...state.events, ...events],
  };
}
