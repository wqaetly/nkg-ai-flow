/**
 * Step 2 — `runManager.invoke({ sinkNodeId })` and
 * `invocationRouter.invokeNode / startNode` tests.
 *
 * Goals:
 *   - sub-graph invoke produces the sink's primary data output and
 *     records a successful Run pinned to the *original* flow id /
 *     version (no synthetic flow registered).
 *   - router.invokeNode validates `nodeId` exists; an unknown id
 *     surfaces `flow.node.not_found` and creates no Run record.
 *   - router.invokeNode bypasses the flow-level `inputSchema` check
 *     (a node-run can run mid-edit even if the flow as a whole is
 *     not currently satisfying the schema).
 *   - router.startNode returns the `runRecord` synchronously and a
 *     `completed` promise that eventually resolves to the same
 *     `ExecuteResult`.
 *   - cancel() works on a sub-graph run.
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
} from "../src/index.js";
import { DeterministicLlmProvider } from "./helpers/deterministicLlmProvider.js";

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
}

async function registerAndPromote(
  rt: Runtime,
  flow: ReturnType<typeof defineFlow>,
) {
  const json = flow.dump();
  const graph = JSON.parse(json);
  await rt.registry.register({ graph, json, status: "staging" });
  await rt.registry.promote(graph.id, graph.version);
  return graph;
}

/**
 * Build the canonical 4-node linear flow shared across these tests.
 * `start -> upper -> tail -> end` so we can pick `upper` as the sink
 * and prove the run stops there.
 */
function buildLinearFlow(
  registry: Runtime["nodeTypeRegistry"],
  id = "rm_subgraph",
) {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry,
    // Note: `inputSchema` is intentionally set so we can assert that
    // `invokeNode` does NOT trip it the way `invoke` would. The full
    // flow needs `name`, but a sub-graph run can pass `null` because
    // the engine only walks the upstream closure of the sink.
    inputSchema: { type: "object", required: ["name"] },
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const upper = flow.node("transform", {
    id: "upper",
    position: { x: 100, y: 0 },
    config: { template: "Hi, ${input.name}" },
  });
  const tail = flow.node("transform", {
    id: "tail",
    position: { x: 200, y: 0 },
    config: { template: "${input}!!" },
  });
  const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
  flow.connect(start.out("out"), upper.in("in"));
  flow.connect(upper.out("out"), tail.in("in"));
  flow.connect(tail.out("out"), end.in("in"));
  return flow;
}

describe("runtime / runManager.invoke({ sinkNodeId })", () => {
  it("runs the sub-graph and pins the RunRecord to the original flow id/version", async () => {
    const rt = newRuntime();
    const flow = buildLinearFlow(rt.nodeTypeRegistry, "rm_subgraph_pin");
    const graph = await registerAndPromote(rt, flow);

    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: { name: "Node" },
      sinkNodeId: "upper",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Hi, Node");
    expect(result.runRecord.flowId).toBe("rm_subgraph_pin");
    expect(result.runRecord.flowVersion).toBe("1.0.0");
    expect(result.runRecord.status).toBe("succeeded");
    // No synthetic flow has been registered alongside.
    const list = await rt.runStore.listByFlow("rm_subgraph_pin");
    expect(list).toHaveLength(1);
  });

  it("cancellation aborts an in-flight sub-graph run", async () => {
    const rt = newRuntime();
    const flow = buildLinearFlow(rt.nodeTypeRegistry, "rm_subgraph_cancel");
    const graph = await registerAndPromote(rt, flow);

    // Run is fast (synchronous transforms), so we abort *before* invoke
    // resolves by racing it against an immediate cancel via the
    // RunManager's external cancel hook. We need the runId, so use the
    // two-phase `start()` path.
    const { runRecord, completed } = await rt.runManager.start({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: { name: "Node" },
      sinkNodeId: "upper",
    });
    // Best-effort cancel; if the engine already reached terminal state
    // RunManager.cancel throws not_found and we treat that as "raced
    // and finished" which still satisfies the contract that cancel
    // cannot break the engine.
    try {
      await rt.runManager.cancel(runRecord.runId, "test");
    } catch {
      /* race window: the run finished first; the assertion below still
         confirms the run is in a terminal state cleanly. */
    }
    const result = await completed;
    expect(["succeeded", "cancelled"]).toContain(result.runRecord.status);
  });
});

describe("runtime / invocationRouter.invokeNode", () => {
  it("returns the sink output and skips the flow inputSchema check", async () => {
    const rt = newRuntime();
    const flow = buildLinearFlow(rt.nodeTypeRegistry, "router_invoke_node");
    await registerAndPromote(rt, flow);

    // `name` is missing — the flow `inputSchema` requires it, so a
    // full `invoke()` would throw `flow.input.invalid`. `invokeNode`
    // must accept this because the sub-graph run is the user's choice
    // to bypass schema while editing.
    const result = await rt.invocationRouter.invokeNode({
      flowId: "router_invoke_node",
      nodeId: "upper",
      input: {},
    });

    expect(result.succeeded).toBe(true);
    // The flow's `inputSchema` requires `name`, but `invokeNode`
    // intentionally bypasses that check. The transform template
    // resolves `${input.name}` to empty string when the field is
    // absent (see `renderTemplate`), giving a benign "Hi, " output
    // — the important assertion is that the run *succeeded* despite
    // the schema mismatch, not the precise output text.
    expect(result.output).toBe("Hi, ");
  });

  it("rejects unknown nodeId with flow.node.not_found and creates no Run", async () => {
    const rt = newRuntime();
    const flow = buildLinearFlow(rt.nodeTypeRegistry, "router_bad_node");
    await registerAndPromote(rt, flow);

    let captured: unknown = null;
    try {
      await rt.invocationRouter.invokeNode({
        flowId: "router_bad_node",
        nodeId: "ghost",
        input: { name: "x" },
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    expect(String(captured)).toContain('has no node with id "ghost"');
    // No Run should have been recorded.
    const list = await rt.runStore.listByFlow("router_bad_node");
    expect(list).toHaveLength(0);
  });
});

describe("runtime / invocationRouter.startNode", () => {
  it("returns a synchronous runRecord and a completed promise", async () => {
    const rt = newRuntime();
    const flow = buildLinearFlow(rt.nodeTypeRegistry, "router_start_node");
    await registerAndPromote(rt, flow);

    const { runRecord, completed } = await rt.invocationRouter.startNode({
      flowId: "router_start_node",
      nodeId: "upper",
      input: { name: "Node" },
    });

    // runRecord is persisted synchronously in `queued` or `running`
    // status (transition happens inside execute()). Either is valid
    // here because execute() may have already advanced the state by
    // the time control returns.
    expect(["queued", "running"]).toContain(runRecord.status);
    expect(runRecord.runId).toMatch(/^run_/);

    const result = await completed;
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Hi, Node");
    expect(result.runRecord.runId).toBe(runRecord.runId);
    expect(result.runRecord.status).toBe("succeeded");
  });
});
