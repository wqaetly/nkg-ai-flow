import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import { createBrowserRuntime } from "../src/browser.js";

describe("Run control seams", () => {
  it("suspends at a node boundary, resumes, and exposes guidance downstream", async () => {
    let observedGuidance: readonly { code: string }[] = [];
    const probe = defineNode({
      type: "run_control_probe",
      typeVersion: "1.0.0",
      title: "Probe",
      run() {
        return { kind: "success", outputs: { out: null } };
      },
    });
    const tail = defineNode({
      type: "run_control_tail",
      typeVersion: "1.0.0",
      title: "Tail",
      run({ ctx }) {
        observedGuidance = ctx.guidance ?? [];
        return { kind: "success", outputs: { out: { ok: true } } };
      },
    });
    const runtime = createBrowserRuntime({
      nodes: [probe, tail],
      generateRunId: () => "run_control_test",
    });
    const flow = defineFlow({
      id: "run_control_flow",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const probeNode = flow.node("run_control_probe", {
      id: "probe",
      position: { x: 160, y: 0 },
    });
    const tailNode = flow.node("run_control_tail", {
      id: "tail",
      position: { x: 320, y: 0 },
    });
    const end = flow.node("end", { id: "end", position: { x: 480, y: 0 } });
    flow.connect(start.out("out"), probeNode.in("in"));
    flow.connect(probeNode.out("out"), tailNode.in("in"));
    flow.connect(tailNode.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());
    await runtime.registry.register({ graph });
    await runtime.registry.promote(graph.id, graph.version);

    const deferred = await runtime.invocationRouter.startDeferred({
      flowId: graph.id,
      input: null,
    });
    const unsubscribe = runtime.eventBus.subscribe(deferred.runRecord.runId, async (event) => {
      if (event.kind === "node_finished" && event.nodeId === "probe") {
        runtime.guidanceInbox.push(event.runId, {
          id: "guidance-1",
          source: "test-supervisor",
          severity: "concern",
          code: "review.required",
          message: "Review before continuing.",
          createdAt: new Date().toISOString(),
        });
        await runtime.runManager.pause(event.runId, "test boundary pause");
      }
    });
    deferred.startExecution();

    await waitFor(async () =>
      (await runtime.runManager.get(deferred.runRecord.runId))?.status === "suspended",
    );
    const beforeResume = await runtime.eventBus.store.read(deferred.runRecord.runId);
    expect(beforeResume.some((event) => event.kind === "node_started" && event.nodeId === "tail")).toBe(false);

    await runtime.runManager.resume(deferred.runRecord.runId, "review acknowledged");
    const result = await deferred.completed;
    unsubscribe();

    expect(result.succeeded).toBe(true);
    expect(observedGuidance).toEqual([
      expect.objectContaining({ code: "review.required" }),
    ]);
    const events = await runtime.eventBus.store.read(deferred.runRecord.runId);
    expect(events.map((event) => event.kind)).toContain("run_suspended");
    expect(events.map((event) => event.kind)).toContain("run_resumed");
  });
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached before timeout");
}
