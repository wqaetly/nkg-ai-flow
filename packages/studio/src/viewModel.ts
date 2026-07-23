import type { NodeEvent } from "@ai-native-flow/event-bus";
import type {
  FieldDescriptor,
  FlowGraph,
  NodeConfigSchema,
  NodeTypeDefinition,
  PortDefinition,
} from "@ai-native-flow/flow-ir";
import { validateGraph, type ValidationResult } from "@ai-native-flow/flow-validator";
import type {
  StudioCanvasEdge,
  StudioCanvasNode,
  StudioPaletteItem,
  StudioSelection,
  StudioState,
  StudioStreamFrame,
  StudioStreamInspector,
  StudioTimelineItem,
  StudioTraceSummary,
  StudioViewModel,
} from "./types.js";
import type { AiPatchPreview } from "@ai-native-flow/flow-builder";
import {
  DEFAULT_STUDIO_FIELD_LOCALE,
  localizeFieldDescriptor,
  type StudioFieldLocale,
} from "./fields/fieldLabels.js";
import { resolveNodeDisplayLabels } from "./paletteLabels.js";
import { localizePortDefinition } from "./portLabels.js";
import { deriveRuntimeDebugNodeState } from "./runtimeDebug.js";

const DEFAULT_NODE_SIZE = { width: 220, height: 132 } as const;

export interface CreateStudioStateOptions {
  graph: FlowGraph;
  palette?: NodeTypeDefinition[];
  /** Locale used to resolve visible config-field labels on node cards. */
  fieldLocale?: StudioFieldLocale;
  events?: NodeEvent[];
  selection?: StudioSelection;
  validation?: ValidationResult;
  patchPreview?: AiPatchPreview;
}

export function createStudioState(options: CreateStudioStateOptions): StudioState {
  const fieldLocale = options.fieldLocale ?? DEFAULT_STUDIO_FIELD_LOCALE;
  const palette = (options.palette ?? []).map((type) =>
    toPaletteItem(type, fieldLocale),
  );
  const validation = options.validation ?? validateGraph(options.graph);
  return {
    graph: options.graph,
    fieldLocale,
    validation,
    operations: [],
    events: options.events ?? [],
    selection: options.selection ?? {},
    palette,
    patchPreview: options.patchPreview,
  };
}

export function createStudioViewModel(state: StudioState): StudioViewModel {
  return {
    theme: "dark-flat",
    flow: {
      id: state.graph.id,
      version: state.graph.version,
      schemaVersion: state.graph.schemaVersion,
      label: state.graph.label,
      description: state.graph.description,
      viewport: state.graph.viewport,
    },
    nodes: state.graph.nodes.map((node) =>
      toCanvasNode(
        node,
        state.events,
        state.fieldLocale ?? DEFAULT_STUDIO_FIELD_LOCALE,
      ),
    ),
    edges: state.graph.edges.map((edge) => {
      const sourceNode = state.graph.nodes.find((node) => node.id === edge.from.nodeId);
      const sourcePort = sourceNode?.ports.find((port) => port.id === edge.from.portId && port.direction === "output");
      return {
        id: edge.id,
        from: `${edge.from.nodeId}.${edge.from.portId}`,
        to: `${edge.to.nodeId}.${edge.to.portId}`,
        condition: edge.condition,
        kind: sourcePort?.kind ?? "unknown",
      } satisfies StudioCanvasEdge;
    }),
    selectedNodeId: state.selection.nodeId,
    selectedEdgeId: state.selection.edgeId,
    palette: state.palette,
    validation: {
      ok: state.validation.ok,
      errors: state.validation.errors,
      warnings: state.validation.warnings,
    },
    operations: state.operations,
    patchPreview: state.patchPreview ? toPatchPreviewPanel(state.patchPreview) : undefined,
    runTimeline: createRunTimeline(state.events),
    traceViewer: createTraceSummary(state.events),
    streamInspector: createStreamInspector(state.events),
  };
}

function toPatchPreviewPanel(preview: AiPatchPreview) {
  return {
    proposalId: preview.proposal.id,
    title: preview.proposal.title,
    author: preview.proposal.author,
    ...preview.summary,
    policyErrorCount: preview.policyErrors.length,
    validationErrorCount: preview.validation.errors.length,
  };
}

function toPaletteItem(
  type: NodeTypeDefinition,
  fieldLocale: StudioFieldLocale,
): StudioPaletteItem {
  const configFields = extractConfigFields(
    type.type,
    type.configSchema,
    fieldLocale,
  );
  const labels = resolveNodeDisplayLabels(
    type.type,
    type.title,
    type.description,
    fieldLocale,
  );
  return {
    type: type.type,
    typeVersion: type.typeVersion,
    title: labels.title,
    description: labels.description,
    runtime: type.runtime,
    defaultPorts: type.defaultPorts.map((port) =>
      localizePortDefinition(type.type, port, fieldLocale),
    ),
    ...(configFields ? { configFields } : {}),
  };
}

/**
 * Pull the reflected field list out of a `NodeTypeDefinition.configSchema`.
 *
 * The Studio supports three input shapes, in priority order:
 *
 *   1. The new `{ fields: FieldDescriptor[] }` shape produced by
 *      `defineNode`'s Zod-reflection layer (richest metadata).
 *   2. JSON-Schema-style `{ type: "object", properties, required }`
 *      shapes used by the legacy `flow-ir` builtin catalogue. We map
 *      `string / number / boolean / array / object` to their closest
 *      `FieldKind` so even nodes that pre-date the inspector get a
 *      basic UI on the card.
 *   3. Anything else (e.g. the placeholder `{ "x-zod": true, typeName }`
 *      old `defineNode` used to emit) yields `undefined` so the field
 *      panel is skipped entirely.
 */
function extractConfigFields(
  nodeType: string,
  configSchema: NodeTypeDefinition["configSchema"],
  fieldLocale: StudioFieldLocale,
): FieldDescriptor[] | undefined {
  if (!configSchema || typeof configSchema !== "object") return undefined;
  const schema = configSchema as NodeConfigSchema & {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };

  // 1. New reflected shape wins.
  if (Array.isArray(schema.fields) && schema.fields.length > 0) {
    return schema.fields.map((f) =>
      localizeFieldDescriptor(nodeType, f, fieldLocale),
    );
  }

  // 2. JSON-Schema fallback for the hand-written `flow-ir` catalogue.
  if (schema.properties && typeof schema.properties === "object") {
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    const out: FieldDescriptor[] = [];
    for (const [name, raw] of Object.entries(schema.properties)) {
      const prop = (raw ?? {}) as {
        type?: string;
        description?: string;
        enum?: ReadonlyArray<string | number>;
        format?: string;
        minimum?: number;
        maximum?: number;
        minLength?: number;
        maxLength?: number;
        items?: { type?: string };
      };
      out.push(
        localizeFieldDescriptor(
          nodeType,
          jsonSchemaPropToDescriptor(name, prop, !required.has(name)),
          fieldLocale,
        ),
      );
    }
    return out.length > 0 ? out : undefined;
  }

  return undefined;
}

function jsonSchemaPropToDescriptor(
  name: string,
  prop: {
    type?: string;
    description?: string;
    enum?: ReadonlyArray<string | number>;
    format?: string;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    items?: { type?: string };
  },
  optional: boolean,
): FieldDescriptor {
  const desc: FieldDescriptor = {
    name,
    kind: "unknown",
    optional,
    nullable: false,
  };
  if (prop.description) desc.description = prop.description;

  if (prop.enum && prop.enum.length > 0) {
    desc.kind = "enum";
    desc.enumOptions = prop.enum.map((v) => ({ label: String(v), value: v }));
    return desc;
  }

  switch (prop.type) {
    case "string":
      desc.kind = "string";
      if (
        prop.format ||
        prop.minLength !== undefined ||
        prop.maxLength !== undefined
      ) {
        desc.constraints = {};
        if (prop.format) desc.constraints.format = prop.format;
        if (prop.minLength !== undefined) desc.constraints.min = prop.minLength;
        if (prop.maxLength !== undefined) desc.constraints.max = prop.maxLength;
      }
      return desc;
    case "number":
    case "integer":
      desc.kind = "number";
      if (prop.minimum !== undefined || prop.maximum !== undefined) {
        desc.constraints = {};
        if (prop.minimum !== undefined) desc.constraints.min = prop.minimum;
        if (prop.maximum !== undefined) desc.constraints.max = prop.maximum;
      }
      return desc;
    case "boolean":
      desc.kind = "boolean";
      return desc;
    case "array":
      desc.kind = prop.items?.type === "string" ? "string[]" : "unknown";
      return desc;
    case "object":
      desc.kind = "record";
      return desc;
    default:
      desc.kind = "unknown";
      return desc;
  }
}

function toCanvasNode(
  node: FlowGraph["nodes"][number],
  events: NodeEvent[],
  fieldLocale: StudioFieldLocale,
): StudioCanvasNode {
  const debug = deriveRuntimeDebugNodeState(events, node.id);
  return {
    id: node.id,
    type: node.type,
    typeVersion: node.typeVersion,
    label: node.label ?? node.id,
    position: { ...node.position },
    size: node.size ?? { ...DEFAULT_NODE_SIZE },
    inputs: portsByDirection(node.type, node.ports, "input", fieldLocale),
    outputs: portsByDirection(node.type, node.ports, "output", fieldLocale),
    config: { ...(node.config ?? {}) },
    status: debug.status,
    ...(debug.runtime ? { runtime: debug.runtime } : {}),
  };
}

function portsByDirection(
  nodeType: string,
  ports: PortDefinition[],
  direction: PortDefinition["direction"],
  fieldLocale: StudioFieldLocale,
): PortDefinition[] {
  return ports
    .filter((port) => port.direction === direction)
    .map((port) => localizePortDefinition(nodeType, port, fieldLocale));
}

export function createRunTimeline(events: NodeEvent[]): StudioTimelineItem[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq || a.eventId.localeCompare(b.eventId))
    .map((event) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      kind: event.kind,
      nodeId: event.nodeId,
      seq: event.seq,
      label: timelineLabel(event),
      severity: timelineSeverity(event),
    }));
}

export function createTraceSummary(events: NodeEvent[]): StudioTraceSummary {
  const timeline = createRunTimeline(events);
  const nodes = new Set(events.flatMap((event) => (event.nodeId ? [event.nodeId] : [])));
  return {
    eventCount: events.length,
    nodeCount: nodes.size,
    errorCount: events.filter((event) => event.kind === "node_error" || event.kind === "run_failed" || event.kind === "transport_error").length,
    warningCount: events.filter((event) => event.kind === "node_warning").length,
    streamCount: events.filter((event) => event.kind.startsWith("stream_")).length,
    transportDiagnostics: timeline.filter((item) => item.kind === "transport_error"),
  };
}

export function createStreamInspector(events: NodeEvent[]): StudioStreamInspector {
  const frames = events.filter(isStreamFrame).map((event) => ({
    eventId: event.eventId,
    nodeId: event.nodeId,
    portId: event.portId,
    streamId: event.streamId,
    seq: event.seq,
    timestamp: event.timestamp,
    kind: event.kind,
    payload: event.payload,
  }));

  return {
    frames,
    replayText: frames
      .filter((frame) => frame.kind === "stream_delta" || frame.kind === "tool_call_delta")
      .map((frame) => payloadToText(frame.payload))
      .join(""),
    cursors: frames.map((frame) => frame.eventId),
    artifacts: frames.filter((frame) => frame.kind === "stream_artifact"),
  };
}

function isStreamFrame(event: NodeEvent): event is NodeEvent & { kind: StudioStreamFrame["kind"] } {
  return event.kind === "stream_open"
    || event.kind === "stream_delta"
    || event.kind === "stream_artifact"
    || event.kind === "stream_usage"
    || event.kind === "stream_close"
    || event.kind === "tool_call_delta";
}

function payloadToText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.delta === "string") return record.delta;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

function timelineLabel(event: NodeEvent): string {
  const subject = event.nodeId ? `node ${event.nodeId}` : `run ${event.runId}`;
  return `${subject} · ${event.kind}`;
}

function timelineSeverity(event: NodeEvent): StudioTimelineItem["severity"] {
  if (event.kind === "node_error" || event.kind === "run_failed" || event.kind === "transport_error") return "error";
  if (event.kind === "node_warning") return "warning";
  if (event.kind === "node_finished" || event.kind === "run_finished") return "success";
  if (event.kind.startsWith("stream_") || event.kind.startsWith("tool_call_")) return "stream";
  return "info";
}
