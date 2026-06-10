/**
 * `defineNodeFactory` is the dependency-injection variant of
 * `defineNode`. It exists because some node logic legitimately needs an
 * external service (e.g. an `LlmProvider`, a tool dispatcher, a vector
 * DB client) that the runtime owns and configures.
 *
 * Authoring style (from `packages/runtime/src/nodes/builtin.ts`'s
 * forthcoming `llm` rewrite):
 *
 *   ```ts
 *   import { defineNode, defineNodeFactory } from "@ai-native-flow/node-sdk";
 *   import { z } from "zod";
 *   import type { LlmProvider } from "./llmProvider.js";
 *
 *   export const llmNode = defineNodeFactory<{ llmProvider: LlmProvider }>(
 *     ({ llmProvider }) => defineNode({
 *       type: "llm",
 *       typeVersion: "1.0.0",
 *       title: "LLM",
 *       config: z.object({
 *         prompt: z.string().default(""),
 *         model: z.string().optional(),
 *         temperature: z.number().optional(),
 *         maxTokens: z.number().optional(),
 *         stream: z.boolean().optional(),
 *       }),
 *       async run({ input, config, ctx }) {
 *         const res = await llmProvider.complete(
 *           { prompt: render(config.prompt, input), ...config },
 *           ctx,
 *         );
 *         return { kind: "success", outputs: { out: null, result: res.text } };
 *       },
 *     }),
 *   );
 *
 *   // wiring:
 *   installNode(target, llmNode({ llmProvider }));
 *   ```
 *
 * Why a separate entry-point instead of letting `defineNode` accept
 * either an object or a `(deps) => object`? Because keeping the two
 * shapes lexically distinct lets every `defineNode` callsite stay
 * dependency-free at a glance, and `installNode` can reject misuse
 * with a clear type error.
 */

import type { DefinedNode, NodeFactory } from "./types.js";

/**
 * Lift a deps-bound builder into a tagged `NodeFactory`. Adds a
 * non-enumerable `__factory` marker so `installNode` and tests can
 * distinguish a factory from an already-resolved `DefinedNode`.
 */
export function defineNodeFactory<TDeps>(
  build: (deps: TDeps) => DefinedNode,
): NodeFactory<TDeps> {
  const fn = ((deps: TDeps): DefinedNode => build(deps)) as NodeFactory<TDeps>;
  Object.defineProperty(fn, "__factory", {
    value: true,
    enumerable: false,
    writable: false,
  });
  return fn;
}

/** Type guard used by `installNode` to accept either flavour. */
export function isNodeFactory<TDeps = unknown>(
  value: DefinedNode | NodeFactory<TDeps>,
): value is NodeFactory<TDeps> {
  return (
    typeof value === "function" &&
    (value as { __factory?: true }).__factory === true
  );
}
