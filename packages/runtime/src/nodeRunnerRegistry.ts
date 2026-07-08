/**
 * Mapping from `(type, typeVersion)` to the concrete `NodeRunner` that
 * executes it. The registry is decoupled from the IR `NodeTypeRegistry`
 * (which only stores port shapes / config schema) so the same flow can
 * be executed by different runtimes (Phase 1 single-process runtime,
 * Phase 4 distributed runtime, simulators, replays).
 *
 * Phase 3 additions (see docs/specs/sandbox.md §5):
 *
 *   - Every registered runner is wrapped by a `SandboxAdapter` (default
 *     `InProcessSandboxAdapter`), so dispatch goes through a uniform
 *     `SandboxedRunner.execute()` regardless of which adapter is in
 *     use. The interface is kept stable so stricter tiers can be
 *     slotted in later without touching this file.
 *   - `register()` rejects a duplicate `(type, version)` pair with
 *     `runner_registry.version_conflict`. Hot-swapping a runner therefore
 *     follows the explicit `T2` protocol: register the *new* version
 *     alongside the old one, promote the Flow Version, drain the old
 *     version, then `drainAndUnregister()` it.
 *   - `unregister()` removes a `(type, version)` pair from dispatch but
 *     does NOT drain in-flight calls — callers should prefer
 *     `drainAndUnregister()` for the standard T2 flow. Calling
 *     `unregister()` for a non-existent pair throws
 *     `runner_registry.not_found`.
 *   - `drainAndUnregister()` is the spec'd hot-swap exit: it stops
 *     dispatching new work to that version (sets the sandbox to
 *     "draining"), waits up to `timeoutMs` for in-flight calls to
 *     finish, disposes the sandbox, and finally removes the entry. If
 *     `drain()` times out the entry is restored to the registry and the
 *     `runner_registry.drain_timeout` error propagates so the caller
 *     can fall back / retry / promote a different Flow Version.
 *   - `list()` returns the full set of registered runners — used by the
 *     drain protocol and by Studio diagnostics.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
} from "@ai-native-flow/flow-ir";
import {
  InProcessSandboxAdapter,
  type SandboxAdapter,
  type SandboxedRunner,
  type SandboxedNodeRunner,
} from "@ai-native-flow/sandbox";
import type { NodeRunner } from "./nodeContext.js";

interface Entry {
  type: string;
  version: string;
  /**
   * Direct handle to the (post-Zod) NodeRunner. Phase 1/2 callers used
   * this as the dispatch path; Phase 3 routes through `sandbox` instead
   * but keeps the field around so Studio / debugger inspectors can
   * reach the underlying function.
   */
  runner: NodeRunner;
  /** Sandboxed handle that the ExecutionEngine actually drives. */
  sandbox: SandboxedRunner;
  /** Monotonically increasing token used to recompute `latest` after `unregister`. */
  registrationSeq: number;
}

export interface NodeRunnerEntry {
  readonly type: string;
  readonly version: string;
  readonly tier: SandboxedRunner["tier"];
  readonly inflight: number;
}

export interface DrainAndUnregisterOptions {
  /**
   * Maximum time (ms) to wait for in-flight executions of this version
   * to finish before failing the drain. When the timeout elapses, the
   * entry is restored to the registry and a `runner_registry.drain_timeout`
   * RuntimeErrorException is re-thrown.
   */
  timeoutMs?: number;
}

export interface NodeRunnerRegistry {
  register(type: string, version: string, runner: NodeRunner): void;
  unregister(type: string, version: string): void;
  drainAndUnregister(
    type: string,
    version: string,
    options?: DrainAndUnregisterOptions,
  ): Promise<void>;
  /**
   * Resolve the `SandboxedRunner` for a given `(type, version)`. This is
   * the dispatch entry-point used by the ExecutionEngine: passing
   * `version` that is not registered falls back to the latest known
   * version of that type, mirroring Phase 1 semantics.
   */
  getSandbox(type: string, version: string): SandboxedRunner;
  /**
   * Resolve the raw NodeRunner. Kept for diagnostic / replay tooling
   * that doesn't want to go through the sandbox.
   */
  get(type: string, version: string): NodeRunner;
  has(type: string, version?: string): boolean;
  list(): readonly NodeRunnerEntry[];
}

export interface InMemoryNodeRunnerRegistryOptions {
  /**
   * Sandbox adapter used to wrap freshly-registered runners. Defaults to
   * `InProcessSandboxAdapter`. The interface stays open for callers that
   * want a custom adapter.
   */
  sandboxAdapter?: SandboxAdapter;
}

export class InMemoryNodeRunnerRegistry implements NodeRunnerRegistry {
  /** Map<type, Map<version, entry>> */
  private readonly entries = new Map<string, Map<string, Entry>>();
  /** Latest version per type, picked by largest `registrationSeq`. */
  private readonly latest = new Map<string, string>();
  /** Monotonic counter for `registrationSeq`. */
  private nextSeq = 1;
  private readonly sandboxAdapter: SandboxAdapter;

  constructor(options: InMemoryNodeRunnerRegistryOptions = {}) {
    this.sandboxAdapter = options.sandboxAdapter ?? new InProcessSandboxAdapter();
  }

  register(type: string, version: string, runner: NodeRunner): void {
    let perType = this.entries.get(type);
    if (!perType) {
      perType = new Map();
      this.entries.set(type, perType);
    }
    if (perType.has(version)) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "runner_registry.version_conflict",
          kind: "validation",
          category: "user_input",
          message: `node runner already registered for ${type}@${version}`,
          source: { module: "registry" },
          context: { type, typeVersion: version },
        }),
      );
    }
    // The runtime's `NodeRunner` and the sandbox's `SandboxedNodeRunner`
    // are structurally compatible: the sandbox types intentionally
    // model the *minimum* surface a NodeRunner must expose (id+signal
    // for ctx; success/error/skip for the result). Casting here keeps
    // the cast in one place rather than every call-site.
    const sandboxedRunner = runner as unknown as SandboxedNodeRunner;
    if (typeof this.sandboxAdapter.loadSync !== "function") {
      // Adapters that need an async handshake during `load()` (e.g. an
      // out-of-process tier added later) MUST omit `loadSync`; the
      // synchronous `register()` path then surfaces a structured error
      // directing the caller to the async registration path.
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "runner_registry.async_adapter_unsupported",
          kind: "validation",
          category: "system",
          message: `SandboxAdapter (tier=${this.sandboxAdapter.tier}) does not support synchronous register(); use registerAsync()`,
          source: { module: "registry" },
          context: { type, typeVersion: version, tier: this.sandboxAdapter.tier },
        }),
      );
    }
    const sandbox = this.sandboxAdapter.loadSync(sandboxedRunner, {
      type,
      typeVersion: version,
    });
    const seq = this.nextSeq++;
    perType.set(version, {
      type,
      version,
      runner,
      sandbox,
      registrationSeq: seq,
    });
    this.latest.set(type, version);
  }

  unregister(type: string, version: string): void {
    const perType = this.entries.get(type);
    if (!perType || !perType.has(version)) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "runner_registry.not_found",
          kind: "not_found",
          category: "system",
          message: `no node runner registered for ${type}@${version}`,
          source: { module: "registry" },
          context: { type, typeVersion: version },
        }),
      );
    }
    perType.delete(version);
    if (perType.size === 0) {
      this.entries.delete(type);
      this.latest.delete(type);
      return;
    }
    if (this.latest.get(type) === version) {
      // Recompute `latest` as the entry with the largest `registrationSeq`.
      let bestVersion: string | undefined;
      let bestSeq = -1;
      for (const e of perType.values()) {
        if (e.registrationSeq > bestSeq) {
          bestSeq = e.registrationSeq;
          bestVersion = e.version;
        }
      }
      if (bestVersion !== undefined) this.latest.set(type, bestVersion);
    }
  }

  async drainAndUnregister(
    type: string,
    version: string,
    options: DrainAndUnregisterOptions = {},
  ): Promise<void> {
    const perType = this.entries.get(type);
    const entry = perType?.get(version);
    if (!perType || !entry) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "runner_registry.not_found",
          kind: "not_found",
          category: "system",
          message: `no node runner registered for ${type}@${version}`,
          source: { module: "registry" },
          context: { type, typeVersion: version },
        }),
      );
    }
    // Eagerly remove the entry from dispatch so no NEW execute() call
    // can land on this sandbox while we're draining. We re-insert on
    // failure to preserve the "atomic" contract.
    perType.delete(version);
    const wasLatest = this.latest.get(type) === version;
    if (perType.size === 0) {
      this.entries.delete(type);
      this.latest.delete(type);
    } else if (wasLatest) {
      let bestVersion: string | undefined;
      let bestSeq = -1;
      for (const e of perType.values()) {
        if (e.registrationSeq > bestSeq) {
          bestSeq = e.registrationSeq;
          bestVersion = e.version;
        }
      }
      if (bestVersion !== undefined) this.latest.set(type, bestVersion);
    }

    try {
      await entry.sandbox.drain(options.timeoutMs);
      await entry.sandbox.dispose();
    } catch (err) {
      // Drain timed out (or dispose failed): roll back so the caller can
      // observe the unchanged registry and decide whether to retry, kill
      // harder, or fall back to a different Flow Version.
      let restored = this.entries.get(type);
      if (!restored) {
        restored = new Map();
        this.entries.set(type, restored);
      }
      restored.set(version, entry);
      // Re-establish `latest` if we were the previous latest.
      if (wasLatest) this.latest.set(type, version);
      throw err;
    }
  }

  getSandbox(type: string, version: string): SandboxedRunner {
    const entry = this.lookupEntry(type, version);
    return entry.sandbox;
  }

  get(type: string, version: string): NodeRunner {
    const entry = this.lookupEntry(type, version);
    return entry.runner;
  }

  has(type: string, version?: string): boolean {
    const perType = this.entries.get(type);
    if (!perType) return false;
    if (!version) return perType.size > 0;
    return perType.has(version);
  }

  list(): readonly NodeRunnerEntry[] {
    const out: NodeRunnerEntry[] = [];
    for (const perType of this.entries.values()) {
      for (const e of perType.values()) {
        out.push({
          type: e.type,
          version: e.version,
          tier: e.sandbox.tier,
          inflight: e.sandbox.inflight(),
        });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* internal                                                            */
  /* ------------------------------------------------------------------ */

  private lookupEntry(type: string, version: string): Entry {
    const perType = this.entries.get(type);
    const entry =
      perType?.get(version) ?? perType?.get(this.latest.get(type) ?? "");
    if (!entry) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "execution_engine.no_runner",
          kind: "not_found",
          category: "system",
          message: `no NodeRunner registered for ${type}@${version}`,
          source: { module: "execution_engine" },
          context: { type, typeVersion: version },
        }),
      );
    }
    return entry;
  }
}
