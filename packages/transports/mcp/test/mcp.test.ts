import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../../runtime/test/helpers/deterministicLlmProvider.js";
import { createFlowSdkClient } from "@ai-native-flow/transport-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import { createFlowMcpServer, flowGraphToTool } from "../src/index.js";

const mcpSlowNode = defineNode({
  type: "mcp_slow_stream",
  typeVersion: "1.0.0",
  title: "MCP Slow Stream",
  validateInput: false,
  async run({ ctx }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await ctx.stream("answer")) as any;
    while (!ctx.signal.aborted) {
      await stream.write({ text: "tick" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { kind: "success", outputs: { out: null, result: "cancelled" } };
  },
});

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
    nodes: [mcpSlowNode],
  });
}

async function registerAndPromote(
  runtime: Runtime,
  flow: ReturnType<typeof defineFlow>,
): Promise<void> {
  const json = flow.dump();
  await runtime.registry.register({
    graph: JSON.parse(json),
    json,
    status: "staging",
  });
  await runtime.registry.promote(flow.id, flow.version);
}

async function registerHello(runtime: Runtime): Promise<void> {
  const flow = defineFlow({
    id: "mcp_hello",
    version: "1.0.0",
    description: "Say hello through MCP",
    inputSchema: { type: "object", required: ["name"] },
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const transform = flow.node("transform", {
    id: "t",
    position: { x: 100, y: 0 },
    config: { template: "Hello ${input.name}" },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), transform.in("in"));
  flow.connect(transform.out("out"), end.in("in"));
  await registerAndPromote(runtime, flow);
}

async function registerSlow(runtime: Runtime): Promise<void> {
  const flow = defineFlow({
    id: "mcp_cancel",
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const slow = flow.node("mcp_slow_stream", {
    id: "slow",
    position: { x: 100, y: 0 },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), slow.in("in"));
  flow.connect(slow.out("out"), end.in("in"));
  await registerAndPromote(runtime, flow);
}

async function registerResumeFlow(runtime: Runtime): Promise<void> {
  const flow = defineFlow({
    id: "mcp_resume",
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const prep = flow.node("transform", {
    id: "prep",
    position: { x: 100, y: 0 },
    config: { template: "prep:${input.name}" },
  });
  const recover = flow.node("transform", {
    id: "recover",
    position: { x: 220, y: 0 },
    config: { template: "recover:${input.orderId}" },
  });
  const end = flow.node("end", { id: "e", position: { x: 340, y: 0 } });
  flow.connect(start.out("out"), prep.in("in"));
  flow.connect(prep.out("output"), recover.in("input"));
  flow.connect(recover.out("out"), end.in("in"));
  await registerAndPromote(runtime, flow);
}

describe("transport-mcp", () => {
  it("creates MCP tool descriptors from flow metadata", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const server = createFlowMcpServer({
      client: createFlowSdkClient({ runtime }),
      registry: runtime.registry,
    });

    const tool = await server.getTool("mcp_hello");

    expect(tool).toEqual({
      name: "mcp_hello",
      flowId: "mcp_hello",
      flowVersion: "1.0.0",
      description: "Say hello through MCP",
      inputSchema: { type: "object", required: ["name"] },
    });
  });

  it("invokes a flow tool through the shared SDK client", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const server = createFlowMcpServer({
      client: createFlowSdkClient({ runtime }),
      registry: runtime.registry,
    });

    const result = await server.callTool({
      name: "mcp_hello",
      arguments: { name: "MCP" },
    });
    const payload = result.structuredContent as { output: unknown; succeeded: boolean };

    expect(result.isError).toBeUndefined();
    expect(payload.succeeded).toBe(true);
    expect(payload.output).toBe("Hello MCP");
    expect(result.content[0]?.type).toBe("text");
  });

  it("streams normalized NodeEvents without protocol-specific ordering", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const server = createFlowMcpServer({
      client: createFlowSdkClient({ runtime }),
      registry: runtime.registry,
    });

    const events = [];
    for await (const message of server.streamTool({
      name: "mcp_hello",
      arguments: { name: "Stream" },
    })) {
      events.push(message.event);
    }

    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
    expect(events.map((event) => event.kind)).toContain("node_finished");
    expect(events.every((event) => event.eventId.length > 0)).toBe(true);
  });

  it("inspects and cancels runs through public SDK operations", async () => {
    const runtime = newRuntime();
    await registerSlow(runtime);
    const client = createFlowSdkClient({ runtime });
    const server = createFlowMcpServer({ client, registry: runtime.registry });
    const started = await client.start("mcp_cancel", null);

    for await (const event of started.events()) {
      if (event.kind === "stream_delta") {
        await server.cancelRun(started.runRecord.runId, "test mcp cancel");
      }
      if (event.kind === "run_cancelled") break;
    }
    const completed = await started.completed;
    const inspection = await server.inspectRun(started.runRecord.runId);

    expect(completed.cancelled).toBe(true);
    expect(inspection.run?.status).toBe("cancelled");
    expect(inspection.events.map((event) => event.kind)).toContain("run_cancelled");
  });

  it("replays persisted events for MCP bindings", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });
    const server = createFlowMcpServer({ client, registry: runtime.registry });

    const result = await client.invoke("mcp_hello", { name: "Replay" });
    const allEvents = await client.events(result.runRecord.runId);
    const replayed = await server.replayRun(result.runRecord.runId, {
      cursor: allEvents[0]!.eventId,
      limit: 2,
    });

    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.eventId).not.toBe(allEvents[0]!.eventId);
    expect(replayed.every((event) => event.runId === result.runRecord.runId)).toBe(true);
  });

  it("resumes a flow from a durable resume point", async () => {
    const variables = new InMemoryVariableStore();
    const runtime = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
      nodes: [mcpSlowNode],
    });
    const now = Date.now();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "recover",
      snapshot: { orderId: "order-1" },
      reason: "mcp resume",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
    await registerResumeFlow(runtime);
    const server = createFlowMcpServer({
      client: createFlowSdkClient({ runtime }),
      registry: runtime.registry,
    });

    const result = await server.resumeFromPoint(
      "mcp_resume",
      "ORDER_RESUME_POINT",
    );

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("recover:order-1");
  });

  it("streams resume-point events for MCP bindings", async () => {
    const variables = new InMemoryVariableStore();
    const runtime = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
      nodes: [mcpSlowNode],
    });
    const now = Date.now();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "recover",
      snapshot: { orderId: "order-2" },
      reason: "mcp stream resume",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
    await registerResumeFlow(runtime);
    const server = createFlowMcpServer({
      client: createFlowSdkClient({ runtime }),
      registry: runtime.registry,
    });

    const events = [];
    for await (const message of server.streamFromPoint(
      "mcp_resume",
      "ORDER_RESUME_POINT",
    )) {
      events.push(message.event);
    }

    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
  });

  it("supports static tool descriptors for remote MCP bindings", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const server = createFlowMcpServer({
      client: createFlowSdkClient({ runtime }),
      tools: [
        flowGraphToTool({
          id: "mcp_hello",
          version: "1.0.0",
          label: "Hello Tool",
          inputSchema: { type: "object" },
        }),
      ],
    });

    const tools = await server.listTools();
    const result = await server.callTool({
      name: "mcp_hello",
      arguments: { name: "Static" },
    });
    const payload = result.structuredContent as { output: unknown };

    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("Hello Tool");
    expect(payload.output).toBe("Hello Static");
  });
});

