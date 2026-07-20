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
  type VariableValue,
} from "@ai-native-flow/variable-store/browser";
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

export interface ResumeFromPointInput {
  flowId: string;
  flowVersion: string;
  flowArtifactHash: string;
  graph: FlowGraph;
  resumePointName: string;
  traceId?: string;
  subflowDepth?: number;
  /** Optional run-scoped variable overrides. */
  variables?: VariableStore;
  /** @deprecated Use `variables`; treated as the same store. */
  secrets?: SecretStore;
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

  /**
   * Resume a flow from a durable `resume_point` marker. The marker's
   * snapshot becomes the new Run input, and its `targetNodeId` becomes
   * the execution entry node.
   */
  async resumeFromPoint(input: ResumeFromPointInput): Promise<ExecuteResult> {
    const point = this.resolveResumePoint(input);
    return this.invoke({
      flowId: input.flowId,
      flowVersion: input.flowVersion,
      flowArtifactHash: input.flowArtifactHash,
      graph: input.graph,
      input: point.snapshot,
      entryNodeId: point.targetNodeId,
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.subflowDepth !== undefined ? { subflowDepth: input.subflowDepth } : {}),
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
      ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    });
  }

  /**
   * Two-phase counterpart of `resumeFromPoint()`, returning the run id
   * immediately plus a promise for terminal completion.
   */
  async startFromPoint(input: ResumeFromPointInput): Promise<{
    runRecord: RunRecord;
    completed: Promise<ExecuteResult>;
  }> {
    const point = this.resolveResumePoint(input);
    return this.start({
      flowId: input.flowId,
      flowVersion: input.flowVersion,
      flowArtifactHash: input.flowArtifactHash,
      graph: input.graph,
      input: point.snapshot,
      entryNodeId: point.targetNodeId,
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.subflowDepth !== undefined ? { subflowDepth: input.subflowDepth } : {}),
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
      ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    });
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
      const variables = selectVariableStore(
        options.variables,
        options.secrets,
        this.options.variables,
      );
      const engine = new ExecutionEngine({
        graph,
        runId: record.runId,
        flowId: record.flowId,
        flowVersion: record.flowVersion,
        ...(record.traceId !== undefined ? { traceId: record.traceId } : {}),
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

  private resolveResumePoint(input: ResumeFromPointInput): ResolvedResumePoint {
    const name = input.resumePointName.trim();
    if (name === "") {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "run_manager.resume_point_missing_name",
          kind: "validation",
          category: "user_input",
          message: "resumeFromPoint requires resumePointName",
          source: {
            module: "run_manager",
            flowId: input.flowId,
            flowVersion: input.flowVersion,
          },
        }),
      );
    }

    const variables = selectVariableStore(
      input.variables,
      input.secrets,
      this.options.variables,
    );
    const state = readResumePoint(name, variables.get(name));
    if (!state) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "run_manager.resume_point_missing",
          kind: "not_found",
          category: "user_input",
          message: `resume point "${name}" does not exist or is invalid`,
          source: {
            module: "run_manager",
            flowId: input.flowId,
            flowVersion: input.flowVersion,
          },
          context: { resumePointName: name },
        }),
      );
    }

    const now = Date.now();
    if (state.status === "expired" || (state.expiresAt !== null && now >= state.expiresAt)) {
      markResumePointExpired(name, state, variables, now);
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "run_manager.resume_point_expired",
          kind: "timeout",
          category: "user_input",
          message: `resume point "${name}" has expired`,
          source: {
            module: "run_manager",
            flowId: input.flowId,
            flowVersion: input.flowVersion,
          },
          context: { resumePointName: name, targetNodeId: state.targetNodeId },
        }),
      );
    }

    const exists = input.graph.nodes.some((node) => node.id === state.targetNodeId);
    if (!exists) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "flow.node.not_found",
          kind: "not_found",
          category: "user_input",
          message: `flow ${input.flowId}@${input.flowVersion} has no resume target node with id "${state.targetNodeId}"`,
          source: {
            module: "run_manager",
            flowId: input.flowId,
            flowVersion: input.flowVersion,
          },
          context: {
            resumePointName: name,
            targetNodeId: state.targetNodeId,
          },
        }),
      );
    }

    markResumePointLoaded(name, state, variables, now);
    return state;
  }
}

function defaultRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

interface ResolvedResumePoint {
  name: string;
  status: "ready" | "expired";
  targetNodeId: string;
  snapshot: VariableValue | null;
  reason: string;
  sourceRunId: string;
  version: number;
  markedAt: number;
  loadedAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

function selectVariableStore(
  variables: VariableStore | undefined,
  secrets: SecretStore | undefined,
  fallback: VariableStore,
): VariableStore {
  return variables && secrets && secrets !== variables
    ? chainVariableStores(variables, secrets)
    : variables ?? secrets ?? fallback;
}

function readResumePoint(
  expectedName: string,
  value: unknown,
): ResolvedResumePoint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const targetNodeId =
    typeof record.targetNodeId === "string" ? record.targetNodeId : "";
  if (name !== expectedName || targetNodeId === "") return null;
  return {
    name,
    status: record.status === "expired" ? "expired" : "ready",
    targetNodeId,
    snapshot: toJsonValue(record.snapshot) ?? null,
    reason: typeof record.reason === "string" ? record.reason : "",
    sourceRunId: typeof record.sourceRunId === "string" ? record.sourceRunId : "",
    version: readNonNegativeInteger(record.version),
    markedAt: readTimestamp(record.markedAt) ?? Date.now(),
    loadedAt: readTimestamp(record.loadedAt),
    expiresAt: readTimestamp(record.expiresAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function markResumePointLoaded(
  name: string,
  state: ResolvedResumePoint,
  store: VariableStore,
  now: number,
): void {
  if (!isMutableVariableStore(store)) return;
  store.set(name, toVariableValue({ ...state, status: "ready", loadedAt: now, updatedAt: now }));
}

function markResumePointExpired(
  name: string,
  state: ResolvedResumePoint,
  store: VariableStore,
  now: number,
): void {
  if (!isMutableVariableStore(store)) return;
  store.set(name, toVariableValue({ ...state, status: "expired", updatedAt: now }));
}

function isMutableVariableStore(
  value: VariableStore,
): value is VariableStore & { set(name: string, value: VariableValue): void } {
  return typeof (value as { set?: unknown }).set === "function";
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function toJsonValue(value: unknown): VariableValue | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(toJsonValue);
    return items.some((item) => item === undefined)
      ? undefined
      : (items as VariableValue[]);
  }
  if (value && typeof value === "object") {
    const out: Record<string, VariableValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item);
      if (converted === undefined) return undefined;
      out[key] = converted;
    }
    return out;
  }
  return undefined;
}

function toVariableValue(state: ResolvedResumePoint): VariableValue {
  return {
    name: state.name,
    status: state.status,
    targetNodeId: state.targetNodeId,
    snapshot: state.snapshot,
    reason: state.reason,
    sourceRunId: state.sourceRunId,
    version: state.version,
    markedAt: state.markedAt,
    loadedAt: state.loadedAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}
