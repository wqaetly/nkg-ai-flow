/**
 * Storage contract for `RunRecord`s.
 *
 * Per `docs/specs/storage.md` §10.3, Run Record / Run Event / Trace /
 * Checkpoint are kept as separate stores. Runtime APIs depend only on
 * these interfaces - never on a concrete database. A SQLite-backed
 * implementation is provided alongside for the MVP; an in-memory
 * implementation is used by tests.
 */

import type { RunRecord, RunStatus } from "../types.js";

export interface RunStore {
  /** Insert a new Run. Throws if `runId` already exists. */
  create(record: RunRecord): Promise<void>;
  /** Read by id. Returns `undefined` when not found. */
  get(runId: string): Promise<RunRecord | undefined>;
  /**
   * Apply a partial update. Implementations must perform an atomic
   * read-modify-write for the listed fields only.
   */
  update(runId: string, patch: Partial<RunRecord> & { status?: RunStatus }): Promise<RunRecord>;
  /** List runs for a given flow id, newest first. */
  listByFlow(flowId: string, options?: { limit?: number }): Promise<RunRecord[]>;
}

/** In-memory RunStore used by tests and the default MVP runtime. */
export class InMemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();

  async create(record: RunRecord): Promise<void> {
    if (this.records.has(record.runId)) {
      throw new Error(`run ${record.runId} already exists`);
    }
    this.records.set(record.runId, { ...record });
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const r = this.records.get(runId);
    return r ? { ...r } : undefined;
  }

  async update(
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<RunRecord> {
    const existing = this.records.get(runId);
    if (!existing) {
      throw new Error(`run ${runId} not found`);
    }
    const merged: RunRecord = { ...existing, ...patch, runId, schemaVersion: existing.schemaVersion };
    this.records.set(runId, merged);
    return { ...merged };
  }

  async listByFlow(flowId: string, options: { limit?: number } = {}): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const r of this.records.values()) {
      if (r.flowId === flowId) out.push({ ...r });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return options.limit ? out.slice(0, options.limit) : out;
  }
}
