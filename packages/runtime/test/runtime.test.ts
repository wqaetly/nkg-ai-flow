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
