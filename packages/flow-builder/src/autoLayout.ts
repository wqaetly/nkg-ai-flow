import type {
  EdgeDefinition,
  FlowGraph,
  NodeConfigSchema,
  NodeInstance,
  NodeTypeRegistry,
  Size,
} from "@ai-native-flow/flow-ir";

const MIN_NODE_WIDTH = 280;
const MAX_NODE_WIDTH = 420;
const HEADER_HEIGHT = 38;
const CONTROL_ROW_HEIGHT = 30;
const DATA_ROW_HEIGHT = 28;
const FIELD_ROW_HEIGHT = 34;
const EMPTY_BODY_HEIGHT = 42;
const SECTION_PADDING = 16;
const LAYER_GAP = 170;
const ROW_GAP = 80;

export interface AutoLayoutOptions {
  registry?: NodeTypeRegistry;
  explicitPositionNodeIds?: ReadonlySet<string>;
}

export function applyAutoLayout(
  flow: FlowGraph,
  options: AutoLayoutOptions = {},
): FlowGraph {
  const nodes = flow.nodes.map((node) => withEstimatedSize(node, options.registry));
  if (nodes.length === 0) {
    return { ...flow, nodes };
  }

  const explicit = options.explicitPositionNodeIds ?? new Set<string>();
  const hasImplicitPosition = nodes.some((node) => !explicit.has(node.id));
  const hasOverlap = hasNodeOverlap(nodes);
  if (!hasImplicitPosition && !hasOverlap) {
    return { ...flow, nodes };
  }

  return {
    ...flow,
    nodes: layoutNodes(nodes, flow.edges),
  };
}

function withEstimatedSize(
  node: NodeInstance,
  registry: NodeTypeRegistry | undefined,
): NodeInstance {
  return {
    ...node,
    size: node.size ?? estimateNodeSize(node, registry),
  };
}

export function estimateNodeSize(
  node: NodeInstance,
  registry?: NodeTypeRegistry,
): Size {
  const label = node.label ?? node.id;
  const portLabels = node.ports.map((port) => port.label ?? port.id);
  const configKeys = Object.keys(node.config ?? {});
  const fieldCount = Math.max(
    configKeys.length,
    reflectedFieldCount(node, registry),
  );
  const longestText = [label, node.type, ...portLabels, ...configKeys]
    .reduce((max, text) => Math.max(max, text.length), 0);

  const width = clamp(MIN_NODE_WIDTH, MAX_NODE_WIDTH, 120 + longestText * 7);
  const hasControlRow = node.ports.some((port) => port.kind === "control");
  const dataInputs = node.ports.filter(
    (port) => port.direction === "input" && port.kind !== "control",
  ).length;
  const dataOutputs = node.ports.filter(
    (port) => port.direction === "output" && port.kind !== "control",
  ).length;
  const dataRows = Math.max(dataInputs, dataOutputs);

  let height = HEADER_HEIGHT;
  if (hasControlRow) height += CONTROL_ROW_HEIGHT;
  if (fieldCount > 0) height += SECTION_PADDING + fieldCount * FIELD_ROW_HEIGHT;
  if (dataRows > 0) height += SECTION_PADDING + dataRows * DATA_ROW_HEIGHT;
  if (!hasControlRow && fieldCount === 0 && dataRows === 0) {
    height += EMPTY_BODY_HEIGHT;
  }

  return {
    width,
    height: Math.max(96, height),
  };
}

function reflectedFieldCount(
  node: NodeInstance,
  registry: NodeTypeRegistry | undefined,
): number {
  const schema = registry
    ?.tryGet(node.type, node.typeVersion)
    ?.configSchema;
  if (!schema || typeof schema !== "object") return 0;
  const configSchema = schema as NodeConfigSchema & {
    properties?: Record<string, unknown>;
  };
  if (Array.isArray(configSchema.fields)) {
    return configSchema.fields.filter((field) => !field.hidden).length;
  }
  if (configSchema.properties && typeof configSchema.properties === "object") {
    return Object.keys(configSchema.properties).length;
  }
  return 0;
}

function layoutNodes(
  nodes: NodeInstance[],
  edges: EdgeDefinition[],
): NodeInstance[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of edges) {
    if (!nodeById.has(edge.from.nodeId) || !nodeById.has(edge.to.nodeId)) {
      continue;
    }
    outgoing.get(edge.from.nodeId)!.push(edge.to.nodeId);
    incoming.set(edge.to.nodeId, (incoming.get(edge.to.nodeId) ?? 0) + 1);
  }

  const queue = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    .map((node) => node.id);
  const indegree = new Map(incoming);
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    visited.add(current);
    const nextIds = [...(outgoing.get(current) ?? [])].sort(
      (a, b) => order.get(a)! - order.get(b)!,
    );
    for (const next of nextIds) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(current) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }

  // Cycles have no zero-indegree entry. Keep them deterministic by placing
  // each remaining node one layer after its latest known predecessor.
  for (const edge of edges) {
    if (!nodeById.has(edge.from.nodeId) || !nodeById.has(edge.to.nodeId)) {
      continue;
    }
    if (visited.has(edge.to.nodeId)) continue;
    layer.set(
      edge.to.nodeId,
      Math.max(layer.get(edge.to.nodeId) ?? 0, (layer.get(edge.from.nodeId) ?? 0) + 1),
    );
  }

  const layers = new Map<number, NodeInstance[]>();
  for (const node of nodes) {
    const key = layer.get(node.id) ?? 0;
    const list = layers.get(key) ?? [];
    list.push(node);
    layers.set(key, list);
  }

  const sortedLayerIds = [...layers.keys()].sort((a, b) => a - b);
  let x = 0;
  const layerX = new Map<number, number>();
  for (const layerId of sortedLayerIds) {
    layerX.set(layerId, x);
    const maxWidth = Math.max(
      ...layers.get(layerId)!.map((node) => node.size?.width ?? MIN_NODE_WIDTH),
    );
    x += maxWidth + LAYER_GAP;
  }

  const positionByNode = new Map<string, { x: number; y: number }>();
  for (const layerId of sortedLayerIds) {
    const layerNodes = layers
      .get(layerId)!
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    let y = 0;
    for (const node of layerNodes) {
      positionByNode.set(node.id, {
        x: layerX.get(layerId)!,
        y,
      });
      y += (node.size?.height ?? 96) + ROW_GAP;
    }
  }

  return nodes.map((node) => ({
    ...node,
    position: positionByNode.get(node.id) ?? node.position,
  }));
}

function hasNodeOverlap(nodes: NodeInstance[]): boolean {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (rectsOverlap(nodes[i]!, nodes[j]!)) return true;
    }
  }
  return false;
}

function rectsOverlap(a: NodeInstance, b: NodeInstance): boolean {
  const aw = a.size?.width ?? MIN_NODE_WIDTH;
  const ah = a.size?.height ?? 96;
  const bw = b.size?.width ?? MIN_NODE_WIDTH;
  const bh = b.size?.height ?? 96;
  return (
    a.position.x < b.position.x + bw &&
    a.position.x + aw > b.position.x &&
    a.position.y < b.position.y + bh &&
    a.position.y + ah > b.position.y
  );
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}
