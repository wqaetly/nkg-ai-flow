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

  it("routes branch_timeout to timed_out from duration metadata", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "branch_timeout_duration_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const branch = flow.node("transform", {
      id: "branch",
      position: { x: 120, y: 0 },
      config: { value: { branch: "slow-api", durationMs: 1250 } },
    });
    const timeout = flow.node("branch_timeout", {
      id: "timeout",
      position: { x: 260, y: 0 },
      config: { timeoutMs: 1000 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "timeout:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), branch.in("in"));
    flow.connect(branch.out("out"), timeout.in("in"));
    flow.connect(branch.out("output"), timeout.in("branch"));
    flow.connect(timeout.out("timed_out"), report.in("in"));
    flow.connect(timeout.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "branch_timeout_duration_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timeout:timed_out");
  });

  it("routes branch_timeout to on_time from started and finished timestamps", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "branch_timeout_timestamps_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const branch = flow.node("transform", {
      id: "branch",
      position: { x: 120, y: 0 },
      config: {
        value: {
          startedAt: 1_000,
          finishedAt: 1_250,
        },
      },
    });
    const timeout = flow.node("branch_timeout", {
      id: "timeout",
      position: { x: 260, y: 0 },
      config: { timeoutMs: 500 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "timeout:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), branch.in("in"));
    flow.connect(branch.out("out"), timeout.in("in"));
    flow.connect(branch.out("output"), timeout.in("branch"));
    flow.connect(timeout.out("on_time"), report.in("in"));
    flow.connect(timeout.out("elapsedMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "branch_timeout_timestamps_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timeout:250");
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

  it("routes cron_schedule to due when the current minute matches", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "cron_schedule_due_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const cron = flow.node("cron_schedule", {
      id: "cron",
      position: { x: 120, y: 0 },
      config: { cron: "30 9 * * 1" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "cron=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), cron.in("in"));
    flow.connect(cron.out("due"), report.in("in"));
    flow.connect(cron.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cron_schedule_due_e2e",
      input: Date.UTC(2026, 0, 5, 9, 30),
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("cron=due");
  });

  it("routes cron_schedule to not_due and reports wait time", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "cron_schedule_not_due_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const cron = flow.node("cron_schedule", {
      id: "cron",
      position: { x: 120, y: 0 },
      config: { cron: "30 9 * * 1" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "wait=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), cron.in("in"));
    flow.connect(cron.out("not_due"), report.in("in"));
    flow.connect(cron.out("waitMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cron_schedule_not_due_e2e",
      input: Date.UTC(2026, 0, 5, 9, 29),
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("wait=60000");
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

  it("routes compare_gate to matched for numeric thresholds", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "compare_gate_matched_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { total: 125 } } },
    });
    const compare = flow.node("compare_gate", {
      id: "compare",
      position: { x: 280, y: 0 },
      config: {
        operator: "gte",
        leftPath: "order.total",
        rightValue: 100,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "match:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), compare.in("in"));
    flow.connect(input.out("output"), compare.in("left"));
    flow.connect(compare.out("matched"), report.in("in"));
    flow.connect(compare.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "compare_gate_matched_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("match:gte_matched");
  });

  it("routes compare_gate to unmatched for case-insensitive contains misses", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "compare_gate_unmatched_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { message: "Payment completed" } },
    });
    const compare = flow.node("compare_gate", {
      id: "compare",
      position: { x: 280, y: 0 },
      config: {
        operator: "contains",
        leftPath: "message",
        rightValue: "failed",
        caseSensitive: false,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "miss:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), compare.in("in"));
    flow.connect(input.out("output"), compare.in("left"));
    flow.connect(compare.out("unmatched"), report.in("in"));
    flow.connect(compare.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "compare_gate_unmatched_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("miss:contains_unmatched");
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

  it("transforms structured payloads with schema_transform mappings", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schema_transform_value_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: {
          id: "u1",
          profile: { name: "Ada" },
          status: "active",
        },
      },
    });
    const mapper = flow.node("schema_transform", {
      id: "mapper",
      position: { x: 280, y: 0 },
      config: {
        mappings: [
          "user.id = id",
          "user.name = profile.name",
          "state = status",
          "kind = \"customer\"",
        ].join("\n"),
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 440, y: 0 },
      config: { template: "mapped=${input.user.id}:${input.user.name}:${input.kind}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), mapper.in("in"));
    flow.connect(input.out("output"), mapper.in("input"));
    flow.connect(mapper.out("transformed"), report.in("in"));
    flow.connect(mapper.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schema_transform_value_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("mapped=u1:Ada:customer");
  });

  it("routes schema_transform to missing when required mappings are absent", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schema_transform_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { id: "u1" } },
    });
    const mapper = flow.node("schema_transform", {
      id: "mapper",
      position: { x: 280, y: 0 },
      config: {
        mappings: [
          "user.id = id",
          "user.email = email",
        ].join("\n"),
        requireAll: true,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 440, y: 0 },
      config: { template: "missing=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), mapper.in("in"));
    flow.connect(input.out("output"), mapper.in("input"));
    flow.connect(mapper.out("missing"), report.in("in"));
    flow.connect(mapper.out("missingCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schema_transform_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("missing=1");
  });

  it("selects the first successful fallback candidate", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "first_success_found_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const primary = flow.node("transform", {
      id: "primary",
      position: { x: 120, y: 40 },
      config: { value: { ok: false, error: "primary down", result: { text: "primary" } } },
    });
    const backup = flow.node("transform", {
      id: "backup",
      position: { x: 120, y: 140 },
      config: { value: { ok: true, result: { text: "backup" } } },
    });
    const last = flow.node("transform", {
      id: "last",
      position: { x: 120, y: 240 },
      config: { value: { ok: true, result: { text: "last" } } },
    });
    const selector = flow.node("first_success", {
      id: "selector",
      position: { x: 320, y: 140 },
      config: {
        mode: "ok",
        valuePath: "result.text",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 140 },
      config: { template: "chosen:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 660, y: 140 } });

    flow.connect(start.out("out"), primary.in("in"));
    flow.connect(start.out("out"), backup.in("in"));
    flow.connect(start.out("out"), last.in("in"));
    flow.connect(primary.out("output"), selector.in("candidates"));
    flow.connect(backup.out("output"), selector.in("candidates"));
    flow.connect(last.out("output"), selector.in("candidates"));
    flow.connect(selector.out("found"), report.in("in"));
    flow.connect(selector.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "first_success_found_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("chosen:backup");
  });

  it("routes first_success to missing when no candidate passes", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "first_success_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const primary = flow.node("transform", {
      id: "primary",
      position: { x: 120, y: 40 },
      config: { value: { status: "failed", error: "timeout" } },
    });
    const backup = flow.node("transform", {
      id: "backup",
      position: { x: 120, y: 140 },
      config: { value: { status: "pending" } },
    });
    const selector = flow.node("first_success", {
      id: "selector",
      position: { x: 320, y: 80 },
      config: {
        mode: "status",
        successValues: "ready,ok",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 80 },
      config: { template: "fallback:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 660, y: 80 } });

    flow.connect(start.out("out"), primary.in("in"));
    flow.connect(start.out("out"), backup.in("in"));
    flow.connect(primary.out("output"), selector.in("candidates"));
    flow.connect(backup.out("output"), selector.in("candidates"));
    flow.connect(selector.out("missing"), report.in("in"));
    flow.connect(selector.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "first_success_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("fallback:no_successful_candidate");
  });

  it("routes fallback to primary when the selected value is usable", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "fallback_primary_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { status: "ready", payload: { text: "live" } } },
    });
    const fallback = flow.node("fallback", {
      id: "fallback",
      position: { x: 300, y: 0 },
      config: {
        mode: "status",
        valuePath: "payload.text",
        fallbackValue: "cached",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 480, y: 0 },
      config: { template: "selected:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 640, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), fallback.in("in"));
    flow.connect(source.out("output"), fallback.in("value"));
    flow.connect(fallback.out("primary"), report.in("in"));
    flow.connect(fallback.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fallback_primary_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("selected:live");
  });

  it("routes fallback to fallback when the primary value carries an error", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "fallback_error_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { ok: true, result: "live", error: "upstream timeout" } },
    });
    const fallback = flow.node("fallback", {
      id: "fallback",
      position: { x: 300, y: 0 },
      config: {
        mode: "ok",
        valuePath: "result",
        fallbackValue: "cached",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 480, y: 0 },
      config: { template: "selected:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 640, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), fallback.in("in"));
    flow.connect(source.out("output"), fallback.in("value"));
    flow.connect(fallback.out("fallback"), report.in("in"));
    flow.connect(fallback.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fallback_error_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("selected:cached");
  });

  it("routes empty_gate to non_empty for populated arrays", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "empty_gate_non_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { items: ["order-1", "order-2"] } },
    });
    const gate = flow.node("empty_gate", {
      id: "gate",
      position: { x: 300, y: 0 },
      config: { path: "items" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 480, y: 0 },
      config: { template: "count:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 640, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), gate.in("in"));
    flow.connect(source.out("output"), gate.in("value"));
    flow.connect(gate.out("non_empty"), report.in("in"));
    flow.connect(gate.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "empty_gate_non_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("count:2");
  });

  it("routes empty_gate to empty for empty arrays", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "empty_gate_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { items: [] } },
    });
    const gate = flow.node("empty_gate", {
      id: "gate",
      position: { x: 300, y: 0 },
      config: { path: "items" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 480, y: 0 },
      config: { template: "empty:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 640, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), gate.in("in"));
    flow.connect(source.out("output"), gate.in("value"));
    flow.connect(gate.out("empty"), report.in("in"));
    flow.connect(gate.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "empty_gate_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("empty:array_empty");
  });

  it("routes cooldown_gate to ready, cooling, then ready after expiry", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cooldown_gate_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    start.addPort({ id: "runInput", direction: "output", kind: "data", label: "Run Input" });
    const gate = flow.node("cooldown_gate", {
      id: "gate",
      position: { x: 140, y: 80 },
      config: {
        name: "ALERT_COOLDOWN",
        durationMs: 1000,
      },
    });
    const ready = flow.node("transform", {
      id: "ready",
      position: { x: 320, y: 20 },
      config: { template: "ready:${input}" },
    });
    const cooling = flow.node("transform", {
      id: "cooling",
      position: { x: 320, y: 140 },
      config: { template: "cooling:${input}" },
    });
    const merge = flow.node("merge", { id: "merge", position: { x: 500, y: 80 } });
    const end = flow.node("end", { id: "e", position: { x: 660, y: 80 } });

    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(start.out("runInput"), gate.in("now"));
    flow.connect(gate.out("ready"), ready.in("in"));
    flow.connect(gate.out("cooling"), cooling.in("in"));
    flow.connect(gate.out("status"), ready.in("input"));
    flow.connect(gate.out("remainingMs"), cooling.in("input"));
    flow.connect(ready.out("out"), merge.in("in"));
    flow.connect(cooling.out("out"), merge.in("in"));
    flow.connect(ready.out("output"), merge.in("value"));
    flow.connect(cooling.out("output"), merge.in("value"));
    flow.connect(merge.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const first = await rt.invocationRouter.invoke({
      flowId: "cooldown_gate_e2e",
      input: 1000,
    });
    const second = await rt.invocationRouter.invoke({
      flowId: "cooldown_gate_e2e",
      input: 1400,
    });
    const third = await rt.invocationRouter.invoke({
      flowId: "cooldown_gate_e2e",
      input: 2100,
    });

    expect(first.succeeded).toBe(true);
    expect(second.succeeded).toBe(true);
    expect(third.succeeded).toBe(true);
    expect(first.output).toBe("ready:ready");
    expect(second.output).toBe("cooling:600");
    expect(third.output).toBe("ready:ready");
  });

  it("resets cooldown_gate state explicitly", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cooldown_gate_reset_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const gate = flow.node("cooldown_gate", {
      id: "gate",
      position: { x: 140, y: 0 },
      config: {
        name: "RESETTABLE_COOLDOWN",
        durationMs: 1000,
      },
    });
    const reset = flow.node("cooldown_gate", {
      id: "reset",
      position: { x: 300, y: 0 },
      config: {
        name: "RESETTABLE_COOLDOWN",
        mode: "reset",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "reset:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 0 } });

    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("ready"), reset.in("in"));
    flow.connect(reset.out("reset"), report.in("in"));
    flow.connect(reset.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cooldown_gate_reset_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("reset:reset");
    expect(variables.has("RESETTABLE_COOLDOWN")).toBe(false);
  });

  it("routes distinct_until_changed only when the selected value changes", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "distinct_until_changed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    start.addPort({ id: "runInput", direction: "output", kind: "data", label: "Run Input" });
    const distinct = flow.node("distinct_until_changed", {
      id: "distinct",
      position: { x: 140, y: 80 },
      config: {
        name: "ORDER_STATUS_STREAM",
        path: "status",
      },
    });
    const changed = flow.node("transform", {
      id: "changed",
      position: { x: 320, y: 20 },
      config: { template: "changed:${input}" },
    });
    const unchanged = flow.node("transform", {
      id: "unchanged",
      position: { x: 320, y: 140 },
      config: { template: "unchanged:${input}" },
    });
    const merge = flow.node("merge", { id: "merge", position: { x: 500, y: 80 } });
    const end = flow.node("end", { id: "e", position: { x: 660, y: 80 } });

    flow.connect(start.out("out"), distinct.in("in"));
    flow.connect(start.out("runInput"), distinct.in("value"));
    flow.connect(distinct.out("changed"), changed.in("in"));
    flow.connect(distinct.out("unchanged"), unchanged.in("in"));
    flow.connect(distinct.out("status"), changed.in("input"));
    flow.connect(distinct.out("status"), unchanged.in("input"));
    flow.connect(changed.out("out"), merge.in("in"));
    flow.connect(unchanged.out("out"), merge.in("in"));
    flow.connect(changed.out("output"), merge.in("value"));
    flow.connect(unchanged.out("output"), merge.in("value"));
    flow.connect(merge.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const first = await rt.invocationRouter.invoke({
      flowId: "distinct_until_changed_e2e",
      input: { status: "open" },
    });
    const second = await rt.invocationRouter.invoke({
      flowId: "distinct_until_changed_e2e",
      input: { status: "open" },
    });
    const third = await rt.invocationRouter.invoke({
      flowId: "distinct_until_changed_e2e",
      input: { status: "closed" },
    });

    expect(first.succeeded).toBe(true);
    expect(second.succeeded).toBe(true);
    expect(third.succeeded).toBe(true);
    expect(first.output).toBe("changed:changed");
    expect(second.output).toBe("unchanged:unchanged");
    expect(third.output).toBe("changed:changed");
  });

  it("can record the first distinct_until_changed value without emitting changed", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "distinct_until_changed_initial_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const distinct = flow.node("distinct_until_changed", {
      id: "distinct",
      position: { x: 140, y: 0 },
      config: {
        name: "BASELINE_STATUS_STREAM",
        emitInitial: false,
        value: "ready",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 320, y: 0 },
      config: { template: "initial:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 480, y: 0 } });

    flow.connect(start.out("out"), distinct.in("in"));
    flow.connect(distinct.out("unchanged"), report.in("in"));
    flow.connect(distinct.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "distinct_until_changed_initial_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("initial:unchanged");
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

  it("records retry_state failures and schedules the next retry", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_retry_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true } },
    });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-1",
        maxAttempts: 3,
        baseDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 1000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "retry:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), retry.in("in"));
    flow.connect(source.out("output"), retry.in("error"));
    flow.connect(retry.out("retry"), report.in("in"));
    flow.connect(retry.out("delayMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_state_retry_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:100");
    expect(variables.get("PAYMENT_RETRY:order-1")).toMatchObject({
      status: "waiting",
      attempt: 1,
      retryable: true,
      lastError: { code: "payment.timeout", retryable: true },
    });
  });

  it("routes retry_state check to waiting while backoff is active", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_RETRY:order-1", {
      status: "waiting",
      attempt: 1,
      maxAttempts: 3,
      retryable: true,
      lastError: { code: "payment.timeout", retryable: true },
      nextRetryAt: Date.now() + 60_000,
      exhaustedAt: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_waiting_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-1",
        mode: "check",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "waiting:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), retry.in("in"));
    flow.connect(retry.out("waiting"), report.in("in"));
    flow.connect(retry.out("attempt"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_state_waiting_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("waiting:1");
  });

  it("routes retry_state to exhausted when attempts reach the limit", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_RETRY:order-1", {
      status: "waiting",
      attempt: 1,
      maxAttempts: 2,
      retryable: true,
      lastError: { code: "payment.timeout", retryable: true },
      nextRetryAt: Date.now() - 1,
      exhaustedAt: null,
      updatedAt: Date.now() - 1000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_exhausted_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true } },
    });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-1",
        maxAttempts: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "exhausted:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), retry.in("in"));
    flow.connect(source.out("output"), retry.in("error"));
    flow.connect(retry.out("exhausted"), report.in("in"));
    flow.connect(retry.out("attempt"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_state_exhausted_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("exhausted:2");
    expect(variables.get("PAYMENT_RETRY:order-1")).toMatchObject({
      status: "exhausted",
      attempt: 2,
    });
  });

  it("resets retry_state after a successful attempt", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_RETRY:order-1", {
      status: "waiting",
      attempt: 1,
      maxAttempts: 3,
      retryable: true,
      lastError: { code: "payment.timeout", retryable: true },
      nextRetryAt: Date.now() + 60_000,
      exhaustedAt: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_reset_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-1",
        mode: "record_success",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "reset:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), retry.in("in"));
    flow.connect(retry.out("reset"), report.in("in"));
    flow.connect(retry.out("attempt"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_state_reset_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("reset:0");
    expect(variables.has("PAYMENT_RETRY:order-1")).toBe(false);
  });

  it("routes error_classifier to matched by error code and category", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "error_classifier_matched_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const classifier = flow.node("error_classifier", {
      id: "classifier",
      position: { x: 260, y: 0 },
      config: {
        codes: "node.http.*",
        categories: "author",
        label: "author_http",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "class:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), failing.in("in"));
    flow.connect(failing.out("error"), classifier.in("error"));
    flow.connect(classifier.out("matched"), report.in("in"));
    flow.connect(classifier.out("label"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "error_classifier_matched_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("class:author_http");
  });

  it("routes error_classifier to unmatched when filters do not match", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "error_classifier_unmatched_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const classifier = flow.node("error_classifier", {
      id: "classifier",
      position: { x: 260, y: 0 },
      config: {
        codes: "node.llm.*",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "miss:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), failing.in("in"));
    flow.connect(failing.out("error"), classifier.in("error"));
    flow.connect(classifier.out("unmatched"), report.in("in"));
    flow.connect(classifier.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "error_classifier_unmatched_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("miss:code_mismatch");
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

  it("routes drained compensation actions into a rollback branch", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "rollback_plan_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const first = flow.node("compensation", {
      id: "first",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_ROLLBACKS",
        mode: "register",
        action: "release_inventory",
        payload: { sku: "book", quantity: 1 },
      },
    });
    const second = flow.node("compensation", {
      id: "second",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_ROLLBACKS",
        mode: "register",
        action: "refund_payment",
        payload: { paymentId: "pay_1" },
      },
    });
    const drain = flow.node("compensation", {
      id: "drain",
      position: { x: 400, y: 0 },
      config: {
        name: "ORDER_ROLLBACKS",
        mode: "drain",
      },
    });
    const rollback = flow.node("rollback", {
      id: "rollback",
      position: { x: 540, y: 0 },
      config: { mode: "plan" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 680, y: 0 },
      config: { template: "rollback:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 820, y: 0 } });

    flow.connect(start.out("out"), first.in("in"));
    flow.connect(first.out("out"), second.in("in"));
    flow.connect(second.out("out"), drain.in("in"));
    flow.connect(drain.out("out"), rollback.in("in"));
    flow.connect(drain.out("actions"), rollback.in("actions"));
    flow.connect(rollback.out("rollback"), report.in("in"));
    flow.connect(rollback.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rollback_plan_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("rollback:2");
    expect(variables.get("ORDER_ROLLBACKS")).toMatchObject({
      actions: [],
    });
  });

  it("routes rollback to empty when there are no compensation actions", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "rollback_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const rollback = flow.node("rollback", {
      id: "rollback",
      position: { x: 120, y: 0 },
      config: { mode: "plan" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "rollback:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), rollback.in("in"));
    flow.connect(rollback.out("empty"), report.in("in"));
    flow.connect(rollback.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rollback_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("rollback:empty");
  });

  it("summarizes rollback results as partial success", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "rollback_partial_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const actions = flow.node("transform", {
      id: "actions",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { id: "a1", action: "release_inventory", payload: { sku: "book" }, registeredAt: 1 },
          { id: "a2", action: "refund_payment", payload: { paymentId: "pay_1" }, registeredAt: 2 },
        ],
      },
    });
    const results = flow.node("transform", {
      id: "results",
      position: { x: 260, y: 0 },
      config: {
        value: [
          { status: "succeeded" },
          { status: "failed", error: "refund_failed" },
        ],
      },
    });
    const rollback = flow.node("rollback", {
      id: "rollback",
      position: { x: 400, y: 0 },
      config: { mode: "summarize" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "partial:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), actions.in("in"));
    flow.connect(actions.out("out"), results.in("in"));
    flow.connect(results.out("out"), rollback.in("in"));
    flow.connect(actions.out("output"), rollback.in("actions"));
    flow.connect(results.out("output"), rollback.in("results"));
    flow.connect(rollback.out("partial"), report.in("in"));
    flow.connect(rollback.out("failureCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rollback_partial_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("partial:1");
  });

  it("marks and loads a resume_point recovery target", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const markFlow = defineFlow({ id: "resume_point_mark_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const markStart = markFlow.node("start", { id: "mark_start", position: { x: 0, y: 0 } });
    const mark = markFlow.node("resume_point", {
      id: "mark",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RESUME_POINT",
        mode: "mark",
        targetNodeId: "charge_payment",
        snapshot: { orderId: "order-1", step: "charge_payment" },
        reason: "payment timeout",
      },
    });
    const markReport = markFlow.node("transform", {
      id: "mark_report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const markEnd = markFlow.node("end", { id: "mark_end", position: { x: 400, y: 0 } });
    markFlow.connect(markStart.out("out"), mark.in("in"));
    markFlow.connect(mark.out("marked"), markReport.in("in"));
    markFlow.connect(mark.out("status"), markReport.in("input"));
    markFlow.connect(markReport.out("out"), markEnd.in("in"));

    const loadFlow = defineFlow({ id: "resume_point_load_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const loadStart = loadFlow.node("start", { id: "load_start", position: { x: 0, y: 0 } });
    const load = loadFlow.node("resume_point", {
      id: "load",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RESUME_POINT",
        mode: "load",
      },
    });
    const loadReport = loadFlow.node("transform", {
      id: "load_report",
      position: { x: 260, y: 0 },
      config: { template: "target:${input}" },
    });
    const loadEnd = loadFlow.node("end", { id: "load_end", position: { x: 400, y: 0 } });
    loadFlow.connect(loadStart.out("out"), load.in("in"));
    loadFlow.connect(load.out("ready"), loadReport.in("in"));
    loadFlow.connect(load.out("targetNodeId"), loadReport.in("input"));
    loadFlow.connect(loadReport.out("out"), loadEnd.in("in"));

    await registerAndPromote(rt, markFlow);
    await registerAndPromote(rt, loadFlow);

    const marked = await rt.invocationRouter.invoke({
      flowId: "resume_point_mark_e2e",
      input: null,
    });
    expect(marked.succeeded).toBe(true);
    expect(marked.output).toBe("resume:marked");
    expect(variables.get("ORDER_RESUME_POINT")).toMatchObject({
      status: "ready",
      targetNodeId: "charge_payment",
      reason: "payment timeout",
      snapshot: { orderId: "order-1", step: "charge_payment" },
    });

    const loaded = await rt.invocationRouter.invoke({
      flowId: "resume_point_load_e2e",
      input: null,
    });
    expect(loaded.succeeded).toBe(true);
    expect(loaded.output).toBe("target:charge_payment");
  });

  it("routes resume_point load to missing when no recovery target exists", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "resume_point_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const load = flow.node("resume_point", {
      id: "load",
      position: { x: 120, y: 0 },
      config: {
        name: "MISSING_RESUME_POINT",
        mode: "load",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), load.in("in"));
    flow.connect(load.out("missing"), report.in("in"));
    flow.connect(load.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "resume_point_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:missing");
  });

  it("routes resume_point load to expired after its TTL window", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "charge_payment",
      snapshot: { orderId: "order-1" },
      reason: "payment timeout",
      sourceRunId: "run_1",
      version: 1,
      markedAt: Date.now() - 10_000,
      loadedAt: null,
      expiresAt: Date.now() - 1,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "resume_point_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const load = flow.node("resume_point", {
      id: "load",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RESUME_POINT",
        mode: "load",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), load.in("in"));
    flow.connect(load.out("expired"), report.in("in"));
    flow.connect(load.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "resume_point_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:expired");
    expect(variables.get("ORDER_RESUME_POINT")).toMatchObject({
      status: "expired",
      targetNodeId: "charge_payment",
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

  it("resumes a wait_signal checkpoint through signal_resume", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const waitFlow = defineFlow({ id: "signal_resume_wait_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const waitStart = waitFlow.node("start", { id: "wait_start", position: { x: 0, y: 0 } });
    const wait = waitFlow.node("wait_signal", {
      id: "wait",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL",
        expected: "approved",
      },
    });
    const waitWaitingReport = waitFlow.node("transform", {
      id: "wait_waiting_report",
      position: { x: 260, y: 0 },
      config: { template: "wait:${input}" },
    });
    const waitReceivedReport = waitFlow.node("transform", {
      id: "wait_received_report",
      position: { x: 260, y: 120 },
      config: { template: "wait:${input}" },
    });
    const waitWaitingEnd = waitFlow.node("end", { id: "wait_waiting_end", position: { x: 400, y: 0 } });
    const waitReceivedEnd = waitFlow.node("end", { id: "wait_received_end", position: { x: 400, y: 120 } });
    waitFlow.connect(waitStart.out("out"), wait.in("in"));
    waitFlow.connect(wait.out("waiting"), waitWaitingReport.in("in"));
    waitFlow.connect(wait.out("status"), waitWaitingReport.in("input"));
    waitFlow.connect(waitWaitingReport.out("out"), waitWaitingEnd.in("in"));
    waitFlow.connect(wait.out("received"), waitReceivedReport.in("in"));
    waitFlow.connect(wait.out("status"), waitReceivedReport.in("input"));
    waitFlow.connect(waitReceivedReport.out("out"), waitReceivedEnd.in("in"));

    const resumeFlow = defineFlow({ id: "signal_resume_write_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const resumeStart = resumeFlow.node("start", { id: "resume_start", position: { x: 0, y: 0 } });
    const resume = resumeFlow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL",
        signal: "approved",
      },
    });
    const resumeReport = resumeFlow.node("transform", {
      id: "resume_report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const resumeEnd = resumeFlow.node("end", { id: "resume_end", position: { x: 400, y: 0 } });
    resumeFlow.connect(resumeStart.out("out"), resume.in("in"));
    resumeFlow.connect(resume.out("resumed"), resumeReport.in("in"));
    resumeFlow.connect(resume.out("status"), resumeReport.in("input"));
    resumeFlow.connect(resumeReport.out("out"), resumeEnd.in("in"));

    await registerAndPromote(rt, waitFlow);
    await registerAndPromote(rt, resumeFlow);

    const waiting = await rt.invocationRouter.invoke({
      flowId: "signal_resume_wait_e2e",
      input: null,
    });
    expect(waiting.succeeded).toBe(true);
    expect(waiting.output).toBe("wait:waiting");

    const resumed = await rt.invocationRouter.invoke({
      flowId: "signal_resume_write_e2e",
      input: null,
    });
    expect(resumed.succeeded).toBe(true);
    expect(resumed.output).toBe("resume:resumed");
    expect(variables.get("ORDER_APPROVAL_SIGNAL")).toMatchObject({
      status: "received",
      signal: "approved",
      expected: "approved",
    });

    const received = await rt.invocationRouter.invoke({
      flowId: "signal_resume_wait_e2e",
      input: null,
    });
    expect(received.succeeded).toBe(true);
    expect(received.output).toBe("wait:received");
  });

  it("routes signal_resume to missing when the wait state is absent", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "signal_resume_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const resume = flow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "MISSING_APPROVAL_SIGNAL",
        signal: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), resume.in("in"));
    flow.connect(resume.out("missing"), report.in("in"));
    flow.connect(resume.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "signal_resume_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:missing");
    expect(variables.has("MISSING_APPROVAL_SIGNAL")).toBe(false);
  });

  it("routes signal_resume to ignored when the signal does not match", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_SIGNAL", {
      status: "waiting",
      signal: null,
      expected: "approved",
      requestedAt: Date.now(),
      expiresAt: null,
      updatedAt: Date.now(),
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "signal_resume_ignored_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const resume = flow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL",
        signal: "denied",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), resume.in("in"));
    flow.connect(resume.out("ignored"), report.in("in"));
    flow.connect(resume.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "signal_resume_ignored_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:ignored");
    expect(variables.get("ORDER_APPROVAL_SIGNAL")).toMatchObject({
      status: "waiting",
      signal: "denied",
      expected: "approved",
    });
  });

  it("routes signal_resume to expired when the wait state has timed out", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_SIGNAL", {
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
    const flow = defineFlow({ id: "signal_resume_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const resume = flow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL",
        signal: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), resume.in("in"));
    flow.connect(resume.out("expired"), report.in("in"));
    flow.connect(resume.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "signal_resume_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:expired");
    expect(variables.get("ORDER_APPROVAL_SIGNAL")).toMatchObject({
      status: "expired",
      signal: "approved",
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

  it("creates a wait_timer checkpoint and routes to waiting", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_timer_waiting_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const timer = flow.node("wait_timer", {
      id: "timer",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RETRY_TIMER",
        durationMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "timer:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), timer.in("in"));
    flow.connect(timer.out("waiting"), report.in("in"));
    flow.connect(timer.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_timer_waiting_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timer:waiting");
    expect(variables.get("ORDER_RETRY_TIMER")).toMatchObject({
      status: "waiting",
    });
    expect((variables.get("ORDER_RETRY_TIMER") as { dueAt?: number }).dueAt).toBeGreaterThan(
      Date.now(),
    );
  });

  it("routes wait_timer to due when a stored timer has reached its due time", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_RETRY_TIMER", {
      status: "waiting",
      requestedAt: Date.now() - 10_000,
      dueAt: Date.now() - 1,
      timeoutAt: null,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_timer_due_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const timer = flow.node("wait_timer", {
      id: "timer",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RETRY_TIMER",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "timer:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), timer.in("in"));
    flow.connect(timer.out("due"), report.in("in"));
    flow.connect(timer.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_timer_due_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timer:due");
    expect(variables.get("ORDER_RETRY_TIMER")).toMatchObject({
      status: "due",
    });
  });

  it("routes wait_timer to expired when the due window is missed", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_RETRY_TIMER", {
      status: "waiting",
      requestedAt: Date.now() - 10_000,
      dueAt: Date.now() - 5_000,
      timeoutAt: Date.now() - 1,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_timer_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const timer = flow.node("wait_timer", {
      id: "timer",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RETRY_TIMER",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "timer:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), timer.in("in"));
    flow.connect(timer.out("expired"), report.in("in"));
    flow.connect(timer.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_timer_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timer:expired");
    expect(variables.get("ORDER_RETRY_TIMER")).toMatchObject({
      status: "expired",
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
    expect(childRuns[0]?.subflowDepth).toBe(1);
  });

  it("invokes a reusable child flow with subflow_template defaults", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "template_child_echo", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const childTransform = child.node("transform", {
      id: "child_transform",
      position: { x: 120, y: 0 },
      config: { template: "child:${input.name}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), childTransform.in("in"));
    child.connect(childTransform.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_calls_template_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "echo_order",
        inputMode: "template",
        templates: {
          echo_order: {
            flowId: "template_child_echo",
            flowVersion: "1.0.0",
            input: { name: "Ada" },
          },
        },
      },
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
      flowId: "parent_calls_template_child",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:child:Ada");
    const childRuns = await rt.runStore.listByFlow("template_child_echo");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.flowVersion).toBe("1.0.0");
    expect(childRuns[0]?.subflowDepth).toBe(1);
  });

  it("routes subflow_template to missing when the template id is absent", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_missing_template", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "missing_template",
        templates: {
          echo_order: {
            flowId: "template_child_echo",
            flowVersion: "1.0.0",
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "template:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("missing"), report.in("in"));
    parent.connect(call.out("status"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_missing_template",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("template:missing");
    expect(await rt.runStore.listByFlow("template_child_echo")).toEqual([]);
  });

  it("routes failed subflow_template child runs when failOnError is false", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "template_child_fails", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const broken = child.node("http", {
      id: "broken_http",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), broken.in("in"));
    child.connect(broken.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_template_failed_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "broken_template",
        failOnError: false,
        templates: {
          broken_template: {
            flowId: "template_child_fails",
            flowVersion: "1.0.0",
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "child:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("failed"), report.in("in"));
    parent.connect(call.out("status"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_failed_child",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("child:failed");
    const childRuns = await rt.runStore.listByFlow("template_child_fails");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("failed");
  });

  it("blocks subflow invocation when maxDepth is reached", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_depth_limit", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: { flowId: "child_depth_limit", maxDepth: 0 },
    });
    const end = parent.node("end", { id: "e", position: { x: 280, y: 0 } });
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("succeeded"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_depth_limit",
      input: null,
    });

    expect(result.succeeded).toBe(false);
    expect(result.error?.code).toBe("node.subflow.max_depth_exceeded");
    expect(await rt.runStore.listByFlow("child_depth_limit")).toEqual([]);
  });

  it("passes subflow local variables as child-scoped overrides", async () => {
    const variables = new InMemoryVariableStore([
      { name: "TENANT", value: "global" },
    ]);
    const rt = newRuntime({ variables });
    const child = defineFlow({ id: "child_reads_local_var", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const getTenant = child.node("state_get", {
      id: "get_tenant",
      position: { x: 120, y: 0 },
      config: { name: "TENANT" },
    });
    const childReport = child.node("transform", {
      id: "child_report",
      position: { x: 260, y: 0 },
      config: { template: "tenant=${input}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 400, y: 0 } });
    child.connect(childStart.out("out"), getTenant.in("in"));
    child.connect(getTenant.out("out"), childReport.in("in"));
    child.connect(getTenant.out("value"), childReport.in("input"));
    child.connect(childReport.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_local_var_override", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: {
        flowId: "child_reads_local_var",
        localVariables: { TENANT: "local" },
      },
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
      flowId: "parent_local_var_override",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:tenant=local");
    expect(variables.get("TENANT")).toBe("global");
  });

  it("keeps subflow local state writes isolated from the parent variable store", async () => {
    const variables = new InMemoryVariableStore();
    const rt = newRuntime({ variables });
    const child = defineFlow({ id: "child_writes_local_state", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const setState = child.node("state_set", {
      id: "set_tmp",
      position: { x: 120, y: 0 },
      config: { name: "CHILD_TMP", value: "local-write" },
    });
    const getState = child.node("state_get", {
      id: "get_tmp",
      position: { x: 260, y: 0 },
      config: { name: "CHILD_TMP" },
    });
    const childReport = child.node("transform", {
      id: "child_report",
      position: { x: 400, y: 0 },
      config: { template: "child=${input}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 540, y: 0 } });
    child.connect(childStart.out("out"), setState.in("in"));
    child.connect(setState.out("out"), getState.in("in"));
    child.connect(getState.out("out"), childReport.in("in"));
    child.connect(getState.out("value"), childReport.in("input"));
    child.connect(childReport.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_local_state_isolated", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: {
        flowId: "child_writes_local_state",
        localScope: true,
      },
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
      flowId: "parent_local_state_isolated",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:child=local-write");
    expect(variables.has("CHILD_TMP")).toBe(false);
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

  it("routes subflow input contract failures without invoking the child flow", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_input_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: {
        flowId: "child_input_contract",
        contractMode: "route",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "input-contract:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });

    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("contract_failed"), report.in("in"));
    parent.connect(call.out("contractIssueCount"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_input_contract",
      input: { id: "missing-name" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("input-contract:1");
    expect(await rt.runStore.listByFlow("child_input_contract")).toEqual([]);
  });

  it("routes subflow output contract failures after a successful child run", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "child_output_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const childTransform = child.node("transform", {
      id: "child_transform",
      position: { x: 120, y: 0 },
      config: { template: "child:${input.name}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), childTransform.in("in"));
    child.connect(childTransform.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_output_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 140, y: 0 },
      config: {
        flowId: "child_output_contract",
        contractMode: "route",
        outputSchema: {
          type: "object",
          required: ["ok"],
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "output-contract:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });

    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("contract_failed"), report.in("in"));
    parent.connect(call.out("contractStage"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_output_contract",
      input: { name: "Ada" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("output-contract:output");
    const childRuns = await rt.runStore.listByFlow("child_output_contract");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("succeeded");
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

  it("continues through quorum once the threshold of values arrives", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "quorum_met_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 120, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 120, y: 140 },
      config: { template: "lower:${input.name}" },
    });
    const branch = flow.node("condition", {
      id: "branch",
      position: { x: 120, y: 240 },
      config: { expression: "input.enabled" },
    });
    const skipped = flow.node("transform", {
      id: "skipped",
      position: { x: 280, y: 240 },
      config: { template: "skipped:${input.name}" },
    });
    const quorum = flow.node("quorum", {
      id: "quorum",
      position: { x: 440, y: 120 },
      config: { threshold: 2 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 120 },
      config: { template: "quorum:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 760, y: 120 } });

    flow.connect(start.out("out"), upper.in("in"));
    flow.connect(start.out("out"), lower.in("in"));
    flow.connect(start.out("out"), branch.in("in"));
    flow.connect(branch.out("true"), skipped.in("in"));
    flow.connect(upper.out("output"), quorum.in("values"));
    flow.connect(lower.out("output"), quorum.in("values"));
    flow.connect(skipped.out("output"), quorum.in("values"));
    flow.connect(quorum.out("met"), report.in("in"));
    flow.connect(quorum.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "quorum_met_e2e",
      input: { name: "Flow", enabled: false },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("quorum:upper:Flow,lower:Flow");
  });

  it("routes quorum to unmet when all reachable values stay below threshold", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "quorum_unmet_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 120, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 120, y: 140 },
      config: { template: "lower:${input.name}" },
    });
    const quorum = flow.node("quorum", {
      id: "quorum",
      position: { x: 300, y: 80 },
      config: { threshold: 3 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 80 },
      config: { template: "remaining:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 80 } });

    flow.connect(start.out("out"), upper.in("in"));
    flow.connect(start.out("out"), lower.in("in"));
    flow.connect(upper.out("output"), quorum.in("values"));
    flow.connect(lower.out("output"), quorum.in("values"));
    flow.connect(quorum.out("unmet"), report.in("in"));
    flow.connect(quorum.out("remaining"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "quorum_unmet_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("remaining:1");
  });

  it("races the first reachable branch without waiting for unreachable siblings", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "race_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const fast = flow.node("transform", {
      id: "fast",
      position: { x: 140, y: 40 },
      config: { value: "fast" },
    });
    const gate = flow.node("condition", {
      id: "gate",
      position: { x: 140, y: 200 },
      config: { expression: "input.runSlow" },
    });
    const slow = flow.node("transform", {
      id: "slow",
      position: { x: 300, y: 200 },
      config: { value: "slow" },
    });
    const race = flow.node("race", { id: "race", position: { x: 460, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 620, y: 120 },
      config: { template: "winner=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 780, y: 120 } });

    flow.connect(start.out("out"), fast.in("in"));
    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("true"), slow.in("in"));
    flow.connect(fast.out("out"), race.in("in"));
    flow.connect(slow.out("out"), race.in("in"));
    flow.connect(fast.out("output"), race.in("values"));
    flow.connect(slow.out("output"), race.in("values"));
    flow.connect(race.out("winner"), report.in("in"));
    flow.connect(race.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "race_e2e",
      input: { runSlow: false },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("winner=fast");
  });

  it("routes race to empty when no value has arrived", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "race_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const race = flow.node("race", { id: "race", position: { x: 160, y: 0 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 320, y: 0 },
      config: { template: "status=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 480, y: 0 } });

    flow.connect(start.out("out"), race.in("in"));
    flow.connect(race.out("empty"), report.in("in"));
    flow.connect(race.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "race_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("status=empty");
  });

  it("routes fail_fast on the first reachable branch error", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "fail_fast_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const firstError = flow.node("transform", {
      id: "first_error",
      position: { x: 140, y: 40 },
      config: { value: { code: "branch.a_failed", message: "A failed" } },
    });
    const gate = flow.node("condition", {
      id: "gate",
      position: { x: 140, y: 200 },
      config: { expression: "input.runSecond" },
    });
    const secondError = flow.node("transform", {
      id: "second_error",
      position: { x: 300, y: 200 },
      config: { value: { code: "branch.b_failed", message: "B failed" } },
    });
    const failFast = flow.node("fail_fast", {
      id: "fail_fast",
      position: { x: 460, y: 120 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 620, y: 120 },
      config: { template: "failed=${input.code}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 780, y: 120 } });

    flow.connect(start.out("out"), firstError.in("in"));
    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(gate.out("true"), secondError.in("in"));
    flow.connect(firstError.out("output"), failFast.in("errors"));
    flow.connect(secondError.out("output"), failFast.in("errors"));
    flow.connect(failFast.out("failed"), report.in("in"));
    flow.connect(failFast.out("error"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fail_fast_e2e",
      input: { runSecond: false },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("failed=branch.a_failed");
  });

  it("routes partial_success to partial when enough branches pass", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "partial_success_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const okA = flow.node("transform", {
      id: "ok_a",
      position: { x: 140, y: 20 },
      config: { value: { status: "ok", label: "a" } },
    });
    const failed = flow.node("transform", {
      id: "failed",
      position: { x: 140, y: 120 },
      config: { value: { status: "failed", error: "branch failed", label: "b" } },
    });
    const okC = flow.node("transform", {
      id: "ok_c",
      position: { x: 140, y: 220 },
      config: { value: { status: "ready", label: "c" } },
    });
    const partial = flow.node("partial_success", {
      id: "partial",
      position: { x: 320, y: 120 },
      config: { mode: "status", minSuccess: 2 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 120 },
      config: { template: "partial=${input.successCount}/${input.total}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 120 } });

    flow.connect(start.out("out"), okA.in("in"));
    flow.connect(start.out("out"), failed.in("in"));
    flow.connect(start.out("out"), okC.in("in"));
    flow.connect(okA.out("output"), partial.in("results"));
    flow.connect(failed.out("output"), partial.in("results"));
    flow.connect(okC.out("output"), partial.in("results"));
    flow.connect(partial.out("partial"), report.in("in"));
    flow.connect(partial.out("summary"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "partial_success_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("partial=2/3");
  });

  it("routes partial_success to failed when too few branches pass", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "partial_success_failed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const ok = flow.node("transform", {
      id: "ok",
      position: { x: 140, y: 20 },
      config: { value: { ok: true, label: "a" } },
    });
    const bad = flow.node("transform", {
      id: "bad",
      position: { x: 140, y: 140 },
      config: { value: { ok: false, error: "bad", label: "b" } },
    });
    const partial = flow.node("partial_success", {
      id: "partial",
      position: { x: 320, y: 80 },
      config: { mode: "ok", minSuccess: 2 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 80 },
      config: { template: "failed=${input.successCount}/${input.total}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 80 } });

    flow.connect(start.out("out"), ok.in("in"));
    flow.connect(start.out("out"), bad.in("in"));
    flow.connect(ok.out("output"), partial.in("results"));
    flow.connect(bad.out("output"), partial.in("results"));
    flow.connect(partial.out("failed"), report.in("in"));
    flow.connect(partial.out("summary"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "partial_success_failed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("failed=1/2");
  });

  it("routes any_success when at least one branch result succeeds", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "any_success_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { status: "failed", error: "api timeout" },
          { status: "succeeded", value: "fresh" },
        ],
      },
    });
    const any = flow.node("any_success", {
      id: "any",
      position: { x: 260, y: 0 },
      config: { mode: "status" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "any=${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), any.in("results"));
    flow.connect(any.out("any_success"), report.in("in"));
    flow.connect(any.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "any_success_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("any=succeeded");
  });

  it("routes any_success to no_success when every result fails", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "any_success_none_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { status: "failed", error: "api timeout" },
          { status: "rejected" },
        ],
      },
    });
    const any = flow.node("any_success", {
      id: "any",
      position: { x: 260, y: 0 },
      config: { mode: "status" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "any=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), any.in("results"));
    flow.connect(any.out("no_success"), report.in("in"));
    flow.connect(any.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "any_success_none_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("any=no_success");
  });

  it("routes any_success to empty when no result has arrived", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "any_success_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: [] },
    });
    const any = flow.node("any_success", {
      id: "any",
      position: { x: 260, y: 0 },
      config: { mode: "status" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "any=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), any.in("results"));
    flow.connect(any.out("empty"), report.in("in"));
    flow.connect(any.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "any_success_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("any=empty");
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

  it("evaluates expressions with expression_eval", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "expression_eval_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: {
          amount: 12,
          status: "ready",
          tags: ["api", "batch"],
        },
      },
    });
    const expression = flow.node("expression_eval", {
      id: "expression",
      position: { x: 260, y: 0 },
      config: {
        expression: "input.amount >= 10 && input.status == 'ready' && contains(input.tags, 'batch')",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "truthy=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), expression.in("in"));
    flow.connect(input.out("output"), expression.in("input"));
    flow.connect(expression.out("out"), report.in("in"));
    flow.connect(expression.out("truthy"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "expression_eval_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("truthy=true");
  });

  it("routes condition branches with numeric and boolean expressions", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "condition_expression_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const condition = flow.node("condition", {
      id: "condition",
      position: { x: 160, y: 120 },
      config: {
        expression: "input.retryable && input.attempts < 3 && input.code != 'fatal'",
      },
    });
    const yes = flow.node("transform", {
      id: "yes",
      position: { x: 320, y: 40 },
      config: { value: "retry" },
    });
    const no = flow.node("transform", {
      id: "no",
      position: { x: 320, y: 200 },
      config: { value: "stop" },
    });
    const merge = flow.node("merge", { id: "merge", position: { x: 480, y: 120 } });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 120 } });

    flow.connect(start.out("out"), condition.in("in"));
    flow.connect(condition.out("true"), yes.in("in"));
    flow.connect(condition.out("false"), no.in("in"));
    flow.connect(yes.out("out"), merge.in("in"));
    flow.connect(no.out("out"), merge.in("in"));
    flow.connect(yes.out("output"), merge.in("value"));
    flow.connect(no.out("output"), merge.in("value"));
    flow.connect(merge.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "condition_expression_e2e",
      input: {
        attempts: 2,
        retryable: true,
        code: "rate_limit",
      },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry");
  });

  it("filters array items with numeric expressions", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "filter_items_expression_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { id: "a", score: 2, tags: ["cold"] },
          { id: "b", score: 5, tags: ["hot", "ready"] },
          { id: "c", score: 8, tags: ["ready"] },
        ],
      },
    });
    const filter = flow.node("filter_items", {
      id: "filter",
      position: { x: 260, y: 0 },
      config: { condition: "item.score >= 5 && contains(item.tags, 'ready')" },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${item.id}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "kept=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), filter.in("in"));
    flow.connect(input.out("output"), filter.in("items"));
    flow.connect(filter.out("out"), map.in("in"));
    flow.connect(filter.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "filter_items_expression_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("kept=b,c");
  });

  it("concatenates array sources with concat_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "concat_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const first = flow.node("transform", {
      id: "first",
      position: { x: 120, y: 20 },
      config: { value: ["a", "b"] },
    });
    const second = flow.node("transform", {
      id: "second",
      position: { x: 120, y: 140 },
      config: { value: ["c"] },
    });
    const concat = flow.node("concat_items", {
      id: "concat",
      position: { x: 280, y: 80 },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 420, y: 80 },
      config: { template: "${index}:${item}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 560, y: 80 },
      config: { template: "concat=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 700, y: 80 } });

    flow.connect(start.out("out"), first.in("in"));
    flow.connect(start.out("out"), second.in("in"));
    flow.connect(first.out("out"), concat.in("in"));
    flow.connect(second.out("out"), concat.in("in"));
    flow.connect(first.out("output"), concat.in("items"));
    flow.connect(second.out("output"), concat.in("items"));
    flow.connect(concat.out("out"), map.in("in"));
    flow.connect(concat.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "concat_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("concat=0:a,1:b,2:c");
  });

  it("splits text into array items with split_text", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "split_text_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: " alpha\n\nbeta \ngamma " },
    });
    const split = flow.node("split_text", {
      id: "split",
      position: { x: 260, y: 0 },
      config: { mode: "lines", trimItems: true, dropEmpty: true },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${index}:${item}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "split=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), split.in("in"));
    flow.connect(input.out("output"), split.in("text"));
    flow.connect(split.out("out"), map.in("in"));
    flow.connect(split.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "split_text_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("split=0:alpha,1:beta,2:gamma");
  });

  it("parses fenced JSON text and routes structured data with parse_json", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "parse_json_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: '```json\n{"kind":"order","items":["a","b"]}\n```' },
    });
    const parse = flow.node("parse_json", {
      id: "parse",
      position: { x: 260, y: 0 },
    });
    const route = flow.node("switch_case", {
      id: "route",
      position: { x: 400, y: 0 },
      config: { path: "value.kind", case1: "order" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "order=${input.items}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), parse.in("in"));
    flow.connect(input.out("output"), parse.in("text"));
    flow.connect(parse.out("parsed"), route.in("in"));
    flow.connect(parse.out("value"), route.in("value"));
    flow.connect(route.out("case1"), report.in("in"));
    flow.connect(route.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "parse_json_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("order=a,b");
  });

  it("routes invalid JSON text through parse_json invalid branch", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "parse_json_invalid_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: "{ invalid json" },
    });
    const parse = flow.node("parse_json", {
      id: "parse",
      position: { x: 260, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "bad=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), parse.in("in"));
    flow.connect(input.out("output"), parse.in("text"));
    flow.connect(parse.out("invalid"), report.in("in"));
    flow.connect(parse.out("errorMessage"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "parse_json_invalid_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toContain("bad=");
  });

  it("stringifies structured data with stable sorted keys using stringify_json", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "stringify_json_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { b: 2, a: { d: 4, c: 3 } } },
    });
    const stringify = flow.node("stringify_json", {
      id: "stringify",
      position: { x: 260, y: 0 },
      config: { sortKeys: true },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "json=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), stringify.in("in"));
    flow.connect(input.out("output"), stringify.in("value"));
    flow.connect(stringify.out("stringified"), report.in("in"));
    flow.connect(stringify.out("text"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "stringify_json_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe('json={"a":{"c":3,"d":4},"b":2}');
  });

  it("routes stringify_json failures without failing the run", async () => {
    const emitBigIntNode = defineNode({
      type: "emit_bigint",
      typeVersion: "1.0.0",
      title: "Emit BigInt",
      ports: [
        { id: "value", direction: "output", kind: "data", label: "Value" },
      ],
      validateInput: false,
      run() {
        return {
          kind: "success",
          outputs: { out: null, value: 1n },
        };
      },
    });
    const rt = newRuntime({ nodes: [emitBigIntNode] });
    const flow = defineFlow({ id: "stringify_json_failed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("emit_bigint", { id: "input", position: { x: 120, y: 0 } });
    const stringify = flow.node("stringify_json", {
      id: "stringify",
      position: { x: 260, y: 0 },
      config: { bigintMode: "error" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "failed=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), stringify.in("in"));
    flow.connect(input.out("value"), stringify.in("value"));
    flow.connect(stringify.out("failed"), report.in("in"));
    flow.connect(stringify.out("errorMessage"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "stringify_json_failed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toContain("BigInt values cannot be represented");
  });

  it("selects nested values by path with select_path", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "select_path_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: {
          order: {
            items: [
              { sku: "first" },
              { sku: "second" },
            ],
          },
        },
      },
    });
    const select = flow.node("select_path", {
      id: "select",
      position: { x: 260, y: 0 },
      config: { path: "order.items[1].sku" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "sku=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), select.in("in"));
    flow.connect(input.out("output"), select.in("value"));
    flow.connect(select.out("found"), report.in("in"));
    flow.connect(select.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "select_path_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("sku=second");
  });

  it("routes missing select_path values with a default", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "select_path_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { id: "ord_1" } } },
    });
    const select = flow.node("select_path", {
      id: "select",
      position: { x: 260, y: 0 },
      config: { path: "order.customer.name", defaultValue: "anonymous" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "customer=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), select.in("in"));
    flow.connect(input.out("output"), select.in("value"));
    flow.connect(select.out("missing"), report.in("in"));
    flow.connect(select.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "select_path_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("customer=anonymous");
  });

  it("sets nested values by path with set_path", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "set_path_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { id: "ord_1" } } },
    });
    const set = flow.node("set_path", {
      id: "set",
      position: { x: 260, y: 0 },
      config: { path: "order.status", value: "paid" },
    });
    const stringify = flow.node("stringify_json", {
      id: "stringify",
      position: { x: 400, y: 0 },
      config: { sortKeys: true },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "updated=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), set.in("in"));
    flow.connect(input.out("output"), set.in("source"));
    flow.connect(set.out("updated"), stringify.in("in"));
    flow.connect(set.out("value"), stringify.in("value"));
    flow.connect(stringify.out("stringified"), report.in("in"));
    flow.connect(stringify.out("text"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "set_path_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe('updated={"order":{"id":"ord_1","status":"paid"}}');
  });

  it("routes set_path to missing when containers cannot be created", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "set_path_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: {} },
    });
    const set = flow.node("set_path", {
      id: "set",
      position: { x: 260, y: 0 },
      config: { path: "order.status", value: "paid", createMissing: false },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "missing=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), set.in("in"));
    flow.connect(input.out("output"), set.in("source"));
    flow.connect(set.out("missing"), report.in("in"));
    flow.connect(set.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "set_path_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("missing=path_missing");
  });

  it("routes set_path to skipped when overwrite is disabled", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "set_path_skipped_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { status: "new" } } },
    });
    const set = flow.node("set_path", {
      id: "set",
      position: { x: 260, y: 0 },
      config: { path: "order.status", value: "paid", overwrite: false },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "previous=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), set.in("in"));
    flow.connect(input.out("output"), set.in("source"));
    flow.connect(set.out("skipped"), report.in("in"));
    flow.connect(set.out("previous"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "set_path_skipped_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("previous=new");
  });

  it("deletes nested object fields by path with delete_path", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "delete_path_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { id: "ord_1", status: "paid", temp: true } } },
    });
    const remove = flow.node("delete_path", {
      id: "delete",
      position: { x: 260, y: 0 },
      config: { path: "order.temp" },
    });
    const stringify = flow.node("stringify_json", {
      id: "stringify",
      position: { x: 400, y: 0 },
      config: { sortKeys: true },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "deleted=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), remove.in("in"));
    flow.connect(input.out("output"), remove.in("source"));
    flow.connect(remove.out("deleted"), stringify.in("in"));
    flow.connect(remove.out("value"), stringify.in("value"));
    flow.connect(stringify.out("stringified"), report.in("in"));
    flow.connect(stringify.out("text"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "delete_path_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe('deleted={"order":{"id":"ord_1","status":"paid"}}');
  });

  it("deletes array entries by path with delete_path splice mode", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "delete_path_array_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { items: ["a", "b", "c"] } },
    });
    const remove = flow.node("delete_path", {
      id: "delete",
      position: { x: 260, y: 0 },
      config: { path: "items[1]", arrayMode: "splice" },
    });
    const stringify = flow.node("stringify_json", {
      id: "stringify",
      position: { x: 400, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "items=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), remove.in("in"));
    flow.connect(input.out("output"), remove.in("source"));
    flow.connect(remove.out("deleted"), stringify.in("in"));
    flow.connect(remove.out("value"), stringify.in("value"));
    flow.connect(stringify.out("stringified"), report.in("in"));
    flow.connect(stringify.out("text"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "delete_path_array_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe('items={"items":["a","c"]}');
  });

  it("routes delete_path to missing when the target path is absent", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "delete_path_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { id: "ord_1" } } },
    });
    const remove = flow.node("delete_path", {
      id: "delete",
      position: { x: 260, y: 0 },
      config: { path: "order.temp" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "missing=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), remove.in("in"));
    flow.connect(input.out("output"), remove.in("source"));
    flow.connect(remove.out("missing"), report.in("in"));
    flow.connect(remove.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "delete_path_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("missing=path_missing");
  });

  it("routes delete_path to skipped when the path is empty", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "delete_path_skipped_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { order: { id: "ord_1" } } },
    });
    const remove = flow.node("delete_path", {
      id: "delete",
      position: { x: 260, y: 0 },
      config: { path: "" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "skipped=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), remove.in("in"));
    flow.connect(input.out("output"), remove.in("source"));
    flow.connect(remove.out("skipped"), report.in("in"));
    flow.connect(remove.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "delete_path_skipped_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("skipped=empty_path");
  });

  it("deep merges object sources with merge_object", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "merge_object_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const base = flow.node("transform", {
      id: "base",
      position: { x: 120, y: 20 },
      config: { value: { order: { id: "ord_1", status: "new" }, tags: ["base"] } },
    });
    const patch = flow.node("transform", {
      id: "patch",
      position: { x: 120, y: 140 },
      config: { value: { order: { status: "paid", total: 42 }, customer: { id: "cus_1" } } },
    });
    const merge = flow.node("merge_object", {
      id: "merge_object",
      position: { x: 280, y: 80 },
      config: { mode: "deep" },
    });
    const stringify = flow.node("stringify_json", {
      id: "stringify",
      position: { x: 420, y: 80 },
      config: { sortKeys: true },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 560, y: 80 },
      config: { template: "merged=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 700, y: 80 } });

    flow.connect(start.out("out"), base.in("in"));
    flow.connect(start.out("out"), patch.in("in"));
    flow.connect(base.out("out"), merge.in("in"));
    flow.connect(patch.out("out"), merge.in("in"));
    flow.connect(base.out("output"), merge.in("objects"));
    flow.connect(patch.out("output"), merge.in("objects"));
    flow.connect(merge.out("out"), stringify.in("in"));
    flow.connect(merge.out("value"), stringify.in("value"));
    flow.connect(stringify.out("stringified"), report.in("in"));
    flow.connect(stringify.out("text"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "merge_object_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(
      'merged={"customer":{"id":"cus_1"},"order":{"id":"ord_1","status":"paid","total":42},"tags":["base"]}',
    );
  });

  it("reports skipped non-object sources with merge_object", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "merge_object_skipped_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: [{ a: 1 }, "skip-me", { b: 2 }] },
    });
    const merge = flow.node("merge_object", {
      id: "merge_object",
      position: { x: 260, y: 0 },
      config: { nonObjectMode: "skip" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "skipped=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), merge.in("in"));
    flow.connect(input.out("output"), merge.in("objects"));
    flow.connect(merge.out("out"), report.in("in"));
    flow.connect(merge.out("skippedCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "merge_object_skipped_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("skipped=1");
  });

  it("flattens nested arrays with flatten_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "flatten_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { source: "a", items: ["a1", "a2"] },
          { source: "b", items: ["b1"] },
        ],
      },
    });
    const flatten = flow.node("flatten_items", {
      id: "flatten",
      position: { x: 260, y: 0 },
      config: { path: "items", depth: 1 },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${index}:${item}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "flat=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), flatten.in("in"));
    flow.connect(input.out("output"), flatten.in("items"));
    flow.connect(flatten.out("out"), map.in("in"));
    flow.connect(flatten.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "flatten_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flat=0:a1,1:a2,2:b1");
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

  it("sorts array items with sort_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "sort_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { id: "low", priority: 1 },
          { id: "high", priority: 3 },
          { id: "middle", priority: 2 },
        ],
      },
    });
    const sort = flow.node("sort_items", {
      id: "sort",
      position: { x: 260, y: 0 },
      config: {
        path: "priority",
        direction: "desc",
        type: "number",
        limit: 2,
      },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${item.id}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "sorted=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), sort.in("in"));
    flow.connect(input.out("output"), sort.in("items"));
    flow.connect(sort.out("out"), map.in("in"));
    flow.connect(sort.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "sort_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("sorted=high,middle");
  });

  it("slices array items with slice_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "slice_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: ["a", "b", "c", "d", "e"] },
    });
    const slice = flow.node("slice_items", {
      id: "slice",
      position: { x: 260, y: 0 },
      config: {
        start: 1,
        count: 3,
      },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${index}:${item}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "slice=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), slice.in("in"));
    flow.connect(input.out("output"), slice.in("items"));
    flow.connect(slice.out("out"), map.in("in"));
    flow.connect(slice.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "slice_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("slice=0:b,1:c,2:d");
  });

  it("builds sliding windows with window_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "window_items_sliding_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: [1, 2, 3, 4, 5] },
    });
    const window = flow.node("window_items", {
      id: "window",
      position: { x: 260, y: 0 },
      config: {
        size: 3,
        step: 2,
        includePartial: true,
      },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "[${item}]" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "windows=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), window.in("in"));
    flow.connect(input.out("output"), window.in("items"));
    flow.connect(window.out("out"), map.in("in"));
    flow.connect(window.out("windows"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "window_items_sliding_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("windows=[1,2,3],[3,4,5],[5]");
  });

  it("drops incomplete windows with window_items by default", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "window_items_drop_partial_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: ["a", "b", "c", "d", "e"] },
    });
    const window = flow.node("window_items", {
      id: "window",
      position: { x: 260, y: 0 },
      config: {
        size: 2,
        step: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "count=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), window.in("in"));
    flow.connect(input.out("output"), window.in("items"));
    flow.connect(window.out("out"), report.in("in"));
    flow.connect(window.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "window_items_drop_partial_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("count=2");
  });

  it("batches array items with batch_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "batch_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: ["a", "b", "c", "d", "e"] },
    });
    const batch = flow.node("batch_items", {
      id: "batch",
      position: { x: 260, y: 0 },
      config: {
        size: 2,
      },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${index}:${item}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "batches=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), batch.in("in"));
    flow.connect(input.out("output"), batch.in("items"));
    flow.connect(batch.out("out"), map.in("in"));
    flow.connect(batch.out("batches"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "batch_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("batches=0:a,b,1:c,d,2:e");
  });

  it("can drop partial batches with batch_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "batch_items_drop_partial_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: ["a", "b", "c", "d", "e"] },
    });
    const batch = flow.node("batch_items", {
      id: "batch",
      position: { x: 260, y: 0 },
      config: {
        size: 2,
        includePartial: false,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "count=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), batch.in("in"));
    flow.connect(input.out("output"), batch.in("items"));
    flow.connect(batch.out("out"), report.in("in"));
    flow.connect(batch.out("count"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "batch_items_drop_partial_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("count=2");
  });

  it("deduplicates array items with unique_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "unique_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { id: "A", label: "first" },
          { id: "b", label: "second" },
          { id: "a", label: "duplicate" },
        ],
      },
    });
    const unique = flow.node("unique_items", {
      id: "unique",
      position: { x: 260, y: 0 },
      config: {
        path: "id",
        caseSensitive: false,
      },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${item.label}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "unique=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), unique.in("in"));
    flow.connect(input.out("output"), unique.in("items"));
    flow.connect(unique.out("out"), map.in("in"));
    flow.connect(unique.out("items"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "unique_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("unique=first,second");
  });

  it("groups array items with group_items", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "group_items_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { id: "a", status: "open" },
          { id: "b", status: "closed" },
          { id: "c", status: "open" },
        ],
      },
    });
    const group = flow.node("group_items", {
      id: "group",
      position: { x: 260, y: 0 },
      config: { path: "status" },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${item.key}:${item.count}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "groups=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), group.in("in"));
    flow.connect(input.out("output"), group.in("items"));
    flow.connect(group.out("out"), map.in("in"));
    flow.connect(group.out("entries"), map.in("items"));
    flow.connect(map.out("out"), report.in("in"));
    flow.connect(map.out("items"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "group_items_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("groups=open:2,closed:1");
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

  it("emits traceable progress events for each foreach iteration", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_iteration_trace_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
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
    const exit = flow.node("end", { id: "e", position: { x: 500, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(begin.out("item"), body.in("input"));
    flow.connect(body.out("out"), end.in("body_done"));
    flow.connect(body.out("output"), end.in("result"));
    flow.connect(end.out("done"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_iteration_trace_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const progress = events.filter(
      (event) => event.kind === "node_progress" && event.nodeId === "begin",
    );
    expect(progress.map((event) => event.seq)).toEqual([10_000, 10_001, 10_002, 10_003]);
    expect(progress.map((event) => (event.payload as { phase: string }).phase)).toEqual([
      "started",
      "finished",
      "started",
      "finished",
    ]);
    expect(progress.map((event) => (event.payload as { iteration: number }).iteration)).toEqual([
      0,
      0,
      1,
      1,
    ]);
    expect(progress[0]?.payload).toMatchObject({
      type: "loop_iteration",
      loopType: "foreach_begin",
      beginNodeId: "begin",
      endNodeId: "loop_end",
      phase: "started",
      iteration: 0,
      status: "running",
      context: {
        item: "alpha",
        index: 0,
        count: 2,
      },
    });
    expect(progress[3]?.payload).toMatchObject({
      phase: "finished",
      iteration: 1,
      status: "completed",
      context: {
        item: "beta",
        index: 1,
        count: 2,
      },
    });
  });

  it("routes foreach blocks to timeout with completed results", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_timeout_e2e",
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
      config: { timeoutMs: 1 },
    });
    const wait = flow.node("delay", {
      id: "wait",
      position: { x: 300, y: 0 },
      config: { durationMs: 3 },
    });
    const emit = flow.node("transform", {
      id: "emit",
      position: { x: 400, y: 0 },
      config: { template: "item=${input}" },
    });
    const end = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 500, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 0 },
      config: { template: "timeout=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 700, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), wait.in("in"));
    flow.connect(wait.out("out"), emit.in("in"));
    flow.connect(begin.out("item"), emit.in("input"));
    flow.connect(emit.out("out"), end.in("body_done"));
    flow.connect(emit.out("output"), end.in("result"));
    flow.connect(end.out("timeout"), report.in("in"));
    flow.connect(end.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_timeout_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timeout=item=alpha");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const finished = events.filter(
      (event) =>
        event.kind === "node_progress" &&
        event.nodeId === "begin" &&
        (event.payload as { phase?: string }).phase === "finished",
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({
      type: "loop_iteration",
      iteration: 0,
      status: "timeout",
    });
  });

  it("continues foreach iterations after body errors when onError is continue", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_error_continue_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
      config: { onError: "continue" },
    });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 300, y: 0 },
      config: {},
    });
    const end = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 400, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 0 },
      config: { template: "errors=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), failing.in("in"));
    flow.connect(failing.out("out"), end.in("body_done"));
    flow.connect(end.out("done"), report.in("in"));
    flow.connect(end.out("errorCount"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_error_continue_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("errors=2");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const finished = events.filter(
      (event) =>
        event.kind === "node_progress" &&
        event.nodeId === "begin" &&
        (event.payload as { phase?: string }).phase === "finished",
    );
    expect(finished.map((event) => (event.payload as { status: string }).status)).toEqual([
      "error_continue",
      "error_continue",
    ]);
  });

  it("routes foreach body errors through the loop error branch when onError is route", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_error_route_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
      config: { onError: "route" },
    });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 300, y: 0 },
      config: {},
    });
    const end = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 400, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 500, y: 0 },
      config: { template: "error=${input.code}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), failing.in("in"));
    flow.connect(failing.out("out"), end.in("body_done"));
    flow.connect(end.out("error"), report.in("in"));
    flow.connect(end.out("firstError"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_error_route_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("error=node.http.missing_url");
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

  it("executes nested foreach blocks independently", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "nested_foreach_block_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const outerItems = flow.node("transform", {
      id: "outer_items",
      position: { x: 100, y: 0 },
      config: { value: ["outer-a", "outer-b"] },
    });
    const outerBegin = flow.node("foreach_begin", {
      id: "outer_begin",
      position: { x: 220, y: 0 },
    });
    const innerItems = flow.node("transform", {
      id: "inner_items",
      position: { x: 340, y: 0 },
      config: { value: [1, 2] },
    });
    const innerBegin = flow.node("foreach_begin", {
      id: "inner_begin",
      position: { x: 460, y: 0 },
    });
    const innerBody = flow.node("transform", {
      id: "inner_body",
      position: { x: 580, y: 0 },
      config: { template: "inner=${input}" },
    });
    const innerEnd = flow.node("foreach_end", {
      id: "inner_end",
      position: { x: 700, y: 0 },
    });
    const outerEnd = flow.node("foreach_end", {
      id: "outer_end",
      position: { x: 820, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 940, y: 0 },
      config: { template: "nested=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 1060, y: 0 } });

    flow.connect(start.out("out"), outerItems.in("in"));
    flow.connect(outerItems.out("out"), outerBegin.in("in"));
    flow.connect(outerItems.out("output"), outerBegin.in("items"));
    flow.connect(outerBegin.out("body"), innerItems.in("in"));
    flow.connect(innerItems.out("out"), innerBegin.in("in"));
    flow.connect(innerItems.out("output"), innerBegin.in("items"));
    flow.connect(innerBegin.out("body"), innerBody.in("in"));
    flow.connect(innerBegin.out("item"), innerBody.in("input"));
    flow.connect(innerBody.out("out"), innerEnd.in("body_done"));
    flow.connect(innerBody.out("output"), innerEnd.in("result"));
    flow.connect(innerEnd.out("done"), outerEnd.in("body_done"));
    flow.connect(innerEnd.out("results"), outerEnd.in("result"));
    flow.connect(outerEnd.out("done"), report.in("in"));
    flow.connect(outerEnd.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "nested_foreach_block_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("nested=inner=1,inner=2,inner=1,inner=2");
  });

  it("skips a loop body when before-check condition is false", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "loop_before_check_skip_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const initial = flow.node("transform", {
      id: "initial",
      position: { x: 120, y: 0 },
      config: { value: { continue: false, label: "initial" } },
    });
    const begin = flow.node("loop_begin", {
      id: "begin",
      position: { x: 260, y: 0 },
      config: { checkMode: "before", maxIterations: 3 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 400, y: 0 },
      config: { value: { continue: true, label: "body" } },
    });
    const loopEnd = flow.node("loop_end", {
      id: "loop_end",
      position: { x: 540, y: 0 },
      config: { condition: "nextState.continue == true" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 680, y: 0 },
      config: { template: "final=${input.label}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 820, y: 0 } });

    flow.connect(start.out("out"), initial.in("in"));
    flow.connect(initial.out("out"), begin.in("in"));
    flow.connect(initial.out("output"), begin.in("initialState"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(body.out("out"), loopEnd.in("body_done"));
    flow.connect(body.out("output"), loopEnd.in("nextState"));
    flow.connect(loopEnd.out("done"), report.in("in"));
    flow.connect(loopEnd.out("finalState"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "loop_before_check_skip_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("final=initial");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(
      events.some((event) => event.kind === "node_started" && event.nodeId === "body"),
    ).toBe(false);
  });

  it("evaluates loop before-check again after each next state", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "loop_before_check_once_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const initial = flow.node("transform", {
      id: "initial",
      position: { x: 120, y: 0 },
      config: { value: { continue: true, label: "initial" } },
    });
    const begin = flow.node("loop_begin", {
      id: "begin",
      position: { x: 260, y: 0 },
      config: { checkMode: "before", maxIterations: 3 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 400, y: 0 },
      config: { value: { continue: false, label: "body" } },
    });
    const loopEnd = flow.node("loop_end", {
      id: "loop_end",
      position: { x: 540, y: 0 },
      config: { condition: "nextState.continue == true" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 680, y: 0 },
      config: { template: "final=${input.label}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 820, y: 0 } });

    flow.connect(start.out("out"), initial.in("in"));
    flow.connect(initial.out("out"), begin.in("in"));
    flow.connect(initial.out("output"), begin.in("initialState"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(body.out("out"), loopEnd.in("body_done"));
    flow.connect(body.out("output"), loopEnd.in("nextState"));
    flow.connect(loopEnd.out("done"), report.in("in"));
    flow.connect(loopEnd.out("finalState"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "loop_before_check_once_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("final=body");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(
      events.filter((event) => event.kind === "node_started" && event.nodeId === "body"),
    ).toHaveLength(1);
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
