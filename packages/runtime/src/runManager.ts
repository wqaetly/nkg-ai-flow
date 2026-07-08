/**
 * RunManager: owns the lifecycle of a Run.
 *
 * Responsibilities (per `docs/specs/runtime-execution.md` §5.5):
 *   - create a Run, pin its Flow Version (do not chase later Registry
 *     promotions),
 *   - persist the RunRecord up-front so external observers can poll,
 *   - drive the ExecutionEngine end-to-end,
 *   - capture the final output / error and update the RunRecord,
 *   - expose `cancel(runId)` that aborts the active engine.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  normalizeError,
  type FlowGraph,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import type { EventBus } from "@ai-native-flow/event-bus";
import {
  chainVariableStores,
  type SecretStore,
  type VariableStore,
} from "@ai-native-flow/variable-store";
import { ExecutionEngine } from "./executionEngine.js";
import type { NodeInvokeFlow } from "./nodeContext.js";
import type { NodeRunnerRegistry } from "./nodeRunnerRegistry.js";
import type { RunStore } from "./storage/runStore.js";
import {
  RUN_RECORD_SCHEMA_VERSION,
  type RunRecord,
} from "./types.js";

export interface RunManagerOptions {
  runStore: RunStore;
  eventBus: EventBus;
  runners: NodeRunnerRegistry;
  variables: VariableStore;
  secrets: SecretStore;
  /** Dispatcher used by `send_event` nodes. */
  triggerEvent?: (event: string) => Promise<unknown>;
  /** Dispatcher used by `subflow` nodes. */
  invokeFlow?: NodeInvokeFlow;
  /**
   * Optional id generator. Defaults to a 26-char `run_<crypto>` string
   * generated via `crypto.randomUUID()`.
   */
  generateRunId?: () => string;
}

export interface CreateRunInput {
  flowId: string;
  flowVersion: string;
  flowArtifactHash: string;
  graph: FlowGraph;
  input: unknown;
  traceId?: string;
  subflowDepth?: number;
  /** Optional run-scoped variable overrides. */
  variables?: VariableStore;
  /** @deprecated Use `variables`; treated as the same store. */
  secrets?: SecretStore;
  /**
   * Sub-graph (sink-node) execution mode. When provided, the engine
   * runs only the upstream closure of this node and treats its
   * completion as the Run terminator. The RunRecord still carries
   * the original `flowId` / `flowVersion` so observability tooling
   * can correlate the partial run with its parent flow.
   *
   * See `docs/specs/runtime-execution.md` §5.5 "sink-node mode" and
   * `ExecutionEngineOptions.sinkNodeId`.
   */
  sinkNodeId?: string;
  /**
   * Optional event-trigger entry node. When set, the engine seeds this
   * node instead of all ordinary zero-indegree start nodes.
   */
  entryNodeId?: string;
}

export interface ExecuteResult {
  runRecord: RunRecord;
  succeeded: boolean;
  cancelled: boolean;
  output?: unknown;
  error?: RuntimeError;
}

export interface ExecuteOptions {
  sinkNodeId?: string;
  entryNodeId?: string;
  variables?: VariableStore;
  /** @deprecated Use `variables`; treated as the same store. */
  secrets?: SecretStore;
}

interface ActiveRun {
  controller: AbortController;
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly options: RunManagerOptions) {}

  /**
   * Create + execute a Run synchronously (resolves when the Run reaches
   * a terminal state). `cancel()` may be called from another async task.
   *
   * If `input.sinkNodeId` is set, runs the sub-graph terminating at that
   * node (sink-node mode); otherwise runs the full flow to its `end`
   * node. The RunRecord remains pinned to the original flow id/version
   * either way — sub-graph mode does **not** synthesise a transient
   * flow in the registry, so observability tooling sees a single
   * coherent timeline per logical flow.
   */
  async invoke(input: CreateRunInput): Promise<ExecuteResult> {
    const runRecord = await this.create(input);
    return this.execute(runRecord, input.graph, {
      ...(input.sinkNodeId !== undefined ? { sinkNodeId: input.sinkNodeId } : {}),
      ...(input.entryNodeId !== undefined ? { entryNodeId: input.entryNodeId } : {}),
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
      ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    });
  }

  /**
   * Two-phase variant: returns the RunRecord immediately once it is
   * persisted, plus a `completed` promise that resolves when the engine
   * reaches a terminal state. SSE / WebSocket transports use this so
   * they can subscribe to the EventBus on `runId` *before* the engine
   * starts emitting events.
   *
   * Mirrors `InvocationRouter.start` semantics; the router delegates to
   * this method for both full-flow and sub-graph runs.
   */
  async start(input: CreateRunInput): Promise<{
    runRecord: RunRecord;
    completed: Promise<ExecuteResult>;
  }> {
    const runRecord = await this.create(input);
    const completed = this.execute(runRecord, input.graph, {
      ...(input.sinkNodeId !== undefined ? { sinkNodeId: input.sinkNodeId } : {}),
      ...(input.entryNodeId !== undefined ? { entryNodeId: input.entryNodeId } : {}),
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
      ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    });
    return { runRecord, completed };
  }

  /** Create the Run and persist the initial record. */
  async create(input: CreateRunInput): Promise<RunRecord> {
    const runId = (this.options.generateRunId ?? defaultRunId)();
    const record: RunRecord = {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId,
      flowId: input.flowId,
      flowVersion: input.flowVersion,
      flowArtifactHash: input.flowArtifactHash,
      status: "queued",
      input: input.input,
      createdAt: new Date().toISOString(),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.subflowDepth !== undefined ? { subflowDepth: input.subflowDepth } : {}),
    };
    await this.options.runStore.create(record);
    return record;
  }

  /** Drive the ExecutionEngine for an already-created Run. */
  async execute(
    record: RunRecord,
    graph: FlowGraph,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const controller = new AbortController();
    this.active.set(record.runId, { controller });
    const startedAt = new Date().toISOString();
    await this.options.runStore.update(record.runId, {
      status: "running",
      startedAt,
    });

    let result;
    try {
      const variables =
        options.variables && options.secrets && options.secrets !== options.variables
          ? chainVariableStores(options.variables, options.secrets)
          : options.variables ?? options.secrets ?? this.options.variables;
      const engine = new ExecutionEngine({
        graph,
        runId: record.runId,
        flowId: record.flowId,
        flowVersion: record.flowVersion,
        runInput: record.input,
        subflowDepth: record.subflowDepth ?? 0,
        runners: this.options.runners,
        variables,
        secrets: variables,
        eventBus: this.options.eventBus,
        signal: controller.signal,
        triggerEvent: this.options.triggerEvent,
        invokeFlow: this.options.invokeFlow,
        ...(options.sinkNodeId !== undefined
          ? { sinkNodeId: options.sinkNodeId }
          : {}),
        ...(options.entryNodeId !== undefined
          ? { entryNodeId: options.entryNodeId }
          : {}),
      });
      result = await engine.run();
    } catch (cause) {
      const error = normalizeError(cause, {
        module: "run_manager",
        flowId: record.flowId,
        flowVersion: record.flowVersion,
      });
      const updated = await this.options.runStore.update(record.runId, {
        status: "failed",
        error,
        finishedAt: new Date().toISOString(),
      });
      this.active.delete(record.runId);
      return {
        runRecord: updated,
        succeeded: false,
        cancelled: false,
        error,
      };
    }

    const finishedAt = new Date().toISOString();
    let updated: RunRecord;
    if (result.cancelled) {
      updated = await this.options.runStore.update(record.runId, {
        status: "cancelled",
        finishedAt,
      });
    } else if (result.succeeded) {
      updated = await this.options.runStore.update(record.runId, {
        status: "succeeded",
        output: result.output,
        finishedAt,
      });
    } else {
      updated = await this.options.runStore.update(record.runId, {
        status: "failed",
        error: result.error,
        finishedAt,
      });
    }
    this.active.delete(record.runId);
    return {
      runRecord: updated,
      succeeded: result.succeeded,
      cancelled: result.cancelled,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  /** Abort an in-flight Run. No-op if the Run is already terminal. */
  async cancel(runId: string, reason?: string): Promise<void> {
    const entry = this.active.get(runId);
    if (!entry) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "run_manager.run_not_active",
          kind: "not_found",
          category: "user_input",
          message: `run ${runId} is not active`,
          source: { module: "run_manager" },
          context: { runId, reason },
        }),
      );
    }
    entry.controller.abort();
  }

  /** Read-through accessor for transports / inspectors. */
  async get(runId: string): Promise<RunRecord | undefined> {
    return this.options.runStore.get(runId);
  }
}

function defaultRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}
