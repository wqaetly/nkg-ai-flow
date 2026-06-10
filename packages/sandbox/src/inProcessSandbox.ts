/**
 * In-process Sandbox Adapter (Phase 3 MVP).
 *
 * Spec: docs/specs/sandbox.md §2 / §3 / §7.
 *
 * The in-process adapter is the trust boundary used by built-in nodes and
 * first-party plugins. It does NOT provide isolation — it relies on the
 * cooperative `AbortSignal` cancellation contract — but it implements the
 * `SandboxedRunner` surface (`inflight()`, `drain()` and `dispose()`). That
 * gives the runtime a uniform `T0 + T1 + T2` hot-swap protocol while keeping
 * the trusted-code path simple.
 *
 * Permission enforcement at this tier is best-effort: a manifest that
 * declares e.g. `permissions.net` is accepted as-is (we cannot block
 * `fetch()` from inside the same isolate), but unsatisfiable shapes — for
 * instance `permissions.spawn === false` paired with a runner that the
 * adapter knows spawns — would be rejected here in later phases. For Phase
 * 3 MVP the adapter is permissive and only validates the structural
 * presence of the runner.
 */

import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import {
  inProcessRunnerMissing,
  sandboxDisposedError,
  sandboxDrainingError,
  drainTimeout,
} from "./errors.js";
import type {
  SandboxAdapter,
  SandboxLoadOptions,
  SandboxNodeContext,
  SandboxNodeInputs,
  SandboxNodeResult,
  SandboxedNodeRunner,
  SandboxedRunner,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class InProcessSandboxAdapter implements SandboxAdapter {
  readonly tier = "inProcess" as const;

  async load(
    runner: SandboxedNodeRunner | undefined,
    options: SandboxLoadOptions,
  ): Promise<SandboxedRunner> {
    return this.loadSync(runner, options);
  }

  loadSync(
    runner: SandboxedNodeRunner | undefined,
    options: SandboxLoadOptions,
  ): SandboxedRunner {
    if (!runner) {
      throw new RuntimeErrorException(
        inProcessRunnerMissing({
          type: options.type,
          typeVersion: options.typeVersion,
        }),
      );
    }
    return new InProcessSandboxedRunner(runner, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Runner handle                                                               */
/* -------------------------------------------------------------------------- */

type Phase = "running" | "draining" | "disposed";

class InProcessSandboxedRunner implements SandboxedRunner {
  readonly tier = "inProcess" as const;
  readonly type: string;
  readonly typeVersion: string;

  private readonly runner: SandboxedNodeRunner;
  private readonly permissions: SandboxLoadOptions["permissions"];

  private phase: Phase = "running";
  /** Number of `execute()` calls that have not yet resolved. */
  private inflightCount = 0;
  /** Resolvers waiting for `inflightCount === 0`. */
  private readonly idleWaiters: Array<() => void> = [];

  constructor(runner: SandboxedNodeRunner, options: SandboxLoadOptions) {
    this.runner = runner;
    this.type = options.type;
    this.typeVersion = options.typeVersion;
    this.permissions = options.permissions;
  }

  inflight(): number {
    return this.inflightCount;
  }

  async execute(
    input: SandboxNodeInputs,
    ctx: SandboxNodeContext,
  ): Promise<SandboxNodeResult> {
    if (this.phase === "disposed") {
      throw new RuntimeErrorException(
        sandboxDisposedError({ type: this.type, typeVersion: this.typeVersion }),
      );
    }
    if (this.phase === "draining") {
      throw new RuntimeErrorException(
        sandboxDrainingError({ type: this.type, typeVersion: this.typeVersion }),
      );
    }

    this.inflightCount += 1;
    try {
      // Note: we deliberately do NOT short-circuit on `ctx.signal.aborted`.
      // Cancellation is the runner's contract — it observes the signal and
      // returns / throws as it sees fit; the engine then maps the outcome
      // to NodeResult. The sandbox stays out of business semantics so the
      // same handle behaves identically across the sandbox seam.
      // Optional wall-clock cap. Co-operates with `ctx.signal`: we never
      // overwrite the caller's signal, we race a separate timeout promise.
      const timeoutMs = this.permissions?.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        return await this.runWithTimeout(input, ctx, timeoutMs);
      }
      return await this.runner(input, ctx);
    } finally {
      this.inflightCount -= 1;
      if (this.inflightCount === 0 && this.idleWaiters.length > 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const w of waiters) w();
      }
    }
  }

  /**
   * Resolve when `inflightCount === 0`. If `timeoutMs` is provided and the
   * runner did not become idle in time, reject with `runner_registry.drain_timeout`.
   *
   * After `drain()` returns successfully the runner is in `draining` phase
   * and `execute()` calls are rejected; the caller is expected to follow up
   * with `dispose()`.
   */
  async drain(timeoutMs?: number): Promise<void> {
    if (this.phase === "disposed") return;
    if (this.phase === "running") this.phase = "draining";

    if (this.inflightCount === 0) return;

    const idle = new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });

    if (timeoutMs === undefined) {
      await idle;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const winner = await Promise.race([idle.then(() => "idle" as const), timeout]);
      if (winner === "timeout") {
        throw new RuntimeErrorException(
          drainTimeout(
            { type: this.type, typeVersion: this.typeVersion },
            timeoutMs,
            this.inflightCount,
          ),
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    // Idempotent: `dispose()` may be called from defensive teardown paths.
    this.phase = "disposed";
    // Wake up any pending drain waiters so they observe the disposed state
    // (their callers will surface a separate error if they were racing).
    const waiters = this.idleWaiters.splice(0);
    for (const w of waiters) w();
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  private async runWithTimeout(
    input: SandboxNodeInputs,
    ctx: SandboxNodeContext,
    timeoutMs: number,
  ): Promise<SandboxNodeResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const winner = await Promise.race([
        Promise.resolve(this.runner(input, ctx)).then((r) => ({
          kind: "result" as const,
          value: r,
        })),
        timeout,
      ]);
      if (winner === "timeout") {
        // The runner is still alive in-process; we cannot kill it from
        // inside the same isolate. We return a structured skip and rely on
        // the runner observing `ctx.signal` for graceful exit.
        return { kind: "skip", reason: `inProcess timeout after ${timeoutMs}ms` };
      }
      return winner.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
