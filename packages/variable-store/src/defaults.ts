/**
 * Process-wide default stores.
 *
 * This module exposes a process-wide `VariableStore`
 * accessible from anywhere in the process. Use it from:
 *
 *   - node logic that wants ambient access without threading `ctx` around,
 *   - one-off scripts that need flow config without booting the runtime,
 *   - CLI tools that want to print effective configuration.
 *
 * Inside a Run the runtime *always* passes a per-Run `NodeContext` whose
 * `variables` is typically the same defaults wrapped with
 * Run-specific overrides. That means node logic should normally consume
 * `ctx.variables` rather than the globals here, because:
 *
 *   - it makes the dependency explicit (and testable with a fake ctx),
 *   - it lets the runtime layer Run-scoped overrides on top.
 *
 * The globals exist so logic *outside* a Run (e.g. provider construction,
 * background workers) still has a uniform API.
 */

import { chainVariableStores } from "./chain.js";
import { InMemoryVariableStore } from "./inMemoryVariableStore.js";
import {
  loadFromDotenvFile,
  loadFromEnv,
  populateFromDotenvFile,
  populateFromEnv,
  type LoadFromDotenvOptions,
  type LoadFromEnvOptions,
} from "./loaders.js";
import type {
  MutableSecretStore,
  MutableVariableStore,
  SecretStore,
  VariableStore,
} from "./types.js";

interface DefaultStoresState {
  /** The composite read-facing variable store handed out via `getDefaultVariableStore`. */
  variables: VariableStore;
  /** Top-most mutable layer used for runtime-set overrides. */
  variableOverrides: MutableVariableStore;
}

let state: DefaultStoresState | undefined;

export interface BootstrapDefaultsOptions {
  /** Optional `.env` file paths, in priority order (highest first). */
  dotenvFiles?: ReadonlyArray<LoadFromDotenvOptions>;
  /** Optional process.env loader options. Pass `null` to skip env loading. */
  env?: LoadFromEnvOptions | null;
  /** Optional initial overrides written to the top mutable layer. */
  overrides?: {
    variables?: MutableVariableStore;
    secrets?: MutableSecretStore;
  };
}

/**
 * Build the default chain. Call this once at process startup. Subsequent
 * `getDefaultVariableStore()` calls return stores that resolve in the layered priority order described in
 * `chain.ts`. Calling `bootstrapDefaults` again **replaces** the state.
 */
export function bootstrapDefaults(options: BootstrapDefaultsOptions = {}): void {
  const variableOverrides =
    options.overrides?.variables ??
    options.overrides?.secrets ??
    new InMemoryVariableStore();

  const variableLayers: VariableStore[] = [variableOverrides];
  if (options.overrides?.secrets && options.overrides.secrets !== variableOverrides) {
    variableLayers.push(options.overrides.secrets);
  }

  if (options.env !== null) {
    const env = loadFromEnv(options.env ?? {});
    variableLayers.push(env.variables);
  }

  if (options.dotenvFiles) {
    for (const file of options.dotenvFiles) {
      const result = loadFromDotenvFile(file);
      variableLayers.push(result.variables);
    }
  }

  state = {
    variables: chainVariableStores(...variableLayers),
    variableOverrides,
  };
}

/** Replace the entire default state with caller-built stores. */
export function setDefaults(options: {
  variables: VariableStore;
  variableOverrides?: MutableVariableStore;
  secrets?: SecretStore;
  secretOverrides?: MutableSecretStore;
}): void {
  state = {
    variables: options.secrets
      ? chainVariableStores(options.variables, options.secrets)
      : options.variables,
    variableOverrides: options.variableOverrides ?? new InMemoryVariableStore(),
  };
}

/** Drop the default state. Mostly for tests. */
export function resetDefaults(): void {
  state = undefined;
}

function ensure(): DefaultStoresState {
  if (!state) {
    // Lazy default: empty stores, no env loading. Callers should normally
    // run `bootstrapDefaults()` before reading, but accidental reads should
    // not crash; they simply find nothing.
    bootstrapDefaults({ env: null });
  }
  return state!;
}

/* -------------------------------------------------------------------------- */
/* Public accessors                                                            */
/* -------------------------------------------------------------------------- */

export function getDefaultVariableStore(): VariableStore {
  return ensure().variables;
}

/** @deprecated Use `getDefaultVariableStore`; returns the same store. */
export function getDefaultSecretStore(): SecretStore {
  return ensure().variables;
}

/**
 * Return the top-most *mutable* override layer for runtime / tests to
 * `set()` values into. The override layer takes precedence over env / file
 * layers so tests can deterministically inject values without worrying
 * about the host environment.
 */
export function getVariableOverrides(): MutableVariableStore {
  return ensure().variableOverrides;
}

/** @deprecated Use `getVariableOverrides`; returns the same store. */
export function getSecretOverrides(): MutableSecretStore {
  return ensure().variableOverrides;
}

/** Convenience: install additional env entries into the existing overrides. */
export function installEnvOverrides(options: LoadFromEnvOptions): void {
  const s = ensure();
  populateFromEnv(s.variableOverrides, s.variableOverrides, options);
}

/** Convenience: install entries from a `.env` file into the overrides. */
export function installDotenvOverrides(options: LoadFromDotenvOptions): void {
  const s = ensure();
  populateFromDotenvFile(s.variableOverrides, s.variableOverrides, options);
}
