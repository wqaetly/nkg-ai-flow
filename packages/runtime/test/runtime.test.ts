/**
 * Runtime tests covering the v5 layer end-to-end against in-memory
 * stores. Each test wires `createRuntime` with an isolated set of stores
 * and a deterministic test LLM provider so no external service is needed.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
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

function deterministicJitterDelay(args: {
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitterPercent: number;
  code: string;
  attempt: number;
}): number {
  const exponential =
    args.baseDelayMs * args.multiplier ** Math.max(0, args.attempt - 1);
  const capped = Math.min(args.maxDelayMs, Math.trunc(exponential));
  if (args.jitterPercent <= 0 || capped <= 0) return capped;
  const spread = capped * (args.jitterPercent / 100);
  const unit = stableUnit(`${args.code}:${args.attempt}`);
  return Math.max(0, Math.trunc(capped - spread + unit * spread * 2));
}

function stableUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
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

  it("evaluates safe transform expressions with expr prefix", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "transform_expr_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const summarize = flow.node("transform", {
      id: "summarize",
      position: { x: 120, y: 0 },
      config: { expression: "expr:sum(input.amounts)" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "sum=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), summarize.in("in"));
    flow.connect(start.out("runInput"), summarize.in("input"));
    flow.connect(summarize.out("out"), report.in("in"));
    flow.connect(summarize.out("output"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "transform_expr_e2e",
      input: { amounts: [2, "3", 5] },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("sum=10");
  });

  it("exposes start runInput as an explicit data output port", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "start_run_input_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 120, y: 0 },
      config: { template: "input=${input.name}:${input.count}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 240, y: 0 } });

    flow.connect(start.out("out"), report.in("in"));
    flow.connect(start.out("runInput"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "start_run_input_e2e",
      input: { name: "Flow", count: 3 },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("input=Flow:3");
  });

  it("propagates traceId onto persisted run, node, and node-channel events", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "trace_id_events_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 120, y: 0 },
      config: { template: "trace:${input.name}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), report.in("in"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "trace_id_events_e2e",
      traceId: "trace-order-1",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.runRecord.traceId).toBe("trace-order-1");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.traceId === "trace-order-1")).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "run_started",
        "node_started",
        "node_log",
        "node_finished",
        "run_finished",
      ]),
    );
  });

  it("invokes a built-in tool and exposes its structured result", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nkg-tool-"));
    try {
      await writeFile(join(tmp, "input.txt"), "tool payload", "utf8");
      const rt = newRuntime();
      const flow = defineFlow({ id: "tool_read_file_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
      const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
      const tool = flow.node("tool", {
        id: "read_tool",
        position: { x: 120, y: 0 },
        config: {
          tool: "read_file",
          args: { path: "input.txt" },
          workingDir: tmp,
          allowedTools: ["read_file"],
          failOnError: true,
        },
      });
      const report = flow.node("transform", {
        id: "report",
        position: { x: 260, y: 0 },
        config: { template: "file=${input.content}" },
      });
      const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

      flow.connect(start.out("out"), tool.in("in"));
      flow.connect(tool.out("success"), report.in("in"));
      flow.connect(tool.out("result"), report.in("input"));
      flow.connect(report.out("out"), end.in("in"));

      await registerAndPromote(rt, flow);

      const result = await rt.invocationRouter.invoke({
        flowId: "tool_read_file_e2e",
        input: null,
      });

      expect(result.succeeded).toBe(true);
      expect(result.output).toBe("file=tool payload");

      const events = await rt.eventBus.store.read(result.runRecord.runId);
      expect(
        events.find((event) => event.kind === "tool_call_started" && event.nodeId === "read_tool")
          ?.payload,
      ).toMatchObject({ toolName: "read_file", args: { path: "input.txt" } });
      expect(
        events.find((event) => event.kind === "tool_call_finished" && event.nodeId === "read_tool")
          ?.payload,
      ).toMatchObject({ toolName: "read_file", ok: true });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("routes a failed tool call through the failed branch when failOnError is false", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nkg-tool-"));
    try {
      const rt = newRuntime();
      const flow = defineFlow({ id: "tool_failed_branch_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
      const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
      const tool = flow.node("tool", {
        id: "read_missing",
        position: { x: 120, y: 0 },
        config: {
          tool: "read_file",
          args: { path: "missing.txt" },
          workingDir: tmp,
          allowedTools: ["read_file"],
          failOnError: false,
        },
      });
      const report = flow.node("transform", {
        id: "report",
        position: { x: 260, y: 0 },
        config: { template: "failed=${input}" },
      });
      const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

      flow.connect(start.out("out"), tool.in("in"));
      flow.connect(tool.out("failed"), report.in("in"));
      flow.connect(tool.out("errorMessage"), report.in("input"));
      flow.connect(report.out("out"), end.in("in"));

      await registerAndPromote(rt, flow);

      const result = await rt.invocationRouter.invoke({
        flowId: "tool_failed_branch_e2e",
        input: null,
      });

      expect(result.succeeded).toBe(true);
      expect(String(result.output)).toContain("ENOENT");

      const events = await rt.eventBus.store.read(result.runRecord.runId);
      expect(
        events.find((event) => event.kind === "tool_call_finished" && event.nodeId === "read_missing")
          ?.payload,
      ).toMatchObject({ toolName: "read_file", ok: false });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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

  it("uses dynamic delay duration input", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "delay_dynamic_duration_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const duration = flow.node("transform", {
      id: "duration",
      position: { x: 120, y: 160 },
      config: { value: 1 },
    });
    const delay = flow.node("delay", {
      id: "wait",
      position: { x: 280, y: 80 },
      config: { durationMs: 50 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 440, y: 80 },
      config: { template: "delay:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 80 } });

    flow.connect(start.out("out"), duration.in("in"));
    flow.connect(start.out("out"), delay.in("in"));
    flow.connect(duration.out("output"), delay.in("durationMs"));
    flow.connect(delay.out("out"), report.in("in"));
    flow.connect(delay.out("durationMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "delay_dynamic_duration_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("delay:1");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const delayOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "wait") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(delayOutput).toMatchObject({
      durationMs: 1,
      elapsedMs: expect.any(Number),
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
  });

  it("fails a node when runtimeTimeoutMs is exceeded", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "runtime_timeout_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const delay = flow.node("delay", {
      id: "wait",
      position: { x: 100, y: 0 },
      config: { durationMs: 50, runtimeTimeoutMs: 1 },
    });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });

    flow.connect(start.out("out"), delay.in("in"));
    flow.connect(delay.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "runtime_timeout_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(false);
    expect(result.error?.code).toBe("node.timeout");
    expect(result.error?.retryable).toBe(true);

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const delayError = events.find(
      (event) => event.kind === "node_error" && event.nodeId === "wait",
    );
    expect(delayError?.payload).toMatchObject({
      error: {
        code: "node.timeout",
        context: { timeoutMs: 1 },
      },
    });
  });

  it("retries a failed node according to runtimeRetry policy", async () => {
    let calls = 0;
    const flakyNode = defineNode({
      type: "flaky_retry",
      typeVersion: "1.0.0",
      title: "Flaky Retry",
      ports: [
        { id: "value", direction: "output", kind: "data", label: "Value" },
      ],
      validateInput: false,
      run({ ctx }) {
        calls += 1;
        if (calls === 1) {
          return {
            kind: "error",
            error: createRuntimeError({
              code: "node.flaky_retry.transient",
              kind: "internal",
              category: "system",
              message: "transient failure",
              retryable: true,
              source: { module: "node_logic", nodeId: ctx.nodeId },
            }) as unknown as { code: string; message: string; [key: string]: unknown },
          };
        }
        return { kind: "success", outputs: { out: null, value: `ok:${ctx.attempt}` } };
      },
    });
    const rt = newRuntime({ nodes: [flakyNode] });
    const flow = defineFlow({ id: "runtime_retry_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const flaky = flow.node("flaky_retry", {
      id: "flaky",
      position: { x: 120, y: 0 },
      config: {
        runtimeRetry: {
          maxAttempts: 2,
          baseDelayMs: 0,
          retryableOnly: true,
        },
      },
    });
    const end = flow.node("end", { id: "e", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), flaky.in("in"));
    flow.connect(flaky.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "runtime_retry_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("ok:2");
    expect(calls).toBe(2);

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(
      events.filter((event) => event.kind === "node_started" && event.nodeId === "flaky"),
    ).toHaveLength(2);
    expect(
      events.find((event) => event.kind === "node_progress" && event.nodeId === "flaky")
        ?.payload,
    ).toMatchObject({
      type: "node_retry",
      attempt: 1,
      nextAttempt: 2,
    });
  });

  it("does not retry non-retryable errors when runtimeRetry requires retryable errors", async () => {
    let calls = 0;
    const fatalNode = defineNode({
      type: "fatal_retry",
      typeVersion: "1.0.0",
      title: "Fatal Retry",
      validateInput: false,
      run({ ctx }) {
        calls += 1;
        return {
          kind: "error",
          error: createRuntimeError({
            code: "node.fatal_retry.failed",
            kind: "validation",
            category: "user_input",
            message: "fatal failure",
            retryable: false,
            source: { module: "node_logic", nodeId: ctx.nodeId },
          }) as unknown as { code: string; message: string; [key: string]: unknown },
        };
      },
    });
    const rt = newRuntime({ nodes: [fatalNode] });
    const flow = defineFlow({ id: "runtime_retry_non_retryable_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const fatal = flow.node("fatal_retry", {
      id: "fatal",
      position: { x: 120, y: 0 },
      config: { runtimeRetry: { maxAttempts: 3, baseDelayMs: 0 } },
    });
    const end = flow.node("end", { id: "e", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), fatal.in("in"));
    flow.connect(fatal.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "runtime_retry_non_retryable_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(false);
    expect(result.error?.code).toBe("node.fatal_retry.failed");
    expect(calls).toBe(1);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const deadlineOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "deadline") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(deadlineOutput).toMatchObject({
      status: "on_time",
      deadlineAt: expect.any(Number),
      effectiveDeadlineAt: expect.any(Number),
      graceMs: 0,
      remainingMs: expect.any(Number),
      overdueByMs: 0,
      onTimeValue: true,
      overdueValue: false,
      now: expect.any(Number),
    });
  });

  it("uses dynamic deadline duration policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "deadline_dynamic_duration_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const startedAtValue = Date.now();
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const startedAt = flow.node("transform", {
      id: "started_at",
      position: { x: 140, y: 40 },
      config: { value: startedAtValue },
    });
    const durationMs = flow.node("transform", {
      id: "duration_ms",
      position: { x: 140, y: 140 },
      config: { value: 60_000 },
    });
    const graceMs = flow.node("transform", {
      id: "grace_ms",
      position: { x: 140, y: 240 },
      config: { value: 250 },
    });
    const deadline = flow.node("deadline", {
      id: "deadline",
      position: { x: 360, y: 140 },
      config: { deadlineAt: "", durationMs: 0, graceMs: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 140 },
      config: { template: "deadline:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 720, y: 140 } });

    flow.connect(start.out("out"), startedAt.in("in"));
    flow.connect(start.out("out"), durationMs.in("in"));
    flow.connect(start.out("out"), graceMs.in("in"));
    flow.connect(start.out("out"), deadline.in("in"));
    flow.connect(startedAt.out("output"), deadline.in("startedAt"));
    flow.connect(durationMs.out("output"), deadline.in("durationMs"));
    flow.connect(graceMs.out("output"), deadline.in("graceMs"));
    flow.connect(deadline.out("on_time"), report.in("in"));
    flow.connect(deadline.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "deadline_dynamic_duration_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("deadline:on_time");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const deadlineOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "deadline") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(deadlineOutput).toMatchObject({
      status: "on_time",
      deadlineAt: startedAtValue + 60_000,
      effectiveDeadlineAt: startedAtValue + 60_250,
      durationMs: 60_000,
      graceMs: 250,
      overdueByMs: 0,
      onTimeValue: true,
      overdueValue: false,
      now: expect.any(Number),
    });
    expect(Number(deadlineOutput?.remainingMs)).toBeGreaterThan(0);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const deadlineOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "deadline") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(deadlineOutput).toMatchObject({
      status: "overdue",
      deadlineAt: expect.any(Number),
      effectiveDeadlineAt: expect.any(Number),
      graceMs: 0,
      remainingMs: 0,
      overdueByMs: expect.any(Number),
      onTimeValue: false,
      overdueValue: true,
      now: expect.any(Number),
    });
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
      config: { timeoutMs: 1000, graceMs: 100 },
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const timeoutOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "timeout") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(timeoutOutput).toMatchObject({
      status: "timed_out",
      elapsedMs: 1250,
      timeoutMs: 1000,
      graceMs: 100,
      effectiveTimeoutMs: 1100,
      timedOut: true,
      remainingMs: 0,
      overdueByMs: 150,
    });
  });

  it("uses dynamic branch_timeout policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "branch_timeout_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 180 } });
    const branch = flow.node("transform", {
      id: "branch",
      position: { x: 140, y: 60 },
      config: { value: { branch: "slow-api", metrics: { elapsed: 650 } } },
    });
    const timeoutMs = flow.node("transform", {
      id: "timeout_ms",
      position: { x: 140, y: 160 },
      config: { value: 500 },
    });
    const graceMs = flow.node("transform", {
      id: "grace_ms",
      position: { x: 140, y: 260 },
      config: { value: 100 },
    });
    const durationMsPath = flow.node("transform", {
      id: "duration_path",
      position: { x: 140, y: 360 },
      config: { value: "metrics.elapsed" },
    });
    const timeout = flow.node("branch_timeout", {
      id: "timeout",
      position: { x: 380, y: 180 },
      config: { timeoutMs: 1000, graceMs: 0, durationMsPath: "durationMs" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 580, y: 180 },
      config: { template: "timeout:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 800, y: 180 } });

    flow.connect(start.out("out"), branch.in("in"));
    flow.connect(start.out("out"), timeoutMs.in("in"));
    flow.connect(start.out("out"), graceMs.in("in"));
    flow.connect(start.out("out"), durationMsPath.in("in"));
    flow.connect(branch.out("out"), timeout.in("in"));
    flow.connect(branch.out("output"), timeout.in("branch"));
    flow.connect(timeoutMs.out("output"), timeout.in("timeoutMs"));
    flow.connect(graceMs.out("output"), timeout.in("graceMs"));
    flow.connect(durationMsPath.out("output"), timeout.in("durationMsPath"));
    flow.connect(timeout.out("timed_out"), report.in("in"));
    flow.connect(timeout.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "branch_timeout_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timeout:timed_out");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const timeoutOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "timeout") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(timeoutOutput).toMatchObject({
      status: "timed_out",
      elapsedMs: 650,
      timeoutMs: 500,
      graceMs: 100,
      effectiveTimeoutMs: 600,
      durationMsPath: "metrics.elapsed",
      startedAtPath: "startedAt",
      finishedAtPath: "finishedAt",
      timedOut: true,
      remainingMs: 0,
      overdueByMs: 50,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const timeoutOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "timeout") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(timeoutOutput).toMatchObject({
      status: "on_time",
      elapsedMs: 250,
      timeoutMs: 500,
      graceMs: 0,
      effectiveTimeoutMs: 500,
      timedOut: false,
      remainingMs: 250,
      overdueByMs: 0,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const windowOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "window") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(windowOutput).toMatchObject({
      status: "open",
      startTime: "09:00",
      endTime: "17:00",
      days: "1,2,3,4,5",
      timezoneOffsetMinutes: 0,
      nextOpenInMs: 0,
      nextOpenAt: Date.UTC(2026, 6, 6, 10, 0),
      openValue: true,
      closedValue: false,
      overnightValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const windowOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "window") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(windowOutput).toMatchObject({
      status: "closed",
      startTime: "09:00",
      endTime: "17:00",
      days: "1,2,3,4,5",
      timezoneOffsetMinutes: 0,
      nextOpenInMs: 1_800_000,
      nextOpenAt: Date.UTC(2026, 6, 6, 9, 0),
      openValue: false,
      closedValue: true,
      overnightValue: false,
    });
  });

  it("uses dynamic schedule_window policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "schedule_window_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 180 } });
    const now = flow.node("transform", {
      id: "now",
      position: { x: 140, y: 40 },
      config: { value: Date.UTC(2026, 6, 6, 10, 0) },
    });
    const startTime = flow.node("transform", {
      id: "start_time",
      position: { x: 140, y: 140 },
      config: { value: "09:00" },
    });
    const endTime = flow.node("transform", {
      id: "end_time",
      position: { x: 140, y: 240 },
      config: { value: "17:00" },
    });
    const days = flow.node("transform", {
      id: "days",
      position: { x: 140, y: 340 },
      config: { value: "1,2,3,4,5" },
    });
    const timezoneOffset = flow.node("transform", {
      id: "timezone_offset",
      position: { x: 140, y: 440 },
      config: { value: 0 },
    });
    const window = flow.node("schedule_window", {
      id: "window",
      position: { x: 380, y: 240 },
      config: {
        startTime: "11:00",
        endTime: "12:00",
        days: "2",
        timezoneOffsetMinutes: 60,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 580, y: 240 },
      config: { template: "window:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 760, y: 240 } });

    flow.connect(start.out("out"), now.in("in"));
    flow.connect(start.out("out"), startTime.in("in"));
    flow.connect(start.out("out"), endTime.in("in"));
    flow.connect(start.out("out"), days.in("in"));
    flow.connect(start.out("out"), timezoneOffset.in("in"));
    flow.connect(now.out("out"), window.in("in"));
    flow.connect(now.out("output"), window.in("now"));
    flow.connect(startTime.out("output"), window.in("startTime"));
    flow.connect(endTime.out("output"), window.in("endTime"));
    flow.connect(days.out("output"), window.in("days"));
    flow.connect(timezoneOffset.out("output"), window.in("timezoneOffsetMinutes"));
    flow.connect(window.out("open"), report.in("in"));
    flow.connect(window.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schedule_window_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("window:open");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const windowOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "window") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(windowOutput).toMatchObject({
      status: "open",
      startTime: "09:00",
      endTime: "17:00",
      days: "1,2,3,4,5",
      timezoneOffsetMinutes: 0,
      nextOpenInMs: 0,
      nextOpenAt: Date.UTC(2026, 6, 6, 10, 0),
      openValue: true,
      closedValue: false,
      overnightValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const cronOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "cron") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(cronOutput).toMatchObject({
      status: "due",
      cron: "30 9 * * 1",
      timezoneOffsetMinutes: 0,
      now: Date.UTC(2026, 0, 5, 9, 30),
      nextAt: Date.UTC(2026, 0, 5, 9, 30),
      nextAtIso: new Date(Date.UTC(2026, 0, 5, 9, 30)).toISOString(),
      waitMs: 0,
      dueValue: true,
      notDueValue: false,
    });
  });

  it("uses dynamic cron_schedule policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "cron_schedule_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const nowValue = Date.UTC(2026, 0, 5, 9, 30);
    const start = flow.node("start", { id: "s", position: { x: 0, y: 160 } });
    const now = flow.node("transform", {
      id: "now",
      position: { x: 140, y: 60 },
      config: { value: nowValue },
    });
    const cronInput = flow.node("transform", {
      id: "cron_input",
      position: { x: 140, y: 160 },
      config: { value: "30 9 * * 1" },
    });
    const timezoneOffset = flow.node("transform", {
      id: "timezone_offset",
      position: { x: 140, y: 260 },
      config: { value: 0 },
    });
    const cron = flow.node("cron_schedule", {
      id: "cron",
      position: { x: 360, y: 160 },
      config: { cron: "0 0 * * 0", timezoneOffsetMinutes: 60 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 160 },
      config: { template: "cron=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 720, y: 160 } });

    flow.connect(start.out("out"), now.in("in"));
    flow.connect(start.out("out"), cronInput.in("in"));
    flow.connect(start.out("out"), timezoneOffset.in("in"));
    flow.connect(now.out("out"), cron.in("in"));
    flow.connect(now.out("output"), cron.in("now"));
    flow.connect(cronInput.out("output"), cron.in("cron"));
    flow.connect(timezoneOffset.out("output"), cron.in("timezoneOffsetMinutes"));
    flow.connect(cron.out("due"), report.in("in"));
    flow.connect(cron.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cron_schedule_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("cron=due");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const cronOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "cron") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(cronOutput).toMatchObject({
      status: "due",
      cron: "30 9 * * 1",
      timezoneOffsetMinutes: 0,
      now: nowValue,
      nextAt: nowValue,
      nextAtIso: new Date(nowValue).toISOString(),
      waitMs: 0,
      dueValue: true,
      notDueValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const cronOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "cron") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(cronOutput).toMatchObject({
      status: "not_due",
      cron: "30 9 * * 1",
      timezoneOffsetMinutes: 0,
      now: Date.UTC(2026, 0, 5, 9, 29),
      nextAt: Date.UTC(2026, 0, 5, 9, 30),
      nextAtIso: new Date(Date.UTC(2026, 0, 5, 9, 30)).toISOString(),
      waitMs: 60_000,
      dueValue: false,
      notDueValue: true,
    });
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

  it("maps schema_transform templates, expressions, and array target paths", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "schema_transform_template_array_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: {
          id: "u1",
          profile: { first: "Ada", last: "Lovelace" },
          roles: ["admin", "editor"],
        },
      },
    });
    const mapper = flow.node("schema_transform", {
      id: "mapper",
      position: { x: 280, y: 0 },
      config: {
        mappings: [
          "users[0].id = id",
          "users[0].label = template:${profile.first} ${profile.last}",
          "users[0].active = expr:contains(roles, 'admin')",
          "users[0].roles = roles",
        ].join("\n"),
      },
    });
    const verify = flow.node("expression_eval", {
      id: "verify",
      position: { x: 440, y: 0 },
      config: {
        expression: [
          "input.users[0].id == 'u1'",
          "input.users[0].label == 'Ada Lovelace'",
          "input.users[0].active == true",
          "input.users[0].roles[1] == 'editor'",
        ].join(" && "),
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 0 },
      config: { template: "valid=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 760, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), mapper.in("in"));
    flow.connect(input.out("output"), mapper.in("input"));
    flow.connect(mapper.out("transformed"), verify.in("in"));
    flow.connect(mapper.out("value"), verify.in("input"));
    flow.connect(verify.out("out"), report.in("in"));
    flow.connect(verify.out("truthy"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "schema_transform_template_array_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("valid=true");
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

  it("routes a dynamically named cooldown_gate to ready", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cooldown_gate_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const gateName = flow.node("transform", {
      id: "gateName",
      position: { x: 120, y: -80 },
      config: { value: "ALERT_DYNAMIC_COOLDOWN" },
    });
    const gate = flow.node("cooldown_gate", {
      id: "gate",
      position: { x: 260, y: 0 },
      config: {
        durationMs: 1000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "ready:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), gateName.in("in"));
    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(start.out("runInput"), gate.in("now"));
    flow.connect(gateName.out("output"), gate.in("name"));
    flow.connect(gate.out("ready"), report.in("in"));
    flow.connect(gate.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cooldown_gate_dynamic_name_e2e",
      input: 1000,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("ready:ALERT_DYNAMIC_COOLDOWN");
    expect(variables.get("ALERT_DYNAMIC_COOLDOWN")).toMatchObject({
      lastAllowedAt: 1000,
      readyAt: 2000,
      durationMs: 1000,
      allowedCount: 1,
    });
    expect(variables.has("")).toBe(false);
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

  it("routes a dynamically named distinct_until_changed stream", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "distinct_until_changed_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const streamName = flow.node("transform", {
      id: "streamName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_STATUS_STREAM" },
    });
    const distinct = flow.node("distinct_until_changed", {
      id: "distinct",
      position: { x: 260, y: 0 },
      config: {
        path: "status",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "changed:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), streamName.in("in"));
    flow.connect(start.out("out"), distinct.in("in"));
    flow.connect(start.out("runInput"), distinct.in("value"));
    flow.connect(streamName.out("output"), distinct.in("name"));
    flow.connect(distinct.out("changed"), report.in("in"));
    flow.connect(distinct.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "distinct_until_changed_dynamic_name_e2e",
      input: { status: "open" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("changed:ORDER_DYNAMIC_STATUS_STREAM");
    expect(variables.get("ORDER_DYNAMIC_STATUS_STREAM")).toMatchObject({
      value: "open",
      evaluations: 1,
      changes: 1,
    });
    expect(variables.has("")).toBe(false);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const policyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "policy") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(policyOutput).toMatchObject({
      status: "retry",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      remainingAttempts: 2,
      exhaustedValue: false,
      delayMs: 100,
    });
  });

  it("applies deterministic jitter to retry_policy backoff", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_jitter_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true } },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 3,
        baseDelayMs: 1000,
        multiplier: 2,
        maxDelayMs: 10_000,
        jitterPercent: 50,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "retry:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(policy.out("retry"), report.in("in"));
    flow.connect(policy.out("delayMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_jitter_e2e",
      input: null,
    });

    const expectedDelay = deterministicJitterDelay({
      baseDelayMs: 1000,
      multiplier: 2,
      maxDelayMs: 10_000,
      jitterPercent: 50,
      code: "payment.timeout",
      attempt: 1,
    });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(`retry:${expectedDelay}`);
  });

  it("honors retry-after metadata in retry_policy backoff", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_retry_after_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.rate_limit", retryable: true, retryAfterMs: 5000 } },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
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
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(policy.out("retry"), report.in("in"));
    flow.connect(policy.out("delayMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_retry_after_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:5000");
  });

  it("uses dynamic retry_policy strategy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_dynamic_strategy_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.dynamic" } },
    });
    const idempotent = flow.node("transform", {
      id: "idempotent",
      position: { x: 260, y: 0 },
      config: { value: true },
    });
    const maxAttempts = flow.node("transform", {
      id: "max_attempts",
      position: { x: 400, y: 0 },
      config: { value: 4 },
    });
    const baseDelay = flow.node("transform", {
      id: "base_delay",
      position: { x: 540, y: 0 },
      config: { value: 200 },
    });
    const multiplier = flow.node("transform", {
      id: "multiplier",
      position: { x: 680, y: 0 },
      config: { value: 3 },
    });
    const maxDelay = flow.node("transform", {
      id: "max_delay",
      position: { x: 820, y: 0 },
      config: { value: 1000 },
    });
    const jitter = flow.node("transform", {
      id: "jitter",
      position: { x: 960, y: 0 },
      config: { value: 0 },
    });
    const retryableOnly = flow.node("transform", {
      id: "retryable_only",
      position: { x: 1100, y: 0 },
      config: { value: true },
    });
    const retryableCodes = flow.node("transform", {
      id: "retryable_codes",
      position: { x: 1240, y: 0 },
      config: { value: "payment.*" },
    });
    const requireIdempotency = flow.node("transform", {
      id: "require_idempotency",
      position: { x: 1380, y: 0 },
      config: { value: true },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 1520, y: 0 },
      config: {
        maxAttempts: 1,
        baseDelayMs: 9999,
        multiplier: 1,
        maxDelayMs: 9999,
        retryableCodes: "inventory.*",
        requireIdempotency: false,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 1660, y: 0 },
      config: { template: "retry:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 1800, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), idempotent.in("in"));
    flow.connect(idempotent.out("out"), maxAttempts.in("in"));
    flow.connect(maxAttempts.out("out"), baseDelay.in("in"));
    flow.connect(baseDelay.out("out"), multiplier.in("in"));
    flow.connect(multiplier.out("out"), maxDelay.in("in"));
    flow.connect(maxDelay.out("out"), jitter.in("in"));
    flow.connect(jitter.out("out"), retryableOnly.in("in"));
    flow.connect(retryableOnly.out("out"), retryableCodes.in("in"));
    flow.connect(retryableCodes.out("out"), requireIdempotency.in("in"));
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(idempotent.out("output"), policy.in("idempotent"));
    flow.connect(maxAttempts.out("output"), policy.in("maxAttempts"));
    flow.connect(baseDelay.out("output"), policy.in("baseDelayMs"));
    flow.connect(multiplier.out("output"), policy.in("multiplier"));
    flow.connect(maxDelay.out("output"), policy.in("maxDelayMs"));
    flow.connect(jitter.out("output"), policy.in("jitterPercent"));
    flow.connect(retryableOnly.out("output"), policy.in("retryableOnly"));
    flow.connect(retryableCodes.out("output"), policy.in("retryableCodes"));
    flow.connect(requireIdempotency.out("output"), policy.in("requireIdempotency"));
    flow.connect(policy.out("retry"), report.in("in"));
    flow.connect(policy.out("delayMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_dynamic_strategy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:200");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const policyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "policy") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(policyOutput).toMatchObject({
      status: "retry",
      retryable: true,
      idempotent: true,
      requiresIdempotency: true,
      blockedByIdempotency: false,
      maxAttempts: 4,
      remainingAttempts: 3,
      baseDelayMs: 200,
      multiplier: 3,
      maxDelayMs: 1000,
      jitterPercent: 0,
      retryableOnly: true,
      retryableCodes: "payment.*",
      delayMs: 200,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const policyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "policy") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(policyOutput).toMatchObject({
      status: "exhausted",
      attempt: 1,
      nextAttempt: 1,
      maxAttempts: 1,
      remainingAttempts: 0,
      exhaustedValue: true,
      delayMs: 0,
    });
  });

  it("routes retry_policy to unsafe when idempotency is required but unknown", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_idempotency_unsafe_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true } },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 3,
        baseDelayMs: 100,
        requireIdempotency: true,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "unsafe:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(policy.out("unsafe"), report.in("in"));
    flow.connect(policy.out("blockedByIdempotency"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_idempotency_unsafe_e2e",
      input: null,
    });
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const policyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "policy") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("unsafe:true");
    expect(policyOutput).toMatchObject({
      status: "unsafe",
      retryable: true,
      requiresIdempotency: true,
      blockedByIdempotency: true,
      exhaustedValue: false,
      unsafeValue: true,
      delayMs: 0,
    });
    expect(policyOutput?.idempotent).toBeUndefined();
  });

  it("allows retry_policy retries when required idempotency is confirmed", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_idempotent_retry_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true, idempotent: true } },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 3,
        baseDelayMs: 100,
        requireIdempotency: true,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "retry:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(policy.out("retry"), report.in("in"));
    flow.connect(policy.out("delayMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_idempotent_retry_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:100");
  });

  it("routes retry_policy to exhausted when error code is not retryable", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_code_filter_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.fatal", retryable: true } },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 3,
        retryableCodes: "payment.timeout,payment.rate_limit",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "retryable:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(policy.out("exhausted"), report.in("in"));
    flow.connect(policy.out("retryable"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_code_filter_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retryable:false");
  });

  it("routes retry_policy to exhausted when retryableOnly is true and retryability is unknown", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "retry_policy_unknown_retryable_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout" } },
    });
    const policy = flow.node("retry_policy", {
      id: "policy",
      position: { x: 260, y: 0 },
      config: {
        maxAttempts: 3,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "exhausted:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), policy.in("error"));
    flow.connect(policy.out("exhausted"), report.in("in"));
    flow.connect(policy.out("attempt"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_policy_unknown_retryable_e2e",
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const retryOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "retry") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(retryOutput).toMatchObject({
      status: "retry",
      stateStatus: "waiting",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      remainingAttempts: 2,
      exhaustedValue: false,
      delayMs: 100,
    });
    expect(variables.get("PAYMENT_RETRY:order-1")).toMatchObject({
      status: "waiting",
      attempt: 1,
      retryable: true,
      lastError: { code: "payment.timeout", retryable: true },
    });
  });

  it("records retry_state failures with a dynamically named state", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const stateName = flow.node("transform", {
      id: "stateName",
      position: { x: 120, y: -80 },
      config: { value: "PAYMENT_DYNAMIC_RETRY" },
    });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true } },
    });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 280, y: 0 },
      config: {
        key: "order-2",
        maxAttempts: 3,
        baseDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 1000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 440, y: 0 },
      config: { template: "retry:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), stateName.in("in"));
    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), retry.in("in"));
    flow.connect(stateName.out("output"), retry.in("name"));
    flow.connect(source.out("output"), retry.in("error"));
    flow.connect(retry.out("retry"), report.in("in"));
    flow.connect(retry.out("stateKey"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "retry_state_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:PAYMENT_DYNAMIC_RETRY:order-2");
    expect(variables.get("PAYMENT_DYNAMIC_RETRY:order-2")).toMatchObject({
      status: "waiting",
      attempt: 1,
      retryable: true,
      lastError: { code: "payment.timeout", retryable: true },
    });
    expect(variables.has("")).toBe(false);
  });

  it("persists retry_state unsafe when required idempotency is unknown", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const recordFlow = defineFlow({ id: "retry_state_idempotency_unsafe_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const recordStart = recordFlow.node("start", { id: "record_start", position: { x: 0, y: 0 } });
    const source = recordFlow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout", retryable: true } },
    });
    const retry = recordFlow.node("retry_state", {
      id: "retry",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "unsafe-order",
        maxAttempts: 3,
        baseDelayMs: 100,
        requireIdempotency: true,
      },
    });
    const recordReport = recordFlow.node("transform", {
      id: "record_report",
      position: { x: 400, y: 0 },
      config: { template: "unsafe:${input}" },
    });
    const recordEnd = recordFlow.node("end", { id: "record_end", position: { x: 540, y: 0 } });

    recordFlow.connect(recordStart.out("out"), source.in("in"));
    recordFlow.connect(source.out("out"), retry.in("in"));
    recordFlow.connect(source.out("output"), retry.in("error"));
    recordFlow.connect(retry.out("unsafe"), recordReport.in("in"));
    recordFlow.connect(retry.out("blockedByIdempotency"), recordReport.in("input"));
    recordFlow.connect(recordReport.out("out"), recordEnd.in("in"));

    const checkFlow = defineFlow({ id: "retry_state_idempotency_unsafe_check_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const checkStart = checkFlow.node("start", { id: "check_start", position: { x: 0, y: 0 } });
    const check = checkFlow.node("retry_state", {
      id: "check",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "unsafe-order",
        mode: "check",
      },
    });
    const checkReport = checkFlow.node("transform", {
      id: "check_report",
      position: { x: 260, y: 0 },
      config: { template: "check:${input}" },
    });
    const checkEnd = checkFlow.node("end", { id: "check_end", position: { x: 400, y: 0 } });

    checkFlow.connect(checkStart.out("out"), check.in("in"));
    checkFlow.connect(check.out("unsafe"), checkReport.in("in"));
    checkFlow.connect(check.out("stateStatus"), checkReport.in("input"));
    checkFlow.connect(checkReport.out("out"), checkEnd.in("in"));

    await registerAndPromote(rt, recordFlow);
    await registerAndPromote(rt, checkFlow);

    const recordResult = await rt.invocationRouter.invoke({
      flowId: "retry_state_idempotency_unsafe_e2e",
      input: null,
    });
    const checkResult = await rt.invocationRouter.invoke({
      flowId: "retry_state_idempotency_unsafe_check_e2e",
      input: null,
    });
    const recordEvents = await rt.eventBus.store.read(recordResult.runRecord.runId);
    const retryOutput = (
      recordEvents.find((event) => event.kind === "node_finished" && event.nodeId === "retry") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(recordResult.succeeded).toBe(true);
    expect(recordResult.output).toBe("unsafe:true");
    expect(checkResult.succeeded).toBe(true);
    expect(checkResult.output).toBe("check:unsafe");
    expect(retryOutput).toMatchObject({
      status: "unsafe",
      stateStatus: "unsafe",
      retryable: true,
      requiresIdempotency: true,
      blockedByIdempotency: true,
      exhaustedValue: false,
      unsafeValue: true,
      delayMs: 0,
    });
    expect(variables.get("PAYMENT_RETRY:unsafe-order")).toMatchObject({
      status: "unsafe",
      attempt: 1,
      retryable: true,
      idempotent: null,
      requiresIdempotency: true,
      blockedByIdempotency: true,
      lastError: { code: "payment.timeout", retryable: true },
    });
  });

  it("records retry_state retries when error code matches a wildcard policy", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_code_filter_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout" } },
    });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-2",
        maxAttempts: 3,
        baseDelayMs: 50,
        retryableCodes: "payment.*",
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
      flowId: "retry_state_code_filter_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:50");
    expect(variables.get("PAYMENT_RETRY:order-2")).toMatchObject({
      status: "waiting",
      attempt: 1,
      retryable: true,
      lastError: { code: "payment.timeout" },
    });
  });

  it("honors retry-after metadata in retry_state backoff", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_retry_after_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.rate_limit", retryable: true, retryAfterMs: 5000 } },
    });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-retry-after",
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
      flowId: "retry_state_retry_after_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("retry:5000");
    expect(variables.get("PAYMENT_RETRY:order-retry-after")).toMatchObject({
      status: "waiting",
      attempt: 1,
      lastError: { code: "payment.rate_limit", retryable: true, retryAfterMs: 5000 },
    });
  });

  it("exhausts retry_state when retryableOnly is true and retryability is unknown", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "retry_state_unknown_retryable_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: { code: "payment.timeout" } },
    });
    const retry = flow.node("retry_state", {
      id: "retry",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_RETRY",
        key: "order-unknown",
        maxAttempts: 3,
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
      flowId: "retry_state_unknown_retryable_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("exhausted:1");
    expect(variables.get("PAYMENT_RETRY:order-unknown")).toMatchObject({
      status: "exhausted",
      attempt: 1,
      retryable: null,
      lastError: { code: "payment.timeout" },
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const retryOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "retry") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(retryOutput).toMatchObject({
      status: "exhausted",
      stateStatus: "exhausted",
      attempt: 2,
      nextAttempt: 2,
      maxAttempts: 2,
      remainingAttempts: 0,
      exhaustedValue: true,
      delayMs: 0,
    });
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

  it("routes a dynamically named rate_limit to allowed", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "rate_limit_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const limitName = flow.node("transform", {
      id: "limitName",
      position: { x: 120, y: -80 },
      config: { value: "PAYMENT_DYNAMIC_API_LIMIT" },
    });
    const limit = flow.node("rate_limit", {
      id: "limit",
      position: { x: 260, y: 0 },
      config: {
        limit: 2,
        windowMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "allowed:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), limitName.in("in"));
    flow.connect(start.out("out"), limit.in("in"));
    flow.connect(limitName.out("output"), limit.in("name"));
    flow.connect(limit.out("allowed"), report.in("in"));
    flow.connect(limit.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rate_limit_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("allowed:PAYMENT_DYNAMIC_API_LIMIT");
    expect(variables.get("PAYMENT_DYNAMIC_API_LIMIT")).toMatchObject({
      limit: 2,
      windowMs: 60_000,
    });
    expect(
      (variables.get("PAYMENT_DYNAMIC_API_LIMIT") as { timestamps?: unknown[] })
        .timestamps,
    ).toHaveLength(1);
    expect(variables.has("")).toBe(false);
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

  it("routes a dynamically named mutex to acquired", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "mutex_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const lockName = flow.node("transform", {
      id: "lockName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_LOCK" },
    });
    const mutex = flow.node("mutex", {
      id: "lock",
      position: { x: 260, y: 0 },
      config: {
        owner: "worker-2",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "acquired:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), lockName.in("in"));
    flow.connect(start.out("out"), mutex.in("in"));
    flow.connect(lockName.out("output"), mutex.in("name"));
    flow.connect(mutex.out("acquired"), report.in("in"));
    flow.connect(mutex.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "mutex_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("acquired:ORDER_DYNAMIC_LOCK");
    expect(variables.get("ORDER_DYNAMIC_LOCK")).toMatchObject({
      locked: true,
      owner: "worker-2",
    });
    expect(variables.has("")).toBe(false);
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

  it("routes a dynamically named semaphore to acquired", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "semaphore_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const poolName = flow.node("transform", {
      id: "poolName",
      position: { x: 120, y: -80 },
      config: { value: "FILE_DYNAMIC_WORKER_POOL" },
    });
    const gate = flow.node("semaphore", {
      id: "gate",
      position: { x: 260, y: 0 },
      config: {
        owner: "worker-3",
        capacity: 2,
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "acquired:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), poolName.in("in"));
    flow.connect(start.out("out"), gate.in("in"));
    flow.connect(poolName.out("output"), gate.in("name"));
    flow.connect(gate.out("acquired"), report.in("in"));
    flow.connect(gate.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "semaphore_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("acquired:FILE_DYNAMIC_WORKER_POOL");
    expect(variables.get("FILE_DYNAMIC_WORKER_POOL")).toMatchObject({
      capacity: 2,
      holders: [{ owner: "worker-3" }],
    });
    expect(variables.has("")).toBe(false);
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

  it("routes idempotency_key with a dynamic namespace input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "idempotency_dynamic_namespace_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const namespace = flow.node("transform", {
      id: "namespace",
      position: { x: 120, y: -80 },
      config: { value: "payments dynamic" },
    });
    const key = flow.node("transform", {
      id: "key",
      position: { x: 120, y: 80 },
      config: { value: "order-namespace" },
    });
    const idem = flow.node("idempotency_key", {
      id: "idem",
      position: { x: 300, y: 0 },
      config: {
        mode: "start",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "idem:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), namespace.in("in"));
    flow.connect(start.out("out"), key.in("in"));
    flow.connect(start.out("out"), idem.in("in"));
    flow.connect(namespace.out("output"), idem.in("namespace"));
    flow.connect(key.out("output"), idem.in("key"));
    flow.connect(idem.out("started"), report.in("in"));
    flow.connect(idem.out("stateKey"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "idempotency_dynamic_namespace_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("idem:IDEMPOTENCY:payments_dynamic:order-namespace");
    expect(variables.get("IDEMPOTENCY:payments_dynamic:order-namespace")).toMatchObject({
      key: "order-namespace",
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

  it("resets idempotency_key by deleting the stored business key", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("IDEMPOTENCY:payments:order-3", {
      key: "order-3",
      status: "completed",
      owner: "previous-run",
      value: "receipt-3",
      error: null,
      startedAt: Date.now() - 1000,
      completedAt: Date.now() - 500,
      failedAt: null,
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now() - 500,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "idempotency_reset_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const idem = flow.node("idempotency_key", {
      id: "idem",
      position: { x: 120, y: 0 },
      config: {
        namespace: "payments",
        key: "order-3",
        mode: "reset",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "idem:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), idem.in("in"));
    flow.connect(idem.out("reset"), report.in("in"));
    flow.connect(idem.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "idempotency_reset_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("idem:reset");
    expect(variables.has("IDEMPOTENCY:payments:order-3")).toBe(false);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const checkOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "check") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(checkOutput).toMatchObject({
      status: "open",
      failureCount: 1,
      failureThreshold: 1,
      remainingFailures: 0,
      resetTimeoutMs: 60_000,
      isOpen: true,
      isHalfOpen: false,
      isClosed: false,
      canPass: false,
      remainingMs: expect.any(Number),
    });
    expect(variables.get("PAYMENT_CIRCUIT")).toMatchObject({
      status: "open",
      failureCount: 1,
    });
  });

  it("opens a dynamically named circuit_breaker after a recorded failure", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const breakerName = flow.node("transform", {
      id: "breakerName",
      position: { x: 120, y: -80 },
      config: { value: "PAYMENT_DYNAMIC_CIRCUIT" },
    });
    const recordFailure = flow.node("circuit_breaker", {
      id: "record_failure",
      position: { x: 260, y: 0 },
      config: {
        failureThreshold: 1,
        resetTimeoutMs: 60_000,
        mode: "record_failure",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), breakerName.in("in"));
    flow.connect(start.out("out"), recordFailure.in("in"));
    flow.connect(breakerName.out("output"), recordFailure.in("name"));
    flow.connect(recordFailure.out("open"), report.in("in"));
    flow.connect(recordFailure.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:PAYMENT_DYNAMIC_CIRCUIT");
    expect(variables.get("PAYMENT_DYNAMIC_CIRCUIT")).toMatchObject({
      status: "open",
      failureCount: 1,
    });
    expect(variables.has("")).toBe(false);
  });

  it("opens a circuit_breaker with dynamic mode and threshold inputs", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_dynamic_policy_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const mode = flow.node("transform", {
      id: "mode",
      position: { x: 120, y: 0 },
      config: { value: "record_failure" },
    });
    const threshold = flow.node("transform", {
      id: "threshold",
      position: { x: 260, y: 0 },
      config: { value: 1 },
    });
    const resetTimeout = flow.node("transform", {
      id: "reset_timeout",
      position: { x: 400, y: 0 },
      config: { value: 60_000 },
    });
    const breaker = flow.node("circuit_breaker", {
      id: "breaker",
      position: { x: 540, y: 0 },
      config: {
        name: "PAYMENT_DYNAMIC_POLICY_CIRCUIT",
        mode: "check",
        failureThreshold: 99,
        resetTimeoutMs: 1,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 680, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 820, y: 0 } });

    flow.connect(start.out("out"), mode.in("in"));
    flow.connect(mode.out("out"), threshold.in("in"));
    flow.connect(threshold.out("out"), resetTimeout.in("in"));
    flow.connect(resetTimeout.out("out"), breaker.in("in"));
    flow.connect(mode.out("output"), breaker.in("mode"));
    flow.connect(threshold.out("output"), breaker.in("failureThreshold"));
    flow.connect(resetTimeout.out("output"), breaker.in("resetTimeoutMs"));
    flow.connect(breaker.out("open"), report.in("in"));
    flow.connect(breaker.out("mode"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:record_failure");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const breakerOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "breaker") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(breakerOutput).toMatchObject({
      mode: "record_failure",
      status: "open",
      failureCount: 1,
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
      isOpen: true,
      canPass: false,
    });
    expect(variables.get("PAYMENT_DYNAMIC_POLICY_CIRCUIT")).toMatchObject({
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const checkOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "check") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(checkOutput).toMatchObject({
      status: "half_open",
      failureCount: 2,
      failureThreshold: 3,
      remainingFailures: 1,
      resetTimeoutMs: 1,
      isOpen: false,
      isHalfOpen: true,
      isClosed: false,
      canPass: true,
      remainingMs: 0,
    });
    expect(variables.get("PAYMENT_CIRCUIT")).toMatchObject({
      status: "half_open",
      failureCount: 2,
    });
  });

  it("routes open circuit_breaker state to half_open with a dynamic reset timeout input", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_DYNAMIC_RESET_CIRCUIT", {
      status: "open",
      failureCount: 2,
      openedAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_dynamic_reset_timeout_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const resetTimeout = flow.node("transform", {
      id: "reset_timeout",
      position: { x: 120, y: 0 },
      config: { value: 1 },
    });
    const check = flow.node("circuit_breaker", {
      id: "check",
      position: { x: 260, y: 0 },
      config: {
        name: "PAYMENT_DYNAMIC_RESET_CIRCUIT",
        resetTimeoutMs: 60_000,
        mode: "check",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), resetTimeout.in("in"));
    flow.connect(resetTimeout.out("out"), check.in("in"));
    flow.connect(resetTimeout.out("output"), check.in("resetTimeoutMs"));
    flow.connect(check.out("half_open"), report.in("in"));
    flow.connect(check.out("resetTimeoutMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_dynamic_reset_timeout_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:1");
    expect(variables.get("PAYMENT_DYNAMIC_RESET_CIRCUIT")).toMatchObject({
      status: "half_open",
      failureCount: 2,
    });
  });

  it("closes a half_open circuit_breaker after a successful probe", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_CIRCUIT", {
      status: "half_open",
      failureCount: 2,
      openedAt: Date.now() - 10_000,
      updatedAt: Date.now() - 1_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_half_open_success_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const recordSuccess = flow.node("circuit_breaker", {
      id: "record_success",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_CIRCUIT",
        mode: "record_success",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), recordSuccess.in("in"));
    flow.connect(recordSuccess.out("closed"), report.in("in"));
    flow.connect(recordSuccess.out("openedAt"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_half_open_success_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:");
    expect(variables.get("PAYMENT_CIRCUIT")).toMatchObject({
      status: "closed",
      failureCount: 0,
      openedAt: null,
    });
  });

  it("reopens a half_open circuit_breaker after a failed probe", async () => {
    const previousOpenedAt = Date.now() - 10_000;
    const variables = new InMemoryVariableStore();
    variables.set("PAYMENT_CIRCUIT", {
      status: "half_open",
      failureCount: 2,
      openedAt: previousOpenedAt,
      updatedAt: Date.now() - 1_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "circuit_breaker_half_open_failure_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const recordFailure = flow.node("circuit_breaker", {
      id: "record_failure",
      position: { x: 120, y: 0 },
      config: {
        name: "PAYMENT_CIRCUIT",
        failureThreshold: 3,
        resetTimeoutMs: 60_000,
        mode: "record_failure",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "circuit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), recordFailure.in("in"));
    flow.connect(recordFailure.out("open"), report.in("in"));
    flow.connect(recordFailure.out("failureCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "circuit_breaker_half_open_failure_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("circuit:3");
    expect(variables.get("PAYMENT_CIRCUIT")).toMatchObject({
      status: "open",
      failureCount: 3,
    });
    expect((variables.get("PAYMENT_CIRCUIT") as { openedAt: number }).openedAt).toBeGreaterThan(previousOpenedAt);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const drainOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "drain") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(drainOutput).toMatchObject({
      name: "ORDER_COMPENSATIONS",
      mode: "drain",
      status: "drained",
      count: 2,
      stackCount: 0,
      updatedAt: expect.any(String),
      registeredValue: false,
      drainedValue: true,
      clearedValue: false,
    });
    expect(variables.get("ORDER_COMPENSATIONS")).toMatchObject({
      actions: [],
    });
  });

  it("registers compensation actions with dynamic name and action inputs", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "compensation_dynamic_inputs_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const name = flow.node("transform", {
      id: "name",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_COMPENSATIONS" },
    });
    const action = flow.node("transform", {
      id: "action",
      position: { x: 120, y: 80 },
      config: { value: "release_dynamic_inventory" },
    });
    const register = flow.node("compensation", {
      id: "register",
      position: { x: 300, y: 0 },
      config: {
        mode: "register",
        payload: { sku: "pen", quantity: 2 },
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "comp:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), name.in("in"));
    flow.connect(start.out("out"), action.in("in"));
    flow.connect(start.out("out"), register.in("in"));
    flow.connect(name.out("output"), register.in("name"));
    flow.connect(action.out("output"), register.in("action"));
    flow.connect(register.out("out"), report.in("in"));
    flow.connect(register.out("actionName"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "compensation_dynamic_inputs_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("comp:release_dynamic_inventory");
    expect(variables.get("ORDER_DYNAMIC_COMPENSATIONS")).toMatchObject({
      actions: [
        {
          action: "release_dynamic_inventory",
          payload: { sku: "pen", quantity: 2 },
        },
      ],
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const rollbackOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "rollback") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(rollbackOutput).toMatchObject({
      status: "rollback",
      mode: "plan",
      successPath: "status",
      errorPath: "error",
      missingResult: "pending",
      count: 2,
      successCount: 0,
      failureCount: 0,
      pendingCount: 2,
      successRate: 0,
      failureRate: 0,
      pendingRate: 1,
      hasFailures: false,
      hasPending: true,
      rollbackValue: true,
      emptyValue: false,
      partialValue: false,
      incompleteValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const rollbackOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "rollback") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(rollbackOutput).toMatchObject({
      status: "partial",
      mode: "summarize",
      successPath: "status",
      errorPath: "error",
      missingResult: "pending",
      count: 2,
      successCount: 1,
      failureCount: 1,
      pendingCount: 0,
      successRate: 0.5,
      failureRate: 0.5,
      pendingRate: 0,
      hasFailures: true,
      hasPending: false,
      rollbackValue: false,
      partialValue: true,
      incompleteValue: false,
    });
  });

  it("routes rollback summarize to incomplete when results are still pending", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "rollback_incomplete_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
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
    const rollback = flow.node("rollback", {
      id: "rollback",
      position: { x: 260, y: 0 },
      config: { mode: "summarize", missingResult: "pending" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "incomplete:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), actions.in("in"));
    flow.connect(actions.out("out"), rollback.in("in"));
    flow.connect(actions.out("output"), rollback.in("actions"));
    flow.connect(rollback.out("incomplete"), report.in("in"));
    flow.connect(rollback.out("pendingCount"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "rollback_incomplete_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("incomplete:2");
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
    const markEvents = await rt.eventBus.store.read(marked.runRecord.runId);
    const markOutput = (
      markEvents.find((event) => event.kind === "node_finished" && event.nodeId === "mark") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(markOutput).toMatchObject({
      status: "marked",
      stateStatus: "ready",
      name: "ORDER_RESUME_POINT",
      targetNodeId: "charge_payment",
      reason: "payment timeout",
      sourceRunId: expect.any(String),
      version: 1,
      markedAt: expect.any(String),
      loadedAt: "",
      expiresAt: "",
      ttlMs: 0,
      remainingMs: 0,
      stateExists: true,
      markedValue: true,
      readyValue: false,
      missingValue: false,
      expiredValue: false,
    });
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
    const loadEvents = await rt.eventBus.store.read(loaded.runRecord.runId);
    const loadOutput = (
      loadEvents.find((event) => event.kind === "node_finished" && event.nodeId === "load") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(loadOutput).toMatchObject({
      status: "ready",
      stateStatus: "ready",
      name: "ORDER_RESUME_POINT",
      targetNodeId: "charge_payment",
      reason: "payment timeout",
      sourceRunId: expect.any(String),
      version: 1,
      markedAt: expect.any(String),
      loadedAt: expect.any(String),
      expiresAt: "",
      ttlMs: 0,
      remainingMs: 0,
      stateExists: true,
      markedValue: false,
      readyValue: true,
      missingValue: false,
      expiredValue: false,
    });
  });

  it("marks a resume_point with dynamic name and reason inputs", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "resume_point_dynamic_inputs_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const name = flow.node("transform", {
      id: "name",
      position: { x: 120, y: -120 },
      config: { value: "ORDER_DYNAMIC_RESUME" },
    });
    const reason = flow.node("transform", {
      id: "reason",
      position: { x: 120, y: 0 },
      config: { value: "dynamic payment timeout" },
    });
    const target = flow.node("transform", {
      id: "target",
      position: { x: 120, y: 120 },
      config: { value: "charge_payment" },
    });
    const mark = flow.node("resume_point", {
      id: "mark",
      position: { x: 320, y: 0 },
      config: {
        mode: "mark",
        snapshot: { orderId: "order-dynamic", step: "charge_payment" },
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 480, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 0 } });

    flow.connect(start.out("out"), name.in("in"));
    flow.connect(start.out("out"), reason.in("in"));
    flow.connect(start.out("out"), target.in("in"));
    flow.connect(start.out("out"), mark.in("in"));
    flow.connect(name.out("output"), mark.in("name"));
    flow.connect(reason.out("output"), mark.in("reason"));
    flow.connect(target.out("output"), mark.in("targetNodeId"));
    flow.connect(mark.out("marked"), report.in("in"));
    flow.connect(mark.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "resume_point_dynamic_inputs_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:ORDER_DYNAMIC_RESUME");
    expect(variables.get("ORDER_DYNAMIC_RESUME")).toMatchObject({
      status: "ready",
      targetNodeId: "charge_payment",
      reason: "dynamic payment timeout",
      snapshot: { orderId: "order-dynamic", step: "charge_payment" },
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const loadOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "load") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(loadOutput).toMatchObject({
      status: "missing",
      stateStatus: "",
      name: "MISSING_RESUME_POINT",
      targetNodeId: "",
      reason: "",
      sourceRunId: "",
      version: 0,
      markedAt: "",
      loadedAt: "",
      expiresAt: "",
      ttlMs: 0,
      remainingMs: 0,
      stateExists: false,
      markedValue: false,
      readyValue: false,
      missingValue: true,
      expiredValue: false,
    });
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

  it("touches a ready resume_point to extend its TTL and update reason", async () => {
    const variables = new InMemoryVariableStore();
    const originalExpiresAt = Date.now() + 100;
    variables.set("ORDER_RESUME_TOUCH", {
      name: "ORDER_RESUME_TOUCH",
      status: "ready",
      targetNodeId: "charge_payment",
      snapshot: { orderId: "order-1" },
      reason: "initial",
      sourceRunId: "run_1",
      version: 7,
      markedAt: Date.now() - 1_000,
      loadedAt: null,
      expiresAt: originalExpiresAt,
      updatedAt: Date.now() - 1_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "resume_point_touch_ready_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const touch = flow.node("resume_point", {
      id: "touch",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RESUME_TOUCH",
        mode: "touch",
        reason: "refreshed",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), touch.in("in"));
    flow.connect(touch.out("marked"), report.in("in"));
    flow.connect(touch.out("reason"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "resume_point_touch_ready_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:refreshed");
    expect(variables.get("ORDER_RESUME_TOUCH")).toMatchObject({
      status: "ready",
      reason: "refreshed",
      version: 7,
    });
    expect((variables.get("ORDER_RESUME_TOUCH") as { expiresAt: number }).expiresAt).toBeGreaterThan(originalExpiresAt);
  });

  it("routes resume_point touch to expired when the marker is already expired", async () => {
    const variables = new InMemoryVariableStore();
    const expiredAt = Date.now() - 1;
    variables.set("ORDER_RESUME_TOUCH_EXPIRED", {
      name: "ORDER_RESUME_TOUCH_EXPIRED",
      status: "ready",
      targetNodeId: "charge_payment",
      snapshot: { orderId: "order-1" },
      reason: "initial",
      sourceRunId: "run_1",
      version: 3,
      markedAt: Date.now() - 10_000,
      loadedAt: null,
      expiresAt: expiredAt,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "resume_point_touch_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const touch = flow.node("resume_point", {
      id: "touch",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_RESUME_TOUCH_EXPIRED",
        mode: "touch",
        reason: "should-not-revive",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), touch.in("in"));
    flow.connect(touch.out("expired"), report.in("in"));
    flow.connect(touch.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "resume_point_touch_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:expired");
    expect(variables.get("ORDER_RESUME_TOUCH_EXPIRED")).toMatchObject({
      status: "expired",
      reason: "initial",
      expiresAt: expiredAt,
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const waitOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "wait") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(waitOutput).toMatchObject({
      status: "received",
      signal: "approved",
      expected: "approved",
      requestedAt: expect.any(String),
      expiresAt: "",
      timeoutMs: 0,
      remainingMs: 0,
      receivedValue: true,
      waitingValue: false,
      expiredValue: false,
    });
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "received",
      signal: "approved",
    });
  });

  it("keeps received wait_signal state terminal when a later signal mismatches", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_RECEIVED", {
      status: "received",
      signal: "approved",
      expected: "approved",
      requestedAt: Date.now() - 1_000,
      expiresAt: null,
      updatedAt: Date.now() - 500,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_received_terminal_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const staleSignal = flow.node("transform", {
      id: "stale_signal",
      position: { x: 120, y: 0 },
      config: { template: "denied" },
    });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_APPROVAL_RECEIVED",
        expected: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "signal:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), staleSignal.in("in"));
    flow.connect(staleSignal.out("out"), wait.in("in"));
    flow.connect(staleSignal.out("output"), wait.in("signal"));
    flow.connect(wait.out("received"), report.in("in"));
    flow.connect(wait.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_signal_received_terminal_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("signal:received");
    expect(variables.get("ORDER_APPROVAL_RECEIVED")).toMatchObject({
      status: "received",
      signal: "approved",
      expected: "approved",
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const waitOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "wait") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(waitOutput).toMatchObject({
      status: "waiting",
      signal: null,
      expected: "approved",
      requestedAt: expect.any(String),
      expiresAt: expect.any(String),
      timeoutMs: 60_000,
      remainingMs: expect.any(Number),
      receivedValue: false,
      waitingValue: true,
      expiredValue: false,
    });
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "waiting",
      signal: null,
      expected: "approved",
    });
  });

  it("creates a wait_signal checkpoint with a dynamic name input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const name = flow.node("transform", {
      id: "name",
      position: { x: 120, y: 0 },
      config: { value: "ORDER_APPROVAL_DYNAMIC" },
    });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 260, y: 0 },
      config: {
        expected: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "signal:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), name.in("in"));
    flow.connect(name.out("out"), wait.in("in"));
    flow.connect(name.out("output"), wait.in("name"));
    flow.connect(wait.out("waiting"), report.in("in"));
    flow.connect(wait.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_signal_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("signal:ORDER_APPROVAL_DYNAMIC");
    expect(variables.get("ORDER_APPROVAL_DYNAMIC")).toMatchObject({
      status: "waiting",
      signal: null,
      expected: "approved",
    });
  });

  it("creates a wait_signal checkpoint with a dynamic expected input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_dynamic_expected_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const expected = flow.node("transform", {
      id: "expected",
      position: { x: 120, y: 0 },
      config: { value: "accepted" },
    });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_APPROVAL_DYNAMIC_EXPECTED",
        expected: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "expected:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), expected.in("in"));
    flow.connect(expected.out("out"), wait.in("in"));
    flow.connect(expected.out("output"), wait.in("expected"));
    flow.connect(wait.out("waiting"), report.in("in"));
    flow.connect(wait.out("expected"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_signal_dynamic_expected_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("expected:accepted");
    expect(variables.get("ORDER_APPROVAL_DYNAMIC_EXPECTED")).toMatchObject({
      status: "waiting",
      signal: null,
      expected: "accepted",
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
    const resumeEvents = await rt.eventBus.store.read(resumed.runRecord.runId);
    const resumeOutput = (
      resumeEvents.find((event) => event.kind === "node_finished" && event.nodeId === "resume") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(resumeOutput).toMatchObject({
      status: "resumed",
      name: "ORDER_APPROVAL_SIGNAL",
      stateStatus: "received",
      signal: "approved",
      expected: "approved",
      stateExists: true,
      matched: true,
      requestedAt: expect.any(String),
      expiresAt: "",
      remainingMs: 0,
      resumedValue: true,
      ignoredValue: false,
      missingValue: false,
      expiredValue: false,
    });
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

  it("resumes a wait_signal checkpoint with a dynamic expected input", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_DYNAMIC_EXPECTED_RESUME", {
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
    const flow = defineFlow({ id: "signal_resume_dynamic_expected_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const signal = flow.node("transform", {
      id: "signal",
      position: { x: 120, y: 0 },
      config: { value: "accepted" },
    });
    const expected = flow.node("transform", {
      id: "expected",
      position: { x: 260, y: 0 },
      config: { value: "accepted" },
    });
    const resume = flow.node("signal_resume", {
      id: "resume",
      position: { x: 400, y: 0 },
      config: {
        name: "ORDER_APPROVAL_DYNAMIC_EXPECTED_RESUME",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), signal.in("in"));
    flow.connect(signal.out("out"), expected.in("in"));
    flow.connect(expected.out("out"), resume.in("in"));
    flow.connect(signal.out("output"), resume.in("signal"));
    flow.connect(expected.out("output"), resume.in("expected"));
    flow.connect(resume.out("resumed"), report.in("in"));
    flow.connect(resume.out("expected"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "signal_resume_dynamic_expected_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:accepted");
    expect(variables.get("ORDER_APPROVAL_DYNAMIC_EXPECTED_RESUME")).toMatchObject({
      status: "received",
      signal: "accepted",
      expected: "accepted",
    });
  });

  it("creates a missing wait_signal checkpoint with a dynamic createIfMissing input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "signal_resume_dynamic_create_if_missing_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const createFlag = flow.node("transform", {
      id: "create_flag",
      position: { x: 120, y: 0 },
      config: { value: true },
    });
    const resume = flow.node("signal_resume", {
      id: "resume",
      position: { x: 260, y: 0 },
      config: {
        name: "ORDER_APPROVAL_CREATE_IF_MISSING",
        signal: "approved",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "resume:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), createFlag.in("in"));
    flow.connect(createFlag.out("out"), resume.in("in"));
    flow.connect(createFlag.out("output"), resume.in("createIfMissing"));
    flow.connect(resume.out("resumed"), report.in("in"));
    flow.connect(resume.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "signal_resume_dynamic_create_if_missing_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:resumed");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const resumeOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "resume") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(resumeOutput).toMatchObject({
      status: "resumed",
      stateStatus: "received",
      stateExists: true,
      matched: true,
      createIfMissing: true,
    });
    expect(variables.get("ORDER_APPROVAL_CREATE_IF_MISSING")).toMatchObject({
      status: "received",
      signal: "approved",
      expected: "approved",
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const resumeOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "resume") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(resumeOutput).toMatchObject({
      status: "missing",
      stateStatus: "",
      signal: "approved",
      expected: "approved",
      stateExists: false,
      matched: true,
      requestedAt: "",
      expiresAt: "",
      remainingMs: 0,
      resumedValue: false,
      ignoredValue: false,
      missingValue: true,
      expiredValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const resumeOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "resume") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(resumeOutput).toMatchObject({
      status: "ignored",
      stateStatus: "waiting",
      signal: "denied",
      expected: "approved",
      stateExists: true,
      matched: false,
      requestedAt: expect.any(String),
      expiresAt: "",
      remainingMs: 0,
      resumedValue: false,
      ignoredValue: true,
      missingValue: false,
      expiredValue: false,
    });
    expect(variables.get("ORDER_APPROVAL_SIGNAL")).toMatchObject({
      status: "waiting",
      signal: "denied",
      expected: "approved",
    });
  });

  it("keeps received signal_resume state idempotent and ignores stale mismatches", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_SIGNAL_RECEIVED", {
      status: "received",
      signal: "approved",
      expected: "approved",
      requestedAt: Date.now() - 1_000,
      expiresAt: null,
      updatedAt: Date.now() - 500,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });

    const duplicateFlow = defineFlow({ id: "signal_resume_duplicate_received_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const duplicateStart = duplicateFlow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const duplicateResume = duplicateFlow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL_RECEIVED",
        signal: "approved",
      },
    });
    const duplicateReport = duplicateFlow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const duplicateEnd = duplicateFlow.node("end", { id: "e", position: { x: 400, y: 0 } });
    duplicateFlow.connect(duplicateStart.out("out"), duplicateResume.in("in"));
    duplicateFlow.connect(duplicateResume.out("resumed"), duplicateReport.in("in"));
    duplicateFlow.connect(duplicateResume.out("status"), duplicateReport.in("input"));
    duplicateFlow.connect(duplicateReport.out("out"), duplicateEnd.in("in"));

    const mismatchFlow = defineFlow({ id: "signal_resume_stale_mismatch_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const mismatchStart = mismatchFlow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const mismatchResume = mismatchFlow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL_RECEIVED",
        signal: "denied",
      },
    });
    const mismatchReport = mismatchFlow.node("transform", {
      id: "report",
      position: { x: 260, y: 0 },
      config: { template: "resume:${input}" },
    });
    const mismatchEnd = mismatchFlow.node("end", { id: "e", position: { x: 400, y: 0 } });
    mismatchFlow.connect(mismatchStart.out("out"), mismatchResume.in("in"));
    mismatchFlow.connect(mismatchResume.out("ignored"), mismatchReport.in("in"));
    mismatchFlow.connect(mismatchResume.out("status"), mismatchReport.in("input"));
    mismatchFlow.connect(mismatchReport.out("out"), mismatchEnd.in("in"));

    await registerAndPromote(rt, duplicateFlow);
    await registerAndPromote(rt, mismatchFlow);

    const duplicate = await rt.invocationRouter.invoke({
      flowId: "signal_resume_duplicate_received_e2e",
      input: null,
    });
    expect(duplicate.succeeded).toBe(true);
    expect(duplicate.output).toBe("resume:resumed");

    const mismatch = await rt.invocationRouter.invoke({
      flowId: "signal_resume_stale_mismatch_e2e",
      input: null,
    });
    expect(mismatch.succeeded).toBe(true);
    expect(mismatch.output).toBe("resume:ignored");
    expect(variables.get("ORDER_APPROVAL_SIGNAL_RECEIVED")).toMatchObject({
      status: "received",
      signal: "approved",
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

  it("does not revive explicitly expired signal_resume state", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_SIGNAL_EXPLICIT_EXPIRED", {
      status: "expired",
      signal: null,
      expected: "approved",
      requestedAt: Date.now() - 10_000,
      expiresAt: null,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "signal_resume_explicit_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const resume = flow.node("signal_resume", {
      id: "resume",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_SIGNAL_EXPLICIT_EXPIRED",
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
      flowId: "signal_resume_explicit_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("resume:expired");
    expect(variables.get("ORDER_APPROVAL_SIGNAL_EXPLICIT_EXPIRED")).toMatchObject({
      status: "expired",
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const waitOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "wait") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(waitOutput).toMatchObject({
      status: "expired",
      signal: null,
      expected: "approved",
      requestedAt: expect.any(String),
      expiresAt: expect.any(String),
      timeoutMs: expect.any(Number),
      remainingMs: 0,
      receivedValue: false,
      waitingValue: false,
      expiredValue: true,
    });
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "expired",
      signal: null,
    });
  });

  it("does not revive explicitly expired wait_signal state", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_APPROVAL_EXPLICIT_EXPIRED", {
      status: "expired",
      signal: "approved",
      expected: "approved",
      requestedAt: Date.now() - 10_000,
      expiresAt: null,
      updatedAt: Date.now() - 10_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_signal_explicit_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const wait = flow.node("wait_signal", {
      id: "wait",
      position: { x: 120, y: 0 },
      config: {
        name: "ORDER_APPROVAL_EXPLICIT_EXPIRED",
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
      flowId: "wait_signal_explicit_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("signal:expired");
    expect(variables.get("ORDER_APPROVAL_EXPLICIT_EXPIRED")).toMatchObject({
      status: "expired",
      signal: "approved",
      expected: "approved",
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const timerOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "timer") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(timerOutput).toMatchObject({
      status: "waiting",
      requestedAt: expect.any(String),
      dueAt: expect.any(String),
      timeoutAt: "",
      timeoutMs: 0,
      remainingMs: expect.any(Number),
      overdueByMs: 0,
      dueValue: false,
      waitingValue: true,
      expiredValue: false,
    });
    expect(variables.get("ORDER_RETRY_TIMER")).toMatchObject({
      status: "waiting",
    });
    expect((variables.get("ORDER_RETRY_TIMER") as { dueAt?: number }).dueAt).toBeGreaterThan(
      Date.now(),
    );
  });

  it("creates a wait_timer checkpoint with a dynamic name input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "wait_timer_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const name = flow.node("transform", {
      id: "name",
      position: { x: 120, y: 0 },
      config: { value: "ORDER_RETRY_TIMER_DYNAMIC" },
    });
    const timer = flow.node("wait_timer", {
      id: "timer",
      position: { x: 260, y: 0 },
      config: {
        durationMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "timer:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), name.in("in"));
    flow.connect(name.out("out"), timer.in("in"));
    flow.connect(name.out("output"), timer.in("name"));
    flow.connect(timer.out("waiting"), report.in("in"));
    flow.connect(timer.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_timer_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timer:ORDER_RETRY_TIMER_DYNAMIC");
    expect(variables.get("ORDER_RETRY_TIMER_DYNAMIC")).toMatchObject({
      status: "waiting",
    });
    expect((variables.get("ORDER_RETRY_TIMER_DYNAMIC") as { dueAt?: number }).dueAt).toBeGreaterThan(
      Date.now(),
    );
  });

  it("resets a wait_timer checkpoint with dynamic reset and timeout inputs", async () => {
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_RETRY_TIMER_DYNAMIC_RESET", {
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
    const flow = defineFlow({ id: "wait_timer_dynamic_reset_timeout_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const reset = flow.node("transform", {
      id: "reset",
      position: { x: 120, y: 0 },
      config: { value: true },
    });
    const timeout = flow.node("transform", {
      id: "timeout",
      position: { x: 260, y: 0 },
      config: { value: 1234 },
    });
    const timer = flow.node("wait_timer", {
      id: "timer",
      position: { x: 400, y: 0 },
      config: {
        name: "ORDER_RETRY_TIMER_DYNAMIC_RESET",
        durationMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "timer:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), reset.in("in"));
    flow.connect(reset.out("out"), timeout.in("in"));
    flow.connect(timeout.out("out"), timer.in("in"));
    flow.connect(reset.out("output"), timer.in("reset"));
    flow.connect(timeout.out("output"), timer.in("timeoutMs"));
    flow.connect(timer.out("waiting"), report.in("in"));
    flow.connect(timer.out("timeoutMs"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "wait_timer_dynamic_reset_timeout_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("timer:1234");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const timerOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "timer") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(timerOutput).toMatchObject({
      status: "waiting",
      timeoutMs: 1234,
      reset: true,
      waitingValue: true,
      dueValue: false,
    });
    const state = variables.get("ORDER_RETRY_TIMER_DYNAMIC_RESET") as {
      status?: string;
      dueAt?: number;
      timeoutAt?: number;
    };
    expect(state).toMatchObject({ status: "waiting" });
    expect(state.dueAt).toBeGreaterThan(Date.now());
    expect(state.timeoutAt).toBe((state.dueAt ?? 0) + 1234);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const timerOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "timer") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(timerOutput).toMatchObject({
      status: "expired",
      requestedAt: expect.any(String),
      dueAt: expect.any(String),
      timeoutAt: expect.any(String),
      timeoutMs: expect.any(Number),
      remainingMs: 0,
      overdueByMs: expect.any(Number),
      dueValue: false,
      waitingValue: false,
      expiredValue: true,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const approvalOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "approval") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(approvalOutput).toMatchObject({
      branch: "requested",
      status: "pending",
      title: "Approve high value order",
      assignee: "finance",
      requestedAt: expect.any(String),
      resolvedAt: "",
      expiresAt: expect.any(String),
      timeoutMs: 60_000,
      remainingMs: expect.any(Number),
      stateExists: true,
      requestedValue: true,
      pendingValue: true,
      approvedValue: false,
      rejectedValue: false,
      expiredValue: false,
    });
    expect(variables.get("ORDER_APPROVAL")).toMatchObject({
      status: "pending",
      title: "Approve high value order",
      assignee: "finance",
      payload: { orderId: "order-1", amount: 4200 },
      decision: null,
    });
  });

  it("requests a dynamically named human approval", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "approval_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const approvalName = flow.node("transform", {
      id: "approvalName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_APPROVAL" },
    });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-2", amount: 2400 } },
    });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 280, y: 0 },
      config: {
        title: "Approve dynamic order",
        assignee: "finance",
        timeoutMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 440, y: 0 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), approvalName.in("in"));
    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), approval.in("in"));
    flow.connect(approvalName.out("output"), approval.in("name"));
    flow.connect(payload.out("output"), approval.in("payload"));
    flow.connect(approval.out("requested"), report.in("in"));
    flow.connect(approval.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:ORDER_DYNAMIC_APPROVAL");
    expect(variables.get("ORDER_DYNAMIC_APPROVAL")).toMatchObject({
      name: "ORDER_DYNAMIC_APPROVAL",
      status: "pending",
      title: "Approve dynamic order",
      assignee: "finance",
      payload: { orderId: "order-2", amount: 2400 },
      decision: null,
    });
    expect(variables.has("")).toBe(false);
  });

  it("requests approval with dynamic policy inputs", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({
      id: "approval_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 240 } });
    const approvalName = flow.node("transform", {
      id: "approval_name",
      position: { x: 140, y: 40 },
      config: { value: "ORDER_DYNAMIC_POLICY_APPROVAL" },
    });
    const mode = flow.node("transform", {
      id: "mode",
      position: { x: 140, y: 140 },
      config: { value: "request" },
    });
    const title = flow.node("transform", {
      id: "title",
      position: { x: 140, y: 240 },
      config: { value: "Approve dynamic policy order" },
    });
    const assignee = flow.node("transform", {
      id: "assignee",
      position: { x: 140, y: 340 },
      config: { value: "risk" },
    });
    const timeoutMs = flow.node("transform", {
      id: "timeout_ms",
      position: { x: 140, y: 440 },
      config: { value: 120_000 },
    });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 140, y: 540 },
      config: { value: { orderId: "order-3", amount: 9000 } },
    });
    const approval = flow.node("approval", {
      id: "approval",
      position: { x: 420, y: 280 },
      config: {
        mode: "check",
        title: "Static title should be ignored",
        assignee: "finance",
        timeoutMs: 1,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 620, y: 280 },
      config: { template: "approval:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 800, y: 280 } });

    flow.connect(start.out("out"), approvalName.in("in"));
    flow.connect(start.out("out"), mode.in("in"));
    flow.connect(start.out("out"), title.in("in"));
    flow.connect(start.out("out"), assignee.in("in"));
    flow.connect(start.out("out"), timeoutMs.in("in"));
    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), approval.in("in"));
    flow.connect(approvalName.out("output"), approval.in("name"));
    flow.connect(mode.out("output"), approval.in("mode"));
    flow.connect(title.out("output"), approval.in("title"));
    flow.connect(assignee.out("output"), approval.in("assignee"));
    flow.connect(timeoutMs.out("output"), approval.in("timeoutMs"));
    flow.connect(payload.out("output"), approval.in("payload"));
    flow.connect(approval.out("requested"), report.in("in"));
    flow.connect(approval.out("mode"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "approval_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("approval:request");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const approvalOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "approval") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(approvalOutput).toMatchObject({
      mode: "request",
      branch: "requested",
      status: "pending",
      title: "Approve dynamic policy order",
      assignee: "risk",
      timeoutMs: 120_000,
      stateExists: true,
      requestedValue: true,
      pendingValue: true,
    });
    expect(variables.get("ORDER_DYNAMIC_POLICY_APPROVAL")).toMatchObject({
      name: "ORDER_DYNAMIC_POLICY_APPROVAL",
      status: "pending",
      title: "Approve dynamic policy order",
      assignee: "risk",
      payload: { orderId: "order-3", amount: 9000 },
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const approvalOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "approval") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(approvalOutput).toMatchObject({
      branch: "rejected",
      status: "rejected",
      title: "Approve order",
      assignee: "finance",
      decision: "rejected",
      comment: "budget exceeded",
      requestedAt: expect.any(String),
      resolvedAt: expect.any(String),
      expiresAt: expect.any(String),
      stateExists: true,
      requestedValue: false,
      pendingValue: false,
      approvedValue: false,
      rejectedValue: true,
      expiredValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const approvalOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "approval") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(approvalOutput).toMatchObject({
      branch: "expired",
      status: "expired",
      title: "Approve order",
      assignee: "finance",
      requestedAt: expect.any(String),
      resolvedAt: expect.any(String),
      expiresAt: expect.any(String),
      remainingMs: 0,
      stateExists: true,
      requestedValue: false,
      pendingValue: false,
      approvedValue: false,
      rejectedValue: false,
      expiredValue: true,
    });
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

  it("appends business events into a dynamically named audit_log", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "audit_log_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const logName = flow.node("transform", {
      id: "logName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_AUDIT_LOG" },
    });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-2", decision: "rejected" } },
    });
    const audit = flow.node("audit_log", {
      id: "audit",
      position: { x: 260, y: 0 },
      config: {
        type: "approval",
        actor: "finance",
        message: "Order rejected",
        maxEntries: 10,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "audit:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), logName.in("in"));
    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), audit.in("in"));
    flow.connect(logName.out("output"), audit.in("name"));
    flow.connect(payload.out("output"), audit.in("payload"));
    flow.connect(audit.out("appended"), report.in("in"));
    flow.connect(audit.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "audit_log_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("audit:ORDER_DYNAMIC_AUDIT_LOG");
    expect(variables.get("ORDER_DYNAMIC_AUDIT_LOG")).toMatchObject({
      sequence: 1,
      entries: [
        {
          sequence: 1,
          type: "approval",
          actor: "finance",
          message: "Order rejected",
          payload: { orderId: "order-2", decision: "rejected" },
          nodeId: "audit",
        },
      ],
    });
    expect(variables.has("")).toBe(false);
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

  it("increments a dynamically named metric", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "metric_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const metricName = flow.node("transform", {
      id: "metricName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_APPROVED_COUNT" },
    });
    const metric = flow.node("metric", {
      id: "metric",
      position: { x: 260, y: 0 },
      config: {
        mode: "increment",
        value: 3,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "metric:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), metricName.in("in"));
    flow.connect(start.out("out"), metric.in("in"));
    flow.connect(metricName.out("output"), metric.in("name"));
    flow.connect(metric.out("updated"), report.in("in"));
    flow.connect(metric.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "metric_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("metric:ORDER_DYNAMIC_APPROVED_COUNT");
    expect(variables.get("ORDER_DYNAMIC_APPROVED_COUNT")).toMatchObject({
      name: "ORDER_DYNAMIC_APPROVED_COUNT",
      value: 3,
      count: 1,
      sum: 3,
      max: 3,
      last: 3,
    });
    expect(variables.has("")).toBe(false);
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

  it("sets a dynamically named feature_flag state", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "feature_flag_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const flagName = flow.node("transform", {
      id: "flagName",
      position: { x: 120, y: -80 },
      config: { value: "CHECKOUT_DYNAMIC_V2" },
    });
    const flag = flow.node("feature_flag", {
      id: "flag",
      position: { x: 260, y: 0 },
      config: {
        mode: "set",
        enabled: true,
        rolloutPercent: 50,
        description: "Dynamic checkout rollout",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "flag:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 580, y: 0 } });

    flow.connect(start.out("out"), flagName.in("in"));
    flow.connect(start.out("out"), flag.in("in"));
    flow.connect(flagName.out("output"), flag.in("name"));
    flow.connect(flag.out("updated"), report.in("in"));
    flow.connect(flag.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "feature_flag_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("flag:CHECKOUT_DYNAMIC_V2");
    expect(variables.get("CHECKOUT_DYNAMIC_V2")).toMatchObject({
      name: "CHECKOUT_DYNAMIC_V2",
      enabled: true,
      rolloutPercent: 50,
      description: "Dynamic checkout rollout",
    });
    expect(variables.has("")).toBe(false);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const childRuns = await rt.runStore.listByFlow("child_echo");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("succeeded");
    expect(childRuns[0]?.output).toBe("child:Ada");
    expect(childRuns[0]?.subflowDepth).toBe(1);
    expect(callOutput).toMatchObject({
      flowId: "child_echo",
      flowVersion: "1.0.0",
      childStartedAt: expect.any(String),
      childFinishedAt: expect.any(String),
      childDurationMs: expect.any(Number),
    });
  });

  it("invokes a dynamically selected subflow version from data inputs", async () => {
    const rt = newRuntime();
    const childV1 = defineFlow({ id: "dynamic_child_echo", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childV1Start = childV1.node("start", { id: "child_v1_start", position: { x: 0, y: 0 } });
    const childV1Transform = childV1.node("transform", {
      id: "child_v1_transform",
      position: { x: 120, y: 0 },
      config: { template: "child-v1:${input.name}" },
    });
    const childV1End = childV1.node("end", { id: "child_v1_end", position: { x: 240, y: 0 } });
    childV1.connect(childV1Start.out("out"), childV1Transform.in("in"));
    childV1.connect(childV1Transform.out("out"), childV1End.in("in"));

    const childV2 = defineFlow({ id: "dynamic_child_echo", version: "2.0.0", registry: rt.nodeTypeRegistry });
    const childV2Start = childV2.node("start", { id: "child_v2_start", position: { x: 0, y: 0 } });
    const childV2Transform = childV2.node("transform", {
      id: "child_v2_transform",
      position: { x: 120, y: 0 },
      config: { template: "child-v2:${input.name}" },
    });
    const childV2End = childV2.node("end", { id: "child_v2_end", position: { x: 240, y: 0 } });
    childV2.connect(childV2Start.out("out"), childV2Transform.in("in"));
    childV2.connect(childV2Transform.out("out"), childV2End.in("in"));

    const parent = defineFlow({ id: "parent_calls_dynamic_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const targetId = parent.node("transform", {
      id: "target_id",
      position: { x: 120, y: -80 },
      config: { value: "dynamic_child_echo" },
    });
    const targetVersion = parent.node("transform", {
      id: "target_version",
      position: { x: 120, y: 80 },
      config: { value: "2.0.0" },
    });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 300, y: 0 },
      config: { inputMode: "runInput" },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "parent:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 600, y: 0 } });

    parent.connect(start.out("out"), targetId.in("in"));
    parent.connect(start.out("out"), targetVersion.in("in"));
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(targetId.out("output"), call.in("flowId"));
    parent.connect(targetVersion.out("output"), call.in("flowVersion"));
    parent.connect(call.out("succeeded"), report.in("in"));
    parent.connect(call.out("output"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, childV1);
    await registerAndPromote(rt, childV2);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_calls_dynamic_child",
      input: { name: "Ada" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:child-v2:Ada");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(callOutput).toMatchObject({
      flowId: "dynamic_child_echo",
      flowVersion: "2.0.0",
      status: "succeeded",
    });
  });

  it("invokes a subflow with dynamic literal input policy", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "child_dynamic_literal_input", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const childTransform = child.node("transform", {
      id: "child_transform",
      position: { x: 120, y: 0 },
      config: { template: "child:${input.name}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), childTransform.in("in"));
    child.connect(childTransform.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_dynamic_literal_input", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const literalInput = parent.node("transform", {
      id: "literal_input",
      position: { x: 120, y: 0 },
      config: { value: { name: "Ada" } },
    });
    const inputMode = parent.node("transform", {
      id: "input_mode",
      position: { x: 260, y: 0 },
      config: { value: "literal" },
    });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 400, y: 0 },
      config: {
        flowId: "child_dynamic_literal_input",
        inputMode: "runInput",
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 560, y: 0 },
      config: { template: "parent:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 700, y: 0 } });

    parent.connect(start.out("out"), literalInput.in("in"));
    parent.connect(literalInput.out("out"), inputMode.in("in"));
    parent.connect(inputMode.out("out"), call.in("in"));
    parent.connect(literalInput.out("output"), call.in("inputValue"));
    parent.connect(inputMode.out("output"), call.in("inputMode"));
    parent.connect(call.out("succeeded"), report.in("in"));
    parent.connect(call.out("output"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_dynamic_literal_input",
      input: { name: "RunInput" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:child:Ada");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      inputMode: "literal",
      status: "succeeded",
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const childRuns = await rt.runStore.listByFlow("template_child_echo");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.flowVersion).toBe("1.0.0");
    expect(childRuns[0]?.subflowDepth).toBe(1);
    expect(callOutput).toMatchObject({
      childStartedAt: expect.any(String),
      childFinishedAt: expect.any(String),
      childDurationMs: expect.any(Number),
      subflowDepth: 0,
      childDepth: 1,
    });
  });

  it("invokes a dynamically supplied subflow_template definition", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "template_dynamic_child_echo", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const childTransform = child.node("transform", {
      id: "child_transform",
      position: { x: 120, y: 0 },
      config: { template: "child:${input.name}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), childTransform.in("in"));
    child.connect(childTransform.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_calls_dynamic_template", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const templates = parent.node("transform", {
      id: "templates",
      position: { x: 120, y: 0 },
      config: {
        value: {
          dynamic_echo: {
            flowId: "template_dynamic_child_echo",
            flowVersion: "1.0.0",
            input: { name: "Ada" },
          },
        },
      },
    });
    const inputMode = parent.node("transform", {
      id: "input_mode",
      position: { x: 260, y: 0 },
      config: { value: "template" },
    });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 400, y: 0 },
      config: {
        templateId: "dynamic_echo",
        inputMode: "runInput",
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 560, y: 0 },
      config: { template: "parent:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 700, y: 0 } });
    parent.connect(start.out("out"), templates.in("in"));
    parent.connect(templates.out("out"), inputMode.in("in"));
    parent.connect(inputMode.out("out"), call.in("in"));
    parent.connect(templates.out("output"), call.in("templates"));
    parent.connect(inputMode.out("output"), call.in("inputMode"));
    parent.connect(call.out("succeeded"), report.in("in"));
    parent.connect(call.out("output"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_calls_dynamic_template",
      input: { name: "RunInput" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:child:Ada");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      templateId: "dynamic_echo",
      inputMode: "template",
      status: "succeeded",
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "missing",
      childStartedAt: null,
      childFinishedAt: null,
      childDurationMs: null,
      subflowDepth: 0,
      childDepth: 0,
    });
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

  it("routes failed subflow_template child runs with dynamic failOnError input", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "template_child_dynamic_fail_policy", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const broken = child.node("http", {
      id: "broken_http",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), broken.in("in"));
    child.connect(broken.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_template_dynamic_failed_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failOnError = parent.node("transform", {
      id: "fail_on_error",
      position: { x: 120, y: 0 },
      config: { value: false },
    });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 260, y: 0 },
      config: {
        templateId: "broken_template",
        failOnError: true,
        templates: {
          broken_template: {
            flowId: "template_child_dynamic_fail_policy",
            flowVersion: "1.0.0",
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "child:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 560, y: 0 } });
    parent.connect(start.out("out"), failOnError.in("in"));
    parent.connect(failOnError.out("out"), call.in("in"));
    parent.connect(failOnError.out("output"), call.in("failOnError"));
    parent.connect(call.out("failed"), report.in("in"));
    parent.connect(call.out("status"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_dynamic_failed_child",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("child:failed");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "failed",
      failOnError: false,
    });
  });

  it("routes subflow_template input contract failures without invoking the child flow", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_template_input_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "contract_child",
        contractMode: "route",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
          },
        },
        templates: {
          contract_child: {
            flowId: "template_input_contract_child",
            flowVersion: "1.0.0",
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "template-input-contract:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });

    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("contract_failed"), report.in("in"));
    parent.connect(call.out("contractIssueCount"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_input_contract",
      input: { id: "missing-name" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("template-input-contract:1");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "contract_failed",
      contractStage: "input",
      childStartedAt: null,
      childFinishedAt: null,
      childDurationMs: null,
      subflowDepth: 0,
      childDepth: 1,
    });
    expect(await rt.runStore.listByFlow("template_input_contract_child")).toEqual([]);
  });

  it("routes subflow_template input contract failures with dynamic contract policy inputs", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_template_dynamic_input_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const schema = parent.node("transform", {
      id: "schema",
      position: { x: 120, y: 0 },
      config: {
        value: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
    });
    const contractMode = parent.node("transform", {
      id: "contract_mode",
      position: { x: 260, y: 0 },
      config: { value: "route" },
    });
    const maxDepth = parent.node("transform", {
      id: "max_depth",
      position: { x: 400, y: 0 },
      config: { value: 7 },
    });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 540, y: 0 },
      config: {
        templateId: "contract_child",
        contractMode: "fail",
        maxDepth: 1,
        templates: {
          contract_child: {
            flowId: "template_dynamic_input_contract_child",
            flowVersion: "1.0.0",
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 700, y: 0 },
      config: { template: "template-input-contract:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 840, y: 0 } });

    parent.connect(start.out("out"), schema.in("in"));
    parent.connect(schema.out("out"), contractMode.in("in"));
    parent.connect(contractMode.out("out"), maxDepth.in("in"));
    parent.connect(maxDepth.out("out"), call.in("in"));
    parent.connect(schema.out("output"), call.in("inputSchema"));
    parent.connect(contractMode.out("output"), call.in("contractMode"));
    parent.connect(maxDepth.out("output"), call.in("maxDepth"));
    parent.connect(call.out("contract_failed"), report.in("in"));
    parent.connect(call.out("contractIssueCount"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_dynamic_input_contract",
      input: { id: "missing-name" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("template-input-contract:1");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "contract_failed",
      contractMode: "route",
      maxDepth: 7,
      childStartedAt: null,
    });
    expect(await rt.runStore.listByFlow("template_dynamic_input_contract_child")).toEqual([]);
  });

  it("routes subflow_template output contract failures after a successful child run", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "template_output_contract_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const childTransform = child.node("transform", {
      id: "child_transform",
      position: { x: 120, y: 0 },
      config: { template: "child:${input.name}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), childTransform.in("in"));
    child.connect(childTransform.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_template_output_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "contract_child",
        contractMode: "route",
        inputMode: "template",
        outputSchema: {
          type: "object",
          required: ["ok"],
        },
        templates: {
          contract_child: {
            flowId: "template_output_contract_child",
            flowVersion: "1.0.0",
            input: { name: "Ada" },
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "template-output-contract:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 440, y: 0 } });

    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("contract_failed"), report.in("in"));
    parent.connect(call.out("contractStage"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_output_contract",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("template-output-contract:output");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const childRuns = await rt.runStore.listByFlow("template_output_contract_child");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("succeeded");
    expect(callOutput).toMatchObject({
      status: "contract_failed",
      contractStage: "output",
      childStartedAt: expect.any(String),
      childFinishedAt: expect.any(String),
      childDurationMs: expect.any(Number),
      subflowDepth: 0,
      childDepth: 1,
    });
  });

  it("keeps subflow_template local variables and state writes isolated", async () => {
    const variables = new InMemoryVariableStore([
      { name: "TENANT", value: "global" },
    ]);
    const rt = newRuntime({ variables });
    const child = defineFlow({ id: "template_child_local_state", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const getTenant = child.node("state_get", {
      id: "get_tenant",
      position: { x: 120, y: 0 },
      config: { name: "TENANT" },
    });
    const setState = child.node("state_set", {
      id: "set_tmp",
      position: { x: 260, y: 0 },
      config: { name: "TEMPLATE_CHILD_TMP", value: "local-write" },
    });
    const childReport = child.node("transform", {
      id: "child_report",
      position: { x: 400, y: 0 },
      config: { template: "tenant=${input}" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 540, y: 0 } });
    child.connect(childStart.out("out"), getTenant.in("in"));
    child.connect(getTenant.out("out"), setState.in("in"));
    child.connect(setState.out("out"), childReport.in("in"));
    child.connect(getTenant.out("value"), childReport.in("input"));
    child.connect(childReport.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_template_local_scope", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "local_child",
        inputMode: "template",
        templates: {
          local_child: {
            flowId: "template_child_local_state",
            flowVersion: "1.0.0",
            input: null,
            localVariables: { TENANT: "template" },
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
      flowId: "parent_template_local_scope",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:tenant=template");
    expect(variables.get("TENANT")).toBe("global");
    expect(variables.has("TEMPLATE_CHILD_TMP")).toBe(false);
  });

  it("passes dynamic subflow_template local variables as child-scoped overrides", async () => {
    const variables = new InMemoryVariableStore([
      { name: "TENANT", value: "global" },
    ]);
    const rt = newRuntime({ variables });
    const child = defineFlow({ id: "template_child_dynamic_local_state", version: "1.0.0", registry: rt.nodeTypeRegistry });
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

    const parent = defineFlow({ id: "parent_template_dynamic_local_scope", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const localVars = parent.node("transform", {
      id: "local_vars",
      position: { x: 120, y: 0 },
      config: { value: { TENANT: "dynamic" } },
    });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 260, y: 0 },
      config: {
        templateId: "local_child",
        inputMode: "template",
        templates: {
          local_child: {
            flowId: "template_child_dynamic_local_state",
            flowVersion: "1.0.0",
            input: null,
            localVariables: { TENANT: "template" },
          },
        },
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "parent:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 560, y: 0 } });
    parent.connect(start.out("out"), localVars.in("in"));
    parent.connect(localVars.out("out"), call.in("in"));
    parent.connect(localVars.out("output"), call.in("localVariables"));
    parent.connect(call.out("succeeded"), report.in("in"));
    parent.connect(call.out("output"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_dynamic_local_scope",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:tenant=dynamic");
    expect(variables.get("TENANT")).toBe("global");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_template") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      localScope: true,
      localVariableCount: 2,
    });
  });

  it("blocks subflow_template direct recursive calls to the same flow version", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_template_recursive", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const call = parent.node("subflow_template", {
      id: "call_template",
      position: { x: 140, y: 0 },
      config: {
        templateId: "self",
        templates: {
          self: {
            flowId: "parent_template_recursive",
            flowVersion: "1.0.0",
          },
        },
      },
    });
    const end = parent.node("end", { id: "e", position: { x: 280, y: 0 } });
    parent.connect(start.out("out"), call.in("in"));
    parent.connect(call.out("succeeded"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_template_recursive",
      input: null,
    });

    expect(result.succeeded).toBe(false);
    expect(result.error?.code).toBe("node.subflow_template.recursive_call");
    expect(await rt.runStore.listByFlow("parent_template_recursive")).toHaveLength(1);
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

  it("passes dynamic subflow local variables as child-scoped overrides", async () => {
    const variables = new InMemoryVariableStore([
      { name: "TENANT", value: "global" },
    ]);
    const rt = newRuntime({ variables });
    const child = defineFlow({ id: "child_reads_dynamic_local_var", version: "1.0.0", registry: rt.nodeTypeRegistry });
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

    const parent = defineFlow({ id: "parent_dynamic_local_var_override", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const localVars = parent.node("transform", {
      id: "local_vars",
      position: { x: 120, y: 0 },
      config: { value: { TENANT: "dynamic" } },
    });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 260, y: 0 },
      config: {
        flowId: "child_reads_dynamic_local_var",
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "parent:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 560, y: 0 } });
    parent.connect(start.out("out"), localVars.in("in"));
    parent.connect(localVars.out("out"), call.in("in"));
    parent.connect(localVars.out("output"), call.in("localVariables"));
    parent.connect(call.out("succeeded"), report.in("in"));
    parent.connect(call.out("output"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_dynamic_local_var_override",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parent:tenant=dynamic");
    expect(variables.get("TENANT")).toBe("global");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      localScope: true,
      localVariableCount: 1,
    });
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

  it("routes failed subflow child runs with dynamic failOnError input", async () => {
    const rt = newRuntime();
    const child = defineFlow({ id: "child_dynamic_fail_policy", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const childStart = child.node("start", { id: "child_start", position: { x: 0, y: 0 } });
    const broken = child.node("http", {
      id: "broken_http",
      position: { x: 120, y: 0 },
      config: { method: "GET" },
    });
    const childEnd = child.node("end", { id: "child_end", position: { x: 240, y: 0 } });
    child.connect(childStart.out("out"), broken.in("in"));
    child.connect(broken.out("out"), childEnd.in("in"));

    const parent = defineFlow({ id: "parent_dynamic_failed_child", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failOnError = parent.node("transform", {
      id: "fail_on_error",
      position: { x: 120, y: 0 },
      config: { value: false },
    });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 260, y: 0 },
      config: {
        flowId: "child_dynamic_fail_policy",
        failOnError: true,
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "child:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 560, y: 0 } });
    parent.connect(start.out("out"), failOnError.in("in"));
    parent.connect(failOnError.out("out"), call.in("in"));
    parent.connect(failOnError.out("output"), call.in("failOnError"));
    parent.connect(call.out("failed"), report.in("in"));
    parent.connect(call.out("status"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, child);
    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_dynamic_failed_child",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("child:failed");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "failed",
      failOnError: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "contract_failed",
      flowId: "child_input_contract",
      flowVersion: "",
    });
    expect(await rt.runStore.listByFlow("child_input_contract")).toEqual([]);
  });

  it("routes subflow input contract failures with dynamic contract policy inputs", async () => {
    const rt = newRuntime();
    const parent = defineFlow({ id: "parent_dynamic_input_contract", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = parent.node("start", { id: "s", position: { x: 0, y: 0 } });
    const schema = parent.node("transform", {
      id: "schema",
      position: { x: 120, y: 0 },
      config: {
        value: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
    });
    const contractMode = parent.node("transform", {
      id: "contract_mode",
      position: { x: 260, y: 0 },
      config: { value: "route" },
    });
    const maxDepth = parent.node("transform", {
      id: "max_depth",
      position: { x: 400, y: 0 },
      config: { value: 7 },
    });
    const call = parent.node("subflow", {
      id: "call_child",
      position: { x: 540, y: 0 },
      config: {
        flowId: "child_dynamic_input_contract",
        contractMode: "fail",
        maxDepth: 1,
      },
    });
    const report = parent.node("transform", {
      id: "report",
      position: { x: 700, y: 0 },
      config: { template: "input-contract:${input}" },
    });
    const end = parent.node("end", { id: "e", position: { x: 840, y: 0 } });

    parent.connect(start.out("out"), schema.in("in"));
    parent.connect(schema.out("out"), contractMode.in("in"));
    parent.connect(contractMode.out("out"), maxDepth.in("in"));
    parent.connect(maxDepth.out("out"), call.in("in"));
    parent.connect(schema.out("output"), call.in("inputSchema"));
    parent.connect(contractMode.out("output"), call.in("contractMode"));
    parent.connect(maxDepth.out("output"), call.in("maxDepth"));
    parent.connect(call.out("contract_failed"), report.in("in"));
    parent.connect(call.out("contractIssueCount"), report.in("input"));
    parent.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, parent);

    const result = await rt.invocationRouter.invoke({
      flowId: "parent_dynamic_input_contract",
      input: { id: "missing-name" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("input-contract:1");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(callOutput).toMatchObject({
      status: "contract_failed",
      contractMode: "route",
      maxDepth: 7,
      childStartedAt: null,
    });
    expect(await rt.runStore.listByFlow("child_dynamic_input_contract")).toEqual([]);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const callOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "call_child") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const childRuns = await rt.runStore.listByFlow("child_output_contract");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("succeeded");
    expect(callOutput).toMatchObject({
      status: "contract_failed",
      flowId: "child_output_contract",
      flowVersion: "1.0.0",
    });
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

  it("writes state with a dynamically named state_set", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "state_set_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const stateName = flow.node("transform", {
      id: "stateName",
      position: { x: 120, y: -80 },
      config: { value: "FLOW_DYNAMIC_STATE_VALUE" },
    });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: { status: "dynamic-ready" } },
    });
    const setState = flow.node("state_set", {
      id: "set_state",
      position: { x: 280, y: 0 },
      config: {
        description: "Value written through a dynamic state_set name.",
      },
    });
    const getState = flow.node("state_get", {
      id: "get_state",
      position: { x: 440, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 0 },
      config: { template: "state=${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 760, y: 0 } });

    flow.connect(start.out("out"), stateName.in("in"));
    flow.connect(start.out("out"), input.in("in"));
    flow.connect(input.out("out"), setState.in("in"));
    flow.connect(stateName.out("output"), setState.in("name"));
    flow.connect(input.out("output"), setState.in("value"));
    flow.connect(setState.out("out"), getState.in("in"));
    flow.connect(setState.out("name"), getState.in("name"));
    flow.connect(getState.out("out"), report.in("in"));
    flow.connect(getState.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "state_set_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("state=dynamic-ready");
    expect(variables.get("FLOW_DYNAMIC_STATE_VALUE")).toEqual({ status: "dynamic-ready" });
    expect(variables.describe("FLOW_DYNAMIC_STATE_VALUE")?.metadata).toMatchObject({
      description: "Value written through a dynamic state_set name.",
      source: "runtime",
      scope: { flowId: "state_set_dynamic_name_e2e" },
    });
    expect(variables.has("")).toBe(false);
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

  it("routes a dynamically named batch_window to waiting", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "batch_window_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const batchName = flow.node("transform", {
      id: "batchName",
      position: { x: 120, y: -80 },
      config: { value: "EMAIL_DYNAMIC_BATCH" },
    });
    const item = flow.node("transform", {
      id: "item",
      position: { x: 120, y: 0 },
      config: { value: "email-2" },
    });
    const batch = flow.node("batch_window", {
      id: "batch",
      position: { x: 280, y: 0 },
      config: {
        maxItems: 2,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 440, y: 0 },
      config: { template: "waiting:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), batchName.in("in"));
    flow.connect(start.out("out"), item.in("in"));
    flow.connect(item.out("out"), batch.in("in"));
    flow.connect(batchName.out("output"), batch.in("name"));
    flow.connect(item.out("output"), batch.in("item"));
    flow.connect(batch.out("waiting"), report.in("in"));
    flow.connect(batch.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "batch_window_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("waiting:EMAIL_DYNAMIC_BATCH");
    expect(variables.get("EMAIL_DYNAMIC_BATCH")).toMatchObject({
      items: ["email-2"],
      flushCount: 0,
    });
    expect(variables.has("")).toBe(false);
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

  it("records payloads into a dynamically named dead_letter", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "dead_letter_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const queueName = flow.node("transform", {
      id: "queueName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_DEAD_LETTERS" },
    });
    const payload = flow.node("transform", {
      id: "payload",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-2", retryable: true } },
    });
    const deadLetter = flow.node("dead_letter", {
      id: "dead_letter",
      position: { x: 260, y: 0 },
      config: {
        reason: "shipping worker failed",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "dead:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), queueName.in("in"));
    flow.connect(start.out("out"), payload.in("in"));
    flow.connect(payload.out("out"), deadLetter.in("in"));
    flow.connect(queueName.out("output"), deadLetter.in("name"));
    flow.connect(payload.out("output"), deadLetter.in("payload"));
    flow.connect(deadLetter.out("recorded"), report.in("in"));
    flow.connect(deadLetter.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "dead_letter_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("dead:ORDER_DYNAMIC_DEAD_LETTERS");
    expect(variables.get("ORDER_DYNAMIC_DEAD_LETTERS")).toMatchObject({
      entries: [
        {
          payload: { orderId: "order-2", retryable: true },
          reason: "shipping worker failed",
        },
      ],
    });
    expect(variables.has("")).toBe(false);
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

  it("pushes items into a dynamically named queue", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "queue_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const queueName = flow.node("transform", {
      id: "queueName",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_QUEUE" },
    });
    const item = flow.node("transform", {
      id: "item",
      position: { x: 120, y: 0 },
      config: { value: { orderId: "order-2", task: "ship" } },
    });
    const queue = flow.node("queue", {
      id: "queue",
      position: { x: 260, y: 0 },
      config: {
        maxItems: 10,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "queued:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), queueName.in("in"));
    flow.connect(start.out("out"), item.in("in"));
    flow.connect(item.out("out"), queue.in("in"));
    flow.connect(queueName.out("output"), queue.in("name"));
    flow.connect(item.out("output"), queue.in("item"));
    flow.connect(queue.out("pushed"), report.in("in"));
    flow.connect(queue.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "queue_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("queued:ORDER_DYNAMIC_QUEUE");
    expect(variables.get("ORDER_DYNAMIC_QUEUE")).toMatchObject({
      items: [{ orderId: "order-2", task: "ship" }],
      pushedCount: 1,
      poppedCount: 0,
    });
    expect(variables.has("")).toBe(false);
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

  it("stores cache entries with a dynamic namespace input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "cache_dynamic_namespace_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const namespace = flow.node("transform", {
      id: "namespace",
      position: { x: 120, y: -100 },
      config: { value: "tenant-a-http" },
    });
    const key = flow.node("transform", {
      id: "key",
      position: { x: 120, y: 0 },
      config: { value: "GET:/orders/dynamic" },
    });
    const value = flow.node("transform", {
      id: "value",
      position: { x: 120, y: 100 },
      config: { value: { status: "ready", source: "dynamic" } },
    });
    const cache = flow.node("cache", {
      id: "cache",
      position: { x: 320, y: 0 },
      config: {
        mode: "set",
        ttlMs: 60_000,
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 480, y: 0 },
      config: { template: "stored:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 620, y: 0 } });

    flow.connect(start.out("out"), namespace.in("in"));
    flow.connect(start.out("out"), key.in("in"));
    flow.connect(start.out("out"), value.in("in"));
    flow.connect(start.out("out"), cache.in("in"));
    flow.connect(namespace.out("output"), cache.in("namespace"));
    flow.connect(key.out("output"), cache.in("key"));
    flow.connect(value.out("output"), cache.in("value"));
    flow.connect(cache.out("stored"), report.in("in"));
    flow.connect(cache.out("storeKey"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "cache_dynamic_namespace_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("stored:CACHE:tenant-a-http:GET:/orders/dynamic");
    expect(variables.get("CACHE:tenant-a-http:GET:/orders/dynamic")).toMatchObject({
      value: { status: "ready", source: "dynamic" },
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const checkpointOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "checkpoint") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(checkpointOutput).toMatchObject({
      status: "saved",
      name: "ORDER_CHECKPOINT",
      label: "after payment authorization",
      version: 1,
      savedAt: expect.any(String),
      loadedAt: "",
      expiresAt: "",
      ttlMs: 0,
      remainingMs: 0,
      stateExists: true,
      savedValue: true,
      loadedValue: false,
      missingValue: false,
      expiredValue: false,
    });
    expect(variables.get("ORDER_CHECKPOINT")).toMatchObject({
      name: "ORDER_CHECKPOINT",
      status: "saved",
      snapshot: { step: "payment", status: "authorized" },
      version: 1,
      label: "after payment authorization",
    });
  });

  it("saves a checkpoint with a dynamic name input", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "checkpoint_dynamic_name_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const name = flow.node("transform", {
      id: "name",
      position: { x: 120, y: -80 },
      config: { value: "ORDER_DYNAMIC_CHECKPOINT" },
    });
    const snapshot = flow.node("transform", {
      id: "snapshot",
      position: { x: 120, y: 80 },
      config: { value: { step: "fulfillment", status: "packed" } },
    });
    const checkpoint = flow.node("checkpoint", {
      id: "checkpoint",
      position: { x: 300, y: 0 },
      config: {
        mode: "save",
        label: "packed",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 460, y: 0 },
      config: { template: "checkpoint:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), name.in("in"));
    flow.connect(start.out("out"), snapshot.in("in"));
    flow.connect(start.out("out"), checkpoint.in("in"));
    flow.connect(name.out("output"), checkpoint.in("name"));
    flow.connect(snapshot.out("output"), checkpoint.in("snapshot"));
    flow.connect(checkpoint.out("saved"), report.in("in"));
    flow.connect(checkpoint.out("name"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "checkpoint_dynamic_name_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("checkpoint:ORDER_DYNAMIC_CHECKPOINT");
    expect(variables.get("ORDER_DYNAMIC_CHECKPOINT")).toMatchObject({
      name: "ORDER_DYNAMIC_CHECKPOINT",
      status: "saved",
      snapshot: { step: "fulfillment", status: "packed" },
      label: "packed",
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const checkpointOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "checkpoint") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(checkpointOutput).toMatchObject({
      status: "loaded",
      name: "ORDER_CHECKPOINT",
      label: "shipping gate",
      version: 3,
      savedAt: new Date(now - 1000).toISOString(),
      loadedAt: expect.any(String),
      expiresAt: new Date(now + 60_000).toISOString(),
      ttlMs: 61_000,
      remainingMs: expect.any(Number),
      stateExists: true,
      savedValue: false,
      loadedValue: true,
      missingValue: false,
      expiredValue: false,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const checkpointOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "checkpoint") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(checkpointOutput).toMatchObject({
      status: "missing",
      name: "ORDER_CHECKPOINT",
      label: "",
      version: 0,
      savedAt: "",
      loadedAt: "",
      expiresAt: "",
      ttlMs: 0,
      remainingMs: 0,
      stateExists: false,
      savedValue: false,
      loadedValue: false,
      missingValue: true,
      expiredValue: false,
    });
    expect(variables.has("ORDER_CHECKPOINT")).toBe(false);
  });

  it("routes checkpoint load to expired when the saved snapshot TTL has elapsed", async () => {
    const now = Date.now();
    const variables = new InMemoryVariableStore();
    variables.set("ORDER_CHECKPOINT", {
      name: "ORDER_CHECKPOINT",
      status: "saved",
      snapshot: { step: "payment", status: "stale" },
      label: "payment gate",
      version: 2,
      savedAt: now - 120_000,
      loadedAt: null,
      expiresAt: now - 1,
      updatedAt: now - 120_000,
    });
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({ id: "checkpoint_expired_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
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
      config: { template: "checkpoint:${input.status}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 400, y: 0 } });

    flow.connect(start.out("out"), checkpoint.in("in"));
    flow.connect(checkpoint.out("expired"), report.in("in"));
    flow.connect(checkpoint.out("snapshot"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "checkpoint_expired_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("checkpoint:stale");
    expect(variables.get("ORDER_CHECKPOINT")).toMatchObject({
      status: "expired",
      version: 2,
      snapshot: { step: "payment", status: "stale" },
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const joinOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "join") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(joinOutput).toMatchObject({
      status: "joined",
      empty: false,
      count: 2,
      expectedCount: 2,
      missingCount: 0,
      complete: true,
      firstValue: "upper:Flow",
      lastValue: "lower:Flow",
    });
  });

  it("reports partial join diagnostics when fewer values arrive than expected", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "join_partial_diagnostics_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 140, y: 0 },
      config: { template: "upper:${input.name}" },
    });
    const join = flow.node("join", {
      id: "join",
      position: { x: 280, y: 0 },
      config: { expectedCount: 2 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "join=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 560, y: 0 } });

    flow.connect(start.out("out"), upper.in("in"));
    flow.connect(upper.out("out"), join.in("in"));
    flow.connect(upper.out("output"), join.in("values"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "join_partial_diagnostics_e2e",
      input: { name: "Flow" },
    });
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const joinOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "join") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("join=partial");
    expect(joinOutput).toMatchObject({
      status: "partial",
      count: 1,
      expectedCount: 2,
      missingCount: 1,
      complete: false,
    });
  });

  it("emits empty join diagnostics when no values arrive", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "join_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const join = flow.node("join", { id: "join", position: { x: 140, y: 0 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 280, y: 0 },
      config: { template: "join=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 420, y: 0 } });

    flow.connect(start.out("out"), join.in("in"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "join_empty_e2e",
      input: null,
    });
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const joinOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "join") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("join=empty");
    expect(joinOutput).toMatchObject({
      status: "empty",
      empty: true,
      count: 0,
      firstValue: null,
      lastValue: null,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const quorumOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "quorum") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(quorumOutput).toMatchObject({
      status: "met",
      metValue: true,
      count: 2,
      threshold: 2,
      remaining: 0,
      firstValue: "upper:Flow",
      lastValue: "lower:Flow",
      quorumRate: 1,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const quorumOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "quorum") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(quorumOutput).toMatchObject({
      status: "unmet",
      metValue: false,
      count: 2,
      threshold: 3,
      remaining: 1,
      firstValue: "upper:Flow",
      lastValue: "lower:Flow",
    });
    expect(quorumOutput?.quorumRate).toBeCloseTo(2 / 3);
  });

  it("uses dynamic quorum threshold input", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "quorum_dynamic_threshold_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const first = flow.node("transform", {
      id: "first",
      position: { x: 140, y: 40 },
      config: { template: "first:${input.name}" },
    });
    const second = flow.node("transform", {
      id: "second",
      position: { x: 140, y: 140 },
      config: { template: "second:${input.name}" },
    });
    const threshold = flow.node("transform", {
      id: "threshold",
      position: { x: 140, y: 240 },
      config: { value: 2 },
    });
    const quorum = flow.node("quorum", {
      id: "quorum",
      position: { x: 340, y: 120 },
      config: { threshold: 3 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 520, y: 120 },
      config: { template: "quorum:${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 700, y: 120 } });

    flow.connect(start.out("out"), first.in("in"));
    flow.connect(start.out("out"), second.in("in"));
    flow.connect(start.out("out"), threshold.in("in"));
    flow.connect(first.out("output"), quorum.in("values"));
    flow.connect(second.out("output"), quorum.in("values"));
    flow.connect(threshold.out("output"), quorum.in("threshold"));
    flow.connect(quorum.out("met"), report.in("in"));
    flow.connect(quorum.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "quorum_dynamic_threshold_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("quorum:first:Flow,second:Flow");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const quorumOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "quorum") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(quorumOutput).toMatchObject({
      status: "met",
      metValue: true,
      count: 2,
      threshold: 2,
      remaining: 0,
      firstValue: "first:Flow",
      lastValue: "second:Flow",
      quorumRate: 1,
    });
  });

  it("continues through quorum before slow in-flight siblings finish", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "quorum_inflight_sibling_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 120, y: 120 },
      config: { branchCount: 3 },
    });
    const fastA = flow.node("transform", {
      id: "fast_a",
      position: { x: 280, y: 20 },
      config: { value: "a" },
    });
    const fastB = flow.node("transform", {
      id: "fast_b",
      position: { x: 280, y: 120 },
      config: { value: "b" },
    });
    const waitSlow = flow.node("delay", {
      id: "wait_slow",
      position: { x: 280, y: 220 },
      config: { durationMs: 60 },
    });
    const slow = flow.node("transform", {
      id: "slow",
      position: { x: 440, y: 220 },
      config: { value: "slow" },
    });
    const quorum = flow.node("quorum", {
      id: "quorum",
      position: { x: 600, y: 120 },
      config: { threshold: 2 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 760, y: 120 },
      config: { template: "quorum=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 920, y: 120 } });

    flow.connect(start.out("out"), fanout.in("in"));
    flow.connect(fanout.out("branch1"), fastA.in("in"));
    flow.connect(fanout.out("branch2"), fastB.in("in"));
    flow.connect(fanout.out("branch3"), waitSlow.in("in"));
    flow.connect(waitSlow.out("out"), slow.in("in"));
    flow.connect(fastA.out("output"), quorum.in("values"));
    flow.connect(fastB.out("output"), quorum.in("values"));
    flow.connect(slow.out("output"), quorum.in("values"));
    flow.connect(quorum.out("met"), report.in("in"));
    flow.connect(quorum.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "quorum_inflight_sibling_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("quorum=a,b");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const reportStarted = events.findIndex(
      (event) => event.kind === "node_started" && event.nodeId === "report",
    );
    const slowFinished = events.findIndex(
      (event) => event.kind === "node_finished" && event.nodeId === "wait_slow",
    );
    expect(reportStarted).toBeGreaterThanOrEqual(0);
    expect(slowFinished).toBeGreaterThanOrEqual(0);
    expect(reportStarted).toBeLessThan(slowFinished);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const raceOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "race") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(raceOutput).toMatchObject({
      status: "winner",
      value: "fast",
      hasWinner: true,
      emptyValue: false,
      winnerIndex: 0,
      index: 0,
      count: 1,
    });
  });

  it("races fast branches before slow in-flight siblings finish", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "race_inflight_sibling_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 120, y: 120 },
      config: { branchCount: 2 },
    });
    const fast = flow.node("transform", {
      id: "fast",
      position: { x: 280, y: 40 },
      config: { value: "fast" },
    });
    const waitSlow = flow.node("delay", {
      id: "wait_slow",
      position: { x: 280, y: 200 },
      config: { durationMs: 60 },
    });
    const slow = flow.node("transform", {
      id: "slow",
      position: { x: 440, y: 200 },
      config: { value: "slow" },
    });
    const race = flow.node("race", { id: "race", position: { x: 600, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 760, y: 120 },
      config: { template: "winner=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 920, y: 120 } });

    flow.connect(start.out("out"), fanout.in("in"));
    flow.connect(fanout.out("branch1"), fast.in("in"));
    flow.connect(fanout.out("branch2"), waitSlow.in("in"));
    flow.connect(waitSlow.out("out"), slow.in("in"));
    flow.connect(fast.out("out"), race.in("in"));
    flow.connect(slow.out("out"), race.in("in"));
    flow.connect(fast.out("output"), race.in("values"));
    flow.connect(slow.out("output"), race.in("values"));
    flow.connect(race.out("winner"), report.in("in"));
    flow.connect(race.out("value"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "race_inflight_sibling_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("winner=fast");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const reportStarted = events.findIndex(
      (event) => event.kind === "node_started" && event.nodeId === "report",
    );
    const slowFinished = events.findIndex(
      (event) => event.kind === "node_finished" && event.nodeId === "wait_slow",
    );
    expect(reportStarted).toBeGreaterThanOrEqual(0);
    expect(slowFinished).toBeGreaterThanOrEqual(0);
    expect(reportStarted).toBeLessThan(slowFinished);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const raceOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "race") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(raceOutput).toMatchObject({
      status: "empty",
      value: null,
      hasWinner: false,
      emptyValue: true,
      winnerIndex: -1,
      index: -1,
      count: 0,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const failFastOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "fail_fast") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(failFastOutput).toMatchObject({
      status: "failed",
      hasFailure: true,
      failedIndex: 0,
      count: 1,
      errorCode: "branch.a_failed",
      errorMessage: "A failed",
    });
  });

  it("uses dynamic fail_fast error code policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "fail_fast_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 180 } });
    const errors = flow.node("transform", {
      id: "errors",
      position: { x: 140, y: 80 },
      config: {
        value: [
          { code: "E_RETRYABLE", message: "try again later" },
          { code: "E_FATAL", message: "stop the batch" },
        ],
      },
    });
    const ignoredCodes = flow.node("transform", {
      id: "ignored_codes",
      position: { x: 140, y: 200 },
      config: { value: "E_RETRYABLE" },
    });
    const failureCodes = flow.node("transform", {
      id: "failure_codes",
      position: { x: 140, y: 320 },
      config: { value: "E_FATAL" },
    });
    const failFast = flow.node("fail_fast", {
      id: "fail_fast",
      position: { x: 380, y: 180 },
      config: { ignoredCodes: "", failureCodes: "" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 580, y: 180 },
      config: { template: "failed=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 780, y: 180 } });

    flow.connect(start.out("out"), errors.in("in"));
    flow.connect(start.out("out"), ignoredCodes.in("in"));
    flow.connect(start.out("out"), failureCodes.in("in"));
    flow.connect(errors.out("output"), failFast.in("errors"));
    flow.connect(ignoredCodes.out("output"), failFast.in("ignoredCodes"));
    flow.connect(failureCodes.out("output"), failFast.in("failureCodes"));
    flow.connect(failFast.out("failed"), report.in("in"));
    flow.connect(failFast.out("errorCode"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fail_fast_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("failed=E_FATAL");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const failFastOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "fail_fast") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(failFastOutput).toMatchObject({
      status: "failed",
      hasFailure: true,
      failedIndex: 1,
      count: 1,
      ignoredCount: 1,
      errorCode: "E_FATAL",
      errorMessage: "stop the batch",
      ignoredCodes: ["E_RETRYABLE"],
      failureCodes: ["E_FATAL"],
      ignoredErrors: [{ code: "E_RETRYABLE", message: "try again later" }],
      errors: [{ code: "E_FATAL", message: "stop the batch" }],
    });
  });

  it("routes fail_fast to clear when no branch errors arrive", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "fail_fast_clear_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const failFast = flow.node("fail_fast", {
      id: "fail_fast",
      position: { x: 140, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 300, y: 0 },
      config: { template: "status=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 460, y: 0 } });

    flow.connect(start.out("out"), failFast.in("in"));
    flow.connect(failFast.out("clear"), report.in("in"));
    flow.connect(failFast.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fail_fast_clear_e2e",
      input: null,
    });
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const failFastOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "fail_fast") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("status=clear");
    expect(failFastOutput).toMatchObject({
      status: "clear",
      hasFailure: false,
      failedIndex: -1,
      count: 0,
      errorCode: "",
      errorMessage: "",
    });
  });

  it("routes fail_fast before slow in-flight siblings finish", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "fail_fast_inflight_sibling_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 120, y: 120 },
      config: { branchCount: 2 },
    });
    const firstError = flow.node("transform", {
      id: "first_error",
      position: { x: 280, y: 40 },
      config: { value: { code: "branch.a_failed", message: "A failed" } },
    });
    const waitSlow = flow.node("delay", {
      id: "wait_slow",
      position: { x: 280, y: 200 },
      config: { durationMs: 60 },
    });
    const slow = flow.node("transform", {
      id: "slow",
      position: { x: 440, y: 200 },
      config: { value: { ok: true } },
    });
    const failFast = flow.node("fail_fast", {
      id: "fail_fast",
      position: { x: 600, y: 120 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 760, y: 120 },
      config: { template: "failed=${input.code}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 920, y: 120 } });

    flow.connect(start.out("out"), fanout.in("in"));
    flow.connect(fanout.out("branch1"), firstError.in("in"));
    flow.connect(fanout.out("branch2"), waitSlow.in("in"));
    flow.connect(waitSlow.out("out"), slow.in("in"));
    flow.connect(firstError.out("output"), failFast.in("errors"));
    flow.connect(slow.out("output"), failFast.in("errors"));
    flow.connect(failFast.out("failed"), report.in("in"));
    flow.connect(failFast.out("error"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "fail_fast_inflight_sibling_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("failed=branch.a_failed");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const reportStarted = events.findIndex(
      (event) => event.kind === "node_started" && event.nodeId === "report",
    );
    const slowFinished = events.findIndex(
      (event) => event.kind === "node_finished" && event.nodeId === "wait_slow",
    );
    expect(reportStarted).toBeGreaterThanOrEqual(0);
    expect(slowFinished).toBeGreaterThanOrEqual(0);
    expect(reportStarted).toBeLessThan(slowFinished);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const partialOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "partial") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(partialOutput).toMatchObject({
      status: "partial",
      successCount: 2,
      failureCount: 1,
      total: 3,
      minSuccess: 2,
      remainingSuccess: 0,
      firstSuccess: { status: "ok", label: "a" },
      firstFailure: { status: "failed", error: "branch failed", label: "b" },
    });
    expect(partialOutput?.successRate).toBeCloseTo(2 / 3);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const partialOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "partial") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(partialOutput).toMatchObject({
      status: "failed",
      successCount: 1,
      failureCount: 1,
      total: 2,
      minSuccess: 2,
      remainingSuccess: 1,
      firstSuccess: { ok: true, label: "a" },
      firstFailure: { ok: false, error: "bad", label: "b" },
      successRate: 0.5,
    });
  });

  it("uses dynamic partial_success policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "partial_success_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 180 } });
    const results = flow.node("transform", {
      id: "results",
      position: { x: 140, y: 60 },
      config: {
        value: [
          { state: "ready", label: "a" },
          { state: "blocked", failure: "api timeout", label: "b" },
          { state: "done", label: "c" },
        ],
      },
    });
    const mode = flow.node("transform", {
      id: "mode",
      position: { x: 140, y: 160 },
      config: { value: "status" },
    });
    const minSuccess = flow.node("transform", {
      id: "min_success",
      position: { x: 140, y: 260 },
      config: { value: 2 },
    });
    const statusPath = flow.node("transform", {
      id: "status_path",
      position: { x: 140, y: 360 },
      config: { value: "state" },
    });
    const successValues = flow.node("transform", {
      id: "success_values",
      position: { x: 140, y: 460 },
      config: { value: "ready,done" },
    });
    const errorPath = flow.node("transform", {
      id: "error_path",
      position: { x: 140, y: 560 },
      config: { value: "failure" },
    });
    const partial = flow.node("partial_success", {
      id: "partial",
      position: { x: 380, y: 260 },
      config: {
        mode: "truthy",
        minSuccess: 3,
        statusPath: "status",
        successValues: "ok",
        errorPath: "error",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 600, y: 260 },
      config: { template: "partial=${input.mode}:${input.successCount}/${input.total}:${input.statusPath}:${input.errorPath}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 840, y: 260 } });

    flow.connect(start.out("out"), results.in("in"));
    flow.connect(start.out("out"), mode.in("in"));
    flow.connect(start.out("out"), minSuccess.in("in"));
    flow.connect(start.out("out"), statusPath.in("in"));
    flow.connect(start.out("out"), successValues.in("in"));
    flow.connect(start.out("out"), errorPath.in("in"));
    flow.connect(results.out("output"), partial.in("results"));
    flow.connect(mode.out("output"), partial.in("mode"));
    flow.connect(minSuccess.out("output"), partial.in("minSuccess"));
    flow.connect(statusPath.out("output"), partial.in("statusPath"));
    flow.connect(successValues.out("output"), partial.in("successValues"));
    flow.connect(errorPath.out("output"), partial.in("errorPath"));
    flow.connect(partial.out("partial"), report.in("in"));
    flow.connect(partial.out("summary"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "partial_success_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("partial=status:2/3:state:failure");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const partialOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "partial") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(partialOutput).toMatchObject({
      status: "partial",
      successCount: 2,
      failureCount: 1,
      total: 3,
      mode: "status",
      minSuccess: 2,
      statusPath: "state",
      successValues: ["ready", "done"],
      errorPath: "failure",
      remainingSuccess: 0,
      firstSuccess: { state: "ready", label: "a" },
      firstFailure: { state: "blocked", failure: "api timeout", label: "b" },
    });
    expect(partialOutput?.successRate).toBeCloseTo(2 / 3);
  });

  it("routes all_success when every branch result succeeds", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "all_success_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { status: "ok", label: "a" },
          { status: "ready", label: "b" },
        ],
      },
    });
    const all = flow.node("all_success", {
      id: "all",
      position: { x: 260, y: 0 },
      config: { mode: "status" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "all=${input.successCount}/${input.total}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), all.in("results"));
    flow.connect(all.out("all_success"), report.in("in"));
    flow.connect(all.out("summary"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "all_success_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("all=2/2");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const allOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "all") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(allOutput).toMatchObject({
      status: "all_success",
      firstSuccess: { status: "ok", label: "a" },
      firstFailure: null,
      hasSuccess: true,
      hasFailure: false,
      successRate: 1,
      failureRate: 0,
    });
  });

  it("uses dynamic all_success policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "all_success_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 180 } });
    const results = flow.node("transform", {
      id: "results",
      position: { x: 140, y: 80 },
      config: {
        value: [
          { state: "ready", label: "a" },
          { state: "done", label: "b" },
        ],
      },
    });
    const mode = flow.node("transform", {
      id: "mode",
      position: { x: 140, y: 180 },
      config: { value: "status" },
    });
    const statusPath = flow.node("transform", {
      id: "status_path",
      position: { x: 140, y: 280 },
      config: { value: "state" },
    });
    const successValues = flow.node("transform", {
      id: "success_values",
      position: { x: 140, y: 380 },
      config: { value: "ready,done" },
    });
    const errorPath = flow.node("transform", {
      id: "error_path",
      position: { x: 140, y: 480 },
      config: { value: "failure" },
    });
    const all = flow.node("all_success", {
      id: "all",
      position: { x: 360, y: 260 },
      config: {
        mode: "ok",
        statusPath: "status",
        successValues: "ok",
        errorPath: "error",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 560, y: 260 },
      config: { template: "all=${input.mode}:${input.successCount}/${input.total}:${input.statusPath}:${input.errorPath}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 800, y: 260 } });

    flow.connect(start.out("out"), results.in("in"));
    flow.connect(start.out("out"), mode.in("in"));
    flow.connect(start.out("out"), statusPath.in("in"));
    flow.connect(start.out("out"), successValues.in("in"));
    flow.connect(start.out("out"), errorPath.in("in"));
    flow.connect(results.out("output"), all.in("results"));
    flow.connect(mode.out("output"), all.in("mode"));
    flow.connect(statusPath.out("output"), all.in("statusPath"));
    flow.connect(successValues.out("output"), all.in("successValues"));
    flow.connect(errorPath.out("output"), all.in("errorPath"));
    flow.connect(all.out("all_success"), report.in("in"));
    flow.connect(all.out("summary"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "all_success_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("all=status:2/2:state:failure");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const allOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "all") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(allOutput).toMatchObject({
      status: "all_success",
      successCount: 2,
      failureCount: 0,
      total: 2,
      mode: "status",
      statusPath: "state",
      successValues: ["ready", "done"],
      errorPath: "failure",
      hasSuccess: true,
      hasFailure: false,
      successRate: 1,
      failureRate: 0,
      firstSuccess: { state: "ready", label: "a" },
      firstFailure: null,
    });
  });

  it("routes all_success to failed when any branch result fails", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "all_success_failed_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { status: "ok", label: "a" },
          { status: "failed", error: "api timeout", label: "b" },
        ],
      },
    });
    const all = flow.node("all_success", {
      id: "all",
      position: { x: 260, y: 0 },
      config: { mode: "status" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "failed=${input.label}:${input.error}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), all.in("results"));
    flow.connect(all.out("failed"), report.in("in"));
    flow.connect(all.out("firstFailure"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "all_success_failed_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("failed=b:api timeout");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const allOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "all") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(allOutput).toMatchObject({
      status: "failed",
      firstSuccess: { status: "ok", label: "a" },
      firstFailure: { status: "failed", error: "api timeout", label: "b" },
      hasSuccess: true,
      hasFailure: true,
      successRate: 0.5,
      failureRate: 0.5,
    });
  });

  it("routes all_success to empty when no result has arrived", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "all_success_empty_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 0 },
      config: { value: [] },
    });
    const all = flow.node("all_success", {
      id: "all",
      position: { x: 260, y: 0 },
      config: { mode: "status" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "all=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 540, y: 0 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("output"), all.in("results"));
    flow.connect(all.out("empty"), report.in("in"));
    flow.connect(all.out("status"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "all_success_empty_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("all=empty");
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const anyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "any") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(anyOutput).toMatchObject({
      status: "any_success",
      value: { status: "succeeded", value: "fresh" },
      firstSuccess: { status: "succeeded", value: "fresh" },
      firstFailure: { status: "failed", error: "api timeout" },
      hasSuccess: true,
      hasFailure: true,
      successRate: 0.5,
      failureRate: 0.5,
    });
  });

  it("uses dynamic any_success policy inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "any_success_dynamic_policy_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 180 } });
    const results = flow.node("transform", {
      id: "results",
      position: { x: 140, y: 80 },
      config: {
        value: [
          { state: "blocked", failure: "api timeout", label: "a" },
          { state: "done", label: "b" },
        ],
      },
    });
    const mode = flow.node("transform", {
      id: "mode",
      position: { x: 140, y: 180 },
      config: { value: "status" },
    });
    const statusPath = flow.node("transform", {
      id: "status_path",
      position: { x: 140, y: 280 },
      config: { value: "state" },
    });
    const successValues = flow.node("transform", {
      id: "success_values",
      position: { x: 140, y: 380 },
      config: { value: "done" },
    });
    const errorPath = flow.node("transform", {
      id: "error_path",
      position: { x: 140, y: 480 },
      config: { value: "failure" },
    });
    const any = flow.node("any_success", {
      id: "any",
      position: { x: 360, y: 260 },
      config: {
        mode: "ok",
        statusPath: "status",
        successValues: "ok",
        errorPath: "error",
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 560, y: 260 },
      config: { template: "any=${input.mode}:${input.successCount}/${input.total}:${input.statusPath}:${input.errorPath}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 800, y: 260 } });

    flow.connect(start.out("out"), results.in("in"));
    flow.connect(start.out("out"), mode.in("in"));
    flow.connect(start.out("out"), statusPath.in("in"));
    flow.connect(start.out("out"), successValues.in("in"));
    flow.connect(start.out("out"), errorPath.in("in"));
    flow.connect(results.out("output"), any.in("results"));
    flow.connect(mode.out("output"), any.in("mode"));
    flow.connect(statusPath.out("output"), any.in("statusPath"));
    flow.connect(successValues.out("output"), any.in("successValues"));
    flow.connect(errorPath.out("output"), any.in("errorPath"));
    flow.connect(any.out("any_success"), report.in("in"));
    flow.connect(any.out("summary"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "any_success_dynamic_policy_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("any=status:1/2:state:failure");
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const anyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "any") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(anyOutput).toMatchObject({
      status: "any_success",
      value: { state: "done", label: "b" },
      successCount: 1,
      failureCount: 1,
      total: 2,
      mode: "status",
      statusPath: "state",
      successValues: ["done"],
      errorPath: "failure",
      hasSuccess: true,
      hasFailure: true,
      successRate: 0.5,
      failureRate: 0.5,
      firstSuccess: { state: "done", label: "b" },
      firstFailure: { state: "blocked", failure: "api timeout", label: "a" },
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const anyOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "any") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(anyOutput).toMatchObject({
      status: "no_success",
      value: null,
      firstSuccess: null,
      firstFailure: { status: "failed", error: "api timeout" },
      hasSuccess: false,
      hasFailure: true,
      successRate: 0,
      failureRate: 1,
    });
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const fanoutOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "fanout") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const joinOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "join") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parallel=upper:Flow,lower:Flow");
    expect(fanoutOutput).toMatchObject({
      branchCount: 2,
      concurrency: 2,
      branchIds: ["branch1", "branch2"],
    });
    expect(joinOutput).toMatchObject({
      status: "joined",
      empty: false,
      count: 2,
      firstValue: "upper:Flow",
      lastValue: "lower:Flow",
    });
  });

  it("executes ready parallel branches concurrently before joining", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "parallel_concurrent_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 120 },
      config: { value: { name: "Flow" } },
    });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 260, y: 120 },
      config: { branchCount: 2 },
    });
    const waitA = flow.node("delay", {
      id: "wait_a",
      position: { x: 420, y: 40 },
      config: { durationMs: 25 },
    });
    const waitB = flow.node("delay", {
      id: "wait_b",
      position: { x: 420, y: 200 },
      config: { durationMs: 25 },
    });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 580, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 580, y: 200 },
      config: { template: "lower:${input.name}" },
    });
    const join = flow.node("join", { id: "join", position: { x: 740, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 880, y: 120 },
      config: { template: "parallel=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 1020, y: 120 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), fanout.in("in"));
    flow.connect(source.out("output"), fanout.in("input"));
    flow.connect(fanout.out("branch1"), waitA.in("in"));
    flow.connect(fanout.out("branch2"), waitB.in("in"));
    flow.connect(waitA.out("out"), upper.in("in"));
    flow.connect(waitB.out("out"), lower.in("in"));
    flow.connect(fanout.out("value"), upper.in("input"));
    flow.connect(fanout.out("value"), lower.in("input"));
    flow.connect(upper.out("out"), join.in("in"));
    flow.connect(lower.out("out"), join.in("in"));
    flow.connect(upper.out("output"), join.in("values"));
    flow.connect(lower.out("output"), join.in("values"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "parallel_concurrent_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parallel=upper:Flow,lower:Flow");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const waitEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) =>
        (event.nodeId === "wait_a" || event.nodeId === "wait_b") &&
        (event.kind === "node_started" || event.kind === "node_finished"),
      );
    const firstFinished = waitEvents.findIndex(({ event }) => event.kind === "node_finished");
    const startsBeforeFirstFinish = waitEvents
      .slice(0, firstFinished)
      .filter(({ event }) => event.kind === "node_started")
      .map(({ event }) => event.nodeId)
      .sort();

    expect(startsBeforeFirstFinish).toEqual(["wait_a", "wait_b"]);
  });

  it("limits direct parallel branch concurrency from the parallel node config", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "parallel_concurrency_limit_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 120 },
      config: { value: { name: "Flow" } },
    });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 260, y: 120 },
      config: { branchCount: 2, concurrency: 1 },
    });
    const waitA = flow.node("delay", {
      id: "wait_a",
      position: { x: 420, y: 40 },
      config: { durationMs: 25 },
    });
    const waitB = flow.node("delay", {
      id: "wait_b",
      position: { x: 420, y: 200 },
      config: { durationMs: 25 },
    });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 580, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 580, y: 200 },
      config: { template: "lower:${input.name}" },
    });
    const join = flow.node("join", { id: "join", position: { x: 740, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 880, y: 120 },
      config: { template: "parallel=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 1020, y: 120 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), fanout.in("in"));
    flow.connect(source.out("output"), fanout.in("input"));
    flow.connect(fanout.out("branch1"), waitA.in("in"));
    flow.connect(fanout.out("branch2"), waitB.in("in"));
    flow.connect(waitA.out("out"), upper.in("in"));
    flow.connect(waitB.out("out"), lower.in("in"));
    flow.connect(fanout.out("value"), upper.in("input"));
    flow.connect(fanout.out("value"), lower.in("input"));
    flow.connect(upper.out("out"), join.in("in"));
    flow.connect(lower.out("out"), join.in("in"));
    flow.connect(upper.out("output"), join.in("values"));
    flow.connect(lower.out("output"), join.in("values"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "parallel_concurrency_limit_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parallel=upper:Flow,lower:Flow");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const waitEvents = events.filter(
      (event) =>
        (event.nodeId === "wait_a" || event.nodeId === "wait_b") &&
        (event.kind === "node_started" || event.kind === "node_finished"),
    );
    const firstFinished = waitEvents.findIndex((event) => event.kind === "node_finished");
    const startsBeforeFirstFinish = waitEvents
      .slice(0, firstFinished)
      .filter((event) => event.kind === "node_started");

    expect(startsBeforeFirstFinish).toHaveLength(1);
  });

  it("limits direct parallel branch concurrency from dynamic inputs", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "parallel_dynamic_concurrency_limit_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const source = flow.node("transform", {
      id: "source",
      position: { x: 120, y: 120 },
      config: { value: { name: "Flow" } },
    });
    const branchCount = flow.node("transform", {
      id: "branch_count",
      position: { x: 260, y: 40 },
      config: { value: 2 },
    });
    const concurrency = flow.node("transform", {
      id: "concurrency",
      position: { x: 260, y: 200 },
      config: { value: 1 },
    });
    const fanout = flow.node("parallel", {
      id: "fanout",
      position: { x: 420, y: 120 },
      config: { branchCount: 4, concurrency: 4 },
    });
    const waitA = flow.node("delay", {
      id: "wait_a",
      position: { x: 580, y: 40 },
      config: { durationMs: 25 },
    });
    const waitB = flow.node("delay", {
      id: "wait_b",
      position: { x: 580, y: 200 },
      config: { durationMs: 25 },
    });
    const upper = flow.node("transform", {
      id: "upper",
      position: { x: 740, y: 40 },
      config: { template: "upper:${input.name}" },
    });
    const lower = flow.node("transform", {
      id: "lower",
      position: { x: 740, y: 200 },
      config: { template: "lower:${input.name}" },
    });
    const join = flow.node("join", { id: "join", position: { x: 900, y: 120 } });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 1040, y: 120 },
      config: { template: "parallel=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 1180, y: 120 } });

    flow.connect(start.out("out"), source.in("in"));
    flow.connect(source.out("out"), branchCount.in("in"));
    flow.connect(branchCount.out("out"), concurrency.in("in"));
    flow.connect(concurrency.out("out"), fanout.in("in"));
    flow.connect(source.out("output"), fanout.in("input"));
    flow.connect(branchCount.out("output"), fanout.in("branchCount"));
    flow.connect(concurrency.out("output"), fanout.in("concurrency"));
    flow.connect(fanout.out("branch1"), waitA.in("in"));
    flow.connect(fanout.out("branch2"), waitB.in("in"));
    flow.connect(waitA.out("out"), upper.in("in"));
    flow.connect(waitB.out("out"), lower.in("in"));
    flow.connect(fanout.out("value"), upper.in("input"));
    flow.connect(fanout.out("value"), lower.in("input"));
    flow.connect(upper.out("out"), join.in("in"));
    flow.connect(lower.out("out"), join.in("in"));
    flow.connect(upper.out("output"), join.in("values"));
    flow.connect(lower.out("output"), join.in("values"));
    flow.connect(join.out("out"), report.in("in"));
    flow.connect(join.out("values"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "parallel_dynamic_concurrency_limit_e2e",
      input: { name: "Flow" },
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parallel=upper:Flow,lower:Flow");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const fanoutOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "fanout") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    expect(fanoutOutput).toMatchObject({
      branchCount: 2,
      concurrency: 1,
      branchIds: ["branch1", "branch2"],
    });
    const waitEvents = events.filter(
      (event) =>
        (event.nodeId === "wait_a" || event.nodeId === "wait_b") &&
        (event.kind === "node_started" || event.kind === "node_finished"),
    );
    const firstFinished = waitEvents.findIndex((event) => event.kind === "node_finished");
    const startsBeforeFirstFinish = waitEvents
      .slice(0, firstFinished)
      .filter((event) => event.kind === "node_started");

    expect(startsBeforeFirstFinish).toHaveLength(1);
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const filterOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "filter") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("kept=keep,keep");
    expect(filterOutput).toMatchObject({ count: 2, rejectedCount: 1, total: 3 });
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

  it("evaluates expression_eval aggregate and string helper functions", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "expression_eval_helpers_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: {
          amounts: [2, "3", "skip", 5],
          tags: ["api", "batch"],
          name: " Ada ",
          fallback: "ready",
          missing: null,
        },
      },
    });
    const expression = flow.node("expression_eval", {
      id: "expression",
      position: { x: 260, y: 0 },
      config: {
        expression: [
          "length(input.tags) == 2",
          "sum(input.amounts) == 10",
          "avg(input.amounts) > 3",
          "min(input.amounts) == 2",
          "max(input.amounts) == 5",
          "lower(trim(input.name)) == 'ada'",
          "upper(coalesce(input.missing, input.fallback)) == 'READY'",
        ].join(" && "),
      },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 400, y: 0 },
      config: { template: "helpers=${input}" },
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
      flowId: "expression_eval_helpers_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("helpers=true");
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

  it("maps array items with map_items expressions", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "map_items_expression_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: { value: [{ name: "alpha" }, { name: "beta" }] },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 260, y: 0 },
      config: { expression: "upper(item.name)" },
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
      flowId: "map_items_expression_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("mapped=ALPHA,BETA");
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

  it("sorts group_items entries by count", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "group_items_sort_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { status: "pending" },
          { status: "closed" },
          { status: "open" },
          { status: "closed" },
          { status: "open" },
          { status: "open" },
        ],
      },
    });
    const group = flow.node("group_items", {
      id: "group",
      position: { x: 260, y: 0 },
      config: { path: "status", sortBy: "count", sortDirection: "desc" },
    });
    const map = flow.node("map_items", {
      id: "map",
      position: { x: 400, y: 0 },
      config: { template: "${item.key}:${item.count}" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "sorted=${input}" },
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
      flowId: "group_items_sort_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("sorted=open:3,closed:2,pending:1");
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

  it("reduces array items with numeric and positional reduce_items modes", async () => {
    const rt = newRuntime();
    const flow = defineFlow({ id: "reduce_items_modes_e2e", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const input = flow.node("transform", {
      id: "input",
      position: { x: 120, y: 0 },
      config: {
        value: [
          { amount: 2, label: "first" },
          { amount: "4", label: "middle" },
          { amount: 6, label: "last-number" },
          { amount: "skip", label: "last" },
        ],
      },
    });
    const average = flow.node("reduce_items", {
      id: "average",
      position: { x: 260, y: 0 },
      config: { mode: "average", path: "amount" },
    });
    const min = flow.node("reduce_items", {
      id: "min",
      position: { x: 260, y: 100 },
      config: { mode: "min", path: "amount" },
    });
    const max = flow.node("reduce_items", {
      id: "max",
      position: { x: 260, y: 200 },
      config: { mode: "max", path: "amount" },
    });
    const first = flow.node("reduce_items", {
      id: "first",
      position: { x: 260, y: 300 },
      config: { mode: "first", path: "label" },
    });
    const last = flow.node("reduce_items", {
      id: "last",
      position: { x: 260, y: 400 },
      config: { mode: "last", path: "label" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 420, y: 0 },
      config: { template: "avg=${input}" },
    });
    const end = flow.node("end", { id: "e", position: { x: 560, y: 0 } });

    flow.connect(start.out("out"), input.in("in"));
    for (const reduce of [average, min, max, first, last]) {
      flow.connect(input.out("out"), reduce.in("in"));
      flow.connect(input.out("output"), reduce.in("items"));
    }
    flow.connect(average.out("out"), report.in("in"));
    flow.connect(average.out("result"), report.in("input"));
    flow.connect(report.out("out"), end.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "reduce_items_modes_e2e",
      input: null,
    });
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const outputFor = (nodeId: string): Record<string, unknown> | undefined =>
      (
        events.find((event) => event.kind === "node_finished" && event.nodeId === nodeId) as
          | { payload?: { output?: Record<string, unknown> } }
          | undefined
      )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("avg=4");
    expect(outputFor("average")).toMatchObject({ result: 4, count: 4, numericCount: 3 });
    expect(outputFor("min")).toMatchObject({ result: 2, count: 4, numericCount: 3 });
    expect(outputFor("max")).toMatchObject({ result: 6, count: 4, numericCount: 3 });
    expect(outputFor("first")).toMatchObject({ result: "first", count: 4, numericCount: 0 });
    expect(outputFor("last")).toMatchObject({ result: "last", count: 4, numericCount: 0 });
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

  it("isolates sequential foreach data scope between iterations", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_iteration_scope_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 120 },
      config: {
        value: [
          { run: true, value: "first" },
          { run: false, value: "second" },
        ],
      },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 220, y: 120 },
    });
    const gate = flow.node("condition", {
      id: "gate",
      position: { x: 340, y: 120 },
      config: { expression: "input.run" },
    });
    const optional = flow.node("transform", {
      id: "optional",
      position: { x: 460, y: 60 },
    });
    const collect = flow.node("transform", {
      id: "collect",
      position: { x: 580, y: 120 },
      config: { template: "seen:${input.value}" },
    });
    const loopEnd = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 700, y: 120 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 820, y: 120 },
      config: { template: "results=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 940, y: 120 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), gate.in("in"));
    flow.connect(begin.out("item"), optional.in("input"));
    flow.connect(gate.out("true"), optional.in("in"));
    flow.connect(gate.out("false"), collect.in("in"));
    flow.connect(optional.out("out"), collect.in("in"));
    flow.connect(optional.out("output"), collect.in("input"));
    flow.connect(collect.out("out"), loopEnd.in("body_done"));
    flow.connect(collect.out("output"), loopEnd.in("result"));
    flow.connect(loopEnd.out("done"), report.in("in"));
    flow.connect(loopEnd.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_iteration_scope_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=seen:first,seen:");
  });

  it("runs foreach parallel mode with batchSize and concurrency while preserving result order", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_parallel_batch_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 100, y: 0 },
      config: { value: ["alpha", "beta", "gamma", "delta"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 200, y: 0 },
      config: { mode: "parallel", concurrency: 2, batchSize: 2 },
    });
    const wait = flow.node("delay", {
      id: "wait",
      position: { x: 300, y: 0 },
      config: { durationMs: 20 },
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
      config: { template: "results=${input}" },
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
    flow.connect(end.out("done"), report.in("in"));
    flow.connect(end.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_parallel_batch_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=item=alpha,item=beta,item=gamma,item=delta");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const progress = events.filter(
      (event) => event.kind === "node_progress" && event.nodeId === "begin",
    );
    const payloads = progress.map(
      (event) =>
        event.payload as {
          phase: "started" | "finished";
          iteration: number;
          status: string;
        },
    );
    const started = payloads.filter((payload) => payload.phase === "started");
    const finished = payloads.filter((payload) => payload.phase === "finished");

    expect(started.map((payload) => payload.iteration)).toEqual([0, 1, 2, 3]);
    expect(finished.map((payload) => payload.iteration).sort()).toEqual([0, 1, 2, 3]);
    expect(payloads.slice(0, 2).map((payload) => payload.phase)).toEqual([
      "started",
      "started",
    ]);
    expect(payloads.slice(0, 2).map((payload) => payload.iteration)).toEqual([0, 1]);

    const firstBatchFinishedAt = Math.max(
      payloads.findIndex((payload) => payload.phase === "finished" && payload.iteration === 0),
      payloads.findIndex((payload) => payload.phase === "finished" && payload.iteration === 1),
    );
    const secondBatchStartedAt = Math.min(
      payloads.findIndex((payload) => payload.phase === "started" && payload.iteration === 2),
      payloads.findIndex((payload) => payload.phase === "started" && payload.iteration === 3),
    );
    expect(secondBatchStartedAt).toBeGreaterThan(firstBatchFinishedAt);
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

  it("routes foreach body errors into compensation and rollback branches", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const flow = defineFlow({
      id: "foreach_error_compensation_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const reserveInventory = flow.node("compensation", {
      id: "reserve_inventory",
      position: { x: 100, y: 0 },
      config: {
        name: "LOOP_COMPENSATIONS",
        mode: "register",
        action: "release_inventory",
        payload: { sku: "book", quantity: 1 },
      },
    });
    const chargePayment = flow.node("compensation", {
      id: "charge_payment",
      position: { x: 200, y: 0 },
      config: {
        name: "LOOP_COMPENSATIONS",
        mode: "register",
        action: "refund_payment",
        payload: { paymentId: "pay_1" },
      },
    });
    const items = flow.node("transform", {
      id: "items",
      position: { x: 300, y: 0 },
      config: { value: ["alpha", "beta"] },
    });
    const begin = flow.node("foreach_begin", {
      id: "begin",
      position: { x: 400, y: 0 },
      config: { onError: "route" },
    });
    const failing = flow.node("http", {
      id: "failing",
      position: { x: 500, y: 0 },
      config: {},
    });
    const loopEnd = flow.node("foreach_end", {
      id: "loop_end",
      position: { x: 600, y: 0 },
    });
    const drain = flow.node("compensation", {
      id: "drain",
      position: { x: 700, y: 0 },
      config: {
        name: "LOOP_COMPENSATIONS",
        mode: "drain",
      },
    });
    const rollback = flow.node("rollback", {
      id: "rollback",
      position: { x: 800, y: 0 },
      config: { mode: "plan" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 900, y: 0 },
      config: { template: "rollback=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 1000, y: 0 } });

    flow.connect(start.out("out"), reserveInventory.in("in"));
    flow.connect(reserveInventory.out("out"), chargePayment.in("in"));
    flow.connect(chargePayment.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), failing.in("in"));
    flow.connect(failing.out("out"), loopEnd.in("body_done"));
    flow.connect(loopEnd.out("error"), drain.in("in"));
    flow.connect(drain.out("out"), rollback.in("in"));
    flow.connect(drain.out("actions"), rollback.in("actions"));
    flow.connect(rollback.out("rollback"), report.in("in"));
    flow.connect(rollback.out("count"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_error_compensation_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("rollback=2");
    expect(variables.get("LOOP_COMPENSATIONS")).toMatchObject({
      actions: [],
    });

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(events.some((event) => event.kind === "node_started" && event.nodeId === "rollback")).toBe(
      true,
    );
    expect(
      events.find(
        (event) =>
          event.kind === "node_progress" &&
          event.nodeId === "begin" &&
          (event.payload as { phase?: string }).phase === "finished",
      )?.payload,
    ).toMatchObject({
      type: "loop_iteration",
      iteration: 0,
      status: "error",
    });
  });

  it("terminates a foreach block on body errors by default", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "foreach_error_terminate_e2e",
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
      config: { template: "should-not-run" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 600, y: 0 } });

    flow.connect(start.out("out"), items.in("in"));
    flow.connect(items.out("out"), begin.in("in"));
    flow.connect(items.out("output"), begin.in("items"));
    flow.connect(begin.out("body"), failing.in("in"));
    flow.connect(failing.out("out"), end.in("body_done"));
    flow.connect(end.out("done"), report.in("in"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "foreach_error_terminate_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(false);
    expect(result.runRecord.status).toBe("failed");
    expect(result.error?.code).toBe("node.http.missing_url");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(
      events.some((event) => event.kind === "node_started" && event.nodeId === "loop_end"),
    ).toBe(false);
    expect(
      events.some((event) => event.kind === "node_started" && event.nodeId === "report"),
    ).toBe(false);
    expect(
      events.find(
        (event) =>
          event.kind === "node_progress" &&
          event.nodeId === "begin" &&
          (event.payload as { phase?: string }).phase === "finished",
      )?.payload,
    ).toMatchObject({
      type: "loop_iteration",
      iteration: 0,
      status: "failed",
    });
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
      config: { reason: "found_beta" },
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const loopOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "loop_end") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const breakOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "break") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=item=alpha,item=beta");
    expect(breakOutput).toMatchObject({ status: "break", reason: "found_beta" });
    expect(loopOutput).toMatchObject({ status: "break", iterationCount: 2, controlReason: "found_beta" });
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
      config: { reason: "skip_beta" },
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
    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const loopOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "loop_end") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const continueOutput = (
      events.find((event) => event.kind === "node_finished" && event.nodeId === "continue") as
        | { payload?: { output?: Record<string, unknown> } }
        | undefined
    )?.payload?.output;
    const continueProgress = events.find(
      (event) =>
        event.kind === "node_progress" &&
        event.nodeId === "begin" &&
        (event.payload as { phase?: string; iteration?: number }).phase === "finished" &&
        (event.payload as { phase?: string; iteration?: number }).iteration === 1,
    ) as { payload?: Record<string, unknown> } | undefined;

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=item=alpha,item=gamma");
    expect(continueOutput).toMatchObject({ status: "continue", reason: "skip_beta" });
    expect(continueProgress?.payload).toMatchObject({
      status: "continue",
      controlReason: "skip_beta",
    });
    expect(loopOutput).toMatchObject({ status: "done", iterationCount: 3 });
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

  it("executes a fixed-range for block with the configured step", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "for_block_step_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const begin = flow.node("for_begin", {
      id: "begin",
      position: { x: 120, y: 0 },
      config: { start: 1, end: 6, step: 2 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 260, y: 0 },
      config: { template: "i=${input}" },
    });
    const loopEnd = flow.node("for_end", {
      id: "loop_end",
      position: { x: 400, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "results=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), begin.in("in"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(begin.out("index"), body.in("input"));
    flow.connect(body.out("out"), loopEnd.in("body_done"));
    flow.connect(body.out("output"), loopEnd.in("result"));
    flow.connect(loopEnd.out("done"), report.in("in"));
    flow.connect(loopEnd.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "for_block_step_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=i=1,i=3,i=5");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    const progress = events.filter(
      (event) => event.kind === "node_progress" && event.nodeId === "begin",
    );
    expect(progress.map((event) => (event.payload as { iteration: number }).iteration)).toEqual([
      0,
      0,
      1,
      1,
      2,
      2,
    ]);
    expect(progress[0]?.payload).toMatchObject({
      type: "loop_iteration",
      loopType: "for_begin",
      context: { index: 1, count: 3 },
    });
    expect(progress[4]?.payload).toMatchObject({
      type: "loop_iteration",
      loopType: "for_begin",
      context: { index: 5, count: 3 },
    });
  });

  it("executes descending for ranges with a negative step", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "for_block_negative_step_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const begin = flow.node("for_begin", {
      id: "begin",
      position: { x: 120, y: 0 },
      config: { start: 5, end: 0, step: -2 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 260, y: 0 },
      config: { template: "i=${input}" },
    });
    const loopEnd = flow.node("for_end", {
      id: "loop_end",
      position: { x: 400, y: 0 },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 540, y: 0 },
      config: { template: "results=${input}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 680, y: 0 } });

    flow.connect(start.out("out"), begin.in("in"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(begin.out("index"), body.in("input"));
    flow.connect(body.out("out"), loopEnd.in("body_done"));
    flow.connect(body.out("output"), loopEnd.in("result"));
    flow.connect(loopEnd.out("done"), report.in("in"));
    flow.connect(loopEnd.out("results"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "for_block_negative_step_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("results=i=5,i=3,i=1");
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

  it("isolates loop_begin data scope between while iterations", async () => {
    const stepNode = defineNode({
      type: "loop_scope_step",
      typeVersion: "1.0.0",
      title: "Loop Scope Step",
      ports: [
        { id: "state", direction: "input", kind: "data", label: "State" },
        { id: "observed", direction: "input", kind: "data", label: "Observed" },
        { id: "nextState", direction: "output", kind: "data", label: "Next State" },
      ],
      validateInput: false,
      run({ input }) {
        const state =
          input.state && typeof input.state === "object"
            ? (input.state as Record<string, unknown>)
            : {};
        const next =
          state.next && typeof state.next === "object"
            ? (state.next as Record<string, unknown>)
            : { continue: false };
        return {
          kind: "success",
          outputs: {
            out: null,
            nextState: {
              ...next,
              observed: input.observed ?? null,
            },
          },
        };
      },
    });
    const rt = newRuntime({ nodes: [stepNode] });
    const flow = defineFlow({
      id: "loop_iteration_scope_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 120 } });
    const initial = flow.node("transform", {
      id: "initial",
      position: { x: 120, y: 120 },
      config: {
        value: {
          continue: true,
          run: true,
          value: "first",
          next: {
            continue: true,
            run: false,
            value: "second",
            next: { continue: false, value: "done" },
          },
        },
      },
    });
    const begin = flow.node("loop_begin", {
      id: "begin",
      position: { x: 260, y: 120 },
      config: { checkMode: "after", maxIterations: 3 },
    });
    const gate = flow.node("condition", {
      id: "gate",
      position: { x: 400, y: 120 },
      config: { expression: "input.run" },
    });
    const optional = flow.node("transform", {
      id: "optional",
      position: { x: 540, y: 60 },
    });
    const step = flow.node("loop_scope_step", {
      id: "step",
      position: { x: 680, y: 120 },
    });
    const loopEnd = flow.node("loop_end", {
      id: "loop_end",
      position: { x: 820, y: 120 },
      config: { condition: "nextState.continue == true" },
    });
    const report = flow.node("transform", {
      id: "report",
      position: { x: 960, y: 120 },
      config: { template: "observed=${input.observed.value}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 1100, y: 120 } });

    flow.connect(start.out("out"), initial.in("in"));
    flow.connect(initial.out("out"), begin.in("in"));
    flow.connect(initial.out("output"), begin.in("initialState"));
    flow.connect(begin.out("body"), gate.in("in"));
    flow.connect(begin.out("state"), optional.in("input"));
    flow.connect(begin.out("state"), step.in("state"));
    flow.connect(gate.out("true"), optional.in("in"));
    flow.connect(gate.out("false"), step.in("in"));
    flow.connect(optional.out("out"), step.in("in"));
    flow.connect(optional.out("output"), step.in("observed"));
    flow.connect(step.out("out"), loopEnd.in("body_done"));
    flow.connect(step.out("nextState"), loopEnd.in("nextState"));
    flow.connect(loopEnd.out("done"), report.in("in"));
    flow.connect(loopEnd.out("finalState"), report.in("input"));
    flow.connect(report.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "loop_iteration_scope_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("observed=");
  });

  it("routes loop_begin max iteration exhaustion only to maxed", async () => {
    const rt = newRuntime();
    const flow = defineFlow({
      id: "loop_maxed_branch_e2e",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 80 } });
    const initial = flow.node("transform", {
      id: "initial",
      position: { x: 120, y: 80 },
      config: { value: { continue: true, label: "initial" } },
    });
    const begin = flow.node("loop_begin", {
      id: "begin",
      position: { x: 260, y: 80 },
      config: { checkMode: "after", maxIterations: 2 },
    });
    const body = flow.node("transform", {
      id: "body",
      position: { x: 400, y: 80 },
      config: { value: { continue: true, label: "again" } },
    });
    const loopEnd = flow.node("loop_end", {
      id: "loop_end",
      position: { x: 540, y: 80 },
      config: { condition: "nextState.continue == true" },
    });
    const maxedReport = flow.node("transform", {
      id: "maxed_report",
      position: { x: 680, y: 40 },
      config: { template: "maxed=${input.label}" },
    });
    const doneReport = flow.node("transform", {
      id: "done_report",
      position: { x: 680, y: 140 },
      config: { template: "done=${input.label}" },
    });
    const exit = flow.node("end", { id: "e", position: { x: 820, y: 40 } });

    flow.connect(start.out("out"), initial.in("in"));
    flow.connect(initial.out("out"), begin.in("in"));
    flow.connect(initial.out("output"), begin.in("initialState"));
    flow.connect(begin.out("body"), body.in("in"));
    flow.connect(body.out("out"), loopEnd.in("body_done"));
    flow.connect(body.out("output"), loopEnd.in("nextState"));
    flow.connect(loopEnd.out("maxed"), maxedReport.in("in"));
    flow.connect(loopEnd.out("finalState"), maxedReport.in("input"));
    flow.connect(loopEnd.out("done"), doneReport.in("in"));
    flow.connect(loopEnd.out("finalState"), doneReport.in("input"));
    flow.connect(maxedReport.out("out"), exit.in("in"));

    await registerAndPromote(rt, flow);

    const result = await rt.invocationRouter.invoke({
      flowId: "loop_maxed_branch_e2e",
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("maxed=again");

    const events = await rt.eventBus.store.read(result.runRecord.runId);
    expect(
      events.some((event) => event.kind === "node_started" && event.nodeId === "done_report"),
    ).toBe(false);
    const loopFinished = events.filter(
      (event) => event.kind === "node_finished" && event.nodeId === "loop_end",
    );
    expect(
      (
        loopFinished.at(-1) as
          | { payload?: { output?: Record<string, unknown> } }
          | undefined
      )?.payload?.output,
    ).toMatchObject({ status: "maxed", iterationCount: 2 });
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
