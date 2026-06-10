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
import { createFlowCli, type CliIo } from "../src/index.js";

const cliSlowNode = defineNode({
  type: "cli_slow_stream",
  typeVersion: "1.0.0",
  title: "CLI Slow Stream",
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
    nodes: [cliSlowNode],
  });
}

function createTestIo(files: Record<string, string> = {}): CliIo & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: {
      write: (chunk: string) => {
        stdoutLines.push(chunk.trimEnd());
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderrLines.push(chunk.trimEnd());
      },
    },
    async readFile(path: string) {
      const file = files[path];
      if (file === undefined) throw new Error(`File not found: ${path}`);
      return file;
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
    id: "cli_hello",
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
    id: "cli_cancel",
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const slow = flow.node("cli_slow_stream", {
    id: "slow",
    position: { x: 100, y: 0 },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), slow.in("in"));
  flow.connect(slow.out("out"), end.in("in"));
  await registerAndPromote(runtime, flow);
}

describe("transport-cli", () => {
  it("runs a flow and renders the final result as JSON", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const io = createTestIo({ "input.json": JSON.stringify({ name: "CLI" }) });
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run(["run", "cli_hello", "--input", "@input.json"]);
    const payload = JSON.parse(io.stdoutLines[0]!);

    expect(result.exitCode).toBe(0);
    expect(payload.succeeded).toBe(true);
    expect(payload.output).toBe("Hello CLI");
    expect(result.runId).toBe(payload.runId);
  });

  it("streams normalized NodeEvents as newline-delimited JSON", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const io = createTestIo();
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run([
      "stream",
      "cli_hello",
      "--input",
      JSON.stringify({ name: "Stream" }),
    ]);
    const events = io.stdoutLines.map((line) => JSON.parse(line));

    expect(result.exitCode).toBe(0);
    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
    expect(events.map((event) => event.kind)).toContain("node_finished");
  });

  it("inspects a run with cursor and limit options", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });
    const invokeResult = await client.invoke("cli_hello", { name: "Inspect" });
    const events = await client.events(invokeResult.runRecord.runId);
    const io = createTestIo();
    const cli = createFlowCli({ client, io });

    const result = await cli.run([
      "inspect",
      invokeResult.runRecord.runId,
      "--cursor",
      events[0]!.eventId,
      "--limit",
      "2",
    ]);
    const payload = JSON.parse(io.stdoutLines[0]!);

    expect(result.exitCode).toBe(0);
    expect(payload.run.runId).toBe(invokeResult.runRecord.runId);
    expect(payload.events).toHaveLength(2);
    expect(payload.events.find((event: { eventId: string }) => event.eventId === events[0]!.eventId)).toBeUndefined();
  });

  it("replays a run as newline-delimited JSON events", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });
    const invokeResult = await client.invoke("cli_hello", { name: "Replay" });
    const events = await client.events(invokeResult.runRecord.runId);
    const io = createTestIo();
    const cli = createFlowCli({ client, io });

    const result = await cli.run([
      "replay",
      invokeResult.runRecord.runId,
      "--cursor",
      events[0]!.eventId,
      "--limit",
      "2",
    ]);
    const replayed = io.stdoutLines.map((line) => JSON.parse(line));

    expect(result.exitCode).toBe(0);
    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.eventId).not.toBe(events[0]!.eventId);
    expect(replayed.every((event) => event.runId === invokeResult.runRecord.runId)).toBe(true);
  });

  it("cancels an in-flight run through the CLI command runner", async () => {
    const runtime = newRuntime();
    await registerSlow(runtime);
    const client = createFlowSdkClient({ runtime });
    const started = await client.start("cli_cancel", null);
    const io = createTestIo();
    const cli = createFlowCli({ client, io });

    const result = await cli.run([
      "cancel",
      started.runRecord.runId,
      "--reason",
      "test cli cancel",
    ]);
    const completed = await started.completed;
    const payload = JSON.parse(io.stdoutLines[0]!);

    expect(result.exitCode).toBe(0);
    expect(payload.cancelled).toBe(true);
    expect(completed.cancelled).toBe(true);
    const record = await client.getRun(started.runRecord.runId);
    expect(record?.status).toBe("cancelled");
  });
});

