/**
 * Browser-safe entry-point that exposes every built-in node's
 * `NodeTypeDefinition` (the data track reflected from `defineNode`)
 * **without** dragging the rest of the Runtime — and most importantly
 * without dragging the Node-only `node:fs` / `node:path` modules
 * `FsArtifactStore` reaches for through `createRuntime.ts`.
 *
 * Hosts that just want to render a Studio palette (the in-browser
 * studio-browser example, a docs site, …) import from
 * `@ai-native-flow/runtime/builtin-definitions` instead of the
 * package barrel. The transitive module graph is then strictly:
 *
 *   builtinDefinitions.ts
 *     └── ./nodes/builtin/*.ts        (pure `defineNode(...)` calls)
 *     └── ./nodes/llmProvider.ts      (pure ESM, no node:fs)
 *
 * Keep this file in lockstep with `createBuiltinRunnerRegistry`'s node
 * list — when adding a new built-in, add it here too.
 */

import type { NodeTypeDefinition } from "@ai-native-flow/flow-ir";
import {
  agentNode,
  conditionNode,
  delayNode,
  endNode,
  eventTriggerNode,
  filterItemsNode,
  httpNode,
  joinNode,
  mapItemsNode,
  llmNode,
  parallelNode,
  foreachBeginNode,
  foreachEndNode,
  forBeginNode,
  forEndNode,
  loopBeginNode,
  loopBreakNode,
  loopContinueNode,
  loopEndNode,
  sendEventNode,
  startNode,
  textInputNode,
  toolNode,
  transformNode,
} from "./nodes/builtin/index.js";
import { AiSdkOpenAICompatibleLlmProvider, type LlmProvider } from "./nodes/llmProvider.js";

/**
 * Snapshot of the built-in node-type definitions. Useful for hosts
 * that want a Studio palette without spinning up a full `Runtime`.
 *
 * `llm` is authored as a `defineNodeFactory`, so we instantiate it
 * with a deterministic fake provider purely to retrieve `definition`.
 * The provider is **never invoked** here — we drop the runner half on
 * the floor and only return the data-track definitions.
 */
export function getBuiltinNodeDefinitions(
  options: { llmProvider?: LlmProvider } = {},
): NodeTypeDefinition[] {
  const llmProvider = options.llmProvider ?? new AiSdkOpenAICompatibleLlmProvider();
  const llmDefined = llmNode({ llmProvider });
  const agentDefined = agentNode({
    llmProvider,
    toolHost: {
      async callTool() {
        return { ok: false, error: "agent tools are unavailable in definitions mode" };
      },
    },
  });
  return [
    startNode.definition,
    endNode.definition,
    transformNode.definition,
    conditionNode.definition,
    delayNode.definition,
    filterItemsNode.definition,
    httpNode.definition,
    joinNode.definition,
    mapItemsNode.definition,
    parallelNode.definition,
    toolNode.definition,
    textInputNode.definition,
    llmDefined.definition,
    agentDefined.definition,
    eventTriggerNode.definition,
    sendEventNode.definition,
    foreachBeginNode.definition,
    foreachEndNode.definition,
    forBeginNode.definition,
    forEndNode.definition,
    loopBeginNode.definition,
    loopBreakNode.definition,
    loopContinueNode.definition,
    loopEndNode.definition,
  ];
}
