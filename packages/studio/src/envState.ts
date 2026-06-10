/**
 * Pure helpers for the workbench's two-layer environment storage
 * (Global + per-flow). Extracted from `StudioWorkbench.tsx` so they
 * can be unit-tested without rendering React components and without
 * a DOM.
 *
 * Storage shape (localStorage key `anf.studio.env.v2`):
 *
 *   {
 *     "version": 2,
 *     "global": EnvRow[],
 *     "apps":   { [flowScopeId: string]: EnvRow[] }
 *   }
 *
 * Backwards compatibility:
 *   - v1 (`anf.studio.env.v1`) was a single flat `EnvRow[]`. We
 *     read it once on first boot and lift it into the v2 `global`
 *     bucket. The v1 key is left untouched so a downgrade to an
 *     older Studio build still finds its data.
 *
 * Merge order at run-time / picker (high -> low priority):
 *   1. active flow's bucket (`apps[flowScopeId]`)
 *   2. global bucket
 *   3. sidecar process-level VariableStore
 *
 * Same-name keys in a higher layer shadow lower layers. The `secret`
 * flag is UI metadata only; every value is sent as a variable.
 */

import type { EnvOverrides } from "./httpClient.js";

/** Single editable row in the workbench Env panel. */
export interface EnvRow {
  id: string;
  key: string;
  value: string;
  secret: boolean;
}

/** Two-layer environment state owned by the workbench. */
export interface EnvState {
  global: EnvRow[];
  /**
   * Flow-scoped buckets keyed by sidecarPath. The storage field keeps
   * the historical `apps` name so existing v2 localStorage data can be
   * read without a migration.
   */
  apps: Record<string, EnvRow[]>;
}

/** localStorage keys. v1 is read-only (migration source). */
export const ENV_STORAGE_KEY_V1 = "anf.studio.env.v1";
export const ENV_STORAGE_KEY = "anf.studio.env.v2";

/** Synthetic scope id used by the panel to mean "the global bucket". */
export const GLOBAL_SCOPE = "__global__";

/**
 * Derive the flow-scoped env bucket id from a flow's `sidecarPath`.
 * Returns `undefined` for imported / Save-As flows that aren't
 * bound to a workspace (those only see the global bucket).
 *
 * `sidecarPath` shape: `"<workspace>/<rel>.json"`.
 */
export function deriveFlowScopeId(sidecarPath: string | undefined): string | undefined {
  if (!sidecarPath) return undefined;
  const normalized = sidecarPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  return normalized ? normalized : undefined;
}

/** Random row id used when localStorage entries lack one. */
export function createEnvRowId(): string {
  return `env_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Defensive parse of a serialized `EnvRow[]`. Tolerates missing
 * fields and re-issues ids when absent so legacy data keeps working.
 */
export function parseRowArray(input: unknown): EnvRow[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item): EnvRow | null => {
      if (!item || typeof item !== "object") return null;
      const rec = item as Record<string, unknown>;
      return {
        id: typeof rec.id === "string" ? rec.id : createEnvRowId(),
        key: typeof rec.key === "string" ? rec.key : "",
        value: typeof rec.value === "string" ? rec.value : "",
        secret: rec.secret === true,
      };
    })
    .filter((row): row is EnvRow => row !== null);
}

/**
 * Load env state from a localStorage-like accessor. Pass `null` to
 * get the empty default. Returns the migrated v2 shape regardless
 * of the on-disk version.
 *
 * The `storage` indirection lets tests run without a DOM.
 */
export function loadEnvState(storage: Pick<Storage, "getItem"> | null): EnvState {
  const empty: EnvState = { global: [], apps: {} };
  if (!storage) return empty;

  // Prefer v2 if present.
  try {
    const rawV2 = storage.getItem(ENV_STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as unknown;
      if (parsed && typeof parsed === "object") {
        const rec = parsed as { global?: unknown; apps?: unknown };
        const global = parseRowArray(rec.global);
        const apps: Record<string, EnvRow[]> = {};
        if (rec.apps && typeof rec.apps === "object") {
          for (const [scopeId, rows] of Object.entries(rec.apps as Record<string, unknown>)) {
            const list = parseRowArray(rows);
            if (list.length > 0) apps[scopeId] = list;
          }
        }
        return { global, apps };
      }
    }
  } catch {
    /* fall through to v1 / empty */
  }

  // v1 fallback — read once, lift into the global bucket.
  try {
    const rawV1 = storage.getItem(ENV_STORAGE_KEY_V1);
    if (rawV1) {
      const list = parseRowArray(JSON.parse(rawV1));
      if (list.length > 0) return { global: list, apps: {} };
    }
  } catch {
    /* ignore */
  }

  return empty;
}

/**
 * Compute the wire-format `envOverrides` payload sent to the sidecar.
 *
 * Layers are walked low → high priority. Higher priority entries
 * fully replace same-name lower-priority entries (including across
 * the variable/secret kind boundary).
 */
export function mergeEnvOverrides(
  state: EnvState,
  activeFlowScopeId: string | undefined,
): EnvOverrides {
  const variables: Record<string, unknown> = {};
  const layers: EnvRow[][] = [state.global];
  if (activeFlowScopeId) {
    const flowRows = state.apps[activeFlowScopeId];
    if (flowRows) layers.push(flowRows);
  }
  for (const layer of layers) {
    for (const row of layer) {
      const key = row.key.trim();
      if (!key) continue;
      variables[key] = row.value;
    }
  }
  return {
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  };
}

/**
 * Project the merged env state to the picker-friendly entry list
 * surfaced to in-node renderers via `EnvVarsProvider`. The active
 * flow's bucket is listed first so its rows shadow same-name global
 * rows (option (a) from the design — no cross-flow leakage).
 */
export interface EnvPickerEntry {
  key: string;
  value: string;
  secret: boolean;
  scope: "flow" | "global";
  flowLabel?: string;
}

export function buildPickerEntries(
  state: EnvState,
  activeFlowScopeId: string | undefined,
): EnvPickerEntry[] {
  const seen = new Set<string>();
  const out: EnvPickerEntry[] = [];
  if (activeFlowScopeId) {
    for (const row of state.apps[activeFlowScopeId] ?? []) {
      const key = row.key.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, value: row.value, secret: row.secret, scope: "flow", flowLabel: activeFlowScopeId });
    }
  }
  for (const row of state.global) {
    const key = row.key.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value: row.value, secret: row.secret, scope: "global" });
  }
  return out;
}

/**
 * Effective merged keyset for the badge counter on the toolbar Env
 * button. Same shadow rules as `mergeEnvOverrides` but returns just
 * the count.
 */
export function countEffectiveKeys(
  state: EnvState,
  activeFlowScopeId: string | undefined,
): number {
  const keys = new Set<string>();
  for (const row of state.global) {
    const k = row.key.trim();
    if (k) keys.add(k);
  }
  if (activeFlowScopeId) {
    for (const row of state.apps[activeFlowScopeId] ?? []) {
      const k = row.key.trim();
      if (k) keys.add(k);
    }
  }
  return keys.size;
}

/**
 * Apply a row mutation to the bucket identified by `scope`. When
 * the bucket is left empty, drop it from `apps` so storage stays
 * tidy across sessions.
 */
export function setRowsForScope(
  state: EnvState,
  scope: string,
  mutate: (rows: EnvRow[]) => EnvRow[],
): EnvState {
  if (scope === GLOBAL_SCOPE) {
    return { ...state, global: mutate(state.global) };
  }
  const next = mutate(state.apps[scope] ?? []);
  if (next.length === 0) {
    if (!state.apps[scope]) return state;
    const { [scope]: _drop, ...rest } = state.apps;
    void _drop;
    return { ...state, apps: rest };
  }
  return { ...state, apps: { ...state.apps, [scope]: next } };
}
