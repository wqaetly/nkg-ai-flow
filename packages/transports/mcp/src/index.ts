import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { RuntimeRegistry, RunRecord } from "@ai-native-flow/runtime";
import type { FlowSdkClient } from "@ai-native-flow/transport-sdk";

export interface FlowMcpServerOptions {
  client: FlowSdkClient;
  /** Optional registry used only for MCP tool descriptors and input schemas. */
  registry?: RuntimeRegistry;
  /** Optional static descriptors for remotely hosted or predeclared flows. */
  tools?: readonly FlowMcpToolDescriptor[];
}

export interface FlowMcpToolDescriptor {
  name: string;
  flowId: string;
  flowVersion?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FlowMcpToolCallRequest {
  name: string;
  arguments?: unknown;
}

export interface FlowMcpToolResult {
  content: FlowMcpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export type FlowMcpContent =
  | { type: "text"; text: string }
  | { type: "resource"; resource: FlowMcpResource };

export interface FlowMcpResource {
  uri: string;
  mimeType: string;
  text: string;
}

export interface FlowMcpRunResult {
  runId: string;
  status: RunRecord["status"];
  succeeded: boolean;
  cancelled: boolean;
  output?: unknown;
  error?: unknown;
}

export interface FlowMcpStreamEvent {
  runId: string;
  event: NodeEvent;
}

export function createFlowMcpServer(options: FlowMcpServerOptions): FlowMcpServer {
  return new FlowMcpServer(options);
}

/**
 * Thin MCP transport adapter.
 *
 * This class intentionally models MCP server behavior without owning a concrete
 * stdio or HTTP binding. The binding layer can wire `listTools`, `callTool`,
 * `streamTool`, `inspectRun`, and `cancelRun` to an MCP SDK while invocation,
 * ordering, cancellation, and event streaming remain delegated to the shared
 * TypeScript SDK and Runtime APIs.
 */
export class FlowMcpServer {
  private readonly client: FlowSdkClient;
  private readonly registry: RuntimeRegistry | undefined;
  private readonly staticTools: readonly FlowMcpToolDescriptor[];

  constructor(options: FlowMcpServerOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.staticTools = options.tools ?? [];
  }

  async listTools(): Promise<FlowMcpToolDescriptor[]> {
    return this.staticTools.map((tool) => ({ ...tool }));
  }

  async getTool(flowId: string, flowVersion?: string): Promise<FlowMcpToolDescriptor> {
    const staticTool = this.staticTools.find(
      (tool) => tool.flowId === flowId && tool.flowVersion === flowVersion,
    );
    if (staticTool) return { ...staticTool };
    if (!this.registry) {
      throw new Error(`No MCP tool descriptor registered for flow ${flowId}`);
    }
    const ref = flowVersion === undefined
      ? await this.registry.getActive(flowId)
      : await this.registry.resolve(flowId, flowVersion);
    return flowGraphToTool(ref.graph, flowVersion);
  }

  async callTool(request: FlowMcpToolCallRequest): Promise<FlowMcpToolResult> {
    const tool = await this.resolveTool(request.name);
    try {
      const result = await this.client.invoke(
        tool.flowId,
        request.arguments ?? {},
        toInvokeOptions(tool),
      );
      const payload: FlowMcpRunResult = {
        runId: result.runRecord.runId,
        status: result.runRecord.status,
        succeeded: result.succeeded,
        cancelled: result.cancelled,
        output: result.output,
        error: result.error,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        ...(result.succeeded ? {} : { isError: true }),
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: renderError(error) }],
      };
    }
  }

  async *streamTool(
    request: FlowMcpToolCallRequest,
  ): AsyncIterable<FlowMcpStreamEvent> {
    const tool = await this.resolveTool(request.name);
    for await (const event of this.client.stream(
      tool.flowId,
      request.arguments ?? {},
      toInvokeOptions(tool),
    )) {
      yield { runId: event.runId, event };
    }
  }

  async inspectRun(
    runId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ run?: RunRecord; events: NodeEvent[] }> {
    const [run, events] = await Promise.all([
      this.client.getRun(runId),
      this.client.events(runId, options),
    ]);
    return { run, events };
  }

  async replayRun(
    runId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<NodeEvent[]> {
    return this.client.replayRun(runId, options);
  }

  async resumeFromPoint(
    flowId: string,
    resumePointName: string,
    options: { flowVersion?: string } = {},
  ): Promise<FlowMcpRunResult> {
    const result = await this.client.resumeFromPoint(
      flowId,
      resumePointName,
      options,
    );
    return {
      runId: result.runRecord.runId,
      status: result.runRecord.status,
      succeeded: result.succeeded,
      cancelled: result.cancelled,
      output: result.output,
      error: result.error,
    };
  }

  async *streamFromPoint(
    flowId: string,
    resumePointName: string,
    options: { flowVersion?: string } = {},
  ): AsyncIterable<FlowMcpStreamEvent> {
    for await (const event of this.client.streamFromPoint(
      flowId,
      resumePointName,
      options,
    )) {
      yield { runId: event.runId, event };
    }
  }

  async cancelRun(runId: string, reason = "mcp cancel requested"): Promise<void> {
    await this.client.cancel(runId, reason);
  }

  private async resolveTool(name: string): Promise<FlowMcpToolDescriptor> {
    const staticTool = this.staticTools.find((tool) => tool.name === name);
    if (staticTool) return staticTool;
    if (!this.registry) throw new Error(`Unknown MCP tool: ${name}`);
    return this.getTool(name);
  }
}

export function flowGraphToTool(
  graph: {
    id: string;
    version: string;
    label?: string;
    description?: string;
    inputSchema?: unknown;
  },
  flowVersion = graph.version,
): FlowMcpToolDescriptor {
  return {
    name: graph.id,
    flowId: graph.id,
    flowVersion,
    description: graph.description ?? graph.label,
    inputSchema: graph.inputSchema ?? defaultMcpInputSchema(),
  };
}

function toInvokeOptions(tool: FlowMcpToolDescriptor): {
  flowVersion?: string;
} {
  return tool.flowVersion === undefined ? {} : { flowVersion: tool.flowVersion };
}

function defaultMcpInputSchema(): unknown {
  return {
    type: "object",
    additionalProperties: true,
  };
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type { NodeEvent };
