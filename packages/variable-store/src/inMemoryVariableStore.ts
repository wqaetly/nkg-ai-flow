/**
 * In-memory implementation of `MutableVariableStore`.
 *
 * Used as:
 *   - the default store inside the runtime,
 *   - the `chain()` building block on top of file / env loaders,
 *   - the test fixture for any node that consumes variables.
 */

import {
  throwVariableNotFound,
  throwVariableTypeMismatch,
} from "./errors.js";
import type {
  MutableVariableStore,
  VariableEntry,
  VariableMetadata,
  VariableValue,
} from "./types.js";

export class InMemoryVariableStore implements MutableVariableStore {
  private readonly entries = new Map<string, VariableEntry>();

  constructor(initial?: Iterable<VariableEntry>) {
    if (initial) {
      for (const entry of initial) this.set(entry.name, entry.value, entry.metadata);
    }
  }

  get(name: string): VariableValue | undefined {
    return this.entries.get(name)?.value;
  }

  getRequired(name: string): VariableValue {
    const e = this.entries.get(name);
    if (!e) throwVariableNotFound(name);
    return e.value;
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
    return this.entries.has(name);
  }

  list(): readonly VariableEntry[] {
    return Array.from(this.entries.values(), cloneEntry);
  }

  describe(name: string): VariableEntry | undefined {
    const e = this.entries.get(name);
    return e ? cloneEntry(e) : undefined;
  }

  set(name: string, value: VariableValue, metadata?: VariableMetadata): void {
    const meta: VariableMetadata = {
      ...(metadata ?? {}),
      updatedAt: metadata?.updatedAt ?? new Date().toISOString(),
    };
    const existing = this.entries.get(name);
    const merged: VariableEntry =
      metadata === undefined && existing
        ? { name, value, metadata: { ...existing.metadata, updatedAt: meta.updatedAt } }
        : { name, value, metadata: meta };
    this.entries.set(name, merged);
  }

  delete(name: string): boolean {
    return this.entries.delete(name);
  }
}

function cloneEntry(entry: VariableEntry): VariableEntry {
  return {
    name: entry.name,
    value: entry.value,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}
