/**
 * Runtime Registry: thin wrapper that combines `RegistryStore` (versioning
 * pointer) with `ArtifactStore` (Flow JSON content) and the
 * `flow-validator` to ensure that whatever a Run ends up pinned to is
 * valid and intact.
 *
 * Responsibilities (per `docs/specs/runtime-execution.md` §5.3 / §5.5):
 *   - register / promote Flow Versions atomically,
 *   - resolve `flowId -> active version`,
 *   - load a Flow Artifact by `(flowId, version)` with hash verification,
 *   - keep validated `FlowGraph`s warm in memory for fast Run creation.
 *
 * This module is internal to `packages/runtime` (per AI Implementation
 * Guide §3) and is not promoted to a standalone package in Phase 1.
 */

import {
  RuntimeErrorException,
  createDefaultRegistry,
  createRuntimeError,
  type FlowGraph,
  type NodeTypeRegistry,
} from "@ai-native-flow/flow-ir";
import { validateFlow } from "@ai-native-flow/flow-validator";
import type { ArtifactStore } from "./storage/artifactStore.js";
import type { RegistryStore } from "./storage/registryStore.js";
import {
  InMemoryRegistryStore,
} from "./storage/registryStore.js";
import { sha256Hex } from "./storage/artifactStore.js";
import type { FlowVersionRef } from "./types.js";

export interface EventTriggerRef {
  event: string;
  flowId: string;
  flowVersion: string;
  flowArtifactHash: string;
  nodeId: string;
  graph: FlowGraph;
}

export interface RuntimeRegistryOptions {
  registryStore?: RegistryStore;
  artifactStore?: ArtifactStore;
  /** Used when validating registered flows. Defaults to the built-in registry. */
  nodeTypeRegistry?: NodeTypeRegistry;
}

export class RuntimeRegistry {
  private readonly store: RegistryStore;
  private readonly artifactStore: ArtifactStore | undefined;
  private readonly nodeTypeRegistry: NodeTypeRegistry;
  /** In-memory cache: `${flowId}@${version}` -> FlowVersionRef. */
  private readonly cache = new Map<string, FlowVersionRef>();
  /** Active event triggers, keyed by event string. */
  private readonly activeEventTriggers = new Map<string, EventTriggerRef[]>();

  constructor(options: RuntimeRegistryOptions = {}) {
    this.store = options.registryStore ?? new InMemoryRegistryStore();
    this.artifactStore = options.artifactStore;
    this.nodeTypeRegistry = options.nodeTypeRegistry ?? createDefaultRegistry();
  }

  /**
   * Register a Flow Artifact. The graph is validated synchronously so
   * malformed flows never enter the registry. If an `ArtifactStore` is
   * configured, the canonical JSON is written there as well so future
   * Runs can rehydrate without keeping the graph in memory.
   */
  async register(args: {
    graph: FlowGraph;
    /** Pre-computed canonical JSON (e.g. from `dump()`). */
    json?: string;
    status?: FlowVersionRef["status"];
  }): Promise<FlowVersionRef> {
    const { graph } = args;
    const status = args.status ?? "staging";
    const validation = validateFlow(graph, { registry: this.nodeTypeRegistry });
    if (!validation.flow) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "registry.flow_invalid",
          kind: "validation",
          category: "author",
          message: `flow ${graph.id}@${graph.version} failed validation`,
          source: { module: "registry", flowId: graph.id, flowVersion: graph.version },
          context: { errors: validation.result.errors },
        }),
      );
    }

    const json = args.json ?? JSON.stringify(graph);
    const hash = sha256Hex(json);

    if (this.artifactStore) {
      await this.artifactStore.putFlow(graph.id, graph.version, json);
    }

    const ref: FlowVersionRef = {
      flowId: graph.id,
      version: graph.version,
      artifactHash: hash,
      status,
      graph: validation.flow,
      registeredAt: new Date().toISOString(),
    };
    await this.store.put(ref);
    this.cache.set(cacheKey(graph.id, graph.version), ref);
    if (ref.status === "active") {
      this.reindexActiveFlow(ref);
    }
    return ref;
  }

  /** Atomic promotion of a registered version to `active`. */
  async promote(flowId: string, version: string): Promise<void> {
    await this.store.promote(flowId, version);
    // Invalidate cache so subsequent reads pick up the new status.
    this.cache.delete(cacheKey(flowId, version));
    const active = await this.store.active(flowId);
    if (active) this.reindexActiveFlow(active);
  }

  /** Resolve the active version for a flow. */
  async getActive(flowId: string): Promise<FlowVersionRef> {
    const ref = await this.store.active(flowId);
    if (!ref) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "registry.no_active_version",
          kind: "not_found",
          category: "user_input",
          message: `no active version for flow ${flowId}`,
          source: { module: "registry", flowId },
          context: { flowId },
        }),
      );
    }
    return ref;
  }

  /**
   * Resolve a (flowId, version) pair, optionally reading from the
   * ArtifactStore and verifying the hash matches.
   */
  async resolve(flowId: string, version: string): Promise<FlowVersionRef> {
    const cached = this.cache.get(cacheKey(flowId, version));
    if (cached) return cached;
    const ref = await this.store.get(flowId, version);
    if (!ref) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "registry.version_not_found",
          kind: "not_found",
          category: "user_input",
          message: `flow ${flowId}@${version} not registered`,
          source: { module: "registry", flowId, flowVersion: version },
          context: { flowId, flowVersion: version },
        }),
      );
    }
    if (this.artifactStore) {
      const json = await this.artifactStore.getFlowJson(
        flowId,
        version,
        ref.artifactHash,
      );
      ref.graph = JSON.parse(json) as FlowGraph;
    }
    this.cache.set(cacheKey(flowId, version), ref);
    return ref;
  }

  /** Convenience: list every registered version for a flow. */
  async list(flowId: string): Promise<FlowVersionRef[]> {
    return this.store.list(flowId);
  }

  /** Return active flow entry-points that listen for a given string event. */
  getEventTriggers(event: string): EventTriggerRef[] {
    return [...(this.activeEventTriggers.get(event) ?? [])];
  }

  private reindexActiveFlow(ref: FlowVersionRef): void {
    this.removeActiveFlowTriggers(ref.flowId);
    for (const node of ref.graph.nodes) {
      if (node.type !== "event_trigger") continue;
      const event = node.config.event;
      if (typeof event !== "string" || event.length === 0) continue;
      const trigger: EventTriggerRef = {
        event,
        flowId: ref.flowId,
        flowVersion: ref.version,
        flowArtifactHash: ref.artifactHash,
        nodeId: node.id,
        graph: ref.graph,
      };
      const list = this.activeEventTriggers.get(event) ?? [];
      list.push(trigger);
      this.activeEventTriggers.set(event, list);
    }
  }

  private removeActiveFlowTriggers(flowId: string): void {
    for (const [event, triggers] of this.activeEventTriggers) {
      const remaining = triggers.filter((trigger) => trigger.flowId !== flowId);
      if (remaining.length === 0) {
        this.activeEventTriggers.delete(event);
      } else if (remaining.length !== triggers.length) {
        this.activeEventTriggers.set(event, remaining);
      }
    }
  }
}

function cacheKey(flowId: string, version: string): string {
  return `${flowId}@${version}`;
}
