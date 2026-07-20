/**
 * Chain composition for stores.
 *
 * `chainVariableStores(...layers)` and legacy `chainSecretStores(...layers)` look
 * up names through layers in order: the FIRST layer that has the name
 * wins. Mutations are not allowed on the chain itself; callers should
 * mutate a specific layer.
 *
 * Typical layering (highest -> lowest priority):
 *
 *   1. `runtimeOverrides`     // explicit `.set()` from app code / tests
 *   2. `processEnv`           // OS environment variables (typed, allow-listed)
 *   3. `dotEnvFile`           // declared dotenv-compatible files
 *   4. `defaults`             // app-shipped defaults
 */

import {
  throwVariableNotFound,
  throwVariableTypeMismatch,
} from "./errors.js";
import type {
  MutableVariableStore,
  SecretStore,
  VariableEntry,
  VariableStore,
  VariableValue,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Variable chain                                                              */
/* -------------------------------------------------------------------------- */

export function chainVariableStores(
  ...layers: ReadonlyArray<VariableStore>
): VariableStore {
  return new ChainedVariableStore(layers);
}

/**
 * Read request-scoped values from `overlay` while routing mutations to a
 * durable base store. This keeps API keys ephemeral and still lets checkpoint
 * nodes persist their own state through the Runtime's writable store.
 */
export function overlayVariableStore(
  overlay: VariableStore,
  writableBase: MutableVariableStore,
): MutableVariableStore {
  return new OverlayVariableStore(overlay, writableBase);
}

class OverlayVariableStore implements MutableVariableStore {
  private readonly reads: VariableStore;

  constructor(
    overlay: VariableStore,
    private readonly writableBase: MutableVariableStore,
  ) {
    this.reads = chainVariableStores(overlay, writableBase);
  }

  get(name: string): VariableValue | undefined { return this.reads.get(name); }
  getRequired(name: string): VariableValue { return this.reads.getRequired(name); }
  getString(name: string): string | undefined { return this.reads.getString(name); }
  getNumber(name: string): number | undefined { return this.reads.getNumber(name); }
  getBoolean(name: string): boolean | undefined { return this.reads.getBoolean(name); }
  has(name: string): boolean { return this.reads.has(name); }
  list(): readonly VariableEntry[] { return this.reads.list(); }
  describe(name: string): VariableEntry | undefined { return this.reads.describe(name); }
  set(name: string, value: VariableValue, metadata?: VariableEntry["metadata"]): void {
    this.writableBase.set(name, value, metadata);
  }
  delete(name: string): boolean { return this.writableBase.delete(name); }
}

class ChainedVariableStore implements VariableStore {
  constructor(private readonly layers: ReadonlyArray<VariableStore>) {}

  get(name: string): VariableValue | undefined {
    for (const layer of this.layers) {
      const v = layer.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  getRequired(name: string): VariableValue {
    const v = this.get(name);
    if (v === undefined) throwVariableNotFound(name);
    return v;
  }

  getString(name: string): string | undefined {
    const v = this.get(name);
    if (v === undefined) return undefined;
    if (typeof v !== "string") throwVariableTypeMismatch(name, "string", typeof v);
    return v;
  }

  getNumber(name: string): number | undefined {
    const v = this.get(name);
    if (v === undefined) return undefined;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    throwVariableTypeMismatch(name, "number", typeof v);
  }

  getBoolean(name: string): boolean | undefined {
    const v = this.get(name);
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      if (lower === "true" || lower === "1") return true;
      if (lower === "false" || lower === "0") return false;
    }
    throwVariableTypeMismatch(name, "boolean", typeof v);
  }

  has(name: string): boolean {
    return this.layers.some((l) => l.has(name));
  }

  list(): readonly VariableEntry[] {
    // De-dup by name; earlier layers win.
    const seen = new Map<string, VariableEntry>();
    for (const layer of this.layers) {
      for (const entry of layer.list()) {
        if (!seen.has(entry.name)) seen.set(entry.name, entry);
      }
    }
    return Array.from(seen.values());
  }

  describe(name: string): VariableEntry | undefined {
    for (const layer of this.layers) {
      const e = layer.describe(name);
      if (e) return e;
    }
    return undefined;
  }
}

/** @deprecated Use `chainVariableStores`. */
export function chainSecretStores(
  ...layers: ReadonlyArray<SecretStore>
): SecretStore {
  return chainVariableStores(...layers);
}
