import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { AiPatchPreview, AiPatchPreviewSummary, FlowDiff, GraphOperation } from "@ai-native-flow/flow-builder";
import type {
  EdgeDefinition,
  FieldDescriptor,
  FlowGraph,
  NodeInstance,
  NodeTypeDefinition,
  PortDefinition,
  RuntimeError,
} from "@ai-native-flow/flow-ir";
import type { ValidationResult } from "@ai-native-flow/flow-validator";
import type { StudioFieldLocale } from "./fields/fieldLabels.js";

export type StudioTheme = "dark-flat";

export interface StudioCanvasNode {
  id: string;
  type: string;
  typeVersion: string;
  label: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  /**
   * Node configuration values keyed by parameter name (often matching a port id).
   * Surfaced here so the canvas renderer can show parameter previews inline
   * without an inspector side panel.
   */
  config: Record<string, unknown>;
  status?: StudioNodeStatus;
  /**
   * Optional execution timing surfaced from the run-event stream so the
   * card can paint a small ms-level timer underneath the status dot.
   *
   * - `startedAt` is the epoch-ms wallclock taken from the latest
   *   `node_started` event for this node. When the node is still
   *   `running` / `streaming`, the canvas computes `now - startedAt` to
   *   tick the timer in real time.
   * - `durationMs` is the terminal duration plucked out of the
   *   `node_finished.payload.durationMs` (or `node_error.payload.durationMs`)
   *   field — used for the frozen final readout once the node settles.
   */
  runtime?: {
    startedAt?: number;
    durationMs?: number;
  };
}

export type StudioNodeStatus = "idle" | "running" | "succeeded" | "failed" | "streaming";

export interface StudioCanvasEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  kind: PortDefinition["kind"] | "unknown";
}

export interface StudioViewModel {
  theme: StudioTheme;
  flow: Pick<FlowGraph, "id" | "version" | "schemaVersion" | "label" | "description" | "viewport">;
  nodes: StudioCanvasNode[];
  edges: StudioCanvasEdge[];
  selectedNodeId?: string;
  selectedEdgeId?: string;
  palette: StudioPaletteItem[];
  validation: StudioValidationPanel;
  operations: GraphOperation[];
  patchPreview?: StudioPatchPreviewPanel;
  runTimeline: StudioTimelineItem[];
  traceViewer: StudioTraceSummary;
  streamInspector: StudioStreamInspector;
}

export interface StudioPatchPreviewPanel extends AiPatchPreviewSummary {
  proposalId: string;
  title: string;
  author: string;
  policyErrorCount: number;
  validationErrorCount: number;
}

export interface StudioPaletteItem {
  type: string;
  typeVersion: string;
  title: string;
  description?: string;
  runtime: NodeTypeDefinition["runtime"];
  defaultPorts: PortDefinition[];
  /**
   * Reflective field descriptors derived from the node's `config`
   * Zod schema (see `node-sdk/describeZodFields`). Studio's Node Field
   * Inspector reads this to render configurable controls directly on
   * the node card. Empty / undefined for legacy types whose
   * `configSchema` doesn't carry the new shape.
   */
  configFields?: FieldDescriptor[];
}

export interface StudioValidationPanel {
  ok: boolean;
  errors: RuntimeError[];
  warnings: RuntimeError[];
}

export interface StudioTimelineItem {
  eventId: string;
  timestamp: string;
  kind: NodeEvent["kind"];
  nodeId?: string;
  seq: number;
  label: string;
  severity: "info" | "success" | "warning" | "error" | "stream";
}

export interface StudioTraceSummary {
  eventCount: number;
  nodeCount: number;
  errorCount: number;
  warningCount: number;
  streamCount: number;
  transportDiagnostics: StudioTimelineItem[];
}

export interface StudioStreamFrame {
  eventId: string;
  nodeId?: string;
  portId?: string;
  streamId?: string;
  seq: number;
  timestamp: string;
  kind: Extract<NodeEvent["kind"], "stream_open" | "stream_delta" | "stream_artifact" | "stream_usage" | "stream_close" | "tool_call_delta">;
  payload: unknown;
}

export interface StudioStreamInspector {
  frames: StudioStreamFrame[];
  replayText: string;
  cursors: string[];
  artifacts: StudioStreamFrame[];
}

export interface StudioSelection {
  nodeId?: string;
  edgeId?: string;
}

export interface StudioState {
  graph: FlowGraph;
  fieldLocale?: StudioFieldLocale;
  validation: ValidationResult;
  operations: GraphOperation[];
  events: NodeEvent[];
  selection: StudioSelection;
  palette: StudioPaletteItem[];
  patchPreview?: AiPatchPreview;
}

export interface StudioApplyResult {
  state: StudioState;
  diff: FlowDiff;
}

export interface StudioRenderOptions {
  title?: string;
  subtitle?: string;
}

export interface StudioNodeDraft {
  id: string;
  type: string;
  typeVersion: string;
  label?: string;
  position: { x: number; y: number };
  ports: PortDefinition[];
  config?: Record<string, unknown>;
}

export interface StudioEdgeDraft {
  id: string;
  from: EdgeDefinition["from"];
  to: EdgeDefinition["to"];
  condition?: string;
}

export type { EdgeDefinition, FieldDescriptor, FlowGraph, GraphOperation, NodeEvent, NodeInstance, NodeTypeDefinition, PortDefinition };
