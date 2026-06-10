/**
 * NodeRunnerRegistry unit tests (Phase 3).
 *
 * Covers the contract pieces needed by hot-swap (T0 + T1 + T2):
 *   - register() rejects duplicate (type, version)
 *   - unregister() removes an entry; missing key throws not_found
 *   - latest version recomputes after unregister()
 *   - get() with unknown version falls back to latest, then to no_runner
 *   - has() and list() reflect the current set
 */

import { describe, expect, it } from "vitest";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import { InMemoryNodeRunnerRegistry } from "../src/nodeRunnerRegistry.js";
import type { NodeRunner } from "../src/nodeContext.js";

const noopRunner: NodeRunner = async () => ({
  kind: "success",
  outputs: { ok: true },
});
const altRunner: NodeRunner = async () => ({
  kind: "success",
  outputs: { ok: false },
});

describe("InMemoryNodeRunnerRegistry", () => {
  it("register() then get() returns the runner for that exact version", () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("foo", "1.0.0", noopRunner);
    expect(r.get("foo", "1.0.0")).toBe(noopRunner);
  });

  it("register() rejects duplicate (type, version) with version_conflict", () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("foo", "1.0.0", noopRunner);
    try {
      r.register("foo", "1.0.0", altRunner);
      throw new Error("expected version_conflict to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "runner_registry.version_conflict",
      );
    }
  });

  it("supports T0: register vN+1 alongside vN, both resolvable by exact version", () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("foo", "1.0.0", noopRunner);
    r.register("foo", "1.1.0", altRunner);
    expect(r.get("foo", "1.0.0")).toBe(noopRunner);
    expect(r.get("foo", "1.1.0")).toBe(altRunner);
    // latest is the most recently registered version
    expect(r.get("foo", "999.999.999")).toBe(altRunner);
  });

  it("unregister() removes the entry; subsequent get() falls back to latest", () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("foo", "1.0.0", noopRunner);
    r.register("foo", "1.1.0", altRunner);
    r.unregister("foo", "1.1.0");
    expect(r.has("foo", "1.1.0")).toBe(false);
    // After draining v1.1.0, latest falls back to v1.0.0
    expect(r.get("foo", "anything")).toBe(noopRunner);
  });

  it("unregister() of an unknown (type, version) throws not_found", () => {
    const r = new InMemoryNodeRunnerRegistry();
    try {
      r.unregister("foo", "1.0.0");
      throw new Error("expected not_found");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "runner_registry.not_found",
      );
    }
  });

  it("unregister() of the only version clears the type entirely", () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("foo", "1.0.0", noopRunner);
    r.unregister("foo", "1.0.0");
    expect(r.has("foo")).toBe(false);
    expect(r.list()).toHaveLength(0);
  });

  it("list() reflects the current set, ignoring registration order details", () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("a", "1.0.0", noopRunner);
    r.register("b", "1.0.0", noopRunner);
    r.register("a", "1.1.0", altRunner);
    const entries = r.list();
    expect(entries).toHaveLength(3);
    // Phase 3 list() also surfaces tier + live inflight count for Studio
    // diagnostics; the test only asserts on the (type, version) tuple so
    // that adding more diagnostic fields later doesn't churn this case.
    const idents = entries.map((e) => ({ type: e.type, version: e.version }));
    expect(idents).toEqual(
      expect.arrayContaining([
        { type: "a", version: "1.0.0" },
        { type: "a", version: "1.1.0" },
        { type: "b", version: "1.0.0" },
      ]),
    );
    // Sanity-check the new diagnostic fields are populated.
    for (const e of entries) {
      expect(e.tier).toBe("inProcess");
      expect(e.inflight).toBe(0);
    }
  });

  it("get() of an unknown type throws execution_engine.no_runner", () => {
    const r = new InMemoryNodeRunnerRegistry();
    try {
      r.get("missing", "1.0.0");
      throw new Error("expected no_runner");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "execution_engine.no_runner",
      );
    }
  });
});

describe("InMemoryNodeRunnerRegistry · drainAndUnregister (Phase 3 T2)", () => {
  it("removes the entry once in-flight calls drain", async () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("foo", "1.0.0", noopRunner);
    await r.drainAndUnregister("foo", "1.0.0");
    expect(r.has("foo", "1.0.0")).toBe(false);
  });

  it("blocks until inflight reaches zero (T2 drain semantics)", async () => {
    const r = new InMemoryNodeRunnerRegistry();
    let release: (() => void) | undefined;
    const slow: NodeRunner = () =>
      new Promise((resolve) => {
        release = () => resolve({ kind: "success", outputs: {} });
      });
    r.register("slow", "1.0.0", slow);
    const sandbox = r.getSandbox("slow", "1.0.0");
    // Start an in-flight execution.
    const exec = sandbox.execute(
      {},
      {
        runId: "r",
        nodeId: "n",
        nodeType: "slow",
        nodeVersion: "1.0.0",
        attempt: 1,
        signal: new AbortController().signal,
      },
    );
    expect(sandbox.inflight()).toBe(1);

    let drained = false;
    const drain = r.drainAndUnregister("slow", "1.0.0").then(() => {
      drained = true;
    });

    // Even though the entry has been removed from dispatch, drain must
    // still wait for the running call.
    await new Promise((res) => setTimeout(res, 5));
    expect(drained).toBe(false);
    // And during that window, has() reports false (no NEW work admitted).
    expect(r.has("slow", "1.0.0")).toBe(false);

    release?.();
    await exec;
    await drain;
    expect(drained).toBe(true);
  });

  it("rolls back the entry when drain() times out, surfacing drain_timeout", async () => {
    const r = new InMemoryNodeRunnerRegistry();
    const stuck: NodeRunner = () =>
      new Promise(() => {
        /* never resolves */
      });
    r.register("stuck", "1.0.0", stuck);
    const sandbox = r.getSandbox("stuck", "1.0.0");
    void sandbox.execute(
      {},
      {
        runId: "r",
        nodeId: "n",
        nodeType: "stuck",
        nodeVersion: "1.0.0",
        attempt: 1,
        signal: new AbortController().signal,
      },
    );

    try {
      await r.drainAndUnregister("stuck", "1.0.0", { timeoutMs: 20 });
      throw new Error("drainAndUnregister should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "runner_registry.drain_timeout",
      );
    }
    // Atomicity: a failed drain must not leave the registry in a half-
    // unregistered state. The caller should observe the entry as still
    // present and dispatchable.
    expect(r.has("stuck", "1.0.0")).toBe(true);
  });

  it("preserves remaining versions after T2: drain v1 while v2 stays serving", async () => {
    const r = new InMemoryNodeRunnerRegistry();
    r.register("multi", "1.0.0", noopRunner);
    r.register("multi", "2.0.0", altRunner);
    await r.drainAndUnregister("multi", "1.0.0");
    expect(r.has("multi", "1.0.0")).toBe(false);
    expect(r.has("multi", "2.0.0")).toBe(true);
    // v2 stays the latest because it was registered last AND v1 is gone.
    expect(r.get("multi", "anything")).toBe(altRunner);
  });

  it("drainAndUnregister() of a missing pair throws not_found", async () => {
    const r = new InMemoryNodeRunnerRegistry();
    try {
      await r.drainAndUnregister("ghost", "1.0.0");
      throw new Error("expected not_found");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "runner_registry.not_found",
      );
    }
  });
});
