/**
 * Step 4 \u2014 transport-cli sub-graph (sink-node) command tests.
 *
 * Verifies that `flow run-node` and `flow stream-node` parse a
 * `<flowId> <nodeId>` positional pair, hand off to the SDK's
 * `invokeNode` / `streamNode`, and render the same kind of output as
 * their full-flow counterparts.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../../runtime/test/helpers/deterministicLlmProvider.js";
import { createFlowSdkClient } from "@ai-native-flow/transport-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import { createFlowCli, type CliIo } from "../src/index.js";

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
}

function createTestIo(files: Record<string, string> = {}): CliIo & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: {
      write: (chunk: string) => {
        stdoutLines.push(chunk.trimEnd());
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderrLines.push(chunk.trimEnd());
      },
    },
    async readFile(path: string) {
      const file = files[path];
      if (file === undefined) throw new Error(`File not found: ${path}`);
      return file;
    },
  };
}

async function registerSubGraph(rt: Runtime, id = "cli_sub"): Promise<void> {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
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

async function registerResumeFlow(rt: Runtime, id = "cli_resume"): Promise<void> {
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

describe("transport-cli / run-node", () => {
  it("runs a sub-graph and renders the sink output as JSON", async () => {
    const runtime = newRuntime();
    await registerSubGraph(runtime, "cli_run_node");
    const io = createTestIo();
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run([
      "run-node",
      "cli_run_node",
      "upper",
      "--input",
      JSON.stringify({ name: "Node" }),
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(io.stdoutLines[0]!);
    expect(payload.succeeded).toBe(true);
    expect(payload.output).toBe("Hi Node");
    expect(payload.nodeId).toBe("upper");
    expect(payload.flowId).toBe("cli_run_node");
  });

  it("returns exit code 1 with a clear error when nodeId is missing", async () => {
    const runtime = newRuntime();
    await registerSubGraph(runtime, "cli_run_node_missing");
    const io = createTestIo();
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run([
      "run-node",
      "cli_run_node_missing",
      "--input",
      "{}",
    ]);
    expect(result.exitCode).toBe(1);
    expect(io.stderrLines.join(" ")).toContain("Missing nodeId");
  });
});

describe("transport-cli / stream-node", () => {
  it("streams sub-graph events as newline-delimited JSON", async () => {
    const runtime = newRuntime();
    await registerSubGraph(runtime, "cli_stream_node");
    const io = createTestIo();
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run([
      "stream-node",
      "cli_stream_node",
      "upper",
      "--input",
      JSON.stringify({ name: "Node" }),
    ]);
    expect(result.exitCode).toBe(0);
    const events = io.stdoutLines.map((line) => JSON.parse(line));
    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
    expect(events.map((e) => e.kind)).toContain("node_finished");
  });
});

describe("transport-cli / run-resume", () => {
  it("runs from a resume point and renders the recovered output", async () => {
    const variables = new InMemoryVariableStore();
    const runtime = createRuntime({
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
    await registerResumeFlow(runtime, "cli_run_resume");
    const io = createTestIo();
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run([
      "run-resume",
      "cli_run_resume",
      "ORDER_RESUME_POINT",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(io.stdoutLines[0]!);
    expect(payload.succeeded).toBe(true);
    expect(payload.output).toBe("recover:order-1");
    expect(payload.resumePointName).toBe("ORDER_RESUME_POINT");
  });
});

describe("transport-cli / stream-resume", () => {
  it("streams resume-point events as newline-delimited JSON", async () => {
    const variables = new InMemoryVariableStore();
    const runtime = createRuntime({
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
    await registerResumeFlow(runtime, "cli_stream_resume");
    const io = createTestIo();
    const cli = createFlowCli({ client: createFlowSdkClient({ runtime }), io });

    const result = await cli.run([
      "stream-resume",
      "cli_stream_resume",
      "ORDER_RESUME_POINT",
    ]);

    expect(result.exitCode).toBe(0);
    const events = io.stdoutLines.map((line) => JSON.parse(line));
    expect(events[0]?.kind).toBe("run_started");
    expect(events[events.length - 1]?.kind).toBe("run_finished");
  });
});

