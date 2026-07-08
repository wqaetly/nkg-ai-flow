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

  it("routes deadline to on_time before the deadline", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "deadline_on_time_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const deadline = flow.node("deadline", {
      id: "deadline",
      position: { x: 120, y: 0 },
      config: { deadlineAt: String(Date.now() + 60_000) },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "deadline:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), deadline.in("in"));
    flow.connect(deadline.out("on_time"), report.in("in"));
    flow.connect(deadline.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "deadline_on_time_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("deadline:on_time");
  });

  it("routes deadline to overdue after the deadline", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "deadline_overdue_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const deadline = flow.node("deadline", {
      id: "deadline",
      position: { x: 120, y: 0 },
      config: { deadlineAt: String(Date.now() - 1000) },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "deadline:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), deadline.in("in"));
    flow.connect(deadline.out("overdue"), report.in("in"));
    flow.connect(deadline.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "deadline_overdue_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("deadline:overdue");
  });

  it("routes schedule_window to open inside the configured window", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schedule_window_open_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const now = flow.node("transform", {
      id: "now",
      position: { x: 120, y: 0 },
      config: { value: Date.UTC(2026, 6, 6, 10, 0) },
    });
    const window = flow.node("schedule_window", {
      id: "window",
      position: { x: 260, y: 0 },
      config: {
        startTime: "09:00",
        endTime: "17:00",
        days: "1,2,3,4,5",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "window:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), now.in("in"));
    flow.connect(now.out("out"), window.in("in"));
    flow.connect(now.out("output"), window.in("now"));
    flow.connect(window.out("open"), report.in("in"));
    flow.connect(window.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schedule_window_open_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("window:open");
  });

  it("routes schedule_window to closed before opening and reports wait time", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schedule_window_closed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const now = flow.node("transform", {
      id: "now",
      position: { x: 120, y: 0 },
      config: { value: Date.UTC(2026, 6, 6, 8, 30) },
    });
    const window = flow.node("schedule_window", {
      id: "window",
      position: { x: 260, y: 0 },
      config: {
        startTime: "09:00",
        endTime: "17:00",
        days: "1,2,3,4,5",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "wait:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), now.in("in"));
    flow.connect(now.out("out"), window.in("in"));
    flow.connect(now.out("output"), window.in("now"));
    flow.connect(window.out("closed"), report.in("in"));
    flow.connect(window.out("nextOpenInMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schedule_window_closed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("wait:1800000");
  });

  it("keeps schedule_window open for overnight windows", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schedule_window_overnight_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const now = flow.node("transform", {
      id: "now",
      position: { x: 120, y: 0 },
      config: { value: Date.UTC(2026, 6, 7, 1, 0) },
    });
    const window = flow.node("schedule_window", {
      id: "window",
      position: { x: 260, y: 0 },
      config: {
        startTime: "22:00",
        endTime: "02:00",
        days: "1",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "window:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), now.in("in"));
    flow.connect(now.out("out"), window.in("in"));
    flow.connect(now.out("output"), window.in("now"));
    flow.connect(window.out("open"), report.in("in"));
    flow.connect(window.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schedule_window_overnight_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("window:open");
  });

  it("routes policy_gate to allowed when all rules pass", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "policy_gate_allowed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { amount: 80, tier: "gold", approved: true } },
    });
    const gate = flow.node("policy_gate", {
      id: "gate",
      position: { x: 260, y: 0 },
      config: {
        mode: "all",
        rules: 'amount <= 100\ntier == "gold"\napproved',
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "policy:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), gate.in("in"));
    flow.connect(input.out("output"), gate.in("input"));
    flow.connect(gate.out("allowed"), report.in("in"));
    flow.connect(gate.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "policy_gate_allowed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("policy:allowed");
  });

  it("routes policy_gate to denied and exposes failed rules", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "policy_gate_denied_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { amount: 150, tier: "silver", approved: true } },
    });
    const gate = flow.node("policy_gate", {
      id: "gate",
      position: { x: 260, y: 0 },
      config: {
        mode: "all",
        rules: 'amount <= 100\ntier == "gold"\napproved',
        reason: "manual_review_required",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "denied:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), gate.in("in"));
    flow.connect(input.out("output"), gate.in("input"));
    flow.connect(gate.out("denied"), report.in("in"));
    flow.connect(gate.out("failed"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "policy_gate_denied_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe('denied:amount <= 100,tier == "gold"');
  });

  it("routes policy_gate to allowed when any rule passes", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "policy_gate_any_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { tier: "silver", beta: true } },
    });
    const gate = flow.node("policy_gate", {
      id: "gate",
      position: { x: 260, y: 0 },
      config: {
        mode: "any",
        rules: 'tier == "gold"\nbeta',
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "policy:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), gate.in("in"));
    flow.connect(input.out("output"), gate.in("input"));
    flow.connect(gate.out("allowed"), report.in("in"));
    flow.connect(gate.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "policy_gate_any_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("policy:allowed");
  });

  it("routes policy_gate with no rules to denied", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "policy_gate_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const gate = flow.node("policy_gate", {
      id: "gate",
      position: { x: 120, y: 0 },
      config: { rules: "" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "reason:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("denied"), report.in("in"));
    flow.connect(gate.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "policy_gate_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("reason:no_rules");
  });

  it("routes schema_guard to valid when the payload matches the schema", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schema_guard_valid_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { id: "order_1", quantity: 2, status: "ready" } },
    });
    const guard = flow.node("schema_guard", {
      id: "guard",
      position: { x: 260, y: 0 },
      config: {
        schema: {
          type: "object",
          required: ["id", "quantity"],
          properties: {
            id: { type: "string", minLength: 1 },
            quantity: { type: "integer", minimum: 1 },
            status: { enum: ["ready", "pending"] },
          },
          additionalProperties: false,
        },
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "schema:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), guard.in("in"));
    flow.connect(input.out("output"), guard.in("input"));
    flow.connect(guard.out("valid"), report.in("in"));
    flow.connect(guard.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schema_guard_valid_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("schema:valid");
  });

  it("routes schema_guard to invalid and reports schema issues", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schema_guard_invalid_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { id: "order_1", quantity: "two", extra: true } },
    });
    const guard = flow.node("schema_guard", {
      id: "guard",
      position: { x: 260, y: 0 },
      config: {
        schema: JSON.stringify({
          type: "object",
          required: ["id", "quantity"],
          properties: {
            id: { type: "string" },
            quantity: { type: "integer" },
          },
          additionalProperties: false,
        }),
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "issues:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), guard.in("in"));
    flow.connect(input.out("output"), guard.in("input"));
    flow.connect(guard.out("invalid"), report.in("in"));
    flow.connect(guard.out("issueCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schema_guard_invalid_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("issues:2");
  });

  it("routes node errors through retry_policy with backoff metadata", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 3,
        baseDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 1000,
        retryableOnly: false,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "retry:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), failing.in("in"));
    flow.connect(failing.out("error"), policy.in("error"));
    flow.connect(policy.out("retry"), report.in("in"));
    flow.connect(policy.out("delayMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:100");
  });

  it("routes exhausted retry_policy errors to the exhausted branch", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_exhausted_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 1,
        retryableOnly: false,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "exhausted:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), failing.in("in"));
    flow.connect(failing.out("error"), policy.in("error"));
    flow.connect(policy.out("exhausted"), report.in("in"));
    flow.connect(policy.out("attempt"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_exhausted_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("exhausted:1");
  });

  it("routes rate_limit to allowed and records a sliding-window hit", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "rate_limit_allowed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const limit = flow.node("rate_limit", {
      id: "limit",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_API_LIMIT",
        limit: 2,
        windowMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "allowed:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), limit.in("in"));
    flow.connect(limit.out("allowed"), report.in("in"));
    flow.connect(limit.out("remaining"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rate_limit_allowed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("allowed:1");
    expect(variables.get("PAYMENT_API_LIMIT")).toMatchObject({
      limit: 2,
      windowMs: 60_000,
    });
    expect(
      (variables.get("PAYMENT_API_LIMIT") as { timestamps?: unknown[] })
        .timestamps,
    ).toHaveLength(1);
  });

  it("routes rate_limit to limited when the window is full", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_API_LIMIT", {
      windowStart: Date.now(),
      windowMs: 60_000,
      limit: 1,
      timestamps: [Date.now()],
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "rate_limit_limited_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const limit = flow.node("rate_limit", {
      id: "limit",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_API_LIMIT",
        limit: 1,
        windowMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "limited:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), limit.in("in"));
    flow.connect(limit.out("limited"), report.in("in"));
    flow.connect(limit.out("remaining"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rate_limit_limited_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("limited:0");
    const state = variables.get("PAYMENT_API_LIMIT") as {
      timestamps?: unknown[];
      updatedAt?: number;
    };
    expect(state.timestamps).toHaveLength(1);
    expect(state.updatedAt).toBeGreaterThan(0);
  });

  it("routes mutex to acquired and records the lock owner", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "mutex_acquired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const mutex = flow.node("mutex", {
      id: "lock",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_LOCK",
        owner: "worker-1",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "acquired:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), mutex.in("in"));
    flow.connect(mutex.out("acquired"), report.in("in"));
    flow.connect(mutex.out("owner"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "mutex_acquired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("acquired:worker-1");
    expect(variables.get("ORDER_LOCK")).toMatchObject({
      locked: true,
      owner: "worker-1",
    });
  });

  it("routes mutex to locked when another owner holds an active lock", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_LOCK", {
      locked: true,
      owner: "worker-1",
      acquiredAt: now,
      expiresAt: now + 60_000,
      updatedAt: now,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "mutex_locked_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const mutex = flow.node("mutex", {
      id: "lock",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_LOCK",
        owner: "worker-2",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "locked:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), mutex.in("in"));
    flow.connect(mutex.out("locked"), report.in("in"));
    flow.connect(mutex.out("owner"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "mutex_locked_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("locked:worker-1");
    expect(variables.get("ORDER_LOCK")).toMatchObject({
      locked: true,
      owner: "worker-1",
    });
  });

  it("routes mutex release to released when the owner matches", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_LOCK", {
      locked: true,
      owner: "worker-1",
      acquiredAt: now,
      expiresAt: now + 60_000,
      updatedAt: now,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "mutex_release_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const mutex = flow.node("mutex", {
      id: "unlock",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_LOCK",
        owner: "worker-1",
        mode: "release",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "released:${input.locked}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), mutex.in("in"));
    flow.connect(mutex.out("released"), report.in("in"));
    flow.connect(mutex.out("state"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "mutex_release_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("released:false");
    expect(variables.get("ORDER_LOCK")).toMatchObject({
      locked: false,
      owner: null,
    });
  });

  it("routes semaphore to acquired and records a permit holder", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "semaphore_acquired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const gate = flow.node("semaphore", {
      id: "gate",
      position: { x: 120, y: 0 },
      config: {
        name: "FILE_WORKER_POOL",
        owner: "worker-1",
        capacity: 2,
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "available:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("acquired"), report.in("in"));
    flow.connect(gate.out("available"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "semaphore_acquired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("available:1");
    expect(variables.get("FILE_WORKER_POOL")).toMatchObject({
      capacity: 2,
      holders: [{ owner: "worker-1" }],
    });
  });

  it("routes semaphore to saturated when capacity is full", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("FILE_WORKER_POOL", {
      capacity: 1,
      holders: [
        {
          owner: "worker-1",
          acquiredAt: now,
          expiresAt: now + 60_000,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "semaphore_saturated_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const gate = flow.node("semaphore", {
      id: "gate",
      position: { x: 120, y: 0 },
      config: {
        name: "FILE_WORKER_POOL",
        owner: "worker-2",
        capacity: 1,
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "saturated:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("saturated"), report.in("in"));
    flow.connect(gate.out("used"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "semaphore_saturated_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("saturated:1");
    expect(variables.get("FILE_WORKER_POOL")).toMatchObject({
      holders: [{ owner: "worker-1" }],
    });
  });

  it("routes semaphore release to released and frees a permit", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("FILE_WORKER_POOL", {
      capacity: 2,
      holders: [
        {
          owner: "worker-1",
          acquiredAt: now,
          expiresAt: now + 60_000,
          updatedAt: now,
        },
        {
          owner: "worker-2",
          acquiredAt: now,
          expiresAt: now + 60_000,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "semaphore_release_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const gate = flow.node("semaphore", {
      id: "gate",
      position: { x: 120, y: 0 },
      config: {
        name: "FILE_WORKER_POOL",
        owner: "worker-1",
        capacity: 2,
        mode: "release",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "available:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("released"), report.in("in"));
    flow.connect(gate.out("available"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "semaphore_release_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("available:1");
    expect(variables.get("FILE_WORKER_POOL")).toMatchObject({
      holders: [{ owner: "worker-2" }],
    });
  });

  it("routes idempotency_key to started for a new business key", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "idempotency_started_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const idem = flow.node("idempotency_key", {
      id: "idem",
      position: { x: 120, y: 0 },
      config: {
        namespace: "payments",
        key: "order-1",
        mode: "start",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "idem:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), idem.in("in"));
    flow.connect(idem.out("started"), report.in("in"));
    flow.connect(idem.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "idempotency_started_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("idem:started");
    expect(variables.get("IDEMPOTENCY:payments:order-1")).toMatchObject({
      key: "order-1",
      status: "started",
    });
  });

  it("routes idempotency_key to replayed for a completed key", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("IDEMPOTENCY:payments:order-1", {
      key: "order-1",
      status: "completed",
      owner: "previous-run",
      value: "receipt-1",
      error: null,
      startedAt: now - 1000,
      completedAt: now - 500,
      failedAt: null,
      expiresAt: now + 60_000,
      updatedAt: now - 500,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "idempotency_replayed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const idem = flow.node("idempotency_key", {
      id: "idem",
      position: { x: 120, y: 0 },
      config: {
        namespace: "payments",
        key: "order-1",
        mode: "start",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "replay:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), idem.in("in"));
    flow.connect(idem.out("replayed"), report.in("in"));
    flow.connect(idem.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "idempotency_replayed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("replay:receipt-1");
    expect(variables.get("IDEMPOTENCY:payments:order-1")).toMatchObject({
      status: "completed",
      value: "receipt-1",
    });
  });

  it("records idempotency_key completion with a downstream value", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "idempotency_completed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 120, y: 0 },
      config: { value: "receipt-2" },
    });
    const idem = flow.node("idempotency_key", {
      id: "idem",
      position: { x: 260, y: 0 },
      config: {
        namespace: "payments",
        key: "order-2",
        mode: "complete",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "completed:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), idem.in("in"));
    flow.connect(payload.out("output"), idem.in("value"));
    flow.connect(idem.out("completed"), report.in("in"));
    flow.connect(idem.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "idempotency_completed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("completed:receipt-2");
    expect(variables.get("IDEMPOTENCY:payments:order-2")).toMatchObject({
      key: "order-2",
      status: "completed",
      value: "receipt-2",
      error: null,
    });
  });

  it("opens a circuit_breaker after recorded failures and routes checks to open", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const recordFailure = flow.node("circuit_breaker", {
      id: "record_failure",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_CIRCUIT",
        failureThreshold: 1,
        resetTimeoutMs: 60_000,
        mode: "record_failure",
      },
    });
    const check = flow.node("circuit_breaker", {
      id: "check",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_CIRCUIT",
        failureThreshold: 1,
        resetTimeoutMs: 60_000,
        mode: "check",
      },
    });
    const fallback = flow.node("transform", {
      id: "fallback",
      position: { x: 400, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), recordFailure.in("in"));
    flow.connect(recordFailure.out("open"), check.in("in"));
    flow.connect(check.out("open"), fallback.in("in"));
    flow.connect(check.out("status"), fallback.in("input"));
    flow.connect(fallback.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:open");
    expect(variables.get("PAYMENT_CIRCUIT")).toMatchObject({
      status: "open",
      failureCount: 1,
    });
  });

  it("routes expired open circuit_breaker state to half_open", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_CIRCUIT", {
      status: "open",
      failureCount: 2,
      openedAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_half_open_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const check = flow.node("circuit_breaker", {
      id: "check",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_CIRCUIT",
        resetTimeoutMs: 1,
        mode: "check",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), check.in("in"));
    flow.connect(check.out("half_open"), report.in("in"));
    flow.connect(check.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_half_open_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:half_open");
    expect(variables.get("PAYMENT_CIRCUIT")).toMatchObject({
      status: "half_open",
      failureCount: 2,
    });
  });

  it("drains compensation actions in reverse registration order", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "compensation_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const first = flow.node("compensation", {
      id: "first",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_COMPENSATIONS",
        mode: "register",
        action: "release_inventory",
        payload: { sku: "book", quantity: 1 },
      },
    });
    const second = flow.node("compensation", {
      id: "second",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_COMPENSATIONS",
        mode: "register",
        action: "refund_payment",
        payload: { paymentId: "pay_1" },
      },
    });
    const drain = flow.node("compensation", {
      id: "drain",
      position: { x: 400, y: 0 },
      config: {
        name: "ORDER_COMPENSATIONS",
        mode: "drain",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "rollback:${input.0.action},${input.1.action}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), first.in("in"));
    flow.connect(first.out("out"), second.in("in"));
    flow.connect(second.out("out"), drain.in("in"));
    flow.connect(drain.out("out"), report.in("in"));
    flow.connect(drain.out("actions"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "compensation_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("rollback:refund_payment,release_inventory");
    expect(variables.get("ORDER_COMPENSATIONS")).toMatchObject({
      actions: [],
    });
  });

  it("routes wait_signal to received when an external signal is present", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      status: "waiting",
      signal: "approved",
      expected: "approved",
      requestedAt: Date.now(),
      expiresAt: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_received_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        expected: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "signal:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), wait.in("in"));
    flow.connect(wait.out("received"), report.in("in"));
    flow.connect(wait.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_signal_received_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("signal:received");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "received",
      signal: "approved",
    });
  });

  it("creates a wait_signal checkpoint and routes to waiting", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_waiting_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        expected: "approved",
        timeoutMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "signal:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), wait.in("in"));
    flow.connect(wait.out("waiting"), report.in("in"));
    flow.connect(wait.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_signal_waiting_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("signal:waiting");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "waiting",
      signal: null,
      expected: "approved",
    });
  });

  it("routes expired wait_signal checkpoints to expired", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      status: "waiting",
      signal: null,
      expected: "approved",
      requestedAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        expected: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "signal:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), wait.in("in"));
    flow.connect(wait.out("expired"), report.in("in"));
    flow.connect(wait.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_signal_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("signal:expired");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "expired",
      signal: null,
    });
  });

  it("requests a human approval and stores pending state", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_request_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-1", amount: 4200 } },
    });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        title: "Approve high value order",
        assignee: "finance",
        timeoutMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), approval.in("in"));
    flow.connect(payload.out("output"), approval.in("payload"));
    flow.connect(approval.out("requested"), report.in("in"));
    flow.connect(approval.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_request_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:pending");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "pending",
      title: "Approve high value order",
      assignee: "finance",
      payload: { orderId: "order-1", amount: 4200 },
      decision: null,
    });
  });

  it("checks approved approval state", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      name: "ORDER_APPROVAL",
      status: "approved",
      title: "Approve release",
      assignee: "lead",
      payload: { release: "2026.07" },
      decision: "approved",
      comment: "looks good",
      requestedAt: Date.now() - 10_000,
      resolvedAt: Date.now() - 1000,
      expiresAt: null,
      updatedAt: Date.now() - 1000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_check_approved_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        mode: "check",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), approval.in("in"));
    flow.connect(approval.out("approved"), report.in("in"));
    flow.connect(approval.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_check_approved_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:approved");
  });

  it("resolves pending approval as rejected", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      name: "ORDER_APPROVAL",
      status: "pending",
      title: "Approve order",
      assignee: "finance",
      payload: { orderId: "order-2" },
      decision: null,
      comment: "",
      requestedAt: Date.now() - 10_000,
      resolvedAt: null,
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_resolve_rejected_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        mode: "resolve",
        decision: "rejected",
        comment: "budget exceeded",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), approval.in("in"));
    flow.connect(approval.out("rejected"), report.in("in"));
    flow.connect(approval.out("decision"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_resolve_rejected_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:rejected");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "rejected",
      decision: "rejected",
      comment: "budget exceeded",
    });
  });

  it("routes expired pending approvals to expired", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      name: "ORDER_APPROVAL",
      status: "pending",
      title: "Approve order",
      assignee: "finance",
      payload: { orderId: "order-3" },
      decision: null,
      comment: "",
      requestedAt: Date.now() - 120_000,
      resolvedAt: null,
      expiresAt: Date.now() - 1,
      updatedAt: Date.now() - 120_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        mode: "check",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), approval.in("in"));
    flow.connect(approval.out("expired"), report.in("in"));
    flow.connect(approval.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:expired");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "expired",
    });
  });

  it("cancels pending approval state", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      name: "ORDER_APPROVAL",
      status: "pending",
      title: "Approve order",
      assignee: "finance",
      payload: { orderId: "order-5" },
      decision: null,
      comment: "",
      requestedAt: Date.now(),
      resolvedAt: null,
      expiresAt: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_cancel_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        mode: "cancel",
        comment: "request withdrawn",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), approval.in("in"));
    flow.connect(approval.out("cancelled"), report.in("in"));
    flow.connect(approval.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_cancel_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:cancelled");
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "cancelled",
      comment: "request withdrawn",
    });
  });

  it("clears approval state", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL", {
      name: "ORDER_APPROVAL",
      status: "pending",
      title: "Approve order",
      assignee: "finance",
      payload: { orderId: "order-4" },
      decision: null,
      comment: "",
      requestedAt: Date.now(),
      resolvedAt: null,
      expiresAt: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_clear_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL",
        mode: "clear",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), approval.in("in"));
    flow.connect(approval.out("cleared"), report.in("in"));
    flow.connect(approval.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_clear_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:missing");
    expect(variables.has("ORDER_APPROVAL")).toBe(false);
  });

  it("appends business events into audit_log", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "audit_log_append_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-1", decision: "approved" } },
    });
    const audit = flow.node("audit_log", {
      id: "audit",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_AUDIT_LOG",
        type: "approval",
        actor: "finance",
        message: "Order approved",
        maxEntries: 10,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "audit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), audit.in("in"));
    flow.connect(payload.out("output"), audit.in("payload"));
    flow.connect(audit.out("appended"), report.in("in"));
    flow.connect(audit.out("sequence"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "audit_log_append_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("audit:1");
    expect(variables.get("ORDER_AUDIT_LOG")).toMatchObject({
      sequence: 1,
      entries: [
        {
          sequence: 1,
          type: "approval",
          actor: "finance",
          message: "Order approved",
          payload: { orderId: "order-1", decision: "approved" },
          nodeId: "audit",
        },
      ],
    });
  });

  it("reads recent audit_log entries with a limit", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_AUDIT_LOG", {
      sequence: 3,
      updatedAt: Date.now(),
      entries: [
        {
          id: "entry-1",
          sequence: 1,
          type: "created",
          actor: "system",
          message: "Order created",
          payload: { orderId: "order-1" },
          recordedAt: Date.now() - 3000,
          runId: "run-1",
          nodeId: "audit",
        },
        {
          id: "entry-2",
          sequence: 2,
          type: "approval",
          actor: "finance",
          message: "Order approved",
          payload: { orderId: "order-1" },
          recordedAt: Date.now() - 2000,
          runId: "run-2",
          nodeId: "audit",
        },
        {
          id: "entry-3",
          sequence: 3,
          type: "payment",
          actor: "payment-service",
          message: "Payment captured",
          payload: { orderId: "order-1" },
          recordedAt: Date.now() - 1000,
          runId: "run-3",
          nodeId: "audit",
        },
      ],
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "audit_log_read_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const audit = flow.node("audit_log", {
      id: "audit",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_AUDIT_LOG",
        mode: "read",
        limit: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "audit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), audit.in("in"));
    flow.connect(audit.out("read"), report.in("in"));
    flow.connect(audit.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "audit_log_read_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("audit:2");
    expect(variables.get("ORDER_AUDIT_LOG")).toMatchObject({
      sequence: 3,
      entries: [
        { sequence: 1 },
        { sequence: 2 },
        { sequence: 3 },
      ],
    });
  });

  it("routes empty audit_log reads to empty", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "audit_log_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const audit = flow.node("audit_log", {
      id: "audit",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_AUDIT_LOG",
        mode: "read",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "audit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), audit.in("in"));
    flow.connect(audit.out("empty"), report.in("in"));
    flow.connect(audit.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "audit_log_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("audit:0");
    expect(variables.has("ORDER_AUDIT_LOG")).toBe(false);
  });

  it("clears audit_log entries", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_AUDIT_LOG", {
      sequence: 2,
      updatedAt: Date.now(),
      entries: [
        {
          id: "entry-1",
          sequence: 1,
          type: "created",
          actor: "system",
          message: "Order created",
          payload: { orderId: "order-1" },
          recordedAt: Date.now() - 1000,
          runId: "run-1",
          nodeId: "audit",
        },
        {
          id: "entry-2",
          sequence: 2,
          type: "cancelled",
          actor: "user",
          message: "Order cancelled",
          payload: { orderId: "order-1" },
          recordedAt: Date.now(),
          runId: "run-2",
          nodeId: "audit",
        },
      ],
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "audit_log_clear_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const audit = flow.node("audit_log", {
      id: "audit",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_AUDIT_LOG",
        mode: "clear",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "audit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), audit.in("in"));
    flow.connect(audit.out("cleared"), report.in("in"));
    flow.connect(audit.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "audit_log_clear_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("audit:2");
    expect(variables.has("ORDER_AUDIT_LOG")).toBe(false);
  });

  it("increments a persisted metric", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVED_COUNT", {
      name: "ORDER_APPROVED_COUNT",
      value: 4,
      count: 4,
      sum: 4,
      min: 1,
      max: 1,
      last: 1,
      samples: [1, 1, 1, 1],
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 1000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "metric_increment_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const metric = flow.node("metric", {
      id: "metric",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVED_COUNT",
        mode: "increment",
        value: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "metric:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), metric.in("in"));
    flow.connect(metric.out("updated"), report.in("in"));
    flow.connect(metric.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "metric_increment_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("metric:6");
    expect(variables.get("ORDER_APPROVED_COUNT")).toMatchObject({
      value: 6,
      count: 5,
      sum: 6,
      max: 2,
      last: 2,
    });
  });

  it("observes metric samples and computes aggregates", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_LATENCY_MS", {
      name: "ORDER_LATENCY_MS",
      value: 120,
      count: 1,
      sum: 120,
      min: 120,
      max: 120,
      last: 120,
      samples: [120],
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 1000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "metric_observe_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const metric = flow.node("metric", {
      id: "metric",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_LATENCY_MS",
        mode: "observe",
        value: 80,
        maxSamples: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "avg:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), metric.in("in"));
    flow.connect(metric.out("updated"), report.in("in"));
    flow.connect(metric.out("average"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "metric_observe_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("avg:100");
    expect(variables.get("ORDER_LATENCY_MS")).toMatchObject({
      value: 80,
      count: 2,
      sum: 200,
      min: 80,
      max: 120,
      samples: [120, 80],
    });
  });

  it("routes missing metric reads to missing", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "metric_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const metric = flow.node("metric", {
      id: "metric",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVED_COUNT",
        mode: "read",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "metric:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), metric.in("in"));
    flow.connect(metric.out("missing"), report.in("in"));
    flow.connect(metric.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "metric_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("metric:0");
    expect(variables.has("ORDER_APPROVED_COUNT")).toBe(false);
  });

  it("resets a metric", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVED_COUNT", {
      name: "ORDER_APPROVED_COUNT",
      value: 10,
      count: 10,
      sum: 10,
      min: 1,
      max: 1,
      last: 1,
      samples: [1, 1],
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 1000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "metric_reset_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const metric = flow.node("metric", {
      id: "metric",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVED_COUNT",
        mode: "reset",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "metric:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), metric.in("in"));
    flow.connect(metric.out("reset"), report.in("in"));
    flow.connect(metric.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "metric_reset_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("metric:0");
    expect(variables.has("ORDER_APPROVED_COUNT")).toBe(false);
  });

  it("sets feature_flag state", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "feature_flag_set_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const flag = flow.node("feature_flag", {
      id: "flag",
      position: { x: 120, y: 0 },
      config: {
        name: "CHECKOUT_V2",
        mode: "set",
        enabled: true,
        rolloutPercent: 25,
        description: "Checkout v2 gradual rollout",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "flag:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), flag.in("in"));
    flow.connect(flag.out("updated"), report.in("in"));
    flow.connect(flag.out("rolloutPercent"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "feature_flag_set_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flag:25");
    expect(variables.get("CHECKOUT_V2")).toMatchObject({
      name: "CHECKOUT_V2",
      enabled: true,
      rolloutPercent: 25,
      description: "Checkout v2 gradual rollout",
    });
  });

  it("routes enabled feature_flag evaluations to enabled", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("CHECKOUT_V2", {
      name: "CHECKOUT_V2",
      enabled: true,
      rolloutPercent: 100,
      description: "all users",
      evaluations: 0,
      lastKey: "",
      lastBucket: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "feature_flag_enabled_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const flag = flow.node("feature_flag", {
      id: "flag",
      position: { x: 120, y: 0 },
      config: {
        name: "CHECKOUT_V2",
        key: "tenant-a",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "flag:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), flag.in("in"));
    flow.connect(flag.out("enabled"), report.in("in"));
    flow.connect(flag.out("enabledValue"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "feature_flag_enabled_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flag:true");
    expect(variables.get("CHECKOUT_V2")).toMatchObject({
      evaluations: 1,
      lastKey: "tenant-a",
    });
  });

  it("routes zero-percent feature_flag rollouts to disabled", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("CHECKOUT_V2", {
      name: "CHECKOUT_V2",
      enabled: true,
      rolloutPercent: 0,
      description: "disabled rollout",
      evaluations: 0,
      lastKey: "",
      lastBucket: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "feature_flag_disabled_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const flag = flow.node("feature_flag", {
      id: "flag",
      position: { x: 120, y: 0 },
      config: {
        name: "CHECKOUT_V2",
        key: "tenant-a",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "flag:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), flag.in("in"));
    flow.connect(flag.out("disabled"), report.in("in"));
    flow.connect(flag.out("enabledValue"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "feature_flag_disabled_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flag:false");
    expect(variables.get("CHECKOUT_V2")).toMatchObject({
      evaluations: 1,
      lastKey: "tenant-a",
    });
  });

  it("clears feature_flag state", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("CHECKOUT_V2", {
      name: "CHECKOUT_V2",
      enabled: true,
      rolloutPercent: 100,
      description: "all users",
      evaluations: 4,
      lastKey: "tenant-a",
      lastBucket: 1,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "feature_flag_clear_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const flag = flow.node("feature_flag", {
      id: "flag",
      position: { x: 120, y: 0 },
      config: {
        name: "CHECKOUT_V2",
        mode: "clear",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "flag:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), flag.in("in"));
    flow.connect(flag.out("cleared"), report.in("in"));
    flow.connect(flag.out("evaluations"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "feature_flag_clear_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flag:0");
    expect(variables.has("CHECKOUT_V2")).toBe(false);
  });

  it("invokes a registered child flow with subflow and returns its output", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "child_echo", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const childTransform = child.node("transform", {
      id: "child_transform",
      position: { x: 120, y: 0 },
      config: { template: "child:${input.name}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), childTransform.in("in"));
    child.connect(childTransform.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_calls_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: { flowId: "child_echo" },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "parent:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("succeeded"), report.in("in"));
    parent.connect(call.out("output"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_calls_child",
      input: { name: "Ada" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:child:Ada");
    const childRuns = await rt.runStore.listByFlow("child_echo");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("succeeded");
    expect(childRuns[0]?.output).toBe("child:Ada");
  });

  it("routes failed subflow child runs when failOnError is false", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "child_fails", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const broken = child.node("http", {
      id: "broken_http",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), broken.in("in"));
    child.connect(broken.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_routes_failed_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: { flowId: "child_fails", failOnError: false },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "child-error:${input.code}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("failed"), report.in("in"));
    parent.connect(call.out("error"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_routes_failed_child",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("child-error:node.http.missing_url");
    const childRuns = await rt.runStore.listByFlow("child_fails");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("failed");
    expect(childRuns[0]?.error?.code).toBe("node.http.missing_url");
  });

  it("writes state for downstream variable resolution with state_set", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "state_set_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: "persisted" },
    });
    const setState = flow.node("state_set", {
      id: "set_state",
      position: { x: 260, y: 0 },
      config: {
        name: "FLOW_STATE_VALUE",
        description: "Value written by the state_set e2e test.",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: { $var: "FLOW_STATE_VALUE" } },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), setState.in("in"));
    flow.connect(input.out("output"), setState.in("value"));
    flow.connect(setState.out("out"), report.in("in"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "state_set_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("persisted");
    expect(variables.get("FLOW_STATE_VALUE")).toBe("persisted");
    expect(variables.describe("FLOW_STATE_VALUE")?.metadata).toMatchObject({
      description: "Value written by the state_set e2e test.",
      source: "runtime",
      scope: { flowId: "state_set_e2e" },
    });
  });

  it("reads state as explicit data with state_get", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "state_get_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { status: "ready" } },
    });
    const setState = flow.node("state_set", {
      id: "set_state",
      position: { x: 260, y: 0 },
      config: { name: "FLOW_STATE_OBJECT" },
    });
    const getState = flow.node("state_get", {
      id: "get_state",
      position: { x: 400, y: 0 },
      config: { name: "FLOW_STATE_OBJECT" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "state=${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), setState.in("in"));
    flow.connect(input.out("output"), setState.in("value"));
    flow.connect(setState.out("out"), getState.in("in"));
    flow.connect(getState.out("out"), report.in("in"));
    flow.connect(getState.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "state_get_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("state=ready");
  });

  it("routes batch_window to waiting while the batch is not full", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "batch_window_waiting_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const item = flow.node("transform", {
      id: "item",
      position: { x: 120, y: 0 },
      config: { value: "email-1" },
    });
    const batch = flow.node("batch_window", {
      id: "batch",
      position: { x: 260, y: 0 },
      config: {
        name: "EMAIL_BATCH",
        maxItems: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "waiting:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), item.in("in"));
    flow.connect(item.out("out"), batch.in("in"));
    flow.connect(item.out("output"), batch.in("item"));
    flow.connect(batch.out("waiting"), report.in("in"));
    flow.connect(batch.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "batch_window_waiting_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("waiting:1");
    expect(variables.get("EMAIL_BATCH")).toMatchObject({
      items: ["email-1"],
      flushCount: 0,
    });
  });

  it("routes batch_window to ready and clears state when maxItems is reached", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("EMAIL_BATCH", {
      items: ["email-1"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flushCount: 0,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "batch_window_ready_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const item = flow.node("transform", {
      id: "item",
      position: { x: 120, y: 0 },
      config: { value: "email-2" },
    });
    const batch = flow.node("batch_window", {
      id: "batch",
      position: { x: 260, y: 0 },
      config: {
        name: "EMAIL_BATCH",
        maxItems: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "ready:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), item.in("in"));
    flow.connect(item.out("out"), batch.in("in"));
    flow.connect(item.out("output"), batch.in("item"));
    flow.connect(batch.out("ready"), report.in("in"));
    flow.connect(batch.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "batch_window_ready_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("ready:email-1,email-2");
    expect(variables.has("EMAIL_BATCH")).toBe(false);
  });

  it("flushes an existing batch_window explicitly", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("EMAIL_BATCH", {
      items: ["email-1", "email-2"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flushCount: 1,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "batch_window_flush_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const batch = flow.node("batch_window", {
      id: "batch",
      position: { x: 120, y: 0 },
      config: {
        name: "EMAIL_BATCH",
        mode: "flush",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "flushed:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), batch.in("in"));
    flow.connect(batch.out("ready"), report.in("in"));
    flow.connect(batch.out("flushCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "batch_window_flush_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flushed:2");
    expect(variables.has("EMAIL_BATCH")).toBe(false);
  });

  it("records node errors into dead_letter", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "dead_letter_enqueue_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const deadLetter = flow.node("dead_letter", {
      id: "dead_letter",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_DEAD_LETTERS",
        reason: "payment http failed",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "dead:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), failing.in("in"));
    flow.connect(failing.out("error"), deadLetter.in("error"));
    flow.connect(deadLetter.out("recorded"), report.in("in"));
    flow.connect(deadLetter.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "dead_letter_enqueue_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("dead:1");
    expect(variables.get("ORDER_DEAD_LETTERS")).toMatchObject({
      entries: [
        {
          error: {
            code: "node.http.missing_url",
          },
          reason: "payment http failed",
        },
      ],
    });
  });

  it("drains existing dead_letter entries", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_DEAD_LETTERS", {
      entries: [
        {
          id: "entry-1",
          payload: { orderId: "order-1" },
          error: { code: "payment.declined" },
          reason: "card declined",
          recordedAt: Date.now(),
        },
        {
          id: "entry-2",
          payload: { orderId: "order-2" },
          error: { code: "inventory.timeout" },
          reason: "inventory service timeout",
          recordedAt: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "dead_letter_drain_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const deadLetter = flow.node("dead_letter", {
      id: "dead_letter",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_DEAD_LETTERS",
        mode: "drain",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "drained:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), deadLetter.in("in"));
    flow.connect(deadLetter.out("drained"), report.in("in"));
    flow.connect(deadLetter.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "dead_letter_drain_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("drained:2");
    expect(variables.has("ORDER_DEAD_LETTERS")).toBe(false);
  });

  it("routes empty dead_letter drains to empty", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "dead_letter_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const deadLetter = flow.node("dead_letter", {
      id: "dead_letter",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_DEAD_LETTERS",
        mode: "drain",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "empty:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), deadLetter.in("in"));
    flow.connect(deadLetter.out("empty"), report.in("in"));
    flow.connect(deadLetter.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "dead_letter_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("empty:0");
    expect(variables.has("ORDER_DEAD_LETTERS")).toBe(false);
  });

  it("pushes items into queue", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "queue_push_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const item = flow.node("transform", {
      id: "item",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-1", task: "charge" } },
    });
    const queue = flow.node("queue", {
      id: "queue",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_WORK_QUEUE",
        maxItems: 10,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "queued:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), item.in("in"));
    flow.connect(item.out("out"), queue.in("in"));
    flow.connect(item.out("output"), queue.in("item"));
    flow.connect(queue.out("pushed"), report.in("in"));
    flow.connect(queue.out("queueSize"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "queue_push_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("queued:1");
    expect(variables.get("ORDER_WORK_QUEUE")).toMatchObject({
      items: [{ orderId: "order-1", task: "charge" }],
      pushedCount: 1,
      poppedCount: 0,
    });
  });

  it("pops queue items in FIFO order", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_WORK_QUEUE", {
      items: ["order-1", "order-2"],
      updatedAt: Date.now(),
      pushedCount: 2,
      poppedCount: 0,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "queue_pop_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const queue = flow.node("queue", {
      id: "queue",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_WORK_QUEUE",
        mode: "pop",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "popped:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), queue.in("in"));
    flow.connect(queue.out("popped"), report.in("in"));
    flow.connect(queue.out("item"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "queue_pop_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("popped:order-1");
    expect(variables.get("ORDER_WORK_QUEUE")).toMatchObject({
      items: ["order-2"],
      pushedCount: 2,
      poppedCount: 1,
    });
  });

  it("peeks queue items without removing them", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_WORK_QUEUE", {
      items: ["order-1", "order-2"],
      updatedAt: Date.now(),
      pushedCount: 2,
      poppedCount: 0,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "queue_peek_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const queue = flow.node("queue", {
      id: "queue",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_WORK_QUEUE",
        mode: "peek",
        count: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "peeked:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), queue.in("in"));
    flow.connect(queue.out("peeked"), report.in("in"));
    flow.connect(queue.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "queue_peek_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("peeked:2");
    expect(variables.get("ORDER_WORK_QUEUE")).toMatchObject({
      items: ["order-1", "order-2"],
      pushedCount: 2,
      poppedCount: 0,
    });
  });

  it("routes empty queue pops to empty", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "queue_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const queue = flow.node("queue", {
      id: "queue",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_WORK_QUEUE",
        mode: "pop",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "empty:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), queue.in("in"));
    flow.connect(queue.out("empty"), report.in("in"));
    flow.connect(queue.out("queueSize"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "queue_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("empty:0");
    expect(variables.has("ORDER_WORK_QUEUE")).toBe(false);
  });

  it("clears queue state explicitly", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_WORK_QUEUE", {
      items: ["order-1", "order-2"],
      updatedAt: Date.now(),
      pushedCount: 2,
      poppedCount: 0,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "queue_clear_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const queue = flow.node("queue", {
      id: "queue",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_WORK_QUEUE",
        mode: "clear",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "cleared:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), queue.in("in"));
    flow.connect(queue.out("cleared"), report.in("in"));
    flow.connect(queue.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "queue_clear_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("cleared:2");
    expect(variables.has("ORDER_WORK_QUEUE")).toBe(false);
  });

  it("stores values in cache", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cache_set_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const value = flow.node("transform", {
      id: "value",
      position: { x: 120, y: 0 },
      config: { value: { status: "ready", source: "http" } },
    });
    const cache = flow.node("cache", {
      id: "cache",
      position: { x: 260, y: 0 },
      config: {
        namespace: "http",
        key: "GET:/orders/1",
        mode: "set",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "stored:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), value.in("in"));
    flow.connect(value.out("out"), cache.in("in"));
    flow.connect(value.out("output"), cache.in("value"));
    flow.connect(cache.out("stored"), report.in("in"));
    flow.connect(cache.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cache_set_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("stored:1");
    expect(variables.get("CACHE:http:GET:/orders/1")).toMatchObject({
      value: { status: "ready", source: "http" },
      hits: 0,
    });
  });

  it("reads cache hits and updates hit count", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("CACHE:http:GET:/orders/1", {
      value: { status: "ready" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      hits: 1,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cache_hit_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const cache = flow.node("cache", {
      id: "cache",
      position: { x: 120, y: 0 },
      config: {
        namespace: "http",
        key: "GET:/orders/1",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "hit:${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), cache.in("in"));
    flow.connect(cache.out("hit"), report.in("in"));
    flow.connect(cache.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cache_hit_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("hit:ready");
    expect(variables.get("CACHE:http:GET:/orders/1")).toMatchObject({
      hits: 2,
    });
  });

  it("routes missing cache entries to miss", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cache_miss_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const cache = flow.node("cache", {
      id: "cache",
      position: { x: 120, y: 0 },
      config: {
        namespace: "http",
        key: "GET:/orders/2",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "miss:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), cache.in("in"));
    flow.connect(cache.out("miss"), report.in("in"));
    flow.connect(cache.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cache_miss_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("miss:0");
  });

  it("routes expired cache entries to expired and deletes them", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("CACHE:http:GET:/orders/1", {
      value: { status: "stale" },
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1,
      hits: 3,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cache_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const cache = flow.node("cache", {
      id: "cache",
      position: { x: 120, y: 0 },
      config: {
        namespace: "http",
        key: "GET:/orders/1",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "expired:${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), cache.in("in"));
    flow.connect(cache.out("expired"), report.in("in"));
    flow.connect(cache.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cache_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("expired:stale");
    expect(variables.has("CACHE:http:GET:/orders/1")).toBe(false);
  });

  it("clears cache entries by namespace", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("CACHE:http:GET:/orders/1", {
      value: "order-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: null,
      hits: 0,
    });
    variables.set("CACHE:http:GET:/orders/2", {
      value: "order-2",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: null,
      hits: 0,
    });
    variables.set("CACHE:llm:summary", {
      value: "kept",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: null,
      hits: 0,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cache_clear_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const cache = flow.node("cache", {
      id: "cache",
      position: { x: 120, y: 0 },
      config: {
        namespace: "http",
        mode: "clear",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "cleared:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), cache.in("in"));
    flow.connect(cache.out("cleared"), report.in("in"));
    flow.connect(cache.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cache_clear_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("cleared:2");
    expect(variables.has("CACHE:http:GET:/orders/1")).toBe(false);
    expect(variables.has("CACHE:http:GET:/orders/2")).toBe(false);
    expect(variables.has("CACHE:llm:summary")).toBe(true);
  });

  it("saves a checkpoint snapshot for later recovery", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "checkpoint_save_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const snapshot = flow.node("transform", {
      id: "snapshot",
      position: { x: 120, y: 0 },
      config: { value: { step: "payment", status: "authorized" } },
    });
    const checkpoint = flow.node("checkpoint", {
      id: "checkpoint",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_CHECKPOINT",
        mode: "save",
        label: "after payment authorization",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "checkpoint:v${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), snapshot.in("in"));
    flow.connect(snapshot.out("out"), checkpoint.in("in"));
    flow.connect(snapshot.out("output"), checkpoint.in("snapshot"));
    flow.connect(checkpoint.out("saved"), report.in("in"));
    flow.connect(checkpoint.out("version"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "checkpoint_save_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("checkpoint:v1");
    expect(variables.get("ORDER_CHECKPOINT")).toMatchObject({
      name: "ORDER_CHECKPOINT",
      status: "saved",
      snapshot: { step: "payment", status: "authorized" },
      version: 1,
      label: "after payment authorization",
    });
  });

  it("loads an existing checkpoint snapshot", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_CHECKPOINT", {
      name: "ORDER_CHECKPOINT",
      status: "saved",
      snapshot: { step: "shipping", status: "ready" },
      label: "shipping gate",
      version: 3,
      savedAt: now - 1000,
      loadedAt: null,
      expiresAt: now + 60_000,
      updatedAt: now - 1000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "checkpoint_load_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const checkpoint = flow.node("checkpoint", {
      id: "checkpoint",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_CHECKPOINT",
        mode: "load",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "loaded:${input.step}:${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), checkpoint.in("in"));
    flow.connect(checkpoint.out("loaded"), report.in("in"));
    flow.connect(checkpoint.out("snapshot"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "checkpoint_load_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("loaded:shipping:ready");
    expect(variables.get("ORDER_CHECKPOINT")).toMatchObject({
      status: "loaded",
      version: 3,
    });
  });

  it("routes checkpoint load to missing when no snapshot exists", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "checkpoint_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const checkpoint = flow.node("checkpoint", {
      id: "checkpoint",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_CHECKPOINT",
        mode: "load",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "checkpoint:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), checkpoint.in("in"));
    flow.connect(checkpoint.out("missing"), report.in("in"));
    flow.connect(checkpoint.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "checkpoint_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("checkpoint:missing");
    expect(variables.has("ORDER_CHECKPOINT")).toBe(false);
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

  it("routes to the matching switch_case branch and forwards the payload", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "switch_case_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 120 },
      config: { value: { status: "approved", title: "release" } },
    });
    const branch = flow.node("switch_case", {
      id: "branch",
      position: { x: 260, y: 120 },
      config: {
        path: "value.status",
        case1: "approved",
        case2: "rejected",
      },
    });
    const approved = flow.node("transform", {
      id: "approved",
      position: { x: 420, y: 40 },
      config: { template: "approved:${input.title}" },
    });
    const fallback = flow.node("transform", {
      id: "fallback",
      position: { x: 420, y: 200 },
      config: { template: "fallback:${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 120 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), branch.in("in"));
    flow.connect(input.out("output"), branch.in("value"));
    flow.connect(branch.out("case1"), approved.in("in"));
    flow.connect(branch.out("default"), fallback.in("in"));
    flow.connect(branch.out("value"), approved.in("input"));
    flow.connect(branch.out("value"), fallback.in("input"));
    flow.connect(approved.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "switch_case_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approved:release");
  });

  it("merges an exclusive switch_case branch before a shared end node", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "merge_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 120 },
      config: { value: { status: "unknown" } },
    });
    const branch = flow.node("switch_case", {
      id: "branch",
      position: { x: 260, y: 120 },
      config: {
        path: "value.status",
        case1: "approved",
      },
    });
    const approved = flow.node("transform", {
      id: "approved",
      position: { x: 420, y: 40 },
      config: { template: "approved:${input.status}" },
    });
    const fallback = flow.node("transform", {
      id: "fallback",
      position: { x: 420, y: 200 },
      config: { template: "fallback:${input.status}" },
    });
    const merge = flow.node("merge", { id: "merge", position: { x: 580, y: 120 } });
    const end = flow.node("end", { id: "e", position: { x: 720, y: 120 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), branch.in("in"));
    flow.connect(input.out("output"), branch.in("value"));
    flow.connect(branch.out("case1"), approved.in("in"));
    flow.connect(branch.out("default"), fallback.in("in"));
    flow.connect(branch.out("value"), approved.in("input"));
    flow.connect(branch.out("value"), fallback.in("input"));
    flow.connect(approved.out("out"), merge.in("in"));
    flow.connect(fallback.out("out"), merge.in("in"));
    flow.connect(approved.out("output"), merge.in("value"));
    flow.connect(fallback.out("output"), merge.in("value"));
    flow.connect(merge.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "merge_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("fallback:unknown");
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
