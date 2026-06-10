# Sandbox

> Companion to [Node System](./node-system.md), [Runtime Execution](./runtime-execution.md),
> [Security](./security.md), and the hot-swap rationale in
> [decisions/runtime-hot-swap.md](../decisions/runtime-hot-swap.md).
>
> Implementation lives in [`packages/sandbox`](../../packages/sandbox). The runtime depends
> on `sandbox` abstractions only — never on a concrete implementation — so a
> `SandboxAdapter` decorator (timeout, metrics, custom telemetry) can be slotted in without
> touching node logic, the scheduler, or the event channel.

## 1. Scope

Today's runtime is a **trusted, single-tenant** environment: nodes are written by the
project team or by first-party plugin authors, and "every author owns their own code". The
sandbox layer therefore plays a much smaller role than the name suggests:

- It is a **uniform execution seam** so node logic can be hot-swapped, drained, and
  disposed regardless of who wrote it.
- It enforces a **wall-clock cap** (`permissions.timeoutMs`) cooperatively — runners are
  expected to honour `ctx.signal`.
- It is **not** an isolation boundary against malicious code. Multi-tier isolation
  (Worker / Process / Container) is deliberately out of scope; see
  [Sandbox Scope: In-process Only](../decisions/sandbox-scope-in-process-only.md)
  for the rationale.

If the project ever opens the runtime to untrusted code (a public node marketplace, a
SaaS where users upload nodes), the `SandboxAdapter` interface is the seam through which
a stricter tier would be added. Until that happens we keep the implementation small and
the ambient surface predictable.

Non-goals:

- AI-generated-code containment, OS-level sandboxing (seccomp / gVisor / Firecracker),
  cross-process IPC framing, capability-based secret proxies. None of these ship today.

## 2. `SandboxAdapter` contract

```ts
// packages/sandbox/src/types.ts

/**
 * Tier identifier exposed for telemetry. Today only "inProcess" ships;
 * the `string & {}` opening is kept so a custom adapter (e.g. a
 * "metrics" decorator wrapping the in-process adapter) can register
 * its own tag without widening the union. Custom tags are telemetry labels,
 * not a promise that this package ships multiple isolation tiers.
 */
export type SandboxTier = "inProcess" | (string & {});

/** Static permissions a sandboxed runner declares. */
export interface SandboxPermissions {
  fs?:      { read?: string[]; write?: string[] };
  net?:     { allowHosts?: string[]; denyHosts?: string[] };
  env?:     { allowNames?: string[] };
  spawn?:   boolean;
  timeoutMs?: number;          // hard wall-clock cap (cooperative)
  maxOutputBytes?: number;
  maxMemoryMB?: number;
}

export interface SandboxLoadOptions {
  type: string;
  typeVersion: string;
  permissions?: SandboxPermissions;
  /** Reserved for adapters that materialise a runner from a content hash. */
  artifactRef?: string;
}

/** A live sandboxed runner. */
export interface SandboxedRunner {
  readonly tier: SandboxTier;
  readonly type: string;
  readonly typeVersion: string;

  execute(input: NodeInputs, ctx: NodeContext): Promise<NodeResult>;
  inflight(): number;
  drain(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxAdapter {
  readonly tier: SandboxTier;

  load(
    runner: SandboxedNodeRunner | undefined,
    options: SandboxLoadOptions,
  ): Promise<SandboxedRunner>;

  /**
   * Optional synchronous load entry-point. The in-process adapter
   * implements it so `NodeRunnerRegistry.register()` stays sync;
   * adapters that need an async handshake omit it and use the async
   * registration path.
   */
  loadSync?(
    runner: SandboxedNodeRunner | undefined,
    options: SandboxLoadOptions,
  ): SandboxedRunner;
}
```

Key invariants:

- A `SandboxedRunner` MUST NOT capture `NodeContext` instances across `execute()` calls.
  The runtime hands a fresh context every attempt; capturing one leaks `runId` / `attempt` /
  `signal` linkage and is a bug.
- Cancellation MUST flow through `ctx.signal`. The adapter does not enforce cancellation —
  it stays out of business semantics so the same handle behaves identically across any
  decorator stack.
- `dispose()` MUST be idempotent. The runtime calls it once, but defensive teardown paths
  may call again.

## 3. The in-process adapter

`InProcessSandboxAdapter` is the only tier shipped today. It does not provide isolation —
it relies on the cooperative `AbortSignal` cancellation contract — but it implements the
full `SandboxedRunner` surface (`inflight()`, `drain()`, `dispose()`) so the runtime gets
a uniform hot-swap protocol regardless of which adapter is wired in.

Behaviour:

- `load()` / `loadSync()` wrap a `SandboxedNodeRunner` and return a handle with an
  `inflight` counter. Missing runner → `sandbox.in_process_runner_missing`.
- `execute()` increments `inflightCount`, awaits the runner (optionally racing
  `permissions.timeoutMs`), decrements on resolve / reject, and wakes any pending
  `drain()` waiters when the counter hits zero.
- A runner that exceeds `timeoutMs` returns `{ kind: "skip", reason: "inProcess timeout
  after Xms" }`. Because we cannot kill a same-isolate runner, the timeout is a
  best-effort signal — co-operating runners observe `ctx.signal` and exit promptly.
- `drain(timeoutMs?)` flips the phase to `"draining"` (rejecting new `execute()` calls
  with `sandbox.draining`), then resolves once `inflight() === 0` or rejects with
  `runner_registry.drain_timeout`.
- `dispose()` flips the phase to `"disposed"` (rejecting new `execute()` calls with
  `sandbox.disposed`) and is idempotent.

Permission enforcement at this tier is best-effort: the manifest is accepted as-is (we
cannot intercept `fetch()` from inside the same isolate). Structural validation
(`permissions.spawn === false` paired with a runner the adapter knows spawns) would be
added here if and when the project chooses to ship a stricter tier.

Implementation:
[`packages/sandbox/src/inProcessSandbox.ts`](../../packages/sandbox/src/inProcessSandbox.ts);
end-to-end coverage in
[`packages/sandbox/test/inProcessSandbox.test.ts`](../../packages/sandbox/test/inProcessSandbox.test.ts).

## 4. Permission Manifest

`NodeTypeDefinition` MAY declare its sandbox needs:

```ts
interface NodeTypeDefinition {
  // ... existing fields ...
  sandbox?: {
    permissions?: SandboxPermissions;
  };
}
```

Validator rules:

- A node that uses `permissions.timeoutMs` is enforced cooperatively by the in-process
  adapter; everything else is structural metadata for now.
- The validator surfaces `sandbox.permission_unsatisfiable` if an adapter cannot honour a
  declaration.

## 5. Runtime integration

The wiring is intentionally trivial:

```ts
// packages/runtime/src/nodeRunnerRegistry.ts (excerpt)
const sandbox = this.sandboxAdapter.loadSync(runner, { type, typeVersion: version });
```

1. `NodeRunnerRegistry` accepts a `SandboxAdapter` (default `InProcessSandboxAdapter`).
2. `register(type, version, runner)` wraps the raw `NodeRunner` via `loadSync` and stores
   the resulting `SandboxedRunner`. Duplicate `(type, version)` pairs are rejected with
   `runner_registry.version_conflict` — the [hot-swap T2 protocol](
   ../decisions/runtime-hot-swap.md) requires the new version to be registered alongside
   the old one before draining.
3. `getSandbox(type, version)` is the dispatch entry-point used by the ExecutionEngine.
4. `unregister(type, version)` removes the entry from dispatch but does NOT drain
   in-flight calls; callers should prefer `drainAndUnregister()` for the standard T2 flow.
5. `drainAndUnregister(type, version, { timeoutMs? })` is the hot-swap exit:
   1. Atomically removes the entry from dispatch (no NEW `execute()` admitted).
   2. Awaits `SandboxedRunner.drain(timeoutMs)`. **In-flight `execute()` calls run to
      completion** — drain only blocks new admissions and waits for current ones.
   3. Calls `SandboxedRunner.dispose()`.
   4. Resolves on success, or **rolls back** the entry (re-inserting it in the registry)
      and re-throws `runner_registry.drain_timeout` / dispose errors so callers can retry,
      fall back to a different Flow Version, or escalate.

The execution engine itself is **unchanged**: it dispatches by `(node.type, node.typeVersion)`
and calls `SandboxedRunner.execute()`. Sandbox enforcement is a property of the runner
handle, not of the engine.

## 6. Execution flow

```text
┌────────────────────────┐    ┌──────────────────────────┐    ┌─────────────────────┐
│ ExecutionEngine        │───▶│ NodeRunnerRegistry       │───▶│ SandboxedRunner     │
│ dispatch(node@ver)     │    │ getSandbox(type, ver)    │    │ .execute(input,ctx) │
└────────────┬───────────┘    └──────────────────────────┘    └──────────┬──────────┘
             │                                                            │
             │  ctx (variables, secrets, signal, emit, stream)           │
             ▼                                                            ▼
      NodeEventChannel                                            in-process boundary
      (publishes ordered                                          (cooperative cancel +
       NodeEvent stream)                                           drain / dispose only)
```

## 7. Compiled artifacts

`@ai-native-flow/compiler` ([`packages/compiler`](../../packages/compiler)) turns a
`DefinedNode` into a content-addressed `NodeLogicArtifact` —
`compileDefinedNode(node)` produces `{ type, typeVersion, definition, runnerSrc, hash }`
where `hash = sha256Hex(canonicalJSON({type, typeVersion, definition, runnerSrc}))`.
`loadArtifactFromString(artifact)` rehydrates the runner via `new Function(...)` so it
can plug back into `SandboxAdapter.load()`.

This is independent from sandbox isolation — it is the **identity / replay / Studio diff**
substrate. Same input → same hash, byte-for-byte. Compiled runners must be
**self-contained**: no closure variables, no module imports inside the function body. The
SDK's `defineNode` currently produces closure-bound runners, so the compiler test fixture
uses a hand-written self-contained runner; turning vanilla `defineNode` output into a
self-contained source is a follow-up for the compiler.

## 8. Drain and rollback protocol

The recommended hot-swap sequence (T2):

```text
1. installNode(target, newRunnerV2)                     // adds 1.1.0 alongside 1.0.0
2. flowRegistry.promote(flowId, newFlowVersion)         // new Runs use 1.1.0
3. (optional) wait for drain window or explicit call:
     await runtime.runners.drainAndUnregister("extract-keywords", "1.0.0",
                                              { timeoutMs: 60_000 })
     // Step 3 is atomic: it removes the entry, drains, disposes; on timeout
     // it re-inserts the entry and re-throws runner_registry.drain_timeout.
```

Rollback simply re-promotes the previous Flow Version. The drain step is intentionally
atomic — if it fails, the registry is observably unchanged, so a rollback never races
with a half-drained version.

The end-to-end test for this sequence is
[`packages/runtime/test/runtime.hotswap.test.ts`](../../packages/runtime/test/runtime.hotswap.test.ts);
it demonstrates that `drainAndUnregister` blocks until in-flight runs complete, that an
in-flight Run still succeeds across the drain boundary, and that a fresh Flow pinned to
the surviving version routes to the right runner without a process restart.

## 9. Error model

Routed through the `RuntimeError` envelope from [error-model.md](./error-model.md):

| Code | Kind | Source module | When |
|---|---|---|---|
| `sandbox.permission_unsatisfiable` | `validation` | `sandbox` | An adapter cannot honour the declared permissions |
| `sandbox.in_process_runner_missing` | `validation` | `sandbox` | `InProcessSandboxAdapter.load()` received `runner: undefined` |
| `sandbox.timeout` | `timeout` | `sandbox` | Wall-clock cap exceeded (cooperative; mapped to `kind:"skip"` by the in-process adapter) |
| `sandbox.draining` | `validation` | `sandbox` | `execute()` invoked after `drain()` started |
| `sandbox.disposed` | `validation` | `sandbox` | `execute()` invoked after `dispose()` |
| `runner_registry.version_conflict` | `validation` | `registry` | Duplicate `(type, version)` registration |
| `runner_registry.not_found` | `not_found` | `registry` | `unregister()` / `drainAndUnregister()` for a non-existent entry |
| `runner_registry.drain_timeout` | `timeout` | `registry` | `drainAndUnregister()` exceeded `timeoutMs`; the registry rolls back atomically before the error surfaces |

Sandbox errors MUST NOT include the secret-revealing `SecretValue` payload; if a runner
receives a secret and crashes, the error context only carries the secret **name**.

## 10. Out of scope (explicit)

To keep the layer honest about what it does and does not do:

- Worker / Process / Container tier adapters and their IPC framing.
- Reverse-RPC bridges for `ctx.emit` / `ctx.stream` / `ctx.varGet` / `ctx.secretGet`.
- Capability-based `SecretStore` proxies.
- A formal policy engine governing which `tier` a node may declare.

If any of these become required (e.g. the project decides to accept untrusted nodes), the
`SandboxAdapter` interface stays the contract — a new adapter implementation slots in
behind the same `loadSync` / `load` shape without touching node code, the runner registry,
or the scheduler.
