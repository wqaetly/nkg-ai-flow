
# Variable and Secret

> This document is the spec for the **configuration / credential two-track abstraction** referenced from
> [ARCHITECTURE.md §3.6](../../ARCHITECTURE.md). It is the single source of truth for `VariableStore`,
> `SecretStore`, `SecretValue`, and the `$var` / `$secret` reference forms inside Flow JSON.
>
> Implementation lives in `packages/variable-store`. Phase 2 delivered the in-memory MVP
> (`InMemoryVariableStore` + `InMemorySecretStore` + `bootstrapDefaults`); production-grade
> backends (KMS, Vault, cloud secret managers) plug in via the same interfaces and are out of
> scope for the MVP.

## 1. Why two tracks

Putting "everything into `process.env`" is the most common cause of accidental secret leakage:
the same string ends up in checkpoints, replay snapshots, Trace payloads and Studio property
panels. This project therefore splits configuration into two **non-fungible** tracks:

| Track | Holds | Listable? | Embeddable in Flow JSON | Embeddable in Run Event / Trace | Wire format |
|---|---|---|---|---|---|
| `VariableStore` | non-sensitive config (model name, base URL, timeouts, feature flags) | ✅ name + value | inline value or `{ "$var": "NAME" }` | ✅ | plain JSON |
| `SecretStore` | sensitive credentials (API keys, tokens, DB passwords) | ✅ name only, **never value** | only `{ "$secret": "NAME" }`; never inline | ❌ never | `SecretValue` wrapper |

The split is intentional and **irreversible**: a value MUST be classified at write time and
MUST NOT silently fall back from one track to the other.

## 2. Public types

The runtime, node SDK, validator, and Studio all import these types from
`@ai-native-flow/variable-store`. Re-declaring or copying them in another package is forbidden
(see [AI Implementation Guide §8](../implementation/ai-implementation-guide.md)).

```ts
// JSON-friendly value (no `undefined`, no functions, no Date).
type VariableValue =
  | string | number | boolean | null
  | readonly VariableValue[]
  | { readonly [k: string]: VariableValue };

interface VariableStore {
  get(name: string): VariableValue | undefined;
  getRequired(name: string): VariableValue;
  getString(name: string):  string  | undefined;
  getNumber(name: string):  number  | undefined;
  getBoolean(name: string): boolean | undefined;
  has(name: string): boolean;
  list(): readonly VariableEntry[];
  describe(name: string): VariableEntry | undefined;
}

interface MutableVariableStore extends VariableStore {
  set(name: string, value: VariableValue, metadata?: VariableMetadata): void;
  delete(name: string): boolean;
}

class SecretValue {
  readonly name: string;
  reveal(): string;            // call sites must be auditable
  toString(): string;          // returns `[secret:NAME]`
  toJSON():   string;          // returns `[secret:NAME]`
}

interface SecretStore {
  has(name: string): boolean;
  get(name: string): SecretValue | undefined;
  getRequired(name: string): SecretValue;
  list(): readonly SecretEntry[];          // MUST NOT expose values
  describe(name: string): SecretEntry | undefined;
}
```

**Required behaviour:**

1. `SecretValue.toString()` and `SecretValue.toJSON()` MUST return the redaction marker
   `` `[secret:${name}]` ``. Any code path that defeats this (`String.prototype.valueOf`,
   `util.inspect` custom hooks, structured clone hacks) is a bug.
2. `SecretStore.list()` MUST NOT include `SecretValue` instances; it MUST return entries with
   only `name` and metadata. Studio dropdowns are the canonical consumer.
3. Both stores MUST be cheap to call repeatedly. The runtime hits them once per node-input
   port assembly and again whenever a node calls `ctx.variables.get()` / `ctx.secrets.get()`.

## 3. Reference forms inside Flow JSON

Two and **only two** reference shapes are recognised inside `NodeInstance.config`:

```jsonc
{ "$var":    "MODEL_DEFAULT" }     // resolved to a VariableValue
{ "$secret": "LLM_API_KEY"   }     // resolved to a SecretValue (NOT a raw string)
```

Rules:

- A reference object MUST have exactly one key (`$var` or `$secret`) whose value is a
  non-empty string.
- A reference may appear at any depth inside `config` (top-level, array element, nested
  object). Resolution walks the entire structure.
- A reference MUST NOT appear inside `NodeInstance.id`, `NodeInstance.type`,
  `NodeInstance.typeVersion`, `EdgeDefinition`, port definitions, or any structural
  field of the FlowGraph; references are config-only.
- Inline secret strings (e.g. `"sk-..."`) inside Flow JSON are a **validation error**
  (`secret.inline_in_flow_json`). The validator MUST reject them.

The IR helpers `isVariableRef(value)` and `isSecretRef(value)` are the single canonical
predicate; do not re-implement them.

## 4. Resolution semantics

Resolution is performed by `resolveRefs(value, { variables, secrets })` from
`@ai-native-flow/variable-store`:

- Returns a **fresh** structure; the input is never mutated.
- A `{ "$var": "X" }` is replaced with the raw `VariableValue` returned by `variables.get("X")`.
- A `{ "$secret": "Y" }` is replaced with the **`SecretValue` wrapper** (not the underlying
  string). Node logic must call `.reveal()` to extract the string and SHOULD do so as close
  to the network call as possible.
- Missing references throw `RuntimeErrorException` with code `variable.not_found` /
  `secret.not_found` unless `{ allowMissing: true }` is set (Studio preview / dry-run only).
- Resolution is **all-or-nothing** per call: if any required reference is missing, no
  partial result is returned.

`collectRefs(value)` walks the same structure without resolving and returns
`{ variables: string[], secrets: string[] }`. It is the canonical input to the validator's
pre-flight check (§6).

## 5. Layering and lookup order

`chainVariableStores(...layers)` and `chainSecretStores(...layers)` compose multiple stores
into a single read-only view. **First layer that returns a value wins.** The default
process-level layering is:

| Priority | Layer | Source | Mutability |
|---|---|---|---|
| 1 (highest) | `runtimeOverrides` | `InMemory*Store` written via app code or tests | mutable |
| 2 | `processEnv` | OS environment variables (typed, allow-listed) | read-only |
| 3 | `dotEnvFile` | dotenv-compatible files in declared order | read-only |
| 4 (lowest) | `defaults` | app-shipped defaults | read-only |

`bootstrapDefaults({ env, dotenvFiles, overrides })` builds the default chain at process
startup. Calling it again **replaces** the state; tests typically use `resetDefaults()` for
isolation. Higher layers shadow lower layers but never delete from them.

> Within a Run, the runtime is free to wrap the default stores with **Run-scoped overrides**
> (e.g. workspace / project / flow scope) before handing them to nodes via `NodeContext`.
> Node logic MUST consume `ctx.variables` / `ctx.secrets` and SHOULD NOT reach for the global
> defaults; that lets the runtime layer Run-scoped overrides on top deterministically.

## 6. Validator contract

The validator MUST run a **pre-flight check** before a Run starts:

1. Walk every `NodeInstance.config` with `collectRefs()` to enumerate referenced names.
2. For each variable name, assert `variables.has(name)`.
3. For each secret name, assert `secrets.has(name)`.
4. On any miss, throw `variable.missing_refs` carrying the full `{ variables, secrets }` miss
   list and the offending `flowId`. The Run MUST NOT start.

Additional validation rules:

- Reject any `NodeInstance.config` that contains a string matching a known secret pattern
  (heuristic: `/^(sk|pk|api[_-]?key|token|secret)[-_]?[A-Za-z0-9]{16,}/i`) — this is the
  inline-secret guard that complements §3.
- Reject `requiredSecrets` / `requiredVariables` declared by a `NodeTypeDefinition` whose
  scope cannot be satisfied by the active Run's scope (workspace / project / flow); see
  [Workspace Model §5](./workspace-model.md).

## 7. Node Type Manifest contract

Every `NodeTypeDefinition` MUST declare what it consumes from each track:

```ts
interface NodeTypeDefinition {
  // ...
  requiredVariables?: string[];   // names this node will read via ctx.variables
  requiredSecrets?:   string[];   // names this node will read via ctx.secrets
  requiredPermissions?: string[];
}
```

Rules:

- A node MUST NOT read a variable / secret that it did not declare. Calling
  `ctx.variables.get("X")` for an undeclared `"X"` is allowed at runtime (returns
  `undefined`) but is a **lint error** that the validator surfaces against the manifest.
- The Studio palette uses these declarations to render the variable / secret picker.
- AI Builder code generation uses these declarations as the typed surface of available
  injections; AI MUST NOT invent ad-hoc secret names.

## 8. Persistence and observability

The two tracks have asymmetric persistence rules:

| Surface | `Variable` | `Secret` |
|---|---|---|
| Flow JSON Artifact | inline value or `{ "$var" }` | `{ "$secret" }` only |
| Run Record | resolved value (audit trail) | reference name only, never value |
| Run Event Store | resolved value | redaction marker `[secret:NAME]` |
| Trace Store | resolved value | redaction marker `[secret:NAME]` |
| Checkpoint | resolved value | reference name only; rehydrated from `SecretStore` on resume |
| Studio property panel | full value | reference name + metadata only |
| Studio variable picker | full list | name + metadata, no values |
| Error stack / log | full value | redaction marker |

The redaction marker `[secret:NAME]` is the only safe representation of a secret outside
`ctx.secrets.get().reveal()`. Any persistence layer that stringifies a `NodeContext`,
`NodeEvent` or `RuntimeError` MUST go through `JSON.stringify` so the `SecretValue.toJSON()`
override fires; manual concatenation is forbidden.

## 9. NodeContext exposure

The runtime hands every node a `NodeContext` that carries both stores:

```ts
interface NodeContext {
  // ... runId, nodeId, attempt, log, emit, stream, ...
  readonly variables: VariableStore;
  readonly secrets:   SecretStore;
}
```

Conventions:

- `ctx.variables` is the only supported way to read non-sensitive config from node logic.
  Reading `process.env` directly is forbidden by [AI Implementation Guide §8](../implementation/ai-implementation-guide.md).
- `ctx.secrets.getRequired(name).reveal()` is the only supported way to extract a secret
  string. Call sites SHOULD pass the revealed string straight into the network call and not
  retain it in module-scoped variables.
- Tests build a deterministic context with `new InMemoryVariableStore([...])` /
  `new InMemorySecretStore([...])` — no `bootstrapDefaults()` needed.

## 10. AI agent constraints

In addition to the global rules in [AI Implementation Guide §8](../implementation/ai-implementation-guide.md):

- AI MUST NOT inline a secret string into Builder output or Flow JSON. The only acceptable
  form is `{ "$secret": "NAME" }` plus a `requiredSecrets` declaration on the node manifest.
- AI MUST NOT add a new secret name without surfacing it through the Manifest;
  silently introducing a `ctx.secrets.get("NEW_KEY")` that the manifest does not declare is
  a lint error.
- AI MUST NOT promote a non-sensitive variable to the secret track or vice versa as a
  workaround for a missing entry. Track classification is a deliberate authoring decision.

## 11. Open items (post-MVP)

- KMS / Vault / cloud-secret-manager backed `SecretStore` adapters (out of scope for MVP).
- `SecretStore.rotate(name)` audit hook, mentioned in [Security §11.3](./security.md) but not
  implemented in Phase 2.
- Workspace / Project / Flow scoping inside a chained store; the Phase 2 chain is global
  per-process. Scope-aware lookup is a Phase 4 task and is tracked in
  [Workspace Model](./workspace-model.md).
- A `requiredVariables` / `requiredSecrets` schema field on `NodeTypeDefinition` is reserved
  but not yet enforced by the validator beyond §6; full enforcement lands together with the
  Manifest tightening in Phase 6.
