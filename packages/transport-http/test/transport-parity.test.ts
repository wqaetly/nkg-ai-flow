import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../runtime/test/helpers/deterministicLlmProvider.js";
import { createHttpHandler } from "@ai-native-flow/transport-http";
import { createFlowCli, type CliIo } from "@ai-native-flow/transport-cli";
import { createFlowMcpServer } from "@ai-native-flow/transport-mcp";
import { createFlowSdkClient } from "@ai-native-flow/transport-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";

const paritySlowNode = defineNode({
  type: "parity_slow_stream",
  typeVersion: "1.0.0",
  title: "Parity Slow Stream",
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
    nodes: [paritySlowNode],
  });
}

function createTestIo(): CliIo & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: {
      write: (chunk) => {
        stdoutLines.push(chunk.trimEnd());
      },
    },
    stderr: {
      write: (chunk) => {
        stderrLines.push(chunk.trimEnd());
      },
    },
    readFile: async () => {
      throw new Error("No files are registered for this test IO");
    },
  };
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
    id: "parity_hello",
    version: "1.0.0",
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
    id: "parity_cancel",
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const slow = flow.node("parity_slow_stream", {
    id: "slow",
    position: { x: 100, y: 0 },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), slow.in("in"));
  flow.connect(slow.out("out"), end.in("in"));
  await registerAndPromote(runtime, flow);
}

describe("transport parity matrix", () => {
  it("returns equivalent invoke output across HTTP, SDK, CLI, and MCP", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const handler = createHttpHandler({ runtime });
    const sdk = createFlowSdkClient({ runtime });
    const cliIo = createTestIo();
    const cli = createFlowCli({ client: sdk, io: cliIo });
    const mcp = createFlowMcpServer({ client: sdk, registry: runtime.registry });

    const httpRes = await handler(new Request("http://test/flows/parity_hello/invoke", {
      method: "POST",
      body: JSON.stringify({ input: { name: "HTTP" } }),
    }));
    const httpBody = await httpRes.json() as { output: unknown; status: string };
    const sdkResult = await sdk.invoke("parity_hello", { name: "SDK" });
    const cliResult = await cli.run([
      "run",
      "parity_hello",
      "--input",
      JSON.stringify({ name: "CLI" }),
    ]);
    const cliBody = JSON.parse(cliIo.stdoutLines[0]!);
    const mcpResult = await mcp.callTool({
      name: "parity_hello",
      arguments: { name: "MCP" },
    });
    const mcpBody = mcpResult.structuredContent as { output: unknown; succeeded: boolean };

    expect(httpRes.status).toBe(200);
    expect(httpBody.status).toBe("succeeded");
    expect(httpBody.output).toBe("Hello HTTP");
    expect(sdkResult.succeeded).toBe(true);
    expect(sdkResult.output).toBe("Hello SDK");
    expect(cliResult.exitCode).toBe(0);
    expect(cliBody.output).toBe("Hello CLI");
    expect(mcpResult.isError).toBeUndefined();
    expect(mcpBody.succeeded).toBe(true);
    expect(mcpBody.output).toBe("Hello MCP");
  });

  it("replays equivalent event logs across HTTP, SDK, CLI, and MCP", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const handler = createHttpHandler({ runtime });
    const sdk = createFlowSdkClient({ runtime });
    const cliIo = createTestIo();
    const cli = createFlowCli({ client: sdk, io: cliIo });
    const mcp = createFlowMcpServer({ client: sdk, registry: runtime.registry });
    const result = await sdk.invoke("parity_hello", { name: "Replay" });
    const allEvents = await sdk.events(result.runRecord.runId);
    const cursor = allEvents[0]!.eventId;

    const httpRes = await handler(new Request(
      `http://test/runs/${result.runRecord.runId}/events?cursor=${cursor}&limit=2`,
    ));
    const httpBody = await httpRes.json() as { events: { eventId: string; kind: string }[] };
    const sdkReplay = await sdk.replayRun(result.runRecord.runId, { cursor, limit: 2 });
    await cli.run(["replay", result.runRecord.runId, "--cursor", cursor, "--limit", "2"]);
    const cliReplay = cliIo.stdoutLines.map((line) => JSON.parse(line));
    const mcpReplay = await mcp.replayRun(result.runRecord.runId, { cursor, limit: 2 });

    const expectedIds = sdkReplay.map((event) => event.eventId);
    expect(httpBody.events.map((event) => event.eventId)).toEqual(expectedIds);
    expect(cliReplay.map((event) => event.eventId)).toEqual(expectedIds);
    expect(mcpReplay.map((event) => event.eventId)).toEqual(expectedIds);
    expect(expectedIds).not.toContain(cursor);
  });

  it("cancels in-flight runs consistently across HTTP, SDK, CLI, and MCP", async () => {
    const runtime = newRuntime();
    await registerSlow(runtime);
    const handler = createHttpHandler({ runtime });
    const sdk = createFlowSdkClient({ runtime });
    const cliIo = createTestIo();
    const cli = createFlowCli({ client: sdk, io: cliIo });
    const mcp = createFlowMcpServer({ client: sdk, registry: runtime.registry });

    const httpRun = await sdk.start("parity_cancel", null);
    const sdkRun = await sdk.start("parity_cancel", null);
    const cliRun = await sdk.start("parity_cancel", null);
    const mcpRun = await sdk.start("parity_cancel", null);

    await waitForStreamDelta(httpRun.events());
    await waitForStreamDelta(sdkRun.events());
    await waitForStreamDelta(cliRun.events());
    await waitForStreamDelta(mcpRun.events());

    const httpRes = await handler(new Request(
      `http://test/runs/${httpRun.runRecord.runId}/cancel`,
      { method: "POST" },
    ));
    await sdkRun.cancel("sdk parity cancel");
    const cliResult = await cli.run(["cancel", cliRun.runRecord.runId]);
    await mcp.cancelRun(mcpRun.runRecord.runId, "mcp parity cancel");

    const [httpResult, sdkResult, cliCompleted, mcpResult] = await Promise.all([
      httpRun.completed,
      sdkRun.completed,
      cliRun.completed,
      mcpRun.completed,
    ]);

    expect(httpRes.status).toBe(202);
    expect(httpResult.cancelled).toBe(true);
    expect(sdkResult.cancelled).toBe(true);
    expect(cliResult.exitCode).toBe(0);
    expect(cliCompleted.cancelled).toBe(true);
    expect(mcpResult.cancelled).toBe(true);
  });
});

async function waitForStreamDelta(events: AsyncIterable<{ kind: string }>): Promise<void> {
  for await (const event of events) {
    if (event.kind === "stream_delta") return;
  }
  throw new Error("Expected stream_delta before terminal event");
}

