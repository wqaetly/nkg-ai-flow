/**
 * Author-facing types for the Node SDK.
 *
 * `defineNode` produces a `DefinedNode` that bundles the data-track
 * (`NodeTypeDefinition`) and the behaviour-track (`NodeRunner`) together,
 * so the rest of the system can register both halves in one call via
 * `installNode`.
 */

import type { z } from "zod";
import type {
  FieldMeta,
  NodeCapabilities,
  NodeTypeDefinition,
  PortDefinition,
} from "@ai-native-flow/flow-ir";

/**
 * Minimal subset of the runtime `NodeContext` that node authors are
 * allowed to depend on. The Node SDK intentionally re-declares the shape
 * here (instead of importing from `@ai-native-flow/runtime`) so that
 * nodes can be authored without pulling the whole runtime into the
 * dependency graph.
 *
 * The runtime's `NodeContext` is structurally compatible with this type;
 * `installNode` does the bridging.
 */
export interface SdkNodeContext {
  readonly runId: string;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly nodeVersion: string;
  readonly attempt: number;
  readonly signal: AbortSignal;

  readonly variables: {
    getString(name: string): string | undefined;
    getNumber(name: string): number | undefined;
    getBoolean(name: string): boolean | undefined;
    get(name: string): unknown;
  };
  readonly secrets: {
    get(name: string): { reveal(): string } | undefined;
  };
  readonly log: {
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };

  /**
   * Publish a simple runtime event that can start matching `event_trigger`
   * flows. The event name is the payload; higher-level payload routing is
   * intentionally left out of the first trigger implementation.
   */
  triggerEvent(event: string): Promise<unknown>;

  /**
   * Optional streaming primitives. Present at runtime; SDK exposes them
   * as `unknown`-typed escape hatches so that nodes which don't stream
   * never have to import the runtime stream types.
   *
   * Nodes that need external dependencies (an `LlmProvider`, a database
   * client, ...) do **not** read them from `ctx`. Instead they are
   * authored via `defineNodeFactory((deps) => defineNode({...}))` and
   * the deps are bound at `installNode` time. This keeps `NodeContext`
   * minimal and makes every node's dependency surface explicit in its
   * own type signature.
   */
  emit(event: unknown): Promise<unknown>;
  stream(portId: string, options?: unknown): Promise<unknown>;
}

/** Outcome returned by a node `run` function. */
export type SdkNodeResult<TOutput = Record<string, unknown>> =
  | { kind: "success"; outputs: TOutput }
  | {
      kind: "error";
      error: { code: string; message: string; [k: string]: unknown };
    }
  | { kind: "skip"; reason: string };

/**
 * Arguments passed to a node `run` function. Authoring style:
 *
 *   ```ts
 *   defineNode({
 *     id: "extract-keywords",
 *     config: z.object({ topN: z.number().default(10) }),
 *     input:  z.object({ text: z.string() }),
 *     output: z.object({ keywords: z.array(z.string()) }),
 *     async run({ input, config, ctx }) { ... }
 *   });
 *   ```
 */
export interface SdkRunArgs<TInput, TConfig> {
  readonly input: TInput;
  readonly config: TConfig;
  readonly ctx: SdkNodeContext;
}

/** Function type for a node's `run` implementation. */
export type SdkRunFn<TInput, TConfig, TOutput> = (
  args: SdkRunArgs<TInput, TConfig>,
) => SdkNodeResult<TOutput> | Promise<SdkNodeResult<TOutput>>;

/**
 * The full spec a node author writes. Schemas use Zod, ports are
 * optional (start/end pseudo-nodes set `kind: "pseudo"` to opt out of
 * the default control-in/control-out wiring).
 */
export interface DefineNodeSpec<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Stable type id, e.g. `"extract-keywords"`. */
  type: string;
  /** Semantic version of this node implementation, e.g. `"1.0.0"`. */
  typeVersion: string;
  /** Human-readable label shown in Studio palettes / docs. */
  title: string;
  description?: string;

  /**
   * Pseudo-nodes (start / end) skip the auto-generated control ports and
   * provide their own `defaultPorts` instead.
   */
  kind?: "default" | "pseudo";

  /** Zod schema for `node.config`. Defaults to passthrough record. */
  config?: z.ZodType<TConfig>;

  /**
   * Zod schema for the merged input payload that arrives on data ports.
   * Defaults to passthrough record. Used for compile-time inference and
   * runtime validation (when `validateInput !== false`).
   */
  input?: z.ZodType<TInput>;

  /**
   * Zod schema for the merged output payload published to data ports.
   * Currently used for documentation only; future Phases may strict-validate.
   */
  output?: z.ZodType<TOutput>;

  /**
   * Extra ports beyond the auto-generated control-in / control-out and
   * the implicit data port derived from `input` / `output`. Use when the
   * node has multiple inputs, multiple outputs or a dedicated error port.
   */
  ports?: PortDefinition[];

  /** Capability hints surfaced through the Node Type Registry. */
  capabilities?: Partial<NodeCapabilities>;

  /**
   * Marks the runtime classification: `"builtin"` (in-process, default),
   * `"plugin"` (loaded via plugin manifest, Phase 3) or `"sandbox"`
   * (isolated process / container, Phase 3+).
   */
  runtime?: NodeTypeDefinition["runtime"];

  /**
   * The node logic. Receives validated `input`, parsed `config`, and the
   * runtime `ctx`. Throwing or returning `{ kind: "error", error }` both
   * surface as a node failure; the runtime normalises either into a
   * `RuntimeError`.
   */
  run: SdkRunFn<TInput, TConfig, TOutput>;

  /**
   * If `false`, skips Zod validation of `input` and just passes the raw
   * record through. Defaults to `true` when an `input` schema is given.
   * Pseudo-nodes (start / end) typically want `false` because the engine
   * injects synthetic fields (`runInput`, `in`).
   */
  validateInput?: boolean;

  /**
   * Optional UI hints layered on top of the Zod-reflected `config`
   * fields. Each key is a top-level field name in the `config` object;
   * the value tweaks how Studio renders the corresponding control
   * (label, placeholder, secret, hidden, order, control type, ...).
   *
   * These metadata never affect runtime behaviour — they are merged
   * into `NodeTypeDefinition.configSchema.fields` at definition time
   * and consumed by the Studio's field-inspector. Authors who don't
   * supply `fieldMeta` still get a fully reflected UI based on the
   * Zod schema alone.
   */
  fieldMeta?: Record<string, FieldMeta>;
}

/**
 * Bundle returned by `defineNode`. Carries both halves so transports
 * never have to know which Registry to talk to.
 */
export interface DefinedNode {
  /** Data track: shape for Studio / Builder / Validator. */
  readonly definition: NodeTypeDefinition;

  /** Capability track: host permissions required before registration/run. */
  readonly capabilities?: NodeCapabilities;

  /** Behaviour track: function for the Execution Engine. */
  readonly runner: SdkInternalRunner;
}

/**
 * Internal runner signature. Compatible with `runtime`'s `NodeRunner`
 * but expressed in terms only the SDK depends on, to keep the SDK free
 * of a runtime import.
 */
export type SdkInternalRunner = (
  inputs: Record<string, unknown>,
  ctx: SdkNodeContext,
) =>
  | Promise<SdkNodeResult<Record<string, unknown>>>
  | SdkNodeResult<Record<string, unknown>>;

/**
 * Closure produced by `defineNodeFactory<TDeps>(factory)`. Calling it
 * with the concrete deps yields a fully-resolved `DefinedNode` ready
 * for `installNode`.
 *
 * Example:
 *
 *   ```ts
 *   const llmNode = defineNodeFactory<{ llmProvider: LlmProvider }>(
 *     ({ llmProvider }) => defineNode({
 *       type: "llm",
 *       typeVersion: "1.0.0",
 *       title: "LLM",
 *       async run({ input, config, ctx }) {
 *         const res = await llmProvider.complete({ ...config }, ctx);
 *         return { kind: "success", outputs: { out: null, result: res.text } };
 *       },
 *     }),
 *   );
 *
 *   installNode(target, llmNode({ llmProvider }));
 *   ```
 */
export interface NodeFactory<TDeps> {
  (deps: TDeps): DefinedNode;
  /** Marker so `installNode` can distinguish factories from instances. */
  readonly __factory: true;
}
