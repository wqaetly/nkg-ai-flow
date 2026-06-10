/**
 * Storage contract for the Runtime Registry.
 *
 * Phase 1 only models the `flowId -> activeVersion` pointer plus a list of
 * registered (versioned) Flow Artifacts. Per
 * `docs/specs/runtime-execution.md` §5.3, promotion must be atomic; the
 * in-memory implementation enforces this trivially because writes are
 * synchronous, while a SQLite implementation would do it inside a
 * transaction.
 */

import type { FlowVersionRef } from "../types.js";

export interface RegistryStore {
  /** Register a new Flow Version (any status). */
  put(ref: FlowVersionRef): Promise<void>;
  /** Look up a specific (flowId, version). */
  get(flowId: string, version: string): Promise<FlowVersionRef | undefined>;
  /** List all known versions for a flow. */
  list(flowId: string): Promise<FlowVersionRef[]>;
  /** Atomic pointer set: returns the previous active version (if any). */
  promote(flowId: string, version: string): Promise<FlowVersionRef | undefined>;
  /** Read the current active version for a flow. */
  active(flowId: string): Promise<FlowVersionRef | undefined>;
}

export class InMemoryRegistryStore implements RegistryStore {
  /** Map<flowId, Map<version, ref>> */
  private readonly versions = new Map<string, Map<string, FlowVersionRef>>();
  private readonly activeByFlow = new Map<string, string>();

  async put(ref: FlowVersionRef): Promise<void> {
    let perFlow = this.versions.get(ref.flowId);
    if (!perFlow) {
      perFlow = new Map();
      this.versions.set(ref.flowId, perFlow);
    }
    perFlow.set(ref.version, { ...ref });
  }

  async get(flowId: string, version: string): Promise<FlowVersionRef | undefined> {
    const r = this.versions.get(flowId)?.get(version);
    return r ? { ...r } : undefined;
  }

  async list(flowId: string): Promise<FlowVersionRef[]> {
    const perFlow = this.versions.get(flowId);
    return perFlow ? Array.from(perFlow.values(), (r) => ({ ...r })) : [];
  }

  async promote(
    flowId: string,
    version: string,
  ): Promise<FlowVersionRef | undefined> {
    const perFlow = this.versions.get(flowId);
    const target = perFlow?.get(version);
    if (!perFlow || !target) {
      throw new Error(`flow ${flowId}@${version} not registered`);
    }

    const previousVersion = this.activeByFlow.get(flowId);
    let previous: FlowVersionRef | undefined;
    if (previousVersion && previousVersion !== version) {
      const prevRef = perFlow.get(previousVersion);
      if (prevRef) {
        prevRef.status = "draining";
        previous = { ...prevRef };
      }
    }

    target.status = "active";
    this.activeByFlow.set(flowId, version);

    return previous;
  }

  async active(flowId: string): Promise<FlowVersionRef | undefined> {
    const v = this.activeByFlow.get(flowId);
    if (!v) return undefined;
    const ref = this.versions.get(flowId)?.get(v);
    return ref ? { ...ref } : undefined;
  }
}
