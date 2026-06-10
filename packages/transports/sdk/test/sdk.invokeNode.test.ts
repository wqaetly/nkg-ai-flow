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

