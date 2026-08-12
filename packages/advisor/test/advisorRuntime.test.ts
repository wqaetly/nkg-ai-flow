import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import { createBrowserRuntime } from "@ai-native-flow/runtime";
import { AdvisorRuntime } from "../src/index.js";

describe("AdvisorRuntime", () => {
  it("lets observe-mode primary execution finish while a slow reviewer is pending", async () => {
    const { runtime, graph } = await fixture("advisor_async_observe");
    let release!: () => void;
    const reviewerGate = new Promise<void>((resolve) => { release = resolve; });
    const advisor = new AdvisorRuntime(runtime, {
      advisorId: "slow-reviewer",
      mode: "observe",
      reviewer: async (batch) => {
        if (!batch.events.some((event) => event.nodeId === "probe")) return undefined;
        await reviewerGate;
        return { severity: "nit", code: "slow.done", message: "Review completed." };
      },
    });

    const started = await advisor.start({ flowId: graph.id, input: null });
    await waitFor(async () =>
      (await runtime.runManager.get(started.runRecord.runId))?.status === "succeeded",
    );
    expect(started.listAdvisories()).toHaveLength(0);

    release();
    const result = await started.completed;
    expect(result.succeeded).toBe(true);
    expect(result.advisories).toHaveLength(1);
  });

  it("publishes observe-mode advice without injecting Run guidance", async () => {
    const { runtime, graph } = await fixture("advisor_observe");
    const advisor = new AdvisorRuntime(runtime, {
      advisorId: "risk-reviewer",
      mode: "observe",
      reviewer: async (batch) =>
        batch.events.some((event) => event.nodeId === "probe")
          ? {
              severity: "concern",
              code: "risk.review",
              message: "The probe requires review.",
            }
          : undefined,
    });

    const result = await advisor.invoke({ flowId: graph.id, input: null });

    expect(result.succeeded).toBe(true);
    expect(result.advisories).toHaveLength(1);
    expect(runtime.guidanceInbox.list(result.runRecord.runId)).toHaveLength(0);
    const events = await runtime.eventBus.store.read(result.runRecord.runId);
    expect(events.some((event) => event.kind === "run_advisory")).toBe(true);
  });

  it("injects concern guidance before the next node in steer mode", async () => {
    const { runtime, graph, guidanceSeen } = await fixture("advisor_steer");
    const advisor = new AdvisorRuntime(runtime, {
      advisorId: "risk-reviewer",
      mode: "steer",
      reviewer: async (batch) =>
        batch.events.some((event) => event.nodeId === "probe")
          ? {
              severity: "concern",
              code: "risk.review",
              message: "Inspect the risk evidence before continuing.",
            }
          : undefined,
    });

    const result = await advisor.invoke({ flowId: graph.id, input: null });

    expect(result.succeeded).toBe(true);
    expect(guidanceSeen()).toEqual([
      expect.objectContaining({ severity: "concern", code: "risk.review" }),
    ]);
  });

  it("suspends gate-mode Runs on blockers and resumes at the boundary", async () => {
    const { runtime, graph, tailStarted } = await fixture("advisor_gate");
    const advisor = new AdvisorRuntime(runtime, {
      advisorId: "risk-reviewer",
      mode: "gate",
      reviewer: async (batch) =>
        batch.events.some((event) => event.nodeId === "probe")
          ? {
              severity: "blocker",
              code: "risk.blocked",
              message: "High-risk action requires acknowledgement.",
            }
          : undefined,
    });

    const started = await advisor.start({ flowId: graph.id, input: null });
    await waitFor(async () =>
      (await runtime.runManager.get(started.runRecord.runId))?.status === "suspended",
    );
    expect(tailStarted()).toBe(false);
    expect(started.listAdvisories()).toEqual([
      expect.objectContaining({ severity: "blocker", code: "risk.blocked" }),
    ]);

    await started.resume("operator acknowledged the blocker");
    const result = await started.completed;

    expect(result.succeeded).toBe(true);
    expect(tailStarted()).toBe(true);
    const events = await runtime.eventBus.store.read(started.runRecord.runId);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["run_advisory", "run_suspended", "run_resumed"]),
    );
  });

  it("deduplicates repeated advice and accepts at most one note per update", async () => {
    const { runtime, graph } = await fixture("advisor_dedupe");
    const advisor = new AdvisorRuntime(runtime, {
      advisorId: "risk-reviewer",
      mode: "observe",
      reviewer: async (batch) =>
        batch.events.some((event) => event.nodeId === "probe")
          ? [
              { severity: "nit", code: "same", message: "First note." },
              { severity: "blocker", code: "second", message: "Second note." },
            ]
          : undefined,
    });

    const result = await advisor.invoke({ flowId: graph.id, input: null });

    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]?.code).toBe("same");
  });
});

async function fixture(id: string) {
  let tailWasStarted = false;
  let receivedGuidance: readonly unknown[] = [];
  const probe = defineNode({
    type: `${id}_probe`,
    typeVersion: "1.0.0",
    title: "Probe",
    run() {
      return { kind: "success", outputs: { out: null, risk: "high" } };
    },
  });
  const tail = defineNode({
    type: `${id}_tail`,
    typeVersion: "1.0.0",
    title: "Tail",
    run({ ctx }) {
      tailWasStarted = true;
      receivedGuidance = ctx.guidance ?? [];
      return { kind: "success", outputs: { out: { ok: true } } };
    },
  });
  let nextRunId = 0;
  const runtime = createBrowserRuntime({
    nodes: [probe, tail],
    generateRunId: () => `${id}_${++nextRunId}`,
  });
  const flow = defineFlow({ id, version: "1.0.0", registry: runtime.nodeTypeRegistry });
  const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
  const probeNode = flow.node(`${id}_probe`, { id: "probe", position: { x: 160, y: 0 } });
  const tailNode = flow.node(`${id}_tail`, { id: "tail", position: { x: 320, y: 0 } });
  const end = flow.node("end", { id: "end", position: { x: 480, y: 0 } });
  flow.connect(start.out("out"), probeNode.in("in"));
  flow.connect(probeNode.out("out"), tailNode.in("in"));
  flow.connect(tailNode.out("out"), end.in("in"));
  const graph = JSON.parse(flow.dump());
  await runtime.registry.register({ graph });
  await runtime.registry.promote(graph.id, graph.version);
  return {
    runtime,
    graph,
    tailStarted: () => tailWasStarted,
    guidanceSeen: () => receivedGuidance,
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached before timeout");
}
