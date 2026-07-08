/**
 * InvocationRouter: the entry point that turns "invoke flow X with input Y"
 * into a Run.
 *
 * Per `docs/specs/runtime-execution.md` §5.5, the router must:
 *   - resolve the active Flow Version (or honour an explicit `flowVersion`),
 *   - perform Pre-run input validation against `inputSchema` *before*
 *     creating the Run record (so failed validations don't pollute Run /
 *     Event store),
 *   - hand the work off to RunManager.
 *
 * Phase 1 input validation is the minimum: presence of `inputSchema` is
 * tolerated (we do shape-only checks). Full JSON-Schema enforcement is
 * Phase 1.5 (jsv / ajv adapter).
 */

import {
  RuntimeErrorException,
  createRuntimeError,
} from "@ai-native-flow/flow-ir";
import type { RuntimeRegistry } from "./registry.js";
import type { ExecuteResult, RunManager } from "./runManager.js";
import type { RunRecord } from "./types.js";
import type { SecretStore, VariableStore } from "@ai-native-flow/variable-store";

export interface InvocationRouterOptions {
  registry: RuntimeRegistry;
  runManager: RunManager;
}

export interface InvokeArgs {
  flowId: string;
  /** Optional explicit version pin; defaults to active version. */
  flowVersion?: string;
  input: unknown;
  traceId?: string;
  subflowDepth?: number;
  /** Optional run-scoped variable overrides. */
  variables?: VariableStore;
  /** Optional run-scoped secret overrides. */
  secrets?: SecretStore;
}

/**
 * Arguments for the sub-graph ("sink-node") invocation entry-points.
 * The flow lookup mirrors `InvokeArgs` exactly; the only addition is
 * the mandatory `nodeId`, which the router validates exists in the
 * resolved flow before handing off to the runtime.
 */
export interface InvokeNodeArgs extends InvokeArgs {
  /** Id of the node whose completion terminates the Run. */
  nodeId: string;
}

export interface ResumeFromPointArgs {
  flowId: string;
  /** Optional explicit version pin; defaults to active version. */
  flowVersion?: string;
  /** Name used by the `resume_point` node when the recovery target was marked. */
  resumePointName: string;
  traceId?: string;
  subflowDepth?: number;
  /** Optional run-scoped variable overrides. */
  variables?: VariableStore;
  /** Optional run-scoped secret overrides. */
  secrets?: SecretStore;
}

export interface TriggerEventArgs {
  event: string;
  traceId?: string;
  subflowDepth?: number;
  /** Optional run-scoped variable overrides. */
  variables?: VariableStore;
  /** Optional run-scoped secret overrides. */
  secrets?: SecretStore;
}

/**
 * Result of `InvocationRouter.start()`. The `runRecord` resolves as soon
 * as the run is registered (before any node executes), while `completed`
 * resolves with the final `ExecuteResult` when the engine reaches a
 * terminal state. Phase 2 SSE handlers subscribe to the EventBus before
 * awaiting `completed`.
 */
export interface StartedRun {
  runRecord: RunRecord;
  completed: Promise<ExecuteResult>;
}

export interface DeferredStartedRun extends StartedRun {
  /** Starts execution once the caller has attached event observers. */
  startExecution: () => void;
}

export class InvocationRouter {
  constructor(private readonly options: InvocationRouterOptions) {}

  async invoke(args: InvokeArgs): Promise<ExecuteResult> {
    const ref = args.flowVersion
      ? await this.options.registry.resolve(args.flowId, args.flowVersion)
      : await this.options.registry.getActive(args.flowId);

    // Pre-run validation: minimal shape check (full JSON-Schema in next phase).
    this.assertInputShape(ref.graph.inputSchema, args.input, args.flowId);

    return this.options.runManager.invoke({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      input: args.input,
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
      ...(args.variables !== undefined ? { variables: args.variables } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
  }

  /**
   * Sub-graph counterpart of `invoke()`. Resolves the flow exactly the
   * same way (active version or pinned version), validates that
   * `nodeId` exists in the flow, and delegates to RunManager with
   * `sinkNodeId` set so the engine runs only the upstream closure of
   * the requested node. Used by Studio's right-click "Run this node",
   * by `cli flow run-node`, and by the HTTP
   * `POST /flows/:flowId/nodes/:nodeId/invoke` endpoint.
   *
   * Pre-run input validation is intentionally skipped here: a node-run
   * does not necessarily need to satisfy the flow-level `inputSchema`
   * (the user is mid-edit, the flow may not be "complete" in the
   * input-shape sense). The node-level runner still validates its own
   * `__config__` / inbound port values inside `executeNode`.
   */
  async invokeNode(args: InvokeNodeArgs): Promise<ExecuteResult> {
    const ref = await this.resolveAndAssertNode(args);
    return this.options.runManager.invoke({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      input: args.input,
      sinkNodeId: args.nodeId,
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
      ...(args.variables !== undefined ? { variables: args.variables } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
  }

  /**
   * Resume a flow from a durable `resume_point` marker. The marker
   * supplies both the target node and the snapshot used as the resumed
   * run input. Flow-level inputSchema validation is skipped for the same
   * reason as `invokeNode()`: the resumed run enters the graph mid-flow.
   */
  async resumeFromPoint(args: ResumeFromPointArgs): Promise<ExecuteResult> {
    const ref = args.flowVersion
      ? await this.options.registry.resolve(args.flowId, args.flowVersion)
      : await this.options.registry.getActive(args.flowId);

    return this.options.runManager.resumeFromPoint({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      resumePointName: args.resumePointName,
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
      ...(args.variables !== undefined ? { variables: args.variables } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
  }

  /**
   * Start every active flow whose `event_trigger` listens for `args.event`.
   * The event string itself is the triggered run input.
   */
  async triggerEvent(args: TriggerEventArgs): Promise<ExecuteResult[]> {
    const triggers = this.options.registry.getEventTriggers(args.event);
    const results: ExecuteResult[] = [];
    for (const trigger of triggers) {
      results.push(
        await this.options.runManager.invoke({
          flowId: trigger.flowId,
          flowVersion: trigger.flowVersion,
          flowArtifactHash: trigger.flowArtifactHash,
          graph: trigger.graph,
          input: args.event,
          entryNodeId: trigger.nodeId,
          ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
          ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
          ...(args.variables !== undefined ? { variables: args.variables } : {}),
          ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
        }),
      );
    }
    return results;
  }

  /**
   * Start a Run and return its `runRecord` synchronously (well, after
   * `RunManager.create` resolves) plus a `completed` promise that the
   * caller can await for the final `ExecuteResult`. This is what the
   * HTTP SSE adapter uses: it needs the `runId` immediately so it can
   * subscribe on the EventBus *before* the engine starts emitting, but
   * it does not want to block the response on completion.
   */
  async start(args: InvokeArgs): Promise<StartedRun> {
    const deferred = await this.startDeferred(args);
    deferred.startExecution();
    return {
      runRecord: deferred.runRecord,
      completed: deferred.completed,
    };
  }

  /**
   * Prepare a Run without executing it yet. Transports with live event
   * channels use this to subscribe first, then call `startExecution()`
   * so `node_started` is delivered live instead of only via replay.
   */
  async startDeferred(args: InvokeArgs): Promise<DeferredStartedRun> {
    const ref = args.flowVersion
      ? await this.options.registry.resolve(args.flowId, args.flowVersion)
      : await this.options.registry.getActive(args.flowId);

    this.assertInputShape(ref.graph.inputSchema, args.input, args.flowId);

    const runRecord = await this.options.runManager.create({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      input: args.input,
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
      ...(args.variables !== undefined ? { variables: args.variables } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
    return this.deferExecution(runRecord, () =>
      this.options.runManager.execute(runRecord, ref.graph, {
        ...(args.variables !== undefined ? { variables: args.variables } : {}),
        ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
      }),
    );
  }

  /**
   * Two-phase sub-graph counterpart of `start()`. Returns the
   * `runRecord` synchronously so SSE handlers can subscribe to the
   * EventBus on the `runId` before the engine emits its first event.
   *
   * Like `invokeNode()`, this validates that `nodeId` exists but does
   * NOT enforce the flow-level `inputSchema` — see that method's
   * docblock for the rationale.
   */
  async startNode(args: InvokeNodeArgs): Promise<StartedRun> {
    const deferred = await this.startNodeDeferred(args);
    deferred.startExecution();
    return {
      runRecord: deferred.runRecord,
      completed: deferred.completed,
    };
  }

  /**
   * Two-phase counterpart of `resumeFromPoint()`. Returns a RunRecord
   * immediately plus a completion promise.
   */
  async startFromPoint(args: ResumeFromPointArgs): Promise<StartedRun> {
    const ref = args.flowVersion
      ? await this.options.registry.resolve(args.flowId, args.flowVersion)
      : await this.options.registry.getActive(args.flowId);

    const started = await this.options.runManager.startFromPoint({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      resumePointName: args.resumePointName,
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
      ...(args.variables !== undefined ? { variables: args.variables } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
    return started;
  }

  /**
   * Deferred sub-graph counterpart of `startDeferred()`.
   */
  async startNodeDeferred(args: InvokeNodeArgs): Promise<DeferredStartedRun> {
    const ref = await this.resolveAndAssertNode(args);
    const runRecord = await this.options.runManager.create({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      input: args.input,
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.subflowDepth !== undefined ? { subflowDepth: args.subflowDepth } : {}),
      ...(args.variables !== undefined ? { variables: args.variables } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
    return this.deferExecution(runRecord, () =>
      this.options.runManager.execute(runRecord, ref.graph, {
        sinkNodeId: args.nodeId,
        ...(args.variables !== undefined ? { variables: args.variables } : {}),
        ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
      }),
    );
  }

  /**
   * Shared resolve-and-validate path for `invokeNode` / `startNode`.
   * Throws `flow.node.not_found` (validation / user_input category)
   * when `args.nodeId` is not present in the resolved graph.
   */
  private async resolveAndAssertNode(args: InvokeNodeArgs) {
    const ref = args.flowVersion
      ? await this.options.registry.resolve(args.flowId, args.flowVersion)
      : await this.options.registry.getActive(args.flowId);
    const exists = ref.graph.nodes.some((n) => n.id === args.nodeId);
    if (!exists) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "flow.node.not_found",
          kind: "not_found",
          category: "user_input",
          message: `flow ${ref.flowId}@${ref.version} has no node with id "${args.nodeId}"`,
          source: {
            module: "invocation_router",
            flowId: ref.flowId,
            flowVersion: ref.version,
          },
          context: { nodeId: args.nodeId },
        }),
      );
    }
    return ref;
  }

  private assertInputShape(
    inputSchema: unknown,
    input: unknown,
    flowId: string,
  ): void {
    if (!inputSchema || typeof inputSchema !== "object") return;
    const schema = inputSchema as { type?: string; required?: string[] };
    if (schema.type === "object") {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new RuntimeErrorException(
          createRuntimeError({
            code: "flow.input.invalid",
            kind: "validation",
            category: "user_input",
            message: `flow ${flowId} expects object input`,
            source: { module: "invocation_router", flowId },
            context: { received: typeof input },
          }),
        );
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!(key in (input as Record<string, unknown>))) {
            throw new RuntimeErrorException(
              createRuntimeError({
                code: "flow.input.invalid",
                kind: "validation",
                category: "user_input",
                message: `flow ${flowId} missing required input field "${key}"`,
                source: { module: "invocation_router", flowId },
                context: { missingField: key },
              }),
            );
          }
        }
      }
    }
  }

  private deferExecution(
    runRecord: RunRecord,
    execute: () => Promise<ExecuteResult>,
  ): DeferredStartedRun {
    let started = false;
    let resolveCompleted!: (result: ExecuteResult) => void;
    let rejectCompleted!: (cause: unknown) => void;
    const completed = new Promise<ExecuteResult>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    return {
      runRecord,
      completed,
      startExecution: () => {
        if (started) return;
        started = true;
        void execute().then(resolveCompleted, rejectCompleted);
      },
    };
  }
}
