# AI Implementation Guide

> This guide turns the architecture into executable instructions for AI coding agents.
> Use it together with [Implementation Roadmap](./roadmap.md) and the specs under [docs/specs](../specs/).

## 1. Default MVP Stack

Use these defaults unless a later decision document explicitly changes them.

| Area | Default |
|---|---|
| Language | TypeScript |
| Module format | ESM |
| Package manager | npm workspaces (`packages/*` / `packages/transports/*` / `apps/*`) |
| Test runner | Vitest |
| Runtime core target | Node-compatible TypeScript |
| Builder runner | Node + `tsx` |
| Schema authoring | Zod |
| Runtime schema format | JSON Schema generated from source schemas |
| HTTP server | Web Fetch `(Request) => Promise<Response>` handler (`@ai-native-flow/transport-http`'s `createHttpHandler`), adapted onto `node:http.createServer` by `apps/studio/src/sidecar.ts` and `packages/transports/http-runner`. **No Hono dependency** — staying on the WHATWG Fetch standard keeps the handler runtime-neutral and reusable on Cloudflare Workers etc. |
| CLI | Node + `tsx`; command implementation lives in `packages/transports/cli` |
| MVP storage | SQLite + local filesystem artifact store (`packages/runtime/src/storage`) |
| MVP event bus | In-memory event bus with persistent event log abstraction (`packages/event-bus`) |
| Streaming transport (MVP) | HTTP SSE (`packages/transport-http/src/sse.ts`) |
| Studio | React 19 + React Flow (`@xyflow/react`) + Vite (`packages/studio` library + `apps/studio` Vite app) |
| Workspace manifest | built-in `apps/*/anf.app.json` discovery + optional host `anf.apps.json`, loaded by `packages/workspace-manifest` (shared by sidecar and `transports/http-runner`) |
| Variable / Secret store (MVP) | `@ai-native-flow/variable-store` (`InMemoryVariableStore` + `InMemorySecretStore` + `bootstrapDefaults`) |

Alternatives are allowed only after the MVP contracts are stable.

## 2. Implementation Order

Implement the project in this order:

1. Monorepo skeleton.
2. `flow-ir` graph types and schemas.
3. `flow-validator` graph validation.
4. `flow-builder` typed builder and deterministic `dump()`.
5. First end-to-end example flow.
6. Single-process runtime.
7. Run event model and event store abstraction.
8. HTTP and CLI invocation.
9. Node Event Channel and streaming.
10. Node SDK (`defineNode` / `defineNodeFactory` / `installNode` — the only supported way to declare a node).
11. `variable-store` two-track abstraction (`VariableStore` + `SecretStore`, `$var` / `$secret` references).
12. Sandbox adapter and TypeScript node compiler.
13. MCP / CLI / SDK transports.
14. Studio.
15. AI Patch / Graph Operation governance.

Do not start Studio, MCP, production sandboxing, distributed queues, or advanced hot update before the builder and single-process runtime work end to end.

> Phase status (kept in sync with [ARCHITECTURE.md §7](../../ARCHITECTURE.md) and [Roadmap](./roadmap.md)): Phase 0 / 1 / 2 / 3 / 4 / 5 / 6 are ✅ delivered. Phase 4 ships `packages/transports/sdk` with `invoke` / `start` / `stream` / `events` / `replayRun` / `watchRunEvents` / `cancel` / `getRun`, `packages/transports/cli` with command-runner plus bootstrap/bin seam, `packages/transports/mcp` with the protocol-agnostic adapter, and `packages/transports/http-runner` (discovers/loads app manifests → auto `register+promote` → boots a `node:http` server); all reuse the shared Runtime API and normalized `NodeEvent`. Phase 3 ships `packages/sandbox` as a trusted in-process execution seam plus `packages/compiler` and T2 drain / hot-swap support; Worker / Process / Container isolation is intentionally out of scope for the current team-owned-code model. Phase 5 ships `packages/studio` (React 19 + `@xyflow/react` editor library) and `apps/studio` (Vite frontend + Node sidecar). Phase 6 ships AI Patch Proposal / Policy Validator / Diff Preview / Approval Gate in `flow-builder` plus Patch Preview projection in `studio`.

## 3. Recommended Monorepo Layout

```text
packages/
  flow-ir/
    src/types.ts
    src/schema.ts
    src/schemaVersion.ts
    src/ids.ts
    src/registry.ts            # NodeTypeRegistry (data track)
    src/errors.ts

  flow-validator/
    src/validateGraph.ts
    src/validatePorts.ts
    src/validateSchema.ts
    src/result.ts

  flow-builder/
    src/builder.ts
    src/nodeHandle.ts
    src/dump.ts
    src/graphOperation.ts

  builder-runner/
    src/runBuilder.ts

  runtime/
    src/runManager.ts
    src/executionEngine.ts
    src/createRuntime.ts        # public composition root
    src/invocationRouter.ts
    src/registry.ts             # internal Registry (not a separate package)
    src/storage/                 # internal Storage abstraction (SQLite + filesystem in MVP)
    src/nodeEventChannel.ts      # internal Node Event Channel
    src/nodeContext.ts           # ctx.variables / ctx.secrets / ctx.emit / ctx.stream
    src/nodeRunnerRegistry.ts    # behaviour track, written-to only via node-sdk's installNode()
    src/nodes/builtin/           # 9 built-in nodes, each authored with @ai-native-flow/node-sdk
    src/nodes/llmProvider.ts     # LlmProvider abstraction (Fake + OpenAI-compatible)

  event-bus/
    src/types.ts
    src/inMemoryEventBus.ts
    src/eventStore.ts

  node-sdk/
    src/defineNode.ts            # zod-typed config / input / output
    src/defineNodeFactory.ts     # factory(deps) => DefinedNode
    src/installNode.ts           # registers DefinedNode into a runtime InstallTarget
    src/types.ts                 # SdkNodeContext / SdkRunFn / DefinedNode

  ai-stream/
    src/types.ts
    src/openaiAdapter.ts

  variable-store/                # MVP for VariableStore + SecretStore (Phase 2)
    src/types.ts                 # VariableStore / SecretStore / SecretValue / $var / $secret
    src/inMemoryVariableStore.ts
    src/inMemorySecretStore.ts
    src/chain.ts                 # chained variable lookup
    src/loaders.ts               # env / file loaders
    src/resolve.ts               # $var / $secret resolution inside Flow JSON
    src/defaults.ts              # bootstrapDefaults() — env + .env file loader
    src/errors.ts

  sandbox/                       # introduced in Phase 3
    src/types.ts                 # SandboxAdapter
    src/inProcessSandbox.ts      # trusted in-process execution seam

  compiler/                      # introduced in Phase 3
    src/compileNode.ts           # TS source -> versioned Node Logic Artifact

  workspace-manifest/            # built-in apps discovery + optional host anf.apps.json loading
    src/types.ts
    src/loadWorkspaceManifest.ts
    src/loadNodePack.ts

  transport-http/                # actual top-level package name (not transports/http)
    src/handler.ts               # createHttpHandler({ runtime, cors }) — Web Fetch (Request)=>Response
    src/sse.ts                   # SSE encoder + cursor handling
    src/index.ts

  transports/                    # introduced in Phase 4
    http-runner/                 # turn app manifests into a running node:http server
    cli/                         # CLI command-runner (run / stream / inspect / replay / cancel)
    mcp/                         # MCP adapter (tool descriptor / callTool / streamTool / inspectRun / replayRun / cancelRun)
    sdk/                         # TypeScript SDK (createFlowSdkClient + invoke/start/stream/events/replayRun/watchRunEvents/cancel/getRun)

  studio/                        # @ai-native-flow/studio editor library — React 19 + @xyflow/react (Phase 5)

apps/                            # business apps and executable shells (Phase 5+)
  studio/                        # @ai-native-flow/studio-app: Vite frontend + Node sidecar (apps/studio/src/sidecar.ts)
  code-review-iwiki/             # business app: custom node pack + flow JSON + serve/inspect/replay shells
  hello-agent/                   # minimal text_input -> agent app: build / invoke

apps/*/anf.app.json              # app-local manifest: declares flowDirs[] and nodePacks[]
```

> Registry, Storage and Node Event Channel are intentionally kept as internal modules of `packages/runtime` to avoid premature package fragmentation. They may be promoted to standalone packages only after Phase 3 if reuse outside `runtime` becomes necessary.
>
> The HTTP transport ships as the top-level package `packages/transport-http` (the Web Fetch handler library), with `packages/transports/http-runner` layering workspace-manifest discovery + auto register/promote + a `node:http` listener on top. Other transports (`cli` / `mcp` / `sdk`) live under `packages/transports/*`. Apps under `apps/*` consume packages but **must not** be depended on by any `packages/*`.

The loader automatically discovers this repository's built-in `apps/*/anf.app.json`; each app manifest declares its own `flowDirs[]` and `nodePacks[]`. When this repository is used as a submodule, the host project may provide a root `anf.apps.json`, but that file only lists host-local app directories in `apps[]`. The host does not need to list or import submodule app paths.

## 4. Package Dependency Rules

- `flow-ir` must not depend on any other internal package.
- `flow-validator` may depend on `flow-ir` only.
- `flow-builder` may depend on `flow-ir` and `flow-validator`.
- `builder-runner` may depend on `flow-builder` and `flow-validator`.
- `variable-store` must not depend on any other internal package; it sits at the same base layer as `flow-ir`.
- `runtime` may depend on `flow-ir`, `flow-validator`, `event-bus`, `node-sdk`, `variable-store`, `ai-stream`, and `sandbox` abstractions.
- `runtime` must **not** depend on `flow-builder` or `builder-runner`. Runtime only consumes Flow Artifacts produced by the builder pipeline; it never invokes the builder.
- `node-sdk` must not depend on concrete sandbox implementations and must not depend on the concrete `variable-store` package; it consumes the `VariableStore` / `SecretStore` interfaces only via `NodeContext`.
- `ai-stream` must not depend on HTTP, CLI, MCP, or Studio transports.
- `transport-http` (and every package under `transports/*`) consume runtime APIs and `NodeEvent`; they must not call node processes directly.
- `workspace-manifest` may only depend on Node standard library + the `node-sdk` types; it must not depend on any transport. Both `apps/studio/src/sidecar.ts` and `packages/transports/http-runner` consume it to share manifest parsing and nodePack loading.
- `sandbox` must not depend on `runtime`; the dependency goes runtime → sandbox abstractions, never the other way.
- `studio` (the package) consumes Runtime Graph Schema and Graph Operation APIs; it must not own the runtime graph schema.
- `apps/*` are terminal consumers: they may depend on any `packages/*` / `packages/transports/*`, but **no** `packages/*` may depend on `apps/*`.

## 5. Core Contracts to Implement First

Implement and test these contracts before transport or UI work:

- `FlowGraph`
- `NodeTypeDefinition`
- `NodeInstance`
- `PortDefinition`
- `EdgeDefinition`
- `FlowBuilder`
- `FlowValidator`
- `RunRecord`
- `NodeEvent`
- `ArtifactRef`
- `SandboxAdapter`
- `NodeContext` (carries `ctx.variables` and `ctx.secrets`)
- `VariableStore` / `SecretStore` / `SecretValue` (single source of truth: `@ai-native-flow/variable-store`)
- `DefinedNode` / `NodeFactory` / `InstallTarget` (single source of truth: `@ai-native-flow/node-sdk`)

## 6. First End-to-End Slice

The first runnable slice should execute a simple flow without Studio, MCP, sandbox isolation, or distributed storage.

Target command:

```bash
flow run apps/hello-agent/helloagent.flow.ts --input '{}'
```

Expected behavior:

1. Builder executes `helloagent.flow.ts`.
2. Builder creates nodes and edges through typed APIs.
3. Builder calls `dump()` to produce deterministic Flow JSON.
4. Validator checks graph, ports, schemas, and permissions.
5. Runtime creates a Run and pins the Flow Version.
6. Scheduler executes `start -> transform -> end`.
7. Event store records ordered events.
8. CLI prints final output.

Expected output:

```json
{
  "message": "Hello, World"
}
```

## 7. Testing and Acceptance Criteria

### Flow Builder

- Creates nodes with stable IDs.
- Connects output ports to input ports.
- Rejects duplicate node IDs.
- Rejects missing ports.
- Rejects invalid port direction.
- Rejects incompatible port kinds.
- `dump()` produces deterministic JSON.
- Same builder code produces the same JSON output.

### Runtime

- Starts a Run from a Flow Artifact.
- Pins Flow Version at Run creation.
- Executes a simple DAG.
- Persists ordered runtime events.
- Supports node failure.
- Supports cancellation.
- Supports retry attempt numbering.

### Streaming

- Emits `stream_open`.
- Emits ordered `stream_delta`.
- Emits `stream_close`.
- Supports cursor resume by `eventId`.
- Does not parse semantic stream from `stdout` or `stderr`.

### Storage

- Separates Flow Artifact, Run Record, Run Event, Trace, and Checkpoint.
- Supports local filesystem artifacts for MVP.
- Keeps storage APIs abstract enough for PostgreSQL / object storage later.

## 8. AI Agent Implementation Constraints

AI coding agents must not:

- Generate Flow JSON manually except in tests.
- Treat React Flow state as runtime schema.
- Use `stdout` or `stderr` as semantic streaming protocol.
- Implement production hot swap with HMR.
- Make runtime core depend on runtime-only APIs.
- Store secrets in Flow JSON.
- Read `process.env` directly from node logic; values must arrive via `ctx.variables.get()` / `ctx.secrets.get()` so that scope and redaction are enforced.
- Stringify or `JSON.stringify` a `SecretValue` for any persisted surface; the redaction marker `[secret:NAME]` must survive serialization.
- Register a node by calling `runners.register(...)` directly; the only supported declaration path is `defineNode` / `defineNodeFactory` + `installNode` (or `createRuntime({ nodes })`).
- Execute AI-generated code without sandbox abstraction.
- Skip validator and directly load builder output.
- Add distributed queues before the in-memory MVP works.
- Add production database dependencies before storage interfaces and SQLite MVP work.
- Implement multiple alternative stacks in the same phase.

## 9. Definition of Done

A phase is done only when:

- Public contracts are typed and exported.
- Unit tests cover happy path and invalid input.
- At least one example uses the implemented capability.
- Errors are explicit and actionable.
- Documentation links to the relevant spec.
- The implementation does not violate package dependency rules.
