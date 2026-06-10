/**
 * NodeContext and NodeRunner contracts.
 *
 * Every node's runtime logic receives a `NodeContext` that gives it:
 *
 *   - `ctx.variables`  : VariableStore - runtime config (model name,
 *                        base URL, API tokens, timeouts, feature flags...).
 *   - `ctx.secrets`    : deprecated alias of `ctx.variables`.
 *   - `ctx.log`        : structured logger that fans out as `node_log`
 *                        events on the EventBus.
 *   - `ctx.signal`     : AbortSignal cancelling the node when the Run is
 *                        cancelled or the per-node timeout fires.
 *   - `ctx.runId`/`ctx.flowId`/`ctx.flowVersion`/`ctx.nodeId`/`ctx.attempt`
 *                      : addressing fields, useful for log correlation.
 *
 * The contract is the same for built-in nodes, plugin nodes, and any user
 * logic that wants to read environment configuration through the same
 * interface (e.g. an HTTP middleware that wants `ctx.variables.get("HTTP_TIMEOUT_MS")`).
 *
 * Phase 1 instantiates one NodeContext per (node, attempt) inside the
 * Execution Engine. Phase 2 extends the contract with `ctx.streams` for
 * streaming outputs.
 */

import type { RuntimeError } from "@ai-native-flow/flow-ir";
import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { SecretStore, VariableStore } from "@ai-native-flow/variable-store";
import type {
  NodeEmitInput,
  NodeOutputStream,
  NodeStreamOptions,
} from "./nodeEventChannel.js";

export interface NodeLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Minimal context object handed to every node and shared with logic helpers.
 *
 * Phase 2 adds two streaming primitives so node logic does not have to
 * touch the EventBus directly:
 *
 *   - `ctx.emit(event)`  : publish an arbitrary NodeEvent (e.g. a
 *                          `stream_artifact` patch, a `tool_call_started`
 *                          marker, a `node_warning`).
 *   - `ctx.stream(port)` : open a backpressure-aware stream that emits
 *                          `stream_open` / `stream_delta` / `stream_close`.
 *
 * Both go through the per-(node, attempt) `NodeEventChannel` which owns
 * `seq` allocation and persistence ordering (see `nodeEventChannel.ts`).
 */
export interface NodeContext {
  readonly runId: string;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly nodeVersion: string;
  readonly attempt: number;
  readonly variables: VariableStore;
  /** @deprecated Use `variables`; this is the same store. */
  readonly secrets: SecretStore;
  readonly log: NodeLogger;
  readonly signal: AbortSignal;

  /**
   * Publish a simple string event into the Runtime trigger layer. Matching
   * active flows that start with `event_trigger` nodes are invoked by the
   * router; the event string itself becomes the triggered run input.
   */
  triggerEvent(event: string): Promise<unknown>;

  /** Publish an arbitrary `NodeEvent` (the channel fills in identity + seq). */
  emit(event: NodeEmitInput): Promise<NodeEvent>;
  /** Open an output stream on `portId`. Resolves once `stream_open` is persisted. */
  stream(portId: string, options?: NodeStreamOptions): Promise<NodeOutputStream>;
}

/** Outcome of a single node execution attempt. */
export type NodeResult =
  | { kind: "success"; outputs: NodeOutputs }
  | { kind: "error"; error: RuntimeError }
  | { kind: "skip"; reason: string };

/**
 * Output payload keyed by output port id. The Scheduler routes each entry
 * along the matching outgoing edge.
 *
 * For control-only ports the value should be `null` (presence on this map
 * means "fire control"). Data ports may carry any JSON-serialisable value.
 */
export type NodeOutputs = Record<string, unknown>;

/** Input payload keyed by input port id. */
export type NodeInputs = Record<string, unknown>;

/**
 * The functional contract a Node implementation fulfils. Pure functions
 * are encouraged so that retries with the same input are deterministic.
 */
export type NodeRunner = (
  input: NodeInputs,
  ctx: NodeContext,
) => Promise<NodeResult> | NodeResult;
