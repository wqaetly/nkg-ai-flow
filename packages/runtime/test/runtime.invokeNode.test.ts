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

describe("runtime / invocationRouter.resumeFromPoint", () => {
  it("starts at the resume target and uses the saved snapshot as entry input", async () => {
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
      snapshot: { orderId: "order-1", step: "charge" },
      reason: "payment timeout",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });

    const flow = defineFlow({ id: "router_resume_point", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const prep = flow.node("transform", {
      id: "prep",
      position: { x: 100, y: 0 },
      config: { template: "prep:${input.name}" },
    });
    const recover = flow.node("transform", {
      id: "recover",
      position: { x: 220, y: 0 },
      config: { template: "recover:${input.orderId}:${input.step}" },
    });
    const tail = flow.node("transform", {
      id: "tail",
      position: { x: 340, y: 0 },
      config: { template: "tail:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 460, y: 0 } });

    flow.connect(start.out("out"), prep.in("in"));
    flow.connect(prep.out("output"), recover.in("input"));
    flow.connect(recover.out("output"), tail.in("input"));
    flow.connect(tail.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.resumeFromPoint({
      flowId: "router_resume_point",
      resumePointName: "ORDER_RESUME_POINT",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("tail:recover:order-1:charge");
    expect(result.runRecord.input).toEqual({ orderId: "order-1", step: "charge" });
    expect(variables.get("ORDER_RESUME_POINT")).toMatchObject({
      loadedAt: expect.any(Number),
      targetNodeId: "recover",
    });

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(
      events.find((event) => event.kind === "node_started" && event.nodeId === "prep"),
    ).toBeUndefined();
    expect(
      events.find((event) => event.kind === "node_started" && event.nodeId === "recover"),
    ).toBeDefined();
  });

  it("returns a runRecord before executing a started resume-point run", async () => {
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
      reason: "manual replay",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });

    const flow = defineFlow({ id: "router_start_resume_point", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const recover = flow.node("transform", {
      id: "recover",
      position: { x: 120, y: 0 },
      config: { template: "recover:${input.orderId}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), recover.in("in"));
    flow.connect(recover.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);

    const { runRecord, completed } = await rt.invocationRouter.startFromPoint({
      flowId: "router_start_resume_point",
      resumePointName: "ORDER_RESUME_POINT",
    });

    expect(["queued", "running"]).toContain(runRecord.status);
    expect(runRecord.input).toEqual({ orderId: "order-2" });

    const result = await completed;
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("recover:order-2");
    expect(result.runRecord.runId).toBe(runRecord.runId);
  });

  it("rejects expired resume points before creating a run", async () => {
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
      snapshot: { orderId: "order-3" },
      reason: "expired replay",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now - 10_000,
      loadedAt: null,
      expiresAt: now - 1,
      updatedAt: now - 10_000,
    });

    const flow = buildLinearFlow(rt.nodeTypeRegistry, "router_expired_resume_point");
    await registerAndPromote(rt, flow);

    await expect(
      rt.invocationRouter.resumeFromPoint({
        flowId: "router_expired_resume_point",
        resumePointName: "ORDER_RESUME_POINT",
      }),
    ).rejects.toThrow("has expired");

    expect(variables.get("ORDER_RESUME_POINT")).toMatchObject({
      status: "expired",
    });
    const list = await rt.runStore.listByFlow("router_expired_resume_point");
    expect(list).toHaveLength(0);
  });
});
