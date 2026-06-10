import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../../runtime/test/helpers/deterministicLlmProvider.js";
import { createFlowSdkClient } from "../src/index.js";

const sdkSlowNode = defineNode({
  type: "sdk_slow_stream",
  typeVersion: "1.0.0",
  title: "SDK Slow Stream",
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
    nodes: [sdkSlowNode],
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
    id: "sdk_hello",
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
    id: "sdk_cancel",
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const slow = flow.node("sdk_slow_stream", {
    id: "slow",
    position: { x: 100, y: 0 },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), slow.in("in"));
  flow.connect(slow.out("out"), end.in("in"));
  await registerAndPromote(runtime, flow);
}

describe("transport-sdk", () => {
  it("invokes a promoted flow through the shared runtime API", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });

    const result = await client.invoke("sdk_hello", { name: "SDK" });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Hello SDK");
    expect(result.runRecord.flowVersion).toBe("1.0.0");
  });

  it("streams normalized NodeEvents from the same event bus", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });

    const events = [];
    for await (const event of client.stream("sdk_hello", { name: "Stream" })) {
      events.push(event);
    }

    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
    expect(events.map((event) => event.kind)).toContain("node_finished");
    expect(events.every((event) => event.eventId.length > 0)).toBe(true);
  });

  it("resumes event reads after a cursor", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });

    const result = await client.invoke("sdk_hello", { name: "Cursor" });
    const allEvents = await client.events(result.runRecord.runId);
    const cursor = allEvents[0]!.eventId;
    const resumed = [];
    for await (const event of client.watchRunEvents(result.runRecord.runId, {
      cursor,
    })) {
      resumed.push(event);
    }

    expect(resumed.find((event) => event.eventId === cursor)).toBeUndefined();
    expect(resumed[resumed.length - 1]?.kind).toBe("run_finished");
    expect(resumed.length).toBe(allEvents.length - 1);
  });

  it("replays persisted events with cursor and limit options", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const client = createFlowSdkClient({ runtime });

    const result = await client.invoke("sdk_hello", { name: "Replay" });
    const allEvents = await client.events(result.runRecord.runId);
    const replayed = await client.replayRun(result.runRecord.runId, {
      cursor: allEvents[0]!.eventId,
      limit: 2,
    });

    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.eventId).not.toBe(allEvents[0]!.eventId);
    expect(replayed[0]?.runId).toBe(result.runRecord.runId);
  });

  it("cancels an in-flight run through the public SDK client", async () => {
    const runtime = newRuntime();
    await registerSlow(runtime);
    const client = createFlowSdkClient({ runtime });

    const started = await client.start("sdk_cancel", null);
    const observed = [];
    for await (const event of started.events()) {
      observed.push(event);
      if (event.kind === "stream_delta") {
        await started.cancel("test requested cancellation");
      }
    }
    const result = await started.completed;

    expect(result.cancelled).toBe(true);
    expect(observed[observed.length - 1]?.kind).toBe("run_cancelled");
    const record = await client.getRun(started.runRecord.runId);
    expect(record?.status).toBe("cancelled");
  });
});

