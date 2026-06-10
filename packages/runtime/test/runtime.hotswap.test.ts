/**
 * End-to-end hot-swap (T0 + T1 + T2) integration tests for Phase 3.
 *
 * Validates the spec §5 promise of `docs/specs/sandbox.md`:
 *
 *   - Two versions of the same node type can coexist in the registry.
 *   - `drainAndUnregister(type, version)` waits for in-flight Runs of
 *     *that* version to finish before removing it; new Runs are routed
 *     to the remaining version.
 *   - A drain that times out must roll back atomically so the entry is
 *     observable as still-registered.
 *
 * The test exercises the FULL execution path: defineNode → installNode
 * → createRuntime → registry.register/promote → invocationRouter.invoke
 * → ExecutionEngine.executeNode → SandboxedRunner.execute → drain.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import { createRuntime, type Runtime } from "../src/index.js";

/* -------------------------------------------------------------------------- */
/* Custom node v1 / v2                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Outbound signal hook: each in-flight execution of `slow_echo@1.0.0`
 * pushes its release callback onto this list. Tests pop from it to
 * unblock the runner exactly when they want.
 */
const v1Releasers: Array<() => void> = [];
const v2Releasers: Array<() => void> = [];

function makeSlowEcho(version: "1.0.0" | "1.1.0", releasers: Array<() => void>) {
  return defineNode({
    type: "slow_echo",
    typeVersion: version,
    title: `Slow Echo ${version}`,
    ports: [
      { id: "result", direction: "output", kind: "data", label: "Result" },
    ],
    validateInput: false,
    async run({ ctx }) {
      const tag = version === "1.0.0" ? "v1" : "v2";
      // Park the runner until the test releases it. This lets the test
      // observe `inflight() === 1` and prove that drain blocks.
      await new Promise<void>((resolve) => {
        const release = () => resolve();
        releasers.push(release);
        // If the engine cancels the Run, surface that path too.
        ctx.signal.addEventListener("abort", release, { once: true });
      });
      return {
        kind: "success",
        outputs: { out: null, result: `${tag}-done` },
      };
    },
  });
}

const slowEchoV1 = makeSlowEcho("1.0.0", v1Releasers);
const slowEchoV2 = makeSlowEcho("1.1.0", v2Releasers);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    nodes: [slowEchoV1, slowEchoV2],
  });
}

async function registerAndPromote(
  rt: Runtime,
  flow: ReturnType<typeof defineFlow>,
) {
  const json = flow.dump();
  const graph = JSON.parse(json);
  await rt.registry.register({ graph, json, status: "staging" });
  await rt.registry.promote(graph.id, graph.version);
  return graph;
}

function makeFlow(rt: Runtime, args: { id: string; version: string; nodeVersion: "1.0.0" | "1.1.0" }) {
  const flow = defineFlow({ id: args.id, version: args.version, registry: rt.nodeTypeRegistry });
  const start = flow.node("start", { id: "node_start_01", position: { x: 0, y: 0 } });
  const echo = flow.node("slow_echo", {
    id: "node_echo_01",
    typeVersion: args.nodeVersion,
    position: { x: 100, y: 0 },
  });
  const end = flow.node("end", { id: "node_end_01", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), echo.in("in"));
  // Only a control edge to end. The ExecutionEngine's `assembleInputs`
  // (see packages/runtime/src/executionEngine.ts) auto-forwards the
  // upstream node's primary data output to `end.in` when the inbound
  // edges are control-only — that's the same convention `hello-flow`
  // uses. We rely on it here so the test stays focused on hot-swap
  // semantics rather than data-port wiring.
  flow.connect(echo.out("out"), end.in("in"));
  return flow;
}

async function waitForInflight(rt: Runtime, type: string, version: string, target: number, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sb = rt.runners.getSandbox(type, version);
    if (sb.inflight() === target) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for inflight=${target} on ${type}@${version}; got ${rt.runners.getSandbox(type, version).inflight()}`,
  );
}

/* -------------------------------------------------------------------------- */
/* T0 + T1 + T2 end-to-end                                                     */
/* -------------------------------------------------------------------------- */

describe("runtime / hot-swap end-to-end (Phase 3 T0+T1+T2)", () => {
  it("drainAndUnregister waits for in-flight Runs and lets them finish", async () => {
    // Reset shared releaser queues between tests.
    v1Releasers.length = 0;
    v2Releasers.length = 0;

    const rt = newRuntime();
    const flow = makeFlow(rt, { id: "hotswap_t2", version: "1.0.0", nodeVersion: "1.0.0" });
    await registerAndPromote(rt, flow);

    // Kick off the run; the slow_echo node will park on its promise.
    const runPromise = rt.invocationRouter.invoke({
      flowId: "hotswap_t2",
      input: { name: "hello" },
    });

    // Wait until the engine actually entered the slow_echo runner. Using
    // the sandbox handle we can observe inflight() reach 1.
    await waitForInflight(rt, "slow_echo", "1.0.0", 1);

    // T2 drain with a tight timeout MUST fail because the runner is still
    // parked. The registry must roll back atomically.
    try {
      await rt.runners.drainAndUnregister("slow_echo", "1.0.0", { timeoutMs: 30 });
      throw new Error("drainAndUnregister should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "runner_registry.drain_timeout",
      );
    }
    // Atomicity: rolled back, still dispatchable.
    expect(rt.runners.has("slow_echo", "1.0.0")).toBe(true);

    // Now release the parked runner and start a real drain.
    const release = v1Releasers.shift();
    expect(release).toBeDefined();
    const drainPromise = rt.runners.drainAndUnregister("slow_echo", "1.0.0");
    release?.();

    // The Run still completes successfully — drain MUST NOT cancel
    // in-flight work, only block new dispatch and wait for current to
    // finish. (spec §5: "in-flight requests run to completion".)
    const result = await runPromise;
    expect(result.succeeded).toBe(true);
    expect(result.runRecord.status).toBe("succeeded");
    expect(result.output).toBe("v1-done");

    // Drain finishes after the in-flight call resolves.
    await drainPromise;
    expect(rt.runners.has("slow_echo", "1.0.0")).toBe(false);
  });

  it("after T2: a fresh Flow pinned to v2 still executes via the surviving runner", async () => {
    v1Releasers.length = 0;
    v2Releasers.length = 0;

    const rt = newRuntime();
    // Both versions are present (T0).
    expect(rt.runners.has("slow_echo", "1.0.0")).toBe(true);
    expect(rt.runners.has("slow_echo", "1.1.0")).toBe(true);

    // Drain v1 immediately (no in-flight calls): the registry should drop it
    // synchronously and v2 keeps serving.
    await rt.runners.drainAndUnregister("slow_echo", "1.0.0");
    expect(rt.runners.has("slow_echo", "1.0.0")).toBe(false);
    expect(rt.runners.has("slow_echo", "1.1.0")).toBe(true);

    // Build a Flow pinned to v2 and run it. The runner parks; release it.
    const flow = makeFlow(rt, { id: "hotswap_after", version: "1.0.0", nodeVersion: "1.1.0" });
    await registerAndPromote(rt, flow);
    const runPromise = rt.invocationRouter.invoke({
      flowId: "hotswap_after",
      input: { name: "hello" },
    });
    await waitForInflight(rt, "slow_echo", "1.1.0", 1);
    v2Releasers.shift()?.();

    const result = await runPromise;
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("v2-done");
  });
});
