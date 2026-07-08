/**
 * ExecutionEngine: drives a single Run from `start` node(s) until every
 * reachable branch has either terminated at an `end` node, errored, or
 * been cancelled. The Run's `output` is taken from the first `end` node
 * to complete (subsequent ends keep running but do not overwrite the
 * captured output); see runtime-execution.md §5.6 for the rationale.
 *
 * Phase 1 scope:
 *   - Topological / control-flow based BFS scheduler. The flow-validator
 *     already guarantees DAG-shape so we do not need cycle detection here.
 *   - Each node receives a unified `NodeInputs` bag containing:
 *       - `__config__`     : node.config with `$var` resolved,
 *       - `__runInput__`   : the original Run input (always present),
 *       - one entry per inbound port, keyed by the port id, holding the
 *         value the upstream node emitted on the connected output port.
 *         Control ports carry `null`. Data ports carry the upstream
 *         output value.
 *       - For convenience, when the node has no inbound data ports, the
 *         keys `input` and `in` are aliased to `__runInput__` so simple
 *         `start -> transform -> end` flows can author plain `${input.x}`
 *         templates without an explicit data wiring.
 *   - Scheduler waits for ALL inbound control + data edges before firing
 *     a node (`all-join` semantics from §5.6 of runtime-execution.md).
 *   - Errors flow through the optional `error` port; if no `error` port
 *     is wired, the Run fails with `run_failed`.
 *   - Cancellation: `runOptions.signal` aborts every in-flight runner.
 *
 * Later phases add loop blocks, explicit parallel/join nodes, retry /
 * timeout policy, checkpoint nodes, resume points, and event replay.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  normalizeError,
  type EdgeDefinition,
  type FlowGraph,
  type NodeInstance,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import type { EventBus } from "@ai-native-flow/event-bus";
import {
  resolveRefs,
  type SecretStore,
  type VariableStore,
} from "@ai-native-flow/variable-store";
import type {
  NodeContext,
  NodeInputs,
  NodeInvokeFlow,
  NodeLogger,
  NodeOutputs,
  NodeResult,
} from "./nodeContext.js";
import { NodeEventChannel } from "./nodeEventChannel.js";
import type { NodeRunnerRegistry } from "./nodeRunnerRegistry.js";
import { evaluateCondition } from "./nodes/builtin/_helpers.js";

export interface ExecutionEngineOptions {
  graph: FlowGraph;
  runId: string;
  flowId: string;
  flowVersion: string;
  runInput: unknown;
  runners: NodeRunnerRegistry;
  variables: VariableStore;
  /** @deprecated Use `variables`; treated as the same store. */
  secrets: SecretStore;
  eventBus: EventBus;
  /** Per-node soft timeout in milliseconds. Defaults to 30s. */
  defaultTimeoutMs?: number;
  /** External cancellation signal (e.g. from RunManager.cancel). */
  signal?: AbortSignal;
  /** Runtime event trigger dispatcher exposed to `send_event` nodes. */
  triggerEvent?: (event: string) => Promise<unknown>;
  /** Registered-flow invocation dispatcher exposed to `subflow` nodes. */
  invokeFlow?: NodeInvokeFlow;
  /** Depth of nested subflow invocation; root runs are 0. */
  subflowDepth?: number;
  /**
   * Sub-graph execution mode. When set, the engine restricts itself to
   * `sinkNodeId` plus its transitive upstream closure (computed from the
   * inbound edges of the original graph), and treats `sinkNodeId`'s
   * completion as the terminal condition. The Run output is taken from
   * the first non-control / non-error data output port of the sink node.
   *
   * In sub-graph mode the requirement "every Run must reach an `end`
   * node" is dropped: the closure may or may not contain an `end` node,
   * and either way the sink is the terminator.
   *
   * This is the mechanism behind `runManager.invokeNode()` / Studio's
   * "Run this node" right-click action — see
   * `docs/specs/transports.md` §8.1.
   */
  sinkNodeId?: string;
  /**
   * Explicit entry node for trigger-driven runs. When present, the
   * scheduler starts from this node instead of ordinary zero-indegree
   * seeds.
   */
  entryNodeId?: string;
}

export interface ExecutionResult {
  /** Final Run output. Populated on success only. */
  output?: unknown;
  /** Final error. Populated on failure only. */
  error?: RuntimeError;
  /** True if the run completed via `end` node, false on error / cancel. */
  succeeded: boolean;
  /** True if cancellation aborted the run. */
  cancelled: boolean;
}

export class ExecutionEngine {
  /** Outputs each node has emitted, keyed by `${nodeId}.${portId}`. */
  private readonly portValues = new Map<string, unknown>();
  /** Per-node count of remaining required inbound edges. */
  private readonly remainingDeps = new Map<string, number>();
  /** Nodes already executed by the main DAG scheduler. */
  private readonly completedNodeIds = new Set<string>();
  /** Per-node input overrides used by block runners when aggregating loop results. */
  private readonly inputOverrides = new Map<string, unknown>();
  /** Per-node progress event sequence, kept away from node lifecycle seq 1/2. */
  private readonly progressSeq = new Map<string, number>();
  /** Node lookup by id. */
  private readonly nodesById = new Map<string, NodeInstance>();
  /** Outbound edges per node id. */
  private readonly outEdges = new Map<string, EdgeDefinition[]>();
  /** Inbound edges per node id. */
  private readonly inEdges = new Map<string, EdgeDefinition[]>();
  /** Final Run output (captured from `end` node `result` field). */
  private finalOutput: unknown = undefined;
  /** Whether `end` node has completed. */
  private endReached = false;
  /** Per-attempt counter for runners (Phase 1 always runs attempt=1). */
  private readonly attempt = 1;

  /**
   * Set of node ids that participate in execution. In full-graph mode
   * this contains every node in `graph.nodes`; in sub-graph mode (see
   * `options.sinkNodeId`) it is the upstream closure of the sink node.
   */
  private readonly activeNodeIds: Set<string>;
  /** Sink node id when running in sub-graph mode, otherwise undefined. */
  private readonly sinkNodeId: string | undefined;
  private readonly entryNodeId: string | undefined;

  constructor(private readonly options: ExecutionEngineOptions) {
    for (const node of options.graph.nodes) this.nodesById.set(node.id, node);

    // Compute the active node set first so edge tables only reflect the
    // sub-graph in `sinkNodeId` mode. We walk inbound edges from the
    // sink, pulling in every transitive upstream node. The sink itself
    // is always included.
    if (options.sinkNodeId !== undefined) {
      if (!this.nodesById.has(options.sinkNodeId)) {
        throw new RuntimeErrorException(
          createRuntimeError({
            code: "execution_engine.sink_node_not_found",
            kind: "validation",
            category: "user_input",
            message: `sink node "${options.sinkNodeId}" is not in flow ${options.flowId}@${options.flowVersion}`,
            source: {
              module: "execution_engine",
              flowId: options.flowId,
              flowVersion: options.flowVersion,
            },
            context: { sinkNodeId: options.sinkNodeId },
          }),
        );
      }
      this.activeNodeIds = computeUpstreamClosure(
        options.graph,
        options.sinkNodeId,
      );
      this.sinkNodeId = options.sinkNodeId;
    } else {
      this.activeNodeIds = new Set(options.graph.nodes.map((n) => n.id));
      this.sinkNodeId = undefined;
    }
    if (
      options.entryNodeId !== undefined &&
      !this.activeNodeIds.has(options.entryNodeId)
    ) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "execution_engine.entry_node_not_found",
          kind: "validation",
          category: "user_input",
          message: `entry node "${options.entryNodeId}" is not in flow ${options.flowId}@${options.flowVersion}`,
          source: {
            module: "execution_engine",
            flowId: options.flowId,
            flowVersion: options.flowVersion,
          },
          context: { entryNodeId: options.entryNodeId },
        }),
      );
    }
    this.entryNodeId = options.entryNodeId;

    for (const edge of options.graph.edges) {
      // In sub-graph mode keep only edges whose endpoints are both inside
      // the active set. Outgoing edges from the sink (or any active
      // node) into the post-sink portion of the graph would otherwise
      // dirty `remainingDeps` for nodes we never plan to execute.
      if (
        !this.activeNodeIds.has(edge.from.nodeId) ||
        !this.activeNodeIds.has(edge.to.nodeId)
      ) {
        continue;
      }
      pushEdge(this.outEdges, edge.from.nodeId, edge);
      pushEdge(this.inEdges, edge.to.nodeId, edge);
    }
    for (const nodeId of this.activeNodeIds) {
      const node = this.nodesById.get(nodeId);
      this.remainingDeps.set(
        nodeId,
        requiredInboundCount(node, this.inEdges.get(nodeId)?.length ?? 0),
      );
    }
  }

  async run(): Promise<ExecutionResult> {
    const { graph, signal, eventBus, runId, flowId, flowVersion, runInput } =
      this.options;

    await eventBus.publish({
      runId,
      flowId,
      flowVersion,
      seq: 0,
      kind: "run_started",
      payload: { input: runInput },
    });

    // Seeds for BFS: every node in the active set with zero inbound
    // edges *within* that set. In full-graph mode this is the set of
    // `start` nodes (they declare no inbound edges); in sub-graph mode
    // it includes any active upstream node whose inbound edges all sit
    // outside the closure (which can't happen by construction — closure
    // is upstream-saturated) plus the original `start` nodes that fall
    // inside the closure.
    const seeds: string[] = [];
    if (this.entryNodeId !== undefined) {
      seeds.push(this.entryNodeId);
    } else {
      for (const nodeId of this.activeNodeIds) {
        if ((this.remainingDeps.get(nodeId) ?? 0) !== 0) continue;
        const node = this.nodesById.get(nodeId);
        if (node?.type === "event_trigger") continue;
        seeds.push(nodeId);
      }
    }
    if (seeds.length === 0) {
      const error = createRuntimeError({
        code: this.sinkNodeId
          ? "execution_engine.subgraph_no_seed"
          : "execution_engine.no_start_node",
        kind: "validation",
        category: "author",
        message: this.sinkNodeId
          ? `sub-graph for sink "${this.sinkNodeId}" has no seed node (no zero-indegree node in the upstream closure)`
          : "flow has no `start` node",
        source: { module: "execution_engine", flowId, flowVersion },
        ...(this.sinkNodeId
          ? { context: { sinkNodeId: this.sinkNodeId } }
          : {}),
      });
      await this.publishRunFailed(error);
      return { succeeded: false, cancelled: false, error };
    }

    const queue: string[] = seeds;
    let cancelled = false;
    const schedulerConcurrency = Math.max(
      1,
      Math.trunc(
        this.options.variables.getNumber("FLOW_SCHEDULER_CONCURRENCY") ?? 16,
      ),
    );

    try {
      while (queue.length > 0) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        const nodeId = queue.shift()!;
        if (this.completedNodeIds.has(nodeId)) continue;
        const node = this.nodesById.get(nodeId);
        if (!node) continue;

        const batch = this.dequeueReadyBatch(node, queue, schedulerConcurrency);
        const results = await Promise.all(
          batch.map(async (batchNode) => ({
            node: batchNode,
            result: await this.executeNode(batchNode),
          })),
        );

        let reachedSink = false;
        for (const { node: executedNode, result } of results) {
          const handled = await this.finishScheduledNode(
            executedNode,
            result,
            queue,
          );
          if (handled.kind === "failed") {
            return { succeeded: false, cancelled: false, error: handled.error };
          }
          if (handled.kind === "sink_reached") {
            reachedSink = true;
            break;
          }
        }
        if (reachedSink) break;
      }
    } catch (cause) {
      const error = normalizeError(cause, {
        module: "execution_engine",
        flowId,
        flowVersion,
      });
      await this.publishRunFailed(error);
      return { succeeded: false, cancelled: false, error };
    }

    if (cancelled) {
      await eventBus.publish({
        runId,
        flowId,
        flowVersion,
        seq: 0,
        kind: "run_cancelled",
        payload: { reason: "external cancellation" },
      });
      return { succeeded: false, cancelled: true };
    }

    if (!this.endReached) {
      if (this.sinkNodeId !== undefined) {
        // Sub-graph mode: scheduling drained the active set without ever
        // running the sink node. That means the closure was malformed —
        // some upstream prerequisite never produced an output that
        // satisfied the sink's join — and we surface it explicitly
        // rather than silently returning `undefined`.
        const error = createRuntimeError({
          code: "execution_engine.sink_unreachable",
          kind: "internal",
          category: "system",
          message: `sub-graph drained without reaching sink node "${this.sinkNodeId}"`,
          source: { module: "execution_engine", flowId, flowVersion },
          context: { sinkNodeId: this.sinkNodeId },
        });
        await this.publishRunFailed(error);
        return { succeeded: false, cancelled: false, error };
      }
      // Full-graph mode: graph exhausted but no `end` node fired - treat
      // as success with whatever the last node emitted (Phase 1 simple
      // semantics) when an `end` node is absent, otherwise as a Run
      // failure.
      const hasEnd = graph.nodes.some((n) => n.type === "end");
      if (hasEnd) {
        const error = createRuntimeError({
          code: "execution_engine.end_unreachable",
          kind: "internal",
          category: "system",
          message: "flow ended without reaching the `end` node",
          source: { module: "execution_engine", flowId, flowVersion },
        });
        await this.publishRunFailed(error);
        return { succeeded: false, cancelled: false, error };
      }
    }

    await eventBus.publish({
      runId,
      flowId,
      flowVersion,
      seq: 0,
      kind: "run_finished",
      payload: { output: this.finalOutput },
    });
    return { succeeded: true, cancelled: false, output: this.finalOutput };
  }

  private dequeueReadyBatch(
    firstNode: NodeInstance,
    queue: string[],
    schedulerConcurrency: number,
  ): NodeInstance[] {
    if (!this.canRunInReadyBatch(firstNode)) return [firstNode];

    const batch = [firstNode];
    for (let index = 0; index < queue.length && batch.length < schedulerConcurrency;) {
      const nodeId = queue[index]!;
      if (this.completedNodeIds.has(nodeId)) {
        queue.splice(index, 1);
        continue;
      }
      const candidate = this.nodesById.get(nodeId);
      if (!candidate) {
        queue.splice(index, 1);
        continue;
      }
      if (!this.canRunInReadyBatch(candidate)) {
        index += 1;
        continue;
      }
      batch.push(candidate);
      queue.splice(index, 1);
    }
    return batch;
  }

  private canRunInReadyBatch(node: NodeInstance): boolean {
    return loopSpecFor(node.type) === undefined;
  }

  private async finishScheduledNode(
    node: NodeInstance,
    result: NodeResult,
    queue: string[],
  ): Promise<ScheduledFinish> {
    this.completedNodeIds.add(node.id);
    if (result.kind === "skip") return { kind: "completed" };
    if (result.kind === "error") {
      const handled = await this.routeErrorOrFail(node, result.error, queue);
      return handled ? { kind: "completed" } : { kind: "failed", error: result.error };
    }
    if (await this.executeLoopBlock(node, queue)) {
      return { kind: "completed" };
    }

    // success: propagate outputs along outgoing edges
    this.recordOutputs(node, result.outputs);
    this.enqueueReadyDownstream(node, result.outputs, queue);

    if (this.sinkNodeId !== undefined) {
      // Sub-graph mode: the sink node's completion is the Run
      // terminator. We pick the first non-control / non-error data
      // output port on the sink as the final output (matching the
      // "primary data output" convention used by `findUpstreamData`).
      if (node.id === this.sinkNodeId) {
        this.finalOutput = pickPrimaryDataOutput(node, result.outputs);
        this.endReached = true;
        return { kind: "sink_reached" };
      }
    } else if (node.type === "end") {
      // Full-graph mode: `end` runner stores final result in
      // outputs.result; capture it and mark the run as complete.
      // We do NOT stop the run here — per docs/specs/runtime-execution.md
      // §5.6, `run_finished` must be published only after every reachable
      // branch reaches a terminal state.
      //
      // The `??` keeps the *first* end node's `result` as the Run output,
      // matching single-end flow behavior. Phase 2 will introduce an
      // explicit join / merge node to make the multi-end output policy
      // authorable.
      this.finalOutput = result.outputs.result ?? this.finalOutput;
      this.endReached = true;
    }

    return { kind: "completed" };
  }

  /* ---------------------------------------------------------------------- */
  /* Node execution                                                          */
  /* ---------------------------------------------------------------------- */

  private async executeNode(
    node: NodeInstance,
    state: ExecutionState = this.defaultExecutionState(),
  ): Promise<NodeResult> {
    const { eventBus, runId, flowId, flowVersion, signal } = this.options;
    const inputs = this.assembleInputs(node, state);
    const startedAt = Date.now();

    await eventBus.publish({
      runId,
      flowId,
      flowVersion,
      nodeId: node.id,
      nodeVersion: node.typeVersion,
      attempt: this.attempt,
      seq: 1,
      kind: "node_started",
      payload: { input: redactInputs(inputs) },
    });

    const sandbox = this.options.runners.getSandbox(node.type, node.typeVersion);
    const ac = new AbortController();
    const timeoutMs =
      readRuntimeTimeoutMs(
        inputs.__config__,
        this.options.defaultTimeoutMs ??
          this.options.variables.getNumber("FLOW_DEFAULT_NODE_TIMEOUT_MS") ??
          30000,
      );
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, timeoutMs)
        : undefined;

    // Per-(node, attempt) channel: it allocates the seq numbers for every
    // event emitted from this node (logger, ctx.emit, ctx.stream) and
    // owns the stream registry. seq 1 is `node_started` (already
    // published above); seq 2 is `node_finished` / `node_error` (emitted
    // below); the channel starts at seq 3.
    const channel = new NodeEventChannel({
      eventBus,
      runId,
      flowId,
      flowVersion,
      nodeId: node.id,
      nodeVersion: node.typeVersion,
      attempt: this.attempt,
      initialSeq: 3,
    });

    const ctx: NodeContext = {
      runId,
      flowId,
      flowVersion,
      nodeId: node.id,
      nodeType: node.type,
      nodeVersion: node.typeVersion,
      attempt: this.attempt,
      subflowDepth: this.options.subflowDepth ?? 0,
      variables: this.options.variables,
      secrets: this.options.variables,
      log: makeNodeLogger(channel),
      signal: ac.signal,
      triggerEvent:
        this.options.triggerEvent ??
        (async () => {
          throw new Error("runtime event triggers are not configured");
        }),
      invokeFlow:
        this.options.invokeFlow ??
        (async () => {
          throw new Error("runtime flow invocation is not configured");
        }),
      emit: (event) => channel.emit(event),
      stream: (portId, options) => channel.stream(portId, options),
    };

    let result: NodeResult;
    try {
      // The runtime's `NodeContext` is a strict structural superset of the
      // sandbox's `SandboxNodeContext` (see docs/specs/sandbox.md §3): every
      // field the sandbox cares about is present, and the cast keeps the
      // boundary explicit. Going through `sandbox.execute()` lets
      // `inflight()` accounting and `drain()`/`dispose()` work uniformly
      // for every runner handle registered through the sandbox seam.
      result = (await sandbox.execute(
        inputs,
        ctx as unknown as Parameters<typeof sandbox.execute>[1],
      )) as NodeResult;
    } catch (cause) {
      result = {
        kind: "error",
        error: normalizeError(cause, {
          module: "node_logic",
          flowId,
          flowVersion,
          nodeId: node.id,
        }),
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (timedOut && result.kind !== "error") {
      result = {
        kind: "error",
        error: createRuntimeError({
          code: "node.timeout",
          kind: "timeout",
          category: "system",
          message: `node "${node.id}" exceeded runtimeTimeoutMs ${timeoutMs}ms`,
          retryable: true,
          source: {
            module: "execution_engine",
            flowId,
            flowVersion,
            nodeId: node.id,
          },
          context: { timeoutMs },
        }),
      };
    }

    // Auto-close any stream the runner left open. The reason flag tells
    // downstream consumers whether the closure is benign (the runner
    // returned without explicit close()) or correlates with cancellation
    // / a node error.
    if (!channel.allStreamsClosed) {
      const reason: "auto" | "cancelled" | "errored" = ac.signal.aborted
        ? "cancelled"
        : result.kind === "error"
          ? "errored"
          : "auto";
      await channel.closeOpenStreams(reason);
    }

    const durationMs = Date.now() - startedAt;
    if (result.kind === "success") {
      await eventBus.publish({
        runId,
        flowId,
        flowVersion,
        nodeId: node.id,
        nodeVersion: node.typeVersion,
        attempt: this.attempt,
        seq: 2,
        kind: "node_finished",
        payload: { output: redactInputs(result.outputs), durationMs },
      });
    } else if (result.kind === "error") {
      await eventBus.publish({
        runId,
        flowId,
        flowVersion,
        nodeId: node.id,
        nodeVersion: node.typeVersion,
        attempt: this.attempt,
        seq: 2,
        kind: "node_error",
        payload: { error: result.error, durationMs },
      });
    }

    return result;
  }

  private assembleInputs(
    node: NodeInstance,
    state: ExecutionState = this.defaultExecutionState(),
  ): NodeInputs {
    const inputs: NodeInputs = {};
    // 1. Resolved config
    inputs.__config__ = resolveRefs(node.config ?? {}, {
      variables: this.options.variables,
      secrets: this.options.variables,
    });
    // 2. Run input always available
    inputs.__runInput__ = this.options.runInput;

    // 3. Inbound edges
    const inbound = this.inEdges.get(node.id) ?? [];
    let hasDataInbound = false;
    const appliedOverrides = new Set<string>();
    for (const edge of inbound) {
      const fromPort = this.findPort(edge.from.nodeId, edge.from.portId);
      const toPort = this.findPort(edge.to.nodeId, edge.to.portId);
      if (fromPort && fromPort.kind === "data") hasDataInbound = true;
      if (toPort && toPort.kind === "data") hasDataInbound = true;
      const overrideKey = `${node.id}.${edge.to.portId}`;
      if (state.inputOverrides.has(overrideKey)) {
        if (!appliedOverrides.has(edge.to.portId)) {
          inputs[edge.to.portId] = state.inputOverrides.get(overrideKey);
          appliedOverrides.add(edge.to.portId);
        }
        continue;
      }
      const valueKey = `${edge.from.nodeId}.${edge.from.portId}`;
      const hasValue = state.portValues.has(valueKey);
      if (
        (node.type === "quorum" || node.type === "race" || node.type === "fail_fast") &&
        toPort?.kind === "data" &&
        !hasValue
      ) {
        continue;
      }
      const value = state.portValues.get(valueKey);
      const nextValue = value ?? null;
      if (toPort?.multiple) {
        const prev = inputs[edge.to.portId];
        inputs[edge.to.portId] = Array.isArray(prev)
          ? [...prev, nextValue]
          : prev === undefined
            ? [nextValue]
            : [prev, nextValue];
      } else {
        inputs[edge.to.portId] = nextValue;
      }
    }
    for (const [key, value] of state.inputOverrides) {
      const prefix = `${node.id}.`;
      if (!key.startsWith(prefix)) continue;
      const portId = key.slice(prefix.length);
      if (appliedOverrides.has(portId)) continue;
      inputs[portId] = value;
      appliedOverrides.add(portId);
    }

    if (node.id === this.entryNodeId) {
      for (const edge of inbound) {
        const toPort = this.findPort(edge.to.nodeId, edge.to.portId);
        if (toPort?.kind !== "data") continue;
        const valueKey = `${edge.from.nodeId}.${edge.from.portId}`;
        if (state.portValues.has(valueKey)) continue;
        if (appliedOverrides.has(edge.to.portId)) continue;
        inputs[edge.to.portId] = this.options.runInput;
        appliedOverrides.add(edge.to.portId);
      }
    }

    // 4. When a node has only control inbound (no data wiring), surface
    // the upstream node's primary data output as `inputs.in` so simple
    // `A -> B -> end` flows can author plain `${input.field}` templates
    // without explicit data edges. We pick the first non-null, non-control
    // output from the upstream nodes' recorded outputs, in inbound order.
    if (!hasDataInbound) {
      const upstreamData = this.findUpstreamData(inbound, state);
      // Both `input` and `in` are *aliases*. We replace control-marker
      // null values too because a control inbound writes `null` here, but
      // the upstream node may have produced a real data value the user
      // wants to template against.
      if (inputs.input === undefined || inputs.input === null) {
        inputs.input = upstreamData ?? this.options.runInput;
      }
      if (inputs.in === undefined || inputs.in === null) {
        inputs.in = upstreamData ?? this.options.runInput;
      }
    }

    if (node.id === this.entryNodeId) {
      if (inputs.input === undefined || inputs.input === null) {
        inputs.input = this.options.runInput;
      }
      if (inputs.in === undefined || inputs.in === null) {
        inputs.in = this.options.runInput;
      }
    }

    // 5. start node also gets `runInput` directly to mirror the doc note.
    if (node.type === "start") {
      inputs.runInput = this.options.runInput;
    }
    if (node.type === "event_trigger") {
      inputs.event = this.options.runInput;
    }

    return inputs;
  }

  /**
   * Look at every inbound control edge and, for each source node, grab the
   * first data-port output value the source emitted on this run. Returns
   * the *first* such value found in inbound order (Phase 1 single-tail
   * semantics; Phase 2 introduces an explicit `__merge__` rule).
   */
  private findUpstreamData(
    inbound: EdgeDefinition[],
    state: ExecutionState = this.defaultExecutionState(),
  ): unknown {
    for (const edge of inbound) {
      const fromNode = this.nodesById.get(edge.from.nodeId);
      if (!fromNode) continue;
      // Look at every output port on the upstream node and pick the first
      // one whose recorded value is neither null (control marker) nor a
      // routed control port itself.
      for (const port of fromNode.ports) {
        if (port.direction !== "output") continue;
        if (port.kind === "control" || port.kind === "error") continue;
        const v = state.portValues.get(`${fromNode.id}.${port.id}`);
        if (v !== undefined && v !== null) return v;
      }
    }
    return undefined;
  }

  private findPort(nodeId: string, portId: string) {
    return this.nodesById.get(nodeId)?.ports.find((p) => p.id === portId);
  }

  /* ---------------------------------------------------------------------- */
  /* Edge propagation                                                        */
  /* ---------------------------------------------------------------------- */

  private defaultExecutionState(): ExecutionState {
    return {
      portValues: this.portValues,
      inputOverrides: this.inputOverrides,
    };
  }

  private recordOutputs(
    node: NodeInstance,
    outputs: NodeOutputs,
    state: ExecutionState = this.defaultExecutionState(),
  ): void {
    for (const [portId, value] of Object.entries(outputs)) {
      state.portValues.set(`${node.id}.${portId}`, value);
    }
  }

  private enqueueReadyDownstream(
    node: NodeInstance,
    outputs: NodeOutputs,
    queue: string[],
  ): void {
    const out = this.outEdges.get(node.id) ?? [];
    for (const edge of out) {
      // Skip if the upstream port has no value emitted (e.g. condition
      // node only emits one of `true` / `false`).
      if (!(edge.from.portId in outputs)) continue;
      const remaining = (this.remainingDeps.get(edge.to.nodeId) ?? 1) - 1;
      this.remainingDeps.set(edge.to.nodeId, remaining);
      if (
        remaining <= 0 &&
        !queue.includes(edge.to.nodeId) &&
        !this.completedNodeIds.has(edge.to.nodeId)
      ) {
        queue.push(edge.to.nodeId);
      }
    }
  }

  private async executeLoopBlock(
    beginNode: NodeInstance,
    queue: string[],
    state: ExecutionState = this.defaultExecutionState(),
  ): Promise<boolean> {
    const spec = loopSpecFor(beginNode.type);
    if (!spec) return false;

    const block = this.findLoopBlock(beginNode, spec.endType);
    if (!block) return false;

    if (beginNode.type === "loop_begin") {
      return this.executeWhileBlock(beginNode, block, queue, state);
    }

    const iterations =
      beginNode.type === "foreach_begin"
        ? this.foreachIterations(beginNode, state)
        : this.forIterations(beginNode, state);
    const aggregated = new Map<string, unknown[]>();
    const config = asRecord(this.assembleInputs(beginNode, state).__config__);
    const errorPolicy = readLoopErrorPolicy(config.onError);
    const timeoutMs = Math.max(0, Math.trunc(numberOr(config.timeoutMs, 0)));
    const startedAt = Date.now();

    if (beginNode.type === "foreach_begin" && config.mode === "parallel") {
      return this.executeParallelForeachBlock(
        beginNode,
        block,
        queue,
        iterations,
        config,
        errorPolicy,
        timeoutMs,
        startedAt,
        state,
      );
    }

    let timedOut = false;
    const loopErrors: RuntimeError[] = [];

    for (let iteration = 0; iteration < iterations.length; iteration += 1) {
      const outputs = iterations[iteration]!;
      await this.publishLoopIterationProgress(beginNode, block, {
        phase: "started",
        iteration,
        status: "running",
        context: loopIterationContext(outputs),
      });
      this.recordOutputs(beginNode, outputs, state);
      const bodyResult = await this.executeLoopBody(block, queue, errorPolicy, state);
      loopErrors.push(...bodyResult.errors);
      this.collectLoopEndInputs(block, aggregated, bodyResult.executedNodeIds, state);
      if (bodyResult.status === "failed") {
        await this.publishLoopIterationProgress(beginNode, block, {
          phase: "finished",
          iteration,
          status: "failed",
          context: loopIterationContext(outputs),
        });
        return true;
      }
      if (bodyResult.status === "error") {
        const errorOutputs = loopErrorOutputs(block.endNode, aggregated, loopErrors);
        this.recordOutputs(block.endNode, errorOutputs, state);
        this.enqueueReadyDownstream(block.endNode, errorOutputs, queue);
        await this.publishLoopIterationProgress(beginNode, block, {
          phase: "finished",
          iteration,
          status: "error",
          context: loopIterationContext(outputs),
        });
        return true;
      }
      if (
        bodyResult.status !== "break" &&
        timeoutMs > 0 &&
        Date.now() - startedAt >= timeoutMs
      ) {
        timedOut = true;
      }
      await this.publishLoopIterationProgress(beginNode, block, {
        phase: "finished",
        iteration,
        status: timedOut
          ? "timeout"
          : bodyResult.errors.length > 0
            ? `error_${bodyResult.status}`
            : bodyResult.status,
        context: loopIterationContext(outputs),
      });
      if (bodyResult.status === "break") break;
      if (timedOut) break;
    }

    if (timedOut) {
      const outputs = loopTimeoutOutputs(block.endNode, aggregated, loopErrors);
      this.recordOutputs(block.endNode, outputs, state);
      this.enqueueReadyDownstream(block.endNode, outputs, queue);
      return true;
    }

    addLoopErrors(aggregated, loopErrors);
    this.applyLoopEndOverrides(block.endNode, aggregated);
    const endResult = await this.executeNode(block.endNode);
    this.clearLoopEndOverrides(block.endNode, aggregated);
    if (endResult.kind === "error") {
      await this.routeErrorOrFail(block.endNode, endResult.error, queue);
      return true;
    }
    if (endResult.kind === "success") {
      this.recordOutputs(block.endNode, endResult.outputs);
      this.enqueueReadyDownstream(block.endNode, endResult.outputs, queue);
    }
    return true;
  }

  private foreachIterations(
    beginNode: NodeInstance,
    state: ExecutionState = this.defaultExecutionState(),
  ): NodeOutputs[] {
    const inputs = this.assembleInputs(beginNode, state);
    const items = Array.isArray(inputs.items) ? inputs.items : [];
    return items.map((item, index) => ({
      body: null,
      item,
      index,
      count: items.length,
    }));
  }

  private forIterations(
    beginNode: NodeInstance,
    state: ExecutionState = this.defaultExecutionState(),
  ): NodeOutputs[] {
    const inputs = this.assembleInputs(beginNode, state);
    const config = asRecord(inputs.__config__);
    const start = numberOr(config.start, 0);
    const end = numberOr(config.end, start);
    const rawStep = numberOr(config.step, 1);
    const step = rawStep === 0 ? 1 : rawStep;
    const values: number[] = [];
    if (step > 0) {
      for (let index = start; index < end; index += step) values.push(index);
    } else {
      for (let index = start; index > end; index += step) values.push(index);
    }
    return values.map((index) => ({
      body: null,
      index,
      count: values.length,
    }));
  }

  private async executeParallelForeachBlock(
    beginNode: NodeInstance,
    block: LoopBlock,
    queue: string[],
    iterations: NodeOutputs[],
    config: Record<string, unknown>,
    errorPolicy: LoopErrorPolicy,
    timeoutMs: number,
    startedAt: number,
    state: ExecutionState,
  ): Promise<boolean> {
    const aggregated = new Map<string, unknown[]>();
    const loopErrors: RuntimeError[] = [];
    const batchSize = Math.max(
      1,
      Math.trunc(numberOr(config.batchSize, iterations.length || 1)),
    );
    const concurrency = Math.max(
      1,
      Math.trunc(numberOr(config.concurrency, batchSize)),
    );

    for (let batchStart = 0; batchStart < iterations.length; batchStart += batchSize) {
      const batch = iterations
        .slice(batchStart, batchStart + batchSize)
        .map((outputs, offset) => ({
          iteration: batchStart + offset,
          outputs,
        }));
      const results = await runLimited(batch, concurrency, ({ iteration, outputs }) =>
        this.executeParallelForeachIteration(
          beginNode,
          block,
          queue,
          errorPolicy,
          timeoutMs,
          startedAt,
          state,
          iteration,
          outputs,
        ),
      );
      let shouldBreak = false;

      for (const result of [...results].sort((a, b) => a.iteration - b.iteration)) {
        mergeAggregated(aggregated, result.aggregated);
        loopErrors.push(...result.bodyResult.errors);

        if (result.bodyResult.status === "failed") return true;
        if (result.bodyResult.status === "error") {
          const errorOutputs = loopErrorOutputs(block.endNode, aggregated, loopErrors);
          this.recordOutputs(block.endNode, errorOutputs, state);
          this.enqueueReadyDownstream(block.endNode, errorOutputs, queue);
          return true;
        }
        if (result.bodyResult.status === "break") {
          shouldBreak = true;
          break;
        }
        if (result.timedOut) {
          const outputs = loopTimeoutOutputs(block.endNode, aggregated, loopErrors);
          this.recordOutputs(block.endNode, outputs, state);
          this.enqueueReadyDownstream(block.endNode, outputs, queue);
          return true;
        }
      }

      if (shouldBreak) break;
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        const outputs = loopTimeoutOutputs(block.endNode, aggregated, loopErrors);
        this.recordOutputs(block.endNode, outputs, state);
        this.enqueueReadyDownstream(block.endNode, outputs, queue);
        return true;
      }
    }

    addLoopErrors(aggregated, loopErrors);
    this.applyLoopEndOverrides(block.endNode, aggregated, state);
    const endResult = await this.executeNode(block.endNode, state);
    this.clearLoopEndOverrides(block.endNode, aggregated, state);
    if (endResult.kind === "error") {
      await this.routeErrorOrFail(block.endNode, endResult.error, queue);
      return true;
    }
    if (endResult.kind === "success") {
      this.recordOutputs(block.endNode, endResult.outputs, state);
      this.enqueueReadyDownstream(block.endNode, endResult.outputs, queue);
    }
    return true;
  }

  private async executeParallelForeachIteration(
    beginNode: NodeInstance,
    block: LoopBlock,
    queue: string[],
    errorPolicy: LoopErrorPolicy,
    timeoutMs: number,
    startedAt: number,
    parentState: ExecutionState,
    iteration: number,
    outputs: NodeOutputs,
  ): Promise<LoopIterationResult> {
    const state: ExecutionState = {
      portValues: new Map(parentState.portValues),
      inputOverrides: new Map(parentState.inputOverrides),
    };
    this.recordOutputs(beginNode, outputs, state);
    await this.publishLoopIterationProgress(beginNode, block, {
      phase: "started",
      iteration,
      status: "running",
      context: loopIterationContext(outputs),
    });

    const bodyResult = await this.executeLoopBody(block, queue, errorPolicy, state);
    const aggregated = new Map<string, unknown[]>();
    this.collectLoopEndInputs(block, aggregated, bodyResult.executedNodeIds, state);
    const timedOut =
      bodyResult.status !== "break" &&
      timeoutMs > 0 &&
      Date.now() - startedAt >= timeoutMs;
    await this.publishLoopIterationProgress(beginNode, block, {
      phase: "finished",
      iteration,
      status: timedOut
        ? "timeout"
        : bodyResult.errors.length > 0
          ? `error_${bodyResult.status}`
          : bodyResult.status,
      context: loopIterationContext(outputs),
    });

    return {
      iteration,
      bodyResult,
      aggregated,
      timedOut,
    };
  }

  private async executeWhileBlock(
    beginNode: NodeInstance,
    block: LoopBlock,
    queue: string[],
    executionState: ExecutionState = this.defaultExecutionState(),
  ): Promise<boolean> {
    const inputs = this.assembleInputs(beginNode, executionState);
    const config = asRecord(inputs.__config__);
    const maxIterations = Math.max(1, Math.trunc(numberOr(config.maxIterations, 10)));
    const checkMode = config.checkMode === "before" ? "before" : "after";
    const errorPolicy = readLoopErrorPolicy(config.onError);
    const timeoutMs = Math.max(0, Math.trunc(numberOr(config.timeoutMs, 0)));
    const startedAt = Date.now();
    const endConfig = asRecord(block.endNode.config ?? {});
    const condition = String(endConfig.condition ?? "nextState.continue == \"true\"");
    let state = inputs.initialState ?? inputs.input ?? null;
    const loopErrors: RuntimeError[] = [];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (
        checkMode === "before" &&
        !evaluateCondition(condition, { nextState: state, input: state })
      ) {
        const outputs = withLoopErrors({ done: null, finalState: state }, loopErrors);
        this.recordOutputs(block.endNode, outputs, executionState);
        this.enqueueReadyDownstream(block.endNode, outputs, queue);
        return true;
      }

      const outputs = {
        body: null,
        state,
        iteration,
      };
      await this.publishLoopIterationProgress(beginNode, block, {
        phase: "started",
        iteration,
        status: "running",
        context: loopIterationContext(outputs),
      });
      this.recordOutputs(beginNode, outputs, executionState);
      const bodyResult = await this.executeLoopBody(
        block,
        queue,
        errorPolicy,
        executionState,
      );
      loopErrors.push(...bodyResult.errors);
      const aggregated = new Map<string, unknown[]>();
      this.collectLoopEndInputs(
        block,
        aggregated,
        bodyResult.executedNodeIds,
        executionState,
      );
      if (bodyResult.status === "failed") {
        await this.publishLoopIterationProgress(beginNode, block, {
          phase: "finished",
          iteration,
          status: "failed",
          context: loopIterationContext(outputs),
        });
        return true;
      }
      if (bodyResult.status === "error") {
        const errorOutputs = loopErrorOutputs(block.endNode, aggregated, loopErrors, state);
        this.recordOutputs(block.endNode, errorOutputs, executionState);
        this.enqueueReadyDownstream(block.endNode, errorOutputs, queue);
        await this.publishLoopIterationProgress(beginNode, block, {
          phase: "finished",
          iteration,
          status: "error",
          context: loopIterationContext(outputs),
        });
        return true;
      }

      if (bodyResult.status === "break") {
        const nextState = lastAggregatedValue(aggregated, "nextState");
        if (nextState !== undefined) state = nextState;
        await this.publishLoopIterationProgress(beginNode, block, {
          phase: "finished",
          iteration,
          status: "break",
          context: loopIterationContext(outputs),
        });
        this.recordOutputs(
          block.endNode,
          withLoopErrors({ done: null, finalState: state }, loopErrors),
          executionState,
        );
        this.enqueueReadyDownstream(
          block.endNode,
          withLoopErrors({ done: null, finalState: state }, loopErrors),
          queue,
        );
        return true;
      }

      if (checkMode === "before") {
        const nextState = lastAggregatedValue(aggregated, "nextState");
        if (nextState !== undefined) state = nextState;
        const hitLimit = iteration === maxIterations - 1;
        const hitTimeout = timeoutMs > 0 && Date.now() - startedAt >= timeoutMs;
        await this.publishLoopIterationProgress(beginNode, block, {
          phase: "finished",
          iteration,
          status: hitTimeout
            ? "timeout"
            : hitLimit
              ? "maxed"
              : bodyResult.errors.length > 0
                ? "error_continue"
                : "continue",
          context: loopIterationContext(outputs),
        });
        if (hitTimeout) {
          const timeoutOutputs = withLoopErrors({ timeout: null, finalState: state }, loopErrors);
          this.recordOutputs(block.endNode, timeoutOutputs, executionState);
          this.enqueueReadyDownstream(block.endNode, timeoutOutputs, queue);
          return true;
        }
        if (hitLimit) {
          const maxedOutputs = withLoopErrors(
            { done: null, maxed: null, finalState: state },
            loopErrors,
          );
          this.recordOutputs(block.endNode, maxedOutputs, executionState);
          this.enqueueReadyDownstream(block.endNode, maxedOutputs, queue);
          return true;
        }
        continue;
      }

      addLoopErrors(aggregated, loopErrors);
      this.applyLoopEndOverrides(block.endNode, aggregated, executionState);
      const endResult = await this.executeNode(block.endNode, executionState);
      this.clearLoopEndOverrides(block.endNode, aggregated, executionState);
      if (endResult.kind === "error") {
        await this.routeErrorOrFail(block.endNode, endResult.error, queue);
        return true;
      }
      if (endResult.kind !== "success") return true;

      const wantsAnotherIteration = "maxed" in endResult.outputs;
      state = endResult.outputs.finalState ?? state;
      const hitLimit = wantsAnotherIteration && iteration === maxIterations - 1;
      const hitTimeout =
        wantsAnotherIteration && timeoutMs > 0 && Date.now() - startedAt >= timeoutMs;
      await this.publishLoopIterationProgress(beginNode, block, {
        phase: "finished",
        iteration,
        status: hitTimeout
          ? "timeout"
          : hitLimit
            ? "maxed"
            : bodyResult.errors.length > 0
              ? `error_${wantsAnotherIteration ? "continue" : "completed"}`
              : wantsAnotherIteration
                ? "continue"
                : "completed",
        context: loopIterationContext(outputs),
      });
      if (hitTimeout) {
        const timeoutOutputs = withLoopErrors({ timeout: null, finalState: state }, loopErrors);
        this.recordOutputs(block.endNode, timeoutOutputs, executionState);
        this.enqueueReadyDownstream(block.endNode, timeoutOutputs, queue);
        return true;
      }
      if (!wantsAnotherIteration || hitLimit) {
        const outputs = hitLimit
          ? withLoopErrors({ ...endResult.outputs, done: null, maxed: null }, loopErrors)
          : endResult.outputs;
        this.recordOutputs(block.endNode, outputs, executionState);
        this.enqueueReadyDownstream(block.endNode, outputs, queue);
        return true;
      }
    }
    return true;
  }

  private async publishLoopIterationProgress(
    beginNode: NodeInstance,
    block: LoopBlock,
    event: {
      phase: "started" | "finished";
      iteration: number;
      status: string;
      context: Record<string, unknown>;
    },
  ): Promise<void> {
    const seq = this.nextProgressSeq(beginNode.id);
    await this.options.eventBus.publish({
      runId: this.options.runId,
      flowId: this.options.flowId,
      flowVersion: this.options.flowVersion,
      nodeId: beginNode.id,
      nodeVersion: beginNode.typeVersion,
      attempt: this.attempt,
      seq,
      kind: "node_progress",
      payload: {
        type: "loop_iteration",
        loopType: beginNode.type,
        beginNodeId: beginNode.id,
        endNodeId: block.endNode.id,
        phase: event.phase,
        iteration: event.iteration,
        status: event.status,
        context: redactInputs(event.context),
      },
    });
  }

  private nextProgressSeq(nodeId: string): number {
    const seq = this.progressSeq.get(nodeId) ?? 10_000;
    this.progressSeq.set(nodeId, seq + 1);
    return seq;
  }

  private async executeLoopBody(
    block: LoopBlock,
    queue: string[],
    errorPolicy: LoopErrorPolicy,
    state: ExecutionState = this.defaultExecutionState(),
  ): Promise<LoopBodyResult> {
    const localQueue = [...block.bodyStartNodeIds];
    const seen = new Set<string>();
    const executedNodeIds = new Set<string>();
    while (localQueue.length > 0) {
      const nodeId = localQueue.shift()!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (!block.bodyNodeIds.has(nodeId)) continue;
      const node = this.nodesById.get(nodeId);
      if (!node) continue;
      const nestedSpec = loopSpecFor(node.type);
      const nestedBlock = nestedSpec
        ? this.findLoopBlock(node, nestedSpec.endType)
        : undefined;
      if (nestedBlock) {
        executedNodeIds.add(node.id);
        if (await this.executeLoopBlock(node, localQueue, state)) {
          executedNodeIds.add(nestedBlock.endNode.id);
          continue;
        }
      }
      const result = await this.executeNode(node, state);
      if (result.kind === "skip") continue;
      executedNodeIds.add(node.id);
      if (result.kind === "error") {
        if (this.hasErrorRoute(node)) {
          await this.routeErrorOrFail(node, result.error, queue);
          return {
            status: "completed",
            executedNodeIds,
            errors: [],
          };
        }
        if (errorPolicy === "continue") {
          return {
            status: "continue",
            executedNodeIds,
            errors: [result.error],
          };
        }
        if (errorPolicy === "break") {
          return {
            status: "break",
            executedNodeIds,
            errors: [result.error],
          };
        }
        if (errorPolicy === "route") {
          return {
            status: "error",
            executedNodeIds,
            errors: [result.error],
          };
        }
        await this.publishRunFailed(result.error);
        return {
          status: "failed",
          executedNodeIds,
          errors: [result.error],
        };
      }
      if (node.type === "loop_break") {
        this.recordOutputs(node, result.outputs, state);
        return { status: "break", executedNodeIds, errors: [] };
      }
      if (node.type === "loop_continue") {
        this.recordOutputs(node, result.outputs, state);
        return { status: "continue", executedNodeIds, errors: [] };
      }
      this.recordOutputs(node, result.outputs, state);
      for (const edge of this.outEdges.get(node.id) ?? []) {
        if (!(edge.from.portId in result.outputs)) continue;
        if (!block.bodyNodeIds.has(edge.to.nodeId)) continue;
        const toPort = this.findPort(edge.to.nodeId, edge.to.portId);
        if (toPort?.kind !== "control") continue;
        localQueue.push(edge.to.nodeId);
      }
    }
    return { status: "completed", executedNodeIds, errors: [] };
  }

  private collectLoopEndInputs(
    block: LoopBlock,
    aggregated: Map<string, unknown[]>,
    executedNodeIds?: ReadonlySet<string>,
    state: ExecutionState = this.defaultExecutionState(),
  ): void {
    for (const edge of this.inEdges.get(block.endNode.id) ?? []) {
      if (!block.bodyNodeIds.has(edge.from.nodeId)) continue;
      if (executedNodeIds && !executedNodeIds.has(edge.from.nodeId)) continue;
      const toPort = this.findPort(edge.to.nodeId, edge.to.portId);
      if (toPort?.kind !== "data") continue;
      const value = state.portValues.get(`${edge.from.nodeId}.${edge.from.portId}`);
      const list = aggregated.get(edge.to.portId) ?? [];
      list.push(value ?? null);
      aggregated.set(edge.to.portId, list);
    }
  }

  private applyLoopEndOverrides(
    endNode: NodeInstance,
    aggregated: Map<string, unknown[]>,
    state: ExecutionState = this.defaultExecutionState(),
  ): void {
    for (const [portId, values] of aggregated) {
      const port = this.findPort(endNode.id, portId);
      state.inputOverrides.set(
        `${endNode.id}.${portId}`,
        port?.multiple ? values : values.at(-1),
      );
    }
  }

  private clearLoopEndOverrides(
    endNode: NodeInstance,
    aggregated: Map<string, unknown[]>,
    state: ExecutionState = this.defaultExecutionState(),
  ): void {
    for (const portId of aggregated.keys()) {
      state.inputOverrides.delete(`${endNode.id}.${portId}`);
    }
  }

  private findLoopBlock(
    beginNode: NodeInstance,
    endType: string,
  ): LoopBlock | undefined {
    const bodyStartNodeIds: string[] = [];
    const bodyNodeIds = new Set<string>();
    let endNode: NodeInstance | undefined;
    const pending: Array<{ nodeId: string; depth: number }> = [];

    for (const edge of this.outEdges.get(beginNode.id) ?? []) {
      if (edge.from.portId !== "body") continue;
      const target = this.nodesById.get(edge.to.nodeId);
      if (!target) continue;
      if (target.type === endType) {
        endNode = target;
      } else {
        bodyStartNodeIds.push(target.id);
        pending.push({ nodeId: target.id, depth: 0 });
      }
    }

    while (pending.length > 0) {
      const { nodeId, depth } = pending.shift()!;
      if (bodyNodeIds.has(nodeId)) continue;
      bodyNodeIds.add(nodeId);
      const node = this.nodesById.get(nodeId);
      const nextDepth =
        node && loopSpecFor(node.type)?.endType === endType ? depth + 1 : depth;
      for (const edge of this.outEdges.get(nodeId) ?? []) {
        const fromPort = this.findPort(edge.from.nodeId, edge.from.portId);
        if (fromPort?.kind !== "control") continue;
        const target = this.nodesById.get(edge.to.nodeId);
        if (!target) continue;
        if (target.type === endType) {
          if (nextDepth === 0) {
            endNode = target;
            continue;
          }
          pending.push({ nodeId: target.id, depth: nextDepth - 1 });
          continue;
        }
        pending.push({ nodeId: target.id, depth: nextDepth });
      }
    }

    if (!endNode) return undefined;
    return { endNode, bodyNodeIds, bodyStartNodeIds };
  }

  private async routeErrorOrFail(
    node: NodeInstance,
    error: RuntimeError,
    queue: string[],
  ): Promise<boolean> {
    // If the node has an `error` output port wired, route the error along
    // that edge as a regular output and continue scheduling. Otherwise
    // fail the whole Run.
    const errorPortEdges = (this.outEdges.get(node.id) ?? []).filter(
      (e) => e.from.portId === "error",
    );
    if (errorPortEdges.length === 0) {
      await this.publishRunFailed(error);
      return false;
    }
    this.recordOutputs(node, { error });
    this.enqueueReadyDownstream(node, { error }, queue);
    return true;
  }

  private hasErrorRoute(node: NodeInstance): boolean {
    return (this.outEdges.get(node.id) ?? []).some((e) => e.from.portId === "error");
  }

  private async publishRunFailed(error: RuntimeError): Promise<void> {
    await this.options.eventBus.publish({
      runId: this.options.runId,
      flowId: this.options.flowId,
      flowVersion: this.options.flowVersion,
      seq: 0,
      kind: "run_failed",
      payload: { error },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pushEdge(
  bucket: Map<string, EdgeDefinition[]>,
  key: string,
  edge: EdgeDefinition,
): void {
  let list = bucket.get(key);
  if (!list) {
    list = [];
    bucket.set(key, list);
  }
  list.push(edge);
}

function requiredInboundCount(
  node: NodeInstance | undefined,
  inboundCount: number,
): number {
  if (node?.type === "merge" && inboundCount > 0) return 1;
  if (node?.type === "race" && inboundCount > 0) return 1;
  if (node?.type === "fail_fast" && inboundCount > 0) return 1;
  if (node?.type === "quorum" && inboundCount > 0) {
    const threshold = Math.max(1, Math.trunc(Number(node.config?.threshold ?? 2)));
    return Math.min(threshold, inboundCount);
  }
  return inboundCount;
}

interface LoopBlock {
  endNode: NodeInstance;
  bodyNodeIds: Set<string>;
  bodyStartNodeIds: string[];
}

interface ExecutionState {
  portValues: Map<string, unknown>;
  inputOverrides: Map<string, unknown>;
}

type LoopErrorPolicy = "terminate" | "continue" | "break" | "route";

type LoopBodyStatus = "completed" | "break" | "continue" | "failed" | "error";

interface LoopBodyResult {
  status: LoopBodyStatus;
  executedNodeIds: Set<string>;
  errors: RuntimeError[];
}

interface LoopIterationResult {
  iteration: number;
  bodyResult: LoopBodyResult;
  aggregated: Map<string, unknown[]>;
  timedOut: boolean;
}

type ScheduledFinish =
  | { kind: "completed" }
  | { kind: "sink_reached" }
  | { kind: "failed"; error: RuntimeError };

function loopSpecFor(type: string): { endType: string } | undefined {
  switch (type) {
    case "foreach_begin":
      return { endType: "foreach_end" };
    case "for_begin":
      return { endType: "for_end" };
    case "loop_begin":
      return { endType: "loop_end" };
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readRuntimeTimeoutMs(config: unknown, fallback: number): number {
  const value = asRecord(config).runtimeTimeoutMs;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : fallback;
  if (!Number.isFinite(parsed)) return Math.max(0, Math.trunc(fallback));
  return Math.max(0, Math.trunc(parsed));
}

function readLoopErrorPolicy(value: unknown): LoopErrorPolicy {
  if (value === "continue" || value === "break" || value === "route") return value;
  return "terminate";
}

function lastAggregatedValue(
  aggregated: Map<string, unknown[]>,
  portId: string,
): unknown {
  const values = aggregated.get(portId);
  return values && values.length > 0 ? values.at(-1) : undefined;
}

function loopIterationContext(outputs: NodeOutputs): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    if (key === "body") continue;
    context[key] = value;
  }
  return context;
}

function loopTimeoutOutputs(
  endNode: NodeInstance,
  aggregated: Map<string, unknown[]>,
  errors: RuntimeError[],
): NodeOutputs {
  const results = aggregated.get("result") ?? [];
  if (endNode.type === "foreach_end") {
    return withLoopErrors({ timeout: null, results }, errors);
  }
  if (endNode.type === "for_end") {
    return withLoopErrors({ timeout: null, results }, errors);
  }
  return withLoopErrors({ timeout: null }, errors);
}

function loopErrorOutputs(
  endNode: NodeInstance,
  aggregated: Map<string, unknown[]>,
  errors: RuntimeError[],
  finalState?: unknown,
): NodeOutputs {
  const results = aggregated.get("result") ?? [];
  if (endNode.type === "foreach_end" || endNode.type === "for_end") {
    return withLoopErrors({ error: null, results }, errors);
  }
  return withLoopErrors({ error: null, finalState: finalState ?? null }, errors);
}

function addLoopErrors(
  aggregated: Map<string, unknown[]>,
  errors: RuntimeError[],
): void {
  if (errors.length === 0) return;
  aggregated.set("errors", errors);
}

function mergeAggregated(
  target: Map<string, unknown[]>,
  source: Map<string, unknown[]>,
): void {
  for (const [portId, values] of source) {
    const existing = target.get(portId) ?? [];
    target.set(portId, [...existing, ...values]);
  }
}

async function runLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

function withLoopErrors(outputs: NodeOutputs, errors: RuntimeError[]): NodeOutputs {
  if (errors.length === 0) {
    return {
      ...outputs,
      errors: [],
      errorCount: 0,
      firstError: null,
    };
  }
  return {
    ...outputs,
    errors,
    errorCount: errors.length,
    firstError: errors[0] ?? null,
  };
}

/**
 * Walk the inbound-edge graph from `sinkNodeId` and return the set of
 * node ids that must execute to satisfy the sink (the sink itself plus
 * every transitive upstream node).
 *
 * This is a plain BFS over reverse edges; the validator already
 * guarantees the original graph is a DAG so a `visited` set is enough
 * to terminate. Edge endpoints that point to nodes not present in
 * `graph.nodes` are silently skipped — they would have been rejected
 * earlier by the flow-builder validator, but we stay defensive here
 * because the engine is the last line of safety before scheduling.
 */
function computeUpstreamClosure(
  graph: FlowGraph,
  sinkNodeId: string,
): Set<string> {
  const inboundByNode = new Map<string, EdgeDefinition[]>();
  for (const edge of graph.edges) {
    pushEdge(inboundByNode, edge.to.nodeId, edge);
  }
  const validIds = new Set(graph.nodes.map((n) => n.id));
  const visited = new Set<string>();
  const queue: string[] = [sinkNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    if (!validIds.has(id)) continue;
    visited.add(id);
    for (const edge of inboundByNode.get(id) ?? []) {
      if (!visited.has(edge.from.nodeId)) queue.push(edge.from.nodeId);
    }
  }
  return visited;
}

/**
 * Pick the "primary data output" of a node for sub-graph mode. We
 * prefer ports declared as `kind: "data"` and `direction: "output"`,
 * skipping `error` ports. If no such port has a recorded value we fall
 * back to the first non-undefined entry in `outputs` so that nodes
 * which omit explicit port metadata (or runners that emit ad-hoc keys)
 * still surface *something* to the caller.
 */
function pickPrimaryDataOutput(
  node: NodeInstance,
  outputs: NodeOutputs,
): unknown {
  for (const port of node.ports) {
    if (port.direction !== "output") continue;
    if (port.kind !== "data") continue;
    const v = outputs[port.id];
    if (v !== undefined) return v;
  }
  for (const [, v] of Object.entries(outputs)) {
    if (v !== undefined) return v;
  }
  return undefined;
}

function makeNodeLogger(channel: NodeEventChannel): NodeLogger {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    // Logger is fire-and-forget: a slow EventBus must not block node
    // logic. Errors are swallowed by EventBus.fanOut already.
    void channel.emit({
      kind: "node_log",
      payload: { level, message, data },
    });
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

/**
 * Lightweight redaction for event payloads. We strip the resolved
 * `__config__` field because it may contain resolved runtime variables
 * such as API keys.
 */
function redactInputs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInputs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "__config__") {
        out[k] = "[redacted-config]";
        continue;
      }
      out[k] = redactInputs(v);
    }
    return out;
  }
  return value;
}

class _UnusedRuntimeErrorException {
  // Keeping the import alive without unused-import lints; the Engine
  // throws plain `RuntimeError` payloads via `publishRunFailed`, but
  // future refactors will use the exception form.
  static readonly _ = RuntimeErrorException;
}
