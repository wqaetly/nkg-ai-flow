/**
 * Sub-graph execution mode (sink-node mode) tests for ExecutionEngine.
 *
 * These tests exercise the engine directly (not via runManager / router)
 * because sub-graph mode is the runtime primitive that
 * `RunManager.invokeNode` (Step 2) and `POST /flows/:flowId/nodes/:nodeId/invoke`
 * (Step 3) build on top of. Verifying the primitive in isolation makes
 * regressions in the higher layers easier to triage.
 *
 * Scope:
 *   - happy path: a linear `start -> A -> B -> end` flow run with
 *     `sinkNodeId = A` produces A's primary data output and never
 *     invokes B/end.
 *   - upstream closure correctness: a fan-out where the sink only
 *     depends on one branch; the sibling branch is not executed.
 *   - cancellation still terminates the engine cleanly.
 *   - bad sink id surfaces a structured `sink_node_not_found` error.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { InMemoryEventBus } from "@ai-native-flow/event-bus";
import {
  createDefaultRegistry,
  type InMemoryNodeTypeRegistry,
} from "@ai-native-flow/flow-ir";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import { ExecutionEngine } from "../src/executionEngine.js";
import { createBuiltinRunnerRegistry } from "../src/nodes/createBuiltinRunnerRegistry.js";
import { DeterministicLlmProvider } from "./helpers/deterministicLlmProvider.js";

interface Harness {
  runners: ReturnType<typeof createBuiltinRunnerRegistry>;
  nodeTypeRegistry: InMemoryNodeTypeRegistry;
  eventBus: InMemoryEventBus;
  variables: InMemoryVariableStore;
  secrets: InMemorySecretStore;
}

function newHarness(): Harness {
  const nodeTypeRegistry = createDefaultRegistry();
  const runners = createBuiltinRunnerRegistry({
    llmProvider: new DeterministicLlmProvider(),
    nodeTypeRegistry,
  });
  return {
    runners,
    nodeTypeRegistry,
    eventBus: new InMemoryEventBus(),
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
  };
}

function buildLinearFlow(
  registry: InMemoryNodeTypeRegistry,
) {
  // start -> upper -> tail -> end
  const flow = defineFlow({ id: "subgraph_linear", version: "1.0.0", registry });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const upper = flow.node("transform", {
    id: "upper",
    position: { x: 100, y: 0 },
    config: { template: "Hello, ${input.name}" },
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
  return JSON.parse(flow.dump());
}

describe("ExecutionEngine / sub-graph (sink-node) mode", () => {
  it("returns the sink node's output and never executes downstream nodes", async () => {
    const h = newHarness();
    const graph = buildLinearFlow(h.nodeTypeRegistry);
    const engine = new ExecutionEngine({
      graph,
      runId: "run_subgraph_linear",
      flowId: graph.id,
      flowVersion: graph.version,
      runInput: { name: "Node" },
      runners: h.runners,
      variables: h.variables,
      secrets: h.secrets,
      eventBus: h.eventBus,
      sinkNodeId: "upper",
    });

    const result = await engine.run();

    expect(result.succeeded).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.output).toBe("Hello, Node");

    const events = await h.eventBus.store.read("run_subgraph_linear");
    const finishedNodes = events
      .filter((e) => e.kind === "node_finished")
      .map((e) => e.nodeId);
    // start + upper must have run; tail and end must NOT have run.
    expect(finishedNodes).toContain("s");
    expect(finishedNodes).toContain("upper");
    expect(finishedNodes).not.toContain("tail");
    expect(finishedNodes).not.toContain("e");
    // Run should still bracket cleanly with run_started / run_finished.
    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
  });

  it("only walks the upstream closure: sibling branches stay untouched", async () => {
    // start -> a -> sink
    //       -> b -> dead
    // Asking for sinkNodeId = "sink" must skip b and dead entirely.
    const h = newHarness();
    const flow = defineFlow({ id: "subgraph_fanout", version: "1.0.0", registry: h.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const a = flow.node("transform", {
      id: "a",
      position: { x: 100, y: -50 },
      config: { template: "A:${input.tag}" },
    });
    const b = flow.node("transform", {
      id: "b",
      position: { x: 100, y: 50 },
      config: { template: "B:${input.tag}" },
    });
    const sink = flow.node("transform", {
      id: "sink",
      position: { x: 200, y: -50 },
      config: { template: "${input}!" },
    });
    const dead = flow.node("transform", {
      id: "dead",
      position: { x: 200, y: 50 },
      config: { template: "${input}?" },
    });
    const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
    flow.connect(start.out("out"), a.in("in"));
    flow.connect(start.out("out"), b.in("in"));
    flow.connect(a.out("out"), sink.in("in"));
    flow.connect(b.out("out"), dead.in("in"));
    // We deliberately do NOT wire sink/dead into end so the validator
    // accepts a multi-end-less shape; this test does not need an end
    // node because sub-graph mode terminates on the sink.
    void end;

    const graph = JSON.parse(flow.dump());
    const engine = new ExecutionEngine({
      graph,
      runId: "run_subgraph_fanout",
      flowId: graph.id,
      flowVersion: graph.version,
      runInput: { tag: "x" },
      runners: h.runners,
      variables: h.variables,
      secrets: h.secrets,
      eventBus: h.eventBus,
      sinkNodeId: "sink",
    });

    const result = await engine.run();
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("A:x!");

    const finishedNodes = (await h.eventBus.store.read("run_subgraph_fanout"))
      .filter((e) => e.kind === "node_finished")
      .map((e) => e.nodeId);
    expect(finishedNodes).toContain("s");
    expect(finishedNodes).toContain("a");
    expect(finishedNodes).toContain("sink");
    // The sibling branch must be entirely absent.
    expect(finishedNodes).not.toContain("b");
    expect(finishedNodes).not.toContain("dead");
  });

  it("rejects an unknown sink node id with sink_node_not_found", async () => {
    const h = newHarness();
    const graph = buildLinearFlow(h.nodeTypeRegistry);    expect(
      () =>
        new ExecutionEngine({
          graph,
          runId: "run_subgraph_bad_sink",
          flowId: graph.id,
          flowVersion: graph.version,
          runInput: null,
          runners: h.runners,
          variables: h.variables,
          secrets: h.secrets,
          eventBus: h.eventBus,
          sinkNodeId: "does_not_exist",
        }),
    ).toThrow(/sink node "does_not_exist" is not in flow/);
  });

  it("honours external cancellation in sub-graph mode", async () => {
    const h = newHarness();
    const graph = buildLinearFlow(h.nodeTypeRegistry);
    const controller = new AbortController();
    // Abort before run() so the very first scheduling tick observes it.
    controller.abort();

    const engine = new ExecutionEngine({
      graph,
      runId: "run_subgraph_cancel",
      flowId: graph.id,
      flowVersion: graph.version,
      runInput: { name: "Node" },
      runners: h.runners,
      variables: h.variables,
      secrets: h.secrets,
      eventBus: h.eventBus,
      sinkNodeId: "upper",
      signal: controller.signal,
    });

    const result = await engine.run();
    expect(result.cancelled).toBe(true);
    expect(result.succeeded).toBe(false);
    const events = await h.eventBus.store.read("run_subgraph_cancel");
    expect(events[events.length - 1]?.kind).toBe("run_cancelled");
  });
});
