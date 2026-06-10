/**
 * InProcessSandboxAdapter unit tests.
 *
 * Covers the contract pieces needed by Phase 3 hot-swap (T2):
 *   - execute happy path
 *   - inflight() accounting
 *   - drain() resolves once inflight reaches 0
 *   - drain() with timeout rejects with `runner_registry.drain_timeout`
 *   - draining/disposed phases reject new execute() calls
 *   - dispose() is idempotent and wakes pending drain waiters
 *   - load() refuses missing runner
 */

import { describe, expect, it } from "vitest";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import {
  InProcessSandboxAdapter,
  RUNNER_REGISTRY_ERROR_CODES,
  SANDBOX_ERROR_CODES,
  type SandboxNodeContext,
  type SandboxedNodeRunner,
} from "../src/index.js";

function makeCtx(overrides: Partial<SandboxNodeContext> = {}): SandboxNodeContext {
  const controller = new AbortController();
  return {
    runId: "run-1",
    nodeId: "node-1",
    nodeType: "noop",
    nodeVersion: "1.0.0",
    attempt: 1,
    signal: controller.signal,
    ...overrides,
  };
}

describe("InProcessSandboxAdapter", () => {
  it("load() rejects missing runner", async () => {
    const adapter = new InProcessSandboxAdapter();
    await expect(adapter.load(undefined, { type: "noop", typeVersion: "1.0.0" }))
      .rejects.toBeInstanceOf(RuntimeErrorException);
  });

  it("execute() returns the runner result and updates inflight()", async () => {
    const adapter = new InProcessSandboxAdapter();
    const runner: SandboxedNodeRunner = async () => ({
      kind: "success",
      outputs: { ok: true },
    });
    const handle = await adapter.load(runner, { type: "noop", typeVersion: "1.0.0" });
    expect(handle.inflight()).toBe(0);

    const result = await handle.execute({}, makeCtx());
    expect(result).toEqual({ kind: "success", outputs: { ok: true } });
    expect(handle.inflight()).toBe(0);
  });

  it("drain() resolves once all in-flight calls finish", async () => {
    const adapter = new InProcessSandboxAdapter();
    let releaseRunner: (() => void) | undefined;
    const runner: SandboxedNodeRunner = () =>
      new Promise((resolve) => {
        releaseRunner = () =>
          resolve({ kind: "success", outputs: { ok: true } });
      });
    const handle = await adapter.load(runner, { type: "slow", typeVersion: "1.0.0" });

    const exec = handle.execute({}, makeCtx());
    expect(handle.inflight()).toBe(1);

    const drain = handle.drain();
    // drain must NOT resolve while inflight > 0
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(drained).toBe(false);

    releaseRunner?.();
    await exec;
    await drain;
    expect(handle.inflight()).toBe(0);
  });

  it("drain(timeoutMs) rejects with runner_registry.drain_timeout when work outlives the cap", async () => {
    const adapter = new InProcessSandboxAdapter();
    const runner: SandboxedNodeRunner = () =>
      new Promise(() => {
        /* never resolves */
      });
    const handle = await adapter.load(runner, { type: "stuck", typeVersion: "1.0.0" });
    void handle.execute({}, makeCtx());

    try {
      await handle.drain(20);
      throw new Error("drain should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        RUNNER_REGISTRY_ERROR_CODES.drainTimeout,
      );
    }
  });

  it("execute() after drain() rejects with sandbox.draining", async () => {
    const adapter = new InProcessSandboxAdapter();
    const runner: SandboxedNodeRunner = async () => ({
      kind: "success",
      outputs: {},
    });
    const handle = await adapter.load(runner, { type: "noop", typeVersion: "1.0.0" });
    await handle.drain();

    try {
      await handle.execute({}, makeCtx());
      throw new Error("execute should be rejected after drain");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        SANDBOX_ERROR_CODES.draining,
      );
    }
  });

  it("execute() after dispose() rejects with sandbox.disposed", async () => {
    const adapter = new InProcessSandboxAdapter();
    const runner: SandboxedNodeRunner = async () => ({
      kind: "success",
      outputs: {},
    });
    const handle = await adapter.load(runner, { type: "noop", typeVersion: "1.0.0" });
    await handle.dispose();

    try {
      await handle.execute({}, makeCtx());
      throw new Error("execute should be rejected after dispose");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        SANDBOX_ERROR_CODES.disposed,
      );
    }
  });

  it("dispose() is idempotent and safe to call multiple times", async () => {
    const adapter = new InProcessSandboxAdapter();
    const runner: SandboxedNodeRunner = async () => ({
      kind: "success",
      outputs: {},
    });
    const handle = await adapter.load(runner, { type: "noop", typeVersion: "1.0.0" });
    await handle.dispose();
    await handle.dispose();
    expect(handle.inflight()).toBe(0);
  });

  it("does NOT short-circuit on ctx.signal.aborted; the runner decides", async () => {
    const adapter = new InProcessSandboxAdapter();
    let invocations = 0;
    const runner: SandboxedNodeRunner = async (_input, ctx) => {
      invocations += 1;
      // Cooperative: a well-behaved runner observes the signal itself and
      // surfaces a structured skip. The sandbox MUST forward this through
      // unchanged so the engine sees the runner's intent.
      if (ctx.signal.aborted) return { kind: "skip", reason: "cancelled" };
      return { kind: "success", outputs: {} };
    };
    const handle = await adapter.load(runner, { type: "noop", typeVersion: "1.0.0" });

    const controller = new AbortController();
    controller.abort();
    const result = await handle.execute({}, makeCtx({ signal: controller.signal }));
    expect(result).toEqual({ kind: "skip", reason: "cancelled" });
    // The sandbox MUST invoke the runner exactly once; it does not pre-empt
    // on the caller's behalf.
    expect(invocations).toBe(1);
  });

  it("permissions.timeoutMs returns a skip when the runner exceeds the wall clock", async () => {
    const adapter = new InProcessSandboxAdapter();
    const runner: SandboxedNodeRunner = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ kind: "success", outputs: {} }), 50);
      });
    const handle = await adapter.load(runner, {
      type: "slow",
      typeVersion: "1.0.0",
      permissions: { timeoutMs: 5 },
    });
    const result = await handle.execute({}, makeCtx());
    expect(result.kind).toBe("skip");
  });
});
