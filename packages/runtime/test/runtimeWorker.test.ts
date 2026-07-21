import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { createPortableRuntime } from "../src/portable.js";
import {
  RuntimeWorkerClient,
  attachRuntimeWorker,
  type RuntimeWorkerEndpoint,
} from "../src/worker.js";

describe("Runtime Worker transport", () => {
  it("registers, invokes, streams events and queries runs across the protocol", async () => {
    const runtime = createPortableRuntime({ generateRunId: sequence("worker_run") });
    const flow = defineFlow({
      id: "worker_contract",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const input = flow.node("text_input", {
      id: "input",
      position: { x: 0, y: 0 },
      config: { value: "from worker" },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(input.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());
    const { clientEndpoint, hostEndpoint } = linkedEndpoints();
    const attached = attachRuntimeWorker({ endpoint: hostEndpoint, runtime });
    const client = new RuntimeWorkerClient({ endpoint: clientEndpoint });
    const events: string[] = [];
    client.subscribe((event) => events.push(event.kind));

    await client.ready();
    await client.register({ graph, json: flow.dump() });
    await client.promote({ flowId: graph.id, flowVersion: graph.version });
    const result = await client.invoke({ flowId: graph.id, input: null });

    expect(result).toMatchObject({ succeeded: true, output: "from worker" });
    expect(events).toContain("run_started");
    expect(events).toContain("run_finished");
    expect(await client.getRun(result.runRecord.runId)).toMatchObject({ status: "succeeded" });
    expect(await client.listRuns(graph.id, 1)).toHaveLength(1);

    client.dispose();
    attached.dispose();
  });

  it("starts and cancels a long run without blocking the worker message loop", async () => {
    const runtime = createPortableRuntime({ generateRunId: sequence("cancel_run") });
    const flow = defineFlow({
      id: "worker_cancel",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const delay = flow.node("delay", {
      id: "delay",
      position: { x: 200, y: 0 },
      config: { durationMs: 10_000 },
    });
    const end = flow.node("end", { id: "end", position: { x: 400, y: 0 } });
    flow.connect(start.out("out"), delay.in("in"));
    flow.connect(delay.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());
    const { clientEndpoint, hostEndpoint } = linkedEndpoints();
    const attached = attachRuntimeWorker({ endpoint: hostEndpoint, runtime });
    const client = new RuntimeWorkerClient({ endpoint: clientEndpoint });

    await client.register({ graph });
    await client.promote({ flowId: graph.id, flowVersion: graph.version });
    const started = await client.start({ flowId: graph.id, input: null });
    await client.cancel(started.runRecord.runId, "fixture cancel");
    const result = await started.completed;

    expect(result.cancelled).toBe(true);
    expect(result.runRecord.status).toBe("cancelled");
    client.dispose();
    attached.dispose();
  });
});

function linkedEndpoints(): {
  clientEndpoint: RuntimeWorkerEndpoint;
  hostEndpoint: RuntimeWorkerEndpoint;
} {
  const clientListeners = new Set<(event: { data: unknown }) => void>();
  const hostListeners = new Set<(event: { data: unknown }) => void>();
  return {
    clientEndpoint: endpoint(clientListeners, hostListeners),
    hostEndpoint: endpoint(hostListeners, clientListeners),
  };
}

function endpoint(
  own: Set<(event: { data: unknown }) => void>,
  peer: Set<(event: { data: unknown }) => void>,
): RuntimeWorkerEndpoint {
  return {
    postMessage(message) {
      queueMicrotask(() => {
        for (const listener of peer) listener({ data: structuredClone(message) });
      });
    },
    addEventListener(_type, listener) {
      own.add(listener);
    },
    removeEventListener(_type, listener) {
      own.delete(listener);
    },
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}_${++value}`;
}
