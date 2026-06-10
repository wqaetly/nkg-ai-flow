# Workspace Model

> This document is referenced from [ARCHITECTURE.md](../../ARCHITECTURE.md) §6.1.
> It defines the multi-tenancy boundary used by Flow naming, Secret scope, Quota, RBAC and Storage isolation.

## 1. Why Workspace

Multiple teams will share one Flow Runtime instance. Without an explicit tenancy boundary the following will leak:

- Flow IDs collide across teams.
- Secrets get pulled by the wrong Flow.
- Run events, traces and artifacts are visible across tenants.
- Quota and rate limits cannot be enforced.
- Audit logs cannot answer "who ran what".

Workspace is the **first-class tenancy unit** of the Runtime. Project and Flow are nested inside Workspace.

## 2. Scope Hierarchy

```text
Workspace
  └── Project
        └── Flow
              └── FlowVersion
                    └── Run
                          └── Node Instance
```

| Scope | Required | Purpose |
|---|---|---|
| `workspaceId` | yes | Top-level tenant boundary. Owns billing, quota, RBAC and Secret Vault root. |
| `projectId`   | yes for prod, optional for MVP | Group of related Flows under the same Workspace. Separate Secret scope from sibling projects. |
| `flowId`      | yes | Stable Flow identifier inside a Project. Must be unique within `(workspaceId, projectId)`, not globally. |
| `flowVersion` | yes | Immutable artifact version. Pinned at Run creation. |
| `runId`       | yes | Unique per execution. Globally unique recommended. |
| `nodeId`      | yes | Stable node instance ID inside Flow. |

Flow IDs and Node IDs are **not** globally unique. The runtime always addresses them with the full scope tuple.

## 3. MVP Posture

- Phase 0 / Phase 1 / Phase 2 may run with a single hardcoded `workspaceId = "default"` and `projectId = "default"`.
- All public APIs (`flow-ir`, `runtime`, `storage`, `transports`) **must still accept and pass through** `workspaceId` and `projectId` from day one. Hardcoding the value at the call site is allowed; removing the parameter from the signature is not.
- Phase 3 introduces real Secret scope enforcement.
- Phase 4 introduces transport-level workspace routing.
- Phase 6 introduces full RBAC and audit.

This avoids retrofitting tenancy into already-released APIs.

## 4. Identifier Rules

- `workspaceId`: opaque string, recommended `ws_*` prefix, ≤ 64 chars, `[a-z0-9_-]`.
- `projectId`: opaque string, recommended `proj_*` prefix, scoped under `workspaceId`.
- `flowId`: human-readable slug, scoped under `(workspaceId, projectId)`. Recommended `[a-z][a-z0-9-]*`.
- `flowVersion`: SemVer or monotonically increasing version (e.g. `v3`). Immutable once published.
- `runId`: globally unique, recommended `run_<ulid>`.
- `nodeId`: stable inside Flow, recommended `node_<type>_<n>`.

The runtime must reject identifiers that contain `/`, whitespace, control chars or non-printable ASCII.

## 5. Secret Scope

Secret resolution walks **most specific to least specific**:

```text
node    -> flow    -> project -> workspace
```

A secret named `OPENAI_API_KEY` defined at workspace level is visible to all flows under that workspace, unless overridden at a more specific scope. A node may declare in its manifest that it only accepts secrets from `flow` or narrower; the runtime must reject broader-scope secret resolution in that case.

```ts
interface SecretScope {
  workspaceId: string;
  projectId?: string;
  flowId?: string;
  nodeId?: string;
}
```

Cross-workspace secret access is forbidden. The runtime must reject any secret resolution where the requested scope's `workspaceId` does not match the Run's `workspaceId`.

## 6. RBAC Sketch

| Role | Workspace | Project | Flow | Run |
|---|---|---|---|---|
| `workspace_admin` | manage | manage | manage | view all |
| `project_admin`   | view  | manage | manage | view all in project |
| `flow_author`     | view  | view   | edit & publish | view own |
| `flow_invoker`    | view  | view   | invoke only | view own |
| `auditor`         | view  | view   | view   | view all |

MVP only needs to record the role per identity; enforcement points (Studio actions, Transport invoke, Patch approval) become required from Phase 6.

## 7. Quota and Rate Limit

Quota is always evaluated at `workspaceId` and optionally at `projectId`. Suggested counters:

- Concurrent running Runs.
- Flow publishes per hour.
- Node Logic Artifact storage size.
- Run event volume per day.
- Outbound HTTP / Tool call count.
- Secret read count.

MVP may use in-memory counters. Production must back them by persistent storage.

## 8. Storage Isolation

- Flow Artifact path: `.runtime/artifacts/flows/<workspaceId>/<projectId>/<flowId>/<version>/`.
- Node Logic Artifact path: `.runtime/artifacts/nodes/<workspaceId>/<projectId>/<nodeId>/<version>/`.
- Run Event Store rows must include `workspaceId`, `projectId`, `flowId`, `flowVersion`, `runId`.
- Trace Store and Checkpoint Store follow the same column set.
- Cross-workspace queries are forbidden by default; admin tooling must require an explicit `--workspace` argument.

## 9. Transport Routing

| Transport | Workspace resolution |
|---|---|
| HTTP   | From auth token claim, fallback to header `X-Workspace-Id` (only allowed in MVP / dev). |
| CLI    | From `--workspace` flag or `FLOW_WORKSPACE` env. |
| MCP    | From MCP session context; one MCP server instance is bound to exactly one workspace. |
| SDK    | From client constructor argument. |
| Studio | From logged-in user session. |

Transports must inject the resolved `workspaceId` into the Invocation Router. Run Manager rejects invocations whose Flow's `workspaceId` does not match the resolved tenant.

## 10. Audit

Every action that crosses a workspace boundary must be denied **and** logged:

- `flow.publish.cross_workspace_denied`
- `secret.resolve.cross_workspace_denied`
- `run.create.cross_workspace_denied`
- `artifact.read.cross_workspace_denied`

Audit log lives in the Trace Store with `kind = "audit"` and is exempt from regular retention until reviewed.

## 11. Open Questions (post-MVP)

- Workspace-level encryption-at-rest with separate KMS keys.
- Cross-workspace Flow sharing (read-only catalog) without copying artifacts.
- Per-workspace custom Node Type Registries.
- Federated multi-cluster Runtime with workspace affinity.

These are intentionally out of scope until Phase 6 governance lands.
