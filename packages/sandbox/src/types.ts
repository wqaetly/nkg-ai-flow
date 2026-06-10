/**
 * Public types for the Sandbox abstraction.
 *
 * Spec: docs/specs/sandbox.md §3.
 *
 * The runtime depends on this package only through these interfaces, so the
 * execution seam can stay stable while the implementation remains the simple
 * in-process adapter used by trusted team-owned nodes.
 *
 * NOTE: this package intentionally does NOT import from `@ai-native-flow/runtime`.
 * Doing so would create a cycle (runtime depends on sandbox, not the other way
 * around). The runner-facing types `NodeInputs` / `NodeContext` / `NodeResult`
 * are therefore re-declared here as *structurally compatible* shapes; the
 * runtime composes its own `NodeRunner` signature from these and its richer
 * `NodeContext`. See `docs/specs/sandbox.md §3` for the contract.
 */

/* -------------------------------------------------------------------------- */
/* Tier                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Tier identifier exposed for telemetry and future extension. Today the
 * runtime only ships `"inProcess"`; the `string & {}` opening is kept so
 * downstream packages can register custom labels for decorator adapters
 * without us having to widen the union.
 *
 * Strong isolation tiers are deliberately out of scope — see the project
 * Decision Log entry "Sandbox scope: in-process only".
 */
export type SandboxTier = "inProcess" | (string & {});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Static permissions a sandboxed runner is allowed to use. The validator
 * checks this against the Node Type Manifest BEFORE the adapter loads the
 * runner; the adapter additionally enforces it at runtime where possible.
 */
export interface SandboxPermissions {
  /** Filesystem access. Paths are absolute or repo-relative. */
  readonly fs?: {
    readonly read?: ReadonlyArray<string>;
    readonly write?: ReadonlyArray<string>;
  };
  /** Network access. Hosts are matched literally; wildcards are TBD. */
  readonly net?: {
    readonly allowHosts?: ReadonlyArray<string>;
    readonly denyHosts?: ReadonlyArray<string>;
  };
  /** Environment variable access (allow-list of names). */
  readonly env?: {
    readonly allowNames?: ReadonlyArray<string>;
  };
  /** Whether the runner may spawn child processes. Default false. */
  readonly spawn?: boolean;
  /** Hard wall-clock cap. */
  readonly timeoutMs?: number;
  /** Cap on total event payload size emitted by the runner. */
  readonly maxOutputBytes?: number;
  /** Approximate memory cap (only enforced by some adapters). */
  readonly maxMemoryMB?: number;
}

/* -------------------------------------------------------------------------- */
/* Runner-facing types (structural compatibility with @ai-native-flow/runtime) */
/* -------------------------------------------------------------------------- */

/**
 * Input payload keyed by input port id. Mirrors `runtime/src/nodeContext.ts`
 * `NodeInputs`.
 */
export type SandboxNodeInputs = Record<string, unknown>;

/**
 * Output payload keyed by output port id. Mirrors `runtime/src/nodeContext.ts`
 * `NodeOutputs`.
 */
export type SandboxNodeOutputs = Record<string, unknown>;

/**
 * Result of a single attempt. Mirrors `runtime/src/nodeContext.ts` `NodeResult`
 * but stays loose on the error / skip branches so this package does not need
 * to depend on `flow-ir`'s `RuntimeError` shape.
 *
 * The runtime's `NodeResult` is a strict subtype of this; structural
 * compatibility is verified by `packages/runtime/test/sandbox-types.test.ts`.
 */
export type SandboxNodeResult =
  | { kind: "success"; outputs: SandboxNodeOutputs }
  | { kind: "error"; error: unknown }
  | { kind: "skip"; reason: string };

/**
 * The minimum surface a runner needs from `NodeContext`. The runtime hands a
 * richer object (with `emit`, `stream`, `log`, `variables`, `secrets`,
 * `flowId`, ...) but this package only contractually requires the cancel
 * signal and addressing fields useful for telemetry.
 *
 * Adapters MUST NOT capture this object across `execute()` calls.
 */
export interface SandboxNodeContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly nodeVersion: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  // Allow adapters to forward additional, runtime-defined fields opaquely.
  readonly [key: string]: unknown;
}

/**
 * Function signature a node author writes (or that the compiler emits). The
 * runtime's `NodeRunner` is structurally compatible with this — it simply
 * takes a richer `NodeContext`.
 */
export type SandboxedNodeRunner = (
  input: SandboxNodeInputs,
  ctx: SandboxNodeContext,
) => Promise<SandboxNodeResult> | SandboxNodeResult;

/* -------------------------------------------------------------------------- */
/* Sandbox runner handle                                                       */
/* -------------------------------------------------------------------------- */

export interface SandboxLoadOptions {
  /** `(type, typeVersion)` — opaque to the adapter, used for telemetry. */
  readonly type: string;
  readonly typeVersion: string;
  /** Permissions derived from the Node Type Manifest. */
  readonly permissions?: SandboxPermissions;
  /**
   * Reserved for adapters that materialise a runner from a content-addressed
   * artifact reference (file path, content hash, OCI digest, ...) instead
   * of capturing a closure. The in-process adapter ignores this field.
   */
  readonly artifactRef?: string;
}

/**
 * A live sandboxed runner. The runtime invokes `.execute()` per attempt and
 * MUST call `.dispose()` exactly once when the runner version is fully
 * drained (after `unregister` + `drain`).
 */
export interface SandboxedRunner {
  readonly tier: SandboxTier;
  readonly type: string;
  readonly typeVersion: string;

  /** Execute one attempt. Honours `ctx.signal` for cancellation. */
  execute(
    input: SandboxNodeInputs,
    ctx: SandboxNodeContext,
  ): Promise<SandboxNodeResult>;

  /** Number of in-flight `execute()` calls. Used by the drain protocol. */
  inflight(): number;

  /**
   * Mark the runner as draining: no new `execute()` calls will be accepted.
   * Resolves when `inflight() === 0`. If `timeoutMs` is given and not all
   * calls finished by then, rejects with `runner_registry.drain_timeout`.
   */
  drain(timeoutMs?: number): Promise<void>;

  /** Tear down resources held by the runner handle. */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Adapter for the sandbox execution seam. Today only
 * `InProcessSandboxAdapter` is shipped; stricter isolation adapters are
 * intentionally out of scope until the product accepts untrusted
 * third-party node code.
 */
export interface SandboxAdapter {
  readonly tier: SandboxTier;

  /**
   * Wrap an in-process `runner`. The adapter MUST validate that
   * requested `permissions` are satisfiable; missing capabilities
   * surface as `sandbox.permission_unsatisfiable`.
   */
  load(
    runner: SandboxedNodeRunner | undefined,
    options: SandboxLoadOptions,
  ): Promise<SandboxedRunner>;

  /**
   * Optional synchronous load entry-point. Adapters whose `load()`
   * resolves on the same microtask (the in-process adapter is the
   * obvious case) implement this so the registry's synchronous
   * `register()` path stays available. Adapters that need an async
   * handshake omit it; the registry then surfaces a structured
   * `runner_registry.async_adapter_unsupported` error directing the
   * caller to the async registration path.
   */
  loadSync?(
    runner: SandboxedNodeRunner | undefined,
    options: SandboxLoadOptions,
  ): SandboxedRunner;
}
