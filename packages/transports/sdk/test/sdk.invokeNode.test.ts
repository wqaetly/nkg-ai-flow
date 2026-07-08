/**
 * Step 4 \u2014 transport-sdk sub-graph (sink-node) tests.
 *
 * Verifies that `FlowSdkClient.invokeNode` / `startNode` / `streamNode`
 * delegate to `runtime.invocationRouter.{invokeNode, startNode}` and
 * surface the same semantics as the underlying runtime: schema bypass,
 * RunRecord pinned to original flow, terminal-event handling.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
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

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
}

async function registerSubGraph(
  rt: Runtime,
  id = "sdk_subgraph",
): Promise<void> {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
    inputSchema: { type: "object", required: ["name"] },
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const upper = flow.node("transform", {
    id: "upper",
    position: { x: 100, y: 0 },
    config: { template: "Hi ${input.name}" },
  });
  const tail = flow.node("transform", {
    id: "tail",
    position: { x: 200, y: 0 },
    config: { template: "${input}!" },
  });
  const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
  flow.connect(start.out("out"), upper.in("in"));
  flow.connect(upper.out("out"), tail.in("in"));
  flow.connect(tail.out("out"), end.in("in"));
  const json = flow.dump();
  await rt.registry.register({
    graph: JSON.parse(json),
    json,
    status: "staging",
  });
  await rt.registry.promote(id, "1.0.0");
}

async function registerResumeFlow(rt: Runtime, id = "sdk_resume_point"): Promise<void> {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
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
  const json = flow.dump();
  await rt.registry.register({
    graph: JSON.parse(json),
    json,
    status: "staging",
  });
  await rt.registry.promote(id, "1.0.0");
}

describe("transport-sdk / invokeNode", () => {
  it("returns the sink output and pins the run to the original flow", async () => {
    const rt = newRuntime();
    await registerSubGraph(rt, "sdk_invoke_node");
    const client = createFlowSdkClient({ runtime: rt });

    const result = await client.invokeNode("sdk_invoke_node", "upper", {
      name: "Node",
    });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Hi Node");
    expect(result.runRecord.flowId).toBe("sdk_invoke_node");
    expect(result.runRecord.flowVersion).toBe("1.0.0");
  });

  it("bypasses the flow inputSchema in sub-graph mode", async () => {
    const rt = newRuntime();
    await registerSubGraph(rt, "sdk_invoke_node_bypass");
    const client = createFlowSdkClient({ runtime: rt });

    // No `name` \u2014 a full `invoke` would throw.
    const result = await client.invokeNode(
      "sdk_invoke_node_bypass",
      "upper",
      {},
    );
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Hi ");
  });
});

describe("transport-sdk / streamNode", () => {
  it("yields run lifecycle events terminating with run_finished", async () => {
    const rt = newRuntime();
    await registerSubGraph(rt, "sdk_stream_node");
    const client = createFlowSdkClient({ runtime: rt });

    const kinds: string[] = [];
    for await (const event of client.streamNode(
      "sdk_stream_node",
      "upper",
      { name: "Node" },
    )) {
      kinds.push(event.kind);
    }
    expect(kinds[0]).toBe("run_started");
    expect(kinds).toContain("node_started");
    expect(kinds).toContain("node_finished");
    expect(kinds[kinds.length - 1]).toBe("run_finished");
  });
});

describe("transport-sdk / startNode", () => {
  it("returns runRecord synchronously and resolves completed afterwards", async () => {
    const rt = newRuntime();
    await registerSubGraph(rt, "sdk_start_node");
    const client = createFlowSdkClient({ runtime: rt });

    const started = await client.startNode("sdk_start_node", "upper", {
      name: "Node",
    });
    expect(started.runRecord.runId).toMatch(/^run_/);
    const result = await started.completed;
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Hi Node");
  });
});

describe("transport-sdk / resumeFromPoint", () => {
  it("delegates resume-point execution to the runtime", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const now = Date.now();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "recover",
      snapshot: { orderId: "order-1" },
      reason: "manual resume",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
    await registerResumeFlow(rt, "sdk_resume_point");
    const client = createFlowSdkClient({ runtime: rt });

    const result = await client.resumeFromPoint(
      "sdk_resume_point",
      "ORDER_RESUME_POINT",
    );

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("recover:order-1");
    expect(result.runRecord.input).toEqual({ orderId: "order-1" });
  });

  it("streams resume-point events through the SDK iterator", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const now = Date.now();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "recover",
      snapshot: { orderId: "order-2" },
      reason: "stream resume",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
    await registerResumeFlow(rt, "sdk_stream_resume_point");
    const client = createFlowSdkClient({ runtime: rt });

    const kinds: string[] = [];
    for await (const event of client.streamFromPoint(
      "sdk_stream_resume_point",
      "ORDER_RESUME_POINT",
    )) {
      kinds.push(event.kind);
    }

    expect(kinds[0]).toBe("run_started");
    expect(kinds).toContain("node_started");
    expect(kinds[kinds.length - 1]).toBe("run_finished");
  });
});

