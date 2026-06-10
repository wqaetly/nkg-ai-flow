/**
 * Loaders that turn external sources (process.env, .env files, app
 * defaults) into `VariableStore` instances.
 *
 * Compatibility notes:
 *
 *   - Legacy `secretNames` / `secrets` inputs are accepted, but all values
 *     are written to the VariableStore.
 *
 *   - `.env` parsing is intentionally minimal: KEY=VALUE per line, blanks
 *     and `# ...` comments ignored, surrounding `"..."` / `'...'` quotes
 *     trimmed. We do not implement variable interpolation in Phase 1
 *     because it adds attack surface (`${HOME}` etc.).
 *
 *   - All loaders are sync; they run once at runtime startup. Re-loading
 *     would invalidate Replay determinism so we never re-read after the
 *     stores are built.
 */

import { readFileSync } from "node:fs";
import { InMemoryVariableStore } from "./inMemoryVariableStore.js";
import type { MutableSecretStore, MutableVariableStore, VariableValue } from "./types.js";

/* -------------------------------------------------------------------------- */
/* process.env                                                                 */
/* -------------------------------------------------------------------------- */

export interface LoadFromEnvOptions {
  /** Deprecated compatibility field. All names now load into VariableStore. */
  secretNames?: ReadonlyArray<string>;
  /**
   * Optional explicit allow-list. If provided, only these names from
   * `process.env` are loaded. If omitted, every entry in `source` is
   * considered (subject to `prefix`).
   */
  allow?: ReadonlyArray<string>;
  /** Optional prefix filter, e.g. `"FLOW_"`. */
  prefix?: string;
  /** Source map; defaults to `process.env`. */
  source?: Record<string, string | undefined>;
  /** Marker recorded in `metadata.source`. */
  origin?: string;
}

export interface LoadResult {
  variables: MutableVariableStore;
  /** @deprecated Same object as `variables`. */
  secrets: MutableSecretStore;
}

/**
 * Load variables from a flat string-string map (`process.env` by default).
 */
export function loadFromEnv(options: LoadFromEnvOptions = {}): LoadResult {
  const variables = new InMemoryVariableStore();
  populate(variables, options);
  return { variables, secrets: variables };
}

/** Populate existing stores from env. Useful when chaining layers. */
export function populateFromEnv(
  variables: MutableVariableStore,
  _secrets: MutableSecretStore,
  options: LoadFromEnvOptions = {},
): void {
  populate(variables, options);
}

function populate(
  variables: MutableVariableStore,
  options: LoadFromEnvOptions,
): void {
  const source = options.source ?? (process.env as Record<string, string | undefined>);
  const allow = options.allow ? new Set(options.allow) : undefined;
  const origin = options.origin ?? "env";

  for (const [name, raw] of Object.entries(source)) {
    if (raw === undefined) continue;
    if (options.prefix && !name.startsWith(options.prefix)) continue;
    if (allow && !allow.has(name)) continue;
    variables.set(name, coerceVariable(raw), { source: origin });
  }
}

/**
 * Coerce a raw env string to a structured `VariableValue`. We only do
 * *safe* coercions:
 *   - "true" / "false" -> boolean
 *   - integer / float numerals -> number
 *   - everything else stays a string
 */
function coerceVariable(raw: string): VariableValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && raw.trim() !== "") {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && raw.trim() === String(asNum)) {
      return asNum;
    }
  }
  return raw;
}

/* -------------------------------------------------------------------------- */
/* .env files                                                                  */
/* -------------------------------------------------------------------------- */

export interface LoadFromDotenvOptions extends LoadFromEnvOptions {
  /** Path to the .env file. */
  path: string;
  /** When true (default), missing file is ignored silently. */
  optional?: boolean;
}

export function loadFromDotenvFile(options: LoadFromDotenvOptions): LoadResult {
  const variables = new InMemoryVariableStore();
  populateFromDotenvFile(variables, variables, options);
  return { variables, secrets: variables };
}

export function populateFromDotenvFile(
  variables: MutableVariableStore,
  _secrets: MutableSecretStore,
  options: LoadFromDotenvOptions,
): void {
  const map = readDotenvFile(options.path, options.optional ?? true);
  if (!map) return;
  populate(variables, {
    ...options,
    source: map,
    origin: options.origin ?? `file:${options.path}`,
  });
}

function readDotenvFile(
  path: string,
  optional: boolean,
): Record<string, string> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (optional && (cause as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
  return parseDotenv(text);
}

/** Minimal KEY=VALUE parser. See module-level note for limits. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Defaults helper                                                             */
/* -------------------------------------------------------------------------- */

export interface DefaultsInput {
  variables?: Record<string, VariableValue>;
  secrets?: Record<string, string>;
}

/** Build a variable store from a plain object. */
export function loadFromDefaults(defaults: DefaultsInput): LoadResult {
  const variables = new InMemoryVariableStore();
  if (defaults.variables) {
    for (const [k, v] of Object.entries(defaults.variables)) {
      variables.set(k, v, { source: "default" });
    }
  }
  if (defaults.secrets) {
    for (const [k, v] of Object.entries(defaults.secrets)) {
      variables.set(k, v, { source: "default" });
    }
  }
  return { variables, secrets: variables };
}
