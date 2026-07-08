/**
 * Runtime tests covering the v5 layer end-to-end against in-memory
 * stores. Each test wires `createRuntime` with an isolated set of stores
 * and a deterministic test LLM provider so no external service is needed.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import {
  createRuntime,
  type CreateRuntimeOptions,
  type LlmProvider,
  type Runtime,
} from "../src/index.js";
import { DeterministicLlmProvider } from "./helpers/deterministicLlmProvider.js";

/**
 * Build a fresh in-memory runtime for each test. Each call gets isolated
 * stores so tests cannot leak state into each other.
 */
function newRuntime(opts?: {
  llmProvider?: DeterministicLlmProvider;
  variables?: InMemoryVariableStore;
  secrets?: InMemorySecretStore;
  nodes?: CreateRuntimeOptions["nodes"];
}): Runtime {
  const variables = opts?.variables ?? new InMemoryVariableStore();
  const secrets = opts?.secrets ?? new InMemorySecretStore();
  const llmProvider = opts?.llmProvider ?? new DeterministicLlmProvider();
  return createRuntime({
    variables,
    secrets,
    llmProvider,
    nodes: opts?.nodes,
  });
}

async function registerAndPromote(rt: Runtime, flow: ReturnType<typeof defineFlow>) {
  const json = flow.dump();
  const graph = JSON.parse(json);
  await rt.registry.register({ graph, json, status: "staging" });
  await rt.registry.promote(graph.id, graph.version);
  return graph;
}

/* -------------------------------------------------------------------------- */
/* hello-flow end-to-end                                                       */
/* -------------------------------------------------------------------------- */

describe("runtime / hello-flow end-to-end", () => {
  it("runs start -> transform -> end and returns a templated message", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "hello_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", {
      id: "node_start_01",
      position: { x: 0, y: 0 },
    });
    const greet = flow.node("transform", {
      id: "node_greet_01",
      position: { x: 100, y: 0 },
      config: { template: "Hello, ${input.name}" },
    });
    const end = flow.node("end", {
      id: "node_end_01",
      position: { x: 200, y: 0 },
    });
    flow.connect(start.out("out"), greet.in("in"));
    flow.connect(greet.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "hello_e2e",
      input: { name: "Node" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.runRecord.status).toBe("succeeded");
    expect(result.output).toBe("Hello, Node");
  });

  it("waits in a delay node before continuing the flow", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "delay_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const delay = flow.node("delay", {
      id: "wait",
      position: { x: 100, y: 0 },
      config: { durationMs: 1 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 200, y: 0 },
      config: { template: "done" },
    });
    const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
    flow.connect(start.out("out"), delay.in("in"));
    flow.connect(delay.out("out"), report.in("in"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "delay_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("done");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const delayFinished = events.find(
      (event) => event.kind === "node_finished" && (event as { nodeId?: string }).nodeId === "wait",
    );
    expect(delayFinished).toBeDefined();
  });

  it("joins fan-out branches and collects their values", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "join_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 120, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 120, y: 200 },
      config: { template: "lower:${input.name}" },
    });
    const join = flow.node("join", { id: "join", position: { x: 280, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 120 },
      config: { template: "joined=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 560, y: 120 } });

    flow.connect(start.out("out"), upper.in("in"));
    flow.connect(start.out("out"), lower.in("in"));
    flow.connect(upper.out("out"), join.in("in"));
    flow.connect(lower.out("out"), join.in("in"));
    flow.connect(upper.out("output"), join.in("values"));
    flow.connect(lower.out("output"), join.in("values"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "join_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("joined=upper:Flow,lower:Flow");
  });

  it("fans out through parallel branches and rejoins selected branches", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "parallel_join_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 120, y: 120 },
      config: { branchCount: 2 },
    });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 280, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 280, y: 200 },
      config: { template: "lower:${input.name}" },
    });
    const join = flow.node("join", { id: "join", position: { x: 440, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 580, y: 120 },
      config: { template: "parallel=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 720, y: 120 } });

    flow.connect(start.out("out"), fanout.in("in"));
    flow.connect(fanout.out("branch1"), upper.in("in"));
    flow.connect(fanout.out("branch2"), lower.in("in"));
    flow.connect(upper.out("out"), join.in("in"));
    flow.connect(lower.out("out"), join.in("in"));
    flow.connect(upper.out("output"), join.in("values"));
    flow.connect(lower.out("output"), join.in("values"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "parallel_join_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parallel=upper:Flow,lower:Flow");
  });

  it("filters array items with filter_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "filter_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: ["keep", "drop", "keep"] },
    });
    const filter = flow.node("filter_items", {
      id: "filter",
      position: { x: 260, y: 0 },
      config: { condition: "item == \"keep\"" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "kept=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), filter.in("in"));
    flow.connect(input.out("output"), filter.in("items"));
    flow.connect(filter.out("out"), report.in("in"));
    flow.connect(filter.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "filter_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("kept=keep,keep");
  });

  it("maps array items with map_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "map_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: ["alpha", "beta", "gamma"] },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 260, y: 0 },
      config: { template: "${index}:${item}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "mapped=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), map.in("in"));
    flow.connect(input.out("output"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "map_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("mapped=0:alpha,1:beta,2:gamma");
  });

  it("reduces array items with reduce_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "reduce_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: [{ amount: 2 }, { amount: "3" }, { amount: 5 }] },
    });
    const reduce = flow.node("reduce_items", {
      id: "reduce",
      position: { x: 260, y: 0 },
      config: { mode: "sum", path: "amount" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "sum=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), reduce.in("in"));
    flow.connect(input.out("output"), reduce.in("items"));
    flow.connect(reduce.out("out"), report.in("in"));
    flow.connect(reduce.out("result"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "reduce_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("sum=10");
  });

  it("executes every item in a foreach begin/end block", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_block_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta", "gamma"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
      config: { mode: "sequential", concurrency: 1, batchSize: 1 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 300, y: 0 },
      config: { template: "item=${input}" },
    });
    const end = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 400, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 0 },
      config: { template: "results=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(begin.out("item"), body.in("input"));
    flow.connect(body.out("out"), end.in("body_done"));
    flow.connect(body.out("output"), end.in("result"));
    flow.connect(end.out("done"), report.in("in"));
    flow.connect(end.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_block_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=item=alpha,item=beta,item=gamma");
  });

  it("stops a foreach block when loop_break runs inside the body", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_break_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta", "gamma"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
      config: { mode: "sequential", concurrency: 1, batchSize: 1 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 300, y: 0 },
      config: { template: "item=${input}" },
    });
    const shouldBreak = flow.node("condition", {
      id: "should_break",
      position: { x: 400, y: 0 },
      config: { expression: "input == \"item=beta\"" },
    });
    const breaker = flow.node("loop_break", {
      id: "break",
      position: { x: 500, y: -80 },
    });
    const end = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 500, y: 80 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 0 },
      config: { template: "results=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 700, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(begin.out("item"), body.in("input"));
    flow.connect(body.out("out"), shouldBreak.in("in"));
    flow.connect(shouldBreak.out("true"), breaker.in("in"));
    flow.connect(shouldBreak.out("false"), end.in("body_done"));
    flow.connect(body.out("output"), end.in("result"));
    flow.connect(end.out("done"), report.in("in"));
    flow.connect(end.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_break_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=item=alpha,item=beta");
  });

  it("skips the current foreach item when loop_continue runs inside the body", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_continue_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta", "gamma"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
      config: { mode: "sequential", concurrency: 1, batchSize: 1 },
    });
    const shouldSkip = flow.node("condition", {
      id: "should_skip",
      position: { x: 300, y: 0 },
      config: { expression: "input == \"beta\"" },
    });
    const continuer = flow.node("loop_continue", {
      id: "continue",
      position: { x: 400, y: -80 },
    });
    const emit = flow.node("transform", {
      id: "emit",
      position: { x: 400, y: 80 },
      config: { template: "item=${input}" },
    });
    const end = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 500, y: 80 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 0 },
      config: { template: "results=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 700, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), shouldSkip.in("in"));
    flow.connect(shouldSkip.out("true"), continuer.in("in"));
    flow.connect(shouldSkip.out("false"), emit.in("in"));
    flow.connect(begin.out("item"), emit.in("input"));
    flow.connect(emit.out("out"), end.in("body_done"));
    flow.connect(emit.out("output"), end.in("result"));
    flow.connect(end.out("done"), report.in("in"));
    flow.connect(end.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_continue_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=item=alpha,item=gamma");
  });

  it("aggregates inbound values for data input ports marked multiple", async () => {
    const captureNode = defineNode({
      type: "capture_multiple",
      typeVersion: "1.0.0",
      title: "Capture Multiple",
      ports: [
        { id: "request", direction: "input", kind: "data", label: "Request", multiple: true },
        { id: "result", direction: "output", kind: "data", label: "Result" },
      ],
      validateInput: false,
      run({ input }) {
        return {
          kind: "success",
          outputs: { out: null, result: (input as Record<string, unknown>).request },
        };
      },
    });
    const rt = newRuntime({ nodes: [captureNode] });
    const flow = defineFlow({ id: "multiple_input_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    start.addPort({ id: "runInput", direction: "output", kind: "data", label: "Run Input" });
    const text = flow.node("text_input", {
      id: "input",
      position: { x: 100, y: 0 },
      config: { value: "canvas text" },
    });
    const capture = flow.node("capture_multiple", { id: "capture", position: { x: 200, y: 0 } });
    const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
    flow.connect(start.out("out"), text.in("in"));
    flow.connect(text.out("out"), capture.in("in"));
    flow.connect(capture.out("out"), end.in("in"));
    flow.connect(start.out("runInput"), capture.in("request"));
    flow.connect(text.out("text"), capture.in("request"));

    await registerAndPromote(rt, flow);
    const result = await rt.invocationRouter.invoke({
      flowId: "multiple_input_e2e",
      input: { query: "run input" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual([{ query: "run input" }, "canvas text"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Variable access through ctx                                                 */
/* -------------------------------------------------------------------------- */

describe("runtime / variables visible to nodes", () => {
  it("llm node reads model and key from variables via ctx", async () => {
    const variables = new InMemoryVariableStore([
      { name: "LLM_DEFAULT_MODEL", value: "deepseek-v4-pro" },
    ]);
    const secrets = new InMemorySecretStore([
      { name: "LLM_API_KEY", value: "sk-test" },
    ]);
    let observedModel: string | undefined;
    let observedKeyVisibility = "";
    // Spy by wrapping
    const wrapped: LlmProvider = {
      complete: async (req, ctx) => {
        observedModel = req.model;
        const key = ctx.variables.getString("LLM_API_KEY");
        observedKeyVisibility = String(key);
        expect(ctx.secrets.getString("LLM_API_KEY")).toBe("sk-test");
        return { text: "ok" };
      },
    };

    const rt = createRuntime({
      variables,
      secrets,
      llmProvider: wrapped,
    });

    const flow = defineFlow({ id: "llm_test", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "node_start_01", position: { x: 0, y: 0 } });
    const llm = flow.node("llm", {
      id: "node_llm_01",
      position: { x: 100, y: 0 },
      config: { prompt: "Say hi to ${input.name}" },
    });
    const end = flow.node("end", { id: "node_end_01", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), llm.in("in"));
    flow.connect(llm.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);
    const result = await rt.invocationRouter.invoke({
      flowId: "llm_test",
      input: { name: "world" },
    });

    expect(result.succeeded).toBe(true);
    expect(observedModel).toBe("deepseek-v4-pro");
    expect(observedKeyVisibility).toBe("sk-test");
  });

  it("$var and $secret references in node config get resolved", async () => {
    const variables = new InMemoryVariableStore([
      { name: "GREETING_PREFIX", value: "Bonjour" },
    ]);
    const secrets = new InMemorySecretStore();
    const rt = newRuntime({ variables, secrets });

    const flow = defineFlow({ id: "ref_test", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "node_start_01", position: { x: 0, y: 0 } });
    // We embed a $var ref inside config.value; the transform runner will
    // emit the resolved value verbatim.
    const t = flow.node("transform", {
      id: "node_t_01",
      position: { x: 100, y: 0 },
      config: { value: { $var: "GREETING_PREFIX" } },
    });
    const end = flow.node("end", { id: "node_end_01", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), t.in("in"));
    flow.connect(t.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);
    const result = await rt.invocationRouter.invoke({
      flowId: "ref_test",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("Bonjour");
  });

  it("$var node config references read the current variable value on each run", async () => {
    const variables = new InMemoryVariableStore([
      { name: "GREETING_PREFIX", value: "Bonjour" },
    ]);
    const secrets = new InMemorySecretStore();
    const rt = newRuntime({ variables, secrets });

    const flow = defineFlow({ id: "live_ref_test", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "node_start_01", position: { x: 0, y: 0 } });
    const t = flow.node("transform", {
      id: "node_t_01",
      position: { x: 100, y: 0 },
      config: { value: { $var: "GREETING_PREFIX" } },
    });
    const end = flow.node("end", { id: "node_end_01", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), t.in("in"));
    flow.connect(t.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const first = await rt.invocationRouter.invoke({
      flowId: "live_ref_test",
      input: null,
    });
    variables.set("GREETING_PREFIX", "Hola");
    const second = await rt.invocationRouter.invoke({
      flowId: "live_ref_test",
      input: null,
    });

    expect(first.succeeded).toBe(true);
    expect(first.output).toBe("Bonjour");
    expect(second.succeeded).toBe(true);
    expect(second.output).toBe("Hola");
  });
});

/* -------------------------------------------------------------------------- */
/* Run lifecycle: input validation, error path, version pinning                */
/* -------------------------------------------------------------------------- */

describe("runtime / lifecycle", () => {
  it("rejects pre-run input that violates inputSchema without creating a Run", async () => {
    const flow = defineFlow({
      id: "schema_test",
      version: "1.0.0",
      inputSchema: { type: "object", required: ["name"] },
    });
    const start = flow.node("start", { id: "node_start_01", position: { x: 0, y: 0 } });
    const end = flow.node("end", { id: "node_end_01", position: { x: 100, y: 0 } });
    flow.connect(start.out("out"), end.in("in"));

    const rt = newRuntime();
    await registerAndPromote(rt, flow);

    let captured: unknown = null;
    try {
      await rt.invocationRouter.invoke({ flowId: "schema_test", input: {} });
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    expect(String(captured)).toContain("missing required input field");
    // No Run should have been recorded.
    expect(await rt.runStore.listByFlow("schema_test")).toHaveLength(0);
  });

  it("pins the Flow Version at Run creation; Registry promotion does not change it", async () => {
    const flow1 = defineFlow({ id: "pin_test", version: "1.0.0" });
    flow1.connect(
      flow1.node("start", { id: "s", position: { x: 0, y: 0 } }).out("out"),
      flow1.node("end", { id: "e", position: { x: 100, y: 0 } }).in("in"),
    );

    const flow2 = defineFlow({ id: "pin_test", version: "2.0.0" });
    flow2.connect(
      flow2.node("start", { id: "s", position: { x: 0, y: 0 } }).out("out"),
      flow2.node("end", { id: "e", position: { x: 100, y: 0 } }).in("in"),
    );

    const rt = newRuntime();
    await registerAndPromote(rt, flow1);

    const r1 = await rt.invocationRouter.invoke({ flowId: "pin_test", input: null });
    expect(r1.runRecord.flowVersion).toBe("1.0.0");

    // Register & promote v2; v1 was previously active.
    await rt.registry.register({
      graph: JSON.parse(flow2.dump()),
      json: flow2.dump(),
      status: "staging",
    });
    await rt.registry.promote("pin_test", "2.0.0");

    const r2 = await rt.invocationRouter.invoke({ flowId: "pin_test", input: null });
    expect(r2.runRecord.flowVersion).toBe("2.0.0");

    // r1's record stays pinned to 1.0.0 even though v2 is now active.
    const r1Record = await rt.runStore.get(r1.runRecord.runId);
    expect(r1Record?.flowVersion).toBe("1.0.0");
  });

  it("propagates node errors as run_failed when no error edge is wired", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "err_test", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    // http node with no url -> emits node.http.missing_url error.
    const http = flow.node("http", { id: "h", position: { x: 100, y: 0 }, config: {} });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), http.in("in"));
    flow.connect(http.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);
    const result = await rt.invocationRouter.invoke({
      flowId: "err_test",
      input: null,
    });
    expect(result.succeeded).toBe(false);
    expect(result.runRecord.status).toBe("failed");
    expect(result.error?.code).toBe("node.http.missing_url");
  });
});

/* -------------------------------------------------------------------------- */
/* Event bus: events are persisted and orderable by cursor                     */
/* -------------------------------------------------------------------------- */

describe("runtime / event store cursor", () => {
  it("persists run lifecycle and node lifecycle events with monotonic ids", async () => {
    const flow = defineFlow({ id: "evt_test", version: "1.0.0" });
    flow.connect(
      flow.node("start", { id: "s", position: { x: 0, y: 0 } }).out("out"),
      flow.node("end", { id: "e", position: { x: 100, y: 0 } }).in("in"),
    );
    const rt = newRuntime();
    await registerAndPromote(rt, flow);
    const result = await rt.invocationRouter.invoke({ flowId: "evt_test", input: null });
    const events = await rt.eventBus.store.read(result.runRecord.runId);

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("run_started");
    expect(kinds).toContain("node_started");
    expect(kinds).toContain("node_finished");
    expect(kinds[kinds.length - 1]).toBe("run_finished");

    // Event ids are unique and lexicographically increasing.
    const ids = events.map((e) => e.eventId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime string events                                                       */
/* -------------------------------------------------------------------------- */

describe("runtime / string event triggers", () => {
  it("runs active event-trigger flows when send_event publishes a matching string", async () => {
    const rt = newRuntime();

    const receiver = defineFlow({
      id: "event_receiver",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const trigger = receiver.node("event_trigger", {
      id: "trigger_order_created",
      position: { x: 0, y: 0 },
      config: { event: "order.created" },
    });
    const capture = receiver.node("transform", {
      id: "capture_event",
      position: { x: 100, y: 0 },
      config: { template: "received:${input}" },
    });
    const receiverEnd = receiver.node("end", {
      id: "receiver_end",
      position: { x: 200, y: 0 },
    });
    receiver.connect(trigger.out("out"), capture.in("in"));
    receiver.connect(trigger.out("event"), capture.in("input"));
    receiver.connect(capture.out("out"), receiverEnd.in("in"));

    const sender = defineFlow({
      id: "event_sender",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = sender.node("start", {
      id: "sender_start",
      position: { x: 0, y: 0 },
    });
    const send = sender.node("send_event", {
      id: "send_order_created",
      position: { x: 100, y: 0 },
      config: { event: "order.created" },
    });
    const senderEnd = sender.node("end", {
      id: "sender_end",
      position: { x: 200, y: 0 },
    });
    sender.connect(start.out("out"), send.in("in"));
    sender.connect(send.out("out"), senderEnd.in("in"));

    await registerAndPromote(rt, receiver);
    await registerAndPromote(rt, sender);

    const senderResult = await rt.invocationRouter.invoke({
      flowId: "event_sender",
      input: null,
    });

    expect(senderResult.succeeded).toBe(true);
    const receiverRuns = await rt.runStore.listByFlow("event_receiver");
    expect(receiverRuns).toHaveLength(1);
    expect(receiverRuns[0]?.status).toBe("succeeded");
    expect(receiverRuns[0]?.input).toBe("order.created");
    expect(receiverRuns[0]?.output).toBe("received:order.created");
  });

  it("does not treat event_trigger as an ordinary manual-invoke seed", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "trigger_only",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const trigger = flow.node("event_trigger", {
      id: "trigger_ping",
      position: { x: 0, y: 0 },
      config: { event: "ping" },
    });
    const end = flow.node("end", {
      id: "trigger_end",
      position: { x: 100, y: 0 },
    });
    flow.connect(trigger.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const manual = await rt.invocationRouter.invoke({
      flowId: "trigger_only",
      input: null,
    });
    const triggered = await rt.invocationRouter.triggerEvent({ event: "ping" });

    expect(manual.succeeded).toBe(false);
    expect(manual.error?.code).toBe("execution_engine.no_start_node");
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.succeeded).toBe(true);
    expect(triggered[0]?.output).toBe("ping");
  });
});

/* -------------------------------------------------------------------------- */
/* Fan-out with multiple `end` nodes: every reachable branch must complete     */
/* before run_finished — see runtime-execution.md §5.6.                        */
/* -------------------------------------------------------------------------- */

describe("runtime / fan-out with multiple end nodes", () => {
  it("runs every parallel branch to its own end before publishing run_finished", async () => {
    // start ──▶ upper ──▶ end_upper
    //       └─▶ lower ──▶ end_lower
    const rt = newRuntime();
    const flow = defineFlow({ id: "fan_out_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "node_start", position: { x: 0, y: 200 } });
    const upper = flow.node("transform", {
      id: "node_upper",
      position: { x: 100, y: 80 },
      config: { template: "UP:${input.text}" },
    });
    const lower = flow.node("transform", {
      id: "node_lower",
      position: { x: 100, y: 320 },
      config: { template: "LO:${input.text}" },
    });
    const endUpper = flow.node("end", { id: "node_end_upper", position: { x: 200, y: 80 } });
    const endLower = flow.node("end", { id: "node_end_lower", position: { x: 200, y: 320 } });
    flow.connect(start.out("out"), upper.in("in"));
    flow.connect(start.out("out"), lower.in("in"));
    flow.connect(upper.out("out"), endUpper.in("in"));
    flow.connect(lower.out("out"), endLower.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fan_out_e2e",
      input: { text: "Hi" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.runRecord.status).toBe("succeeded");

    // Both `end` nodes must have emitted node_finished events. The
    // pre-fix bug would `break` after the first end and silently drop
    // the sibling branch — `node_end_lower` would be missing here.
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const finishedNodes = events
      .filter((e) => e.kind === "node_finished")
      .map((e) => (e as { nodeId?: string }).nodeId);
    expect(finishedNodes).toContain("node_end_upper");
    expect(finishedNodes).toContain("node_end_lower");

    // run_finished must come *after* both end nodes, not interleaved.
    const lastIdx = events.length - 1;
    expect(events[lastIdx]?.kind).toBe("run_finished");
    const lastEndUpperIdx = events.findLastIndex(
      (e) => e.kind === "node_finished" && (e as { nodeId?: string }).nodeId === "node_end_upper",
    );
    const lastEndLowerIdx = events.findLastIndex(
      (e) => e.kind === "node_finished" && (e as { nodeId?: string }).nodeId === "node_end_lower",
    );
    expect(lastEndUpperIdx).toBeLessThan(lastIdx);
    expect(lastEndLowerIdx).toBeLessThan(lastIdx);
  });
});
