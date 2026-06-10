/**
 * Public types for the environment variable store.
 *
 * Runtime configuration uses one store: `VariableStore`. Older names such
 * as `SecretStore` / `$secret` remain only as compatibility aliases and do
 * not create a second storage path.
 */

/* -------------------------------------------------------------------------- */
/* VariableStore: non-sensitive key-value config                              */
/* -------------------------------------------------------------------------- */

/** JSON-friendly value type. */
export type VariableValue =
  | string
  | number
  | boolean
  | null
  | readonly VariableValue[]
  | { readonly [key: string]: VariableValue };

/** Optional metadata attached to a variable. */
export interface VariableMetadata {
  /** Optional human description; rendered in Studio variable picker. */
  description?: string;
  /** Optional logical scope; informational only in Phase 1. */
  scope?: VariableScope;
  /** Origin (`env` / `file` / `default` / `runtime`); useful for debugging. */
  source?: string;
  /** ISO-8601 timestamp of the most recent update. */
  updatedAt?: string;
}

export interface VariableScope {
  workspaceId?: string;
  projectId?: string;
  flowId?: string;
}

export interface VariableEntry {
  name: string;
  value: VariableValue;
  metadata?: VariableMetadata;
}

/**
 * Read-only contract used by every node, every logic site, and the IR
 * `$var` resolver. Implementations MUST be cheap to call repeatedly because
 * the runtime hits them once per node input port assembly.
 */
export interface VariableStore {
  /** Return the stored value, or `undefined` if the variable is absent. */
  get(name: string): VariableValue | undefined;

  /**
   * Return the stored value, throwing a structured error when absent. Use
   * this from node logic that cannot proceed without the variable - it
   * gives much clearer error codes than a downstream `null` dereference.
   */
  getRequired(name: string): VariableValue;

  /** Coerced helpers. Each throws if the value is present but wrong-typed. */
  getString(name: string): string | undefined;
  getNumber(name: string): number | undefined;
  getBoolean(name: string): boolean | undefined;

  has(name: string): boolean;
  list(): readonly VariableEntry[];
  /** Optional structured lookup; returns metadata alongside the value. */
  describe(name: string): VariableEntry | undefined;
}

/** Mutable extension; not every Store needs to support this. */
export interface MutableVariableStore extends VariableStore {
  set(name: string, value: VariableValue, metadata?: VariableMetadata): void;
  delete(name: string): boolean;
}

/** @deprecated Use `VariableMetadata`. */
export type SecretMetadata = VariableMetadata;
/** @deprecated Use `VariableEntry`. */
export type SecretEntry = VariableEntry;
/** @deprecated Use `VariableStore`. */
export type SecretStore = VariableStore;
/** @deprecated Use `MutableVariableStore`. */
export type MutableSecretStore = MutableVariableStore;

/* -------------------------------------------------------------------------- */
/* Reference forms used inside Flow JSON                                       */
/* -------------------------------------------------------------------------- */

/** `{ "$var": "MODEL_DEFAULT" }` */
export interface VariableRef {
  $var: string;
}

/** `{ "$secret": "LLM_API_KEY" }` */
export interface SecretRef {
  $secret: string;
}

export function isVariableRef(value: unknown): value is VariableRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $var?: unknown }).$var === "string" &&
    Object.keys(value as object).length === 1
  );
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $secret?: unknown }).$secret === "string" &&
    Object.keys(value as object).length === 1
  );
}
