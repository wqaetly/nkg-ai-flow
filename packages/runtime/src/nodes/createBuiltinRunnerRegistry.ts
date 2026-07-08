/**
 * Convenience factory that wires the built-in NodeRunner catalogue.
 *
 * Phase 1 ships start / end / transform / condition / http / tool /
 * llm / text_input / agent / event_trigger / send_event. All built-ins
 * are authored via `defineNode` / `defineNodeFactory` in `./builtin/`,
 * so the wiring here is identical
 * to what a third-party plugin would write — there is no special-casing
 * for "built-ins".
 *
 * The `defineNode` outputs carry both halves of a node's contract:
 *
 *   - The data track (`NodeTypeDefinition`, including the reflected
 *     `configSchema.fields[]` consumed by Studio's Node Field Inspector).
 *   - The runner (executes `(input, config, ctx) => result`).
 *
 * `installNode(target, node)` dispatches each half to the matching
 * `InstallTarget` callback. The factory accepts an optional
 * `nodeTypeRegistry` so callers (notably `createRuntime`) can have the
 * data track land in their shared registry without writing custom
 * plumbing.
 */

import {
  RuntimeErrorException,
  type InMemoryNodeTypeRegistry,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import { installNode, type InstallTarget } from "@ai-native-flow/node-sdk";
import type { SandboxAdapter } from "@ai-native-flow/sandbox";
import { InMemoryNodeRunnerRegistry } from "../nodeRunnerRegistry.js";
import type { NodeRunner } from "../nodeContext.js";
import {
  circuitBreakerNode,
  compensationNode,
  conditionNode,
  delayNode,
  filterItemsNode,
  agentNode,
  endNode,
  eventTriggerNode,
  httpNode,
  joinNode,
  mapItemsNode,
  mergeNode,
  parallelNode,
  reduceItemsNode,
  retryPolicyNode,
  switchCaseNode,
  foreachBeginNode,
  foreachEndNode,
  forBeginNode,
  forEndNode,
  llmNode,
  loopBeginNode,
  loopBreakNode,
  loopContinueNode,
  loopEndNode,
  sendEventNode,
  startNode,
  stateGetNode,
  stateSetNode,
  textInputNode,
  toolNode,
  transformNode,
  waitSignalNode,
} from "./builtin/index.js";
import { createNodeAgentToolHost } from "./builtin/agentTools.node.js";
import { AiSdkOpenAICompatibleLlmProvider, type LlmProvider } from "./llmProvider.js";

export interface CreateBuiltinRunnerRegistryOptions {
  /**
   * Provider used by the `llm` node. Defaults to the AI SDK backed
   * OpenAI-compatible provider.
   */
  llmProvider?: LlmProvider;
  /**
   * Sandbox adapter used by the runner registry to wrap every freshly
   * registered node logic. Defaults to `InProcessSandboxAdapter` (set
   * by `InMemoryNodeRunnerRegistry`'s constructor). The option is kept
   * open for callers who want to plug in a custom adapter (e.g. a
   * timeout / metrics decorator) without forking the registry.
   */
  sandboxAdapter?: SandboxAdapter;
  /**
   * Optional shared `NodeTypeRegistry`. When provided, every built-in
   * node's `NodeTypeDefinition` (data track) is registered into it via
   * the regular `InstallTarget.registerType` callback — exactly like a
   * third-party node would. Definitions whose `(type, typeVersion)` is
   * already present are skipped (so the IR-level pseudo-nodes
   * `start` / `end`, pre-filled by `createDefaultRegistry()`, don't
   * trigger a `version_conflict`).
   *
   * When omitted, the data track is dropped on the floor and only the
   * runner half is wired — useful for callers that already provide
   * the data track elsewhere or for tests.
   */
  nodeTypeRegistry?: InMemoryNodeTypeRegistry;
}

/**
 * Build the `InstallTarget` consumed by `installNode`. The runner
 * registry always receives the runner half; the type registry is
 * optional and treated as additive (existing entries are kept,
 * preventing the IR-level pseudo-node pre-fill from collisioning).
 */
function makeInstallTarget(
  runners: InMemoryNodeRunnerRegistry,
  types: InMemoryNodeTypeRegistry | undefined,
): InstallTarget {
  return {
    registerType(definition: NodeTypeDefinition): void {
      if (!types) return;
      // Skip definitions already present (e.g. start/end pseudo-nodes
      // pre-registered by `createDefaultRegistry()`). Anything else is
      // appended through the same path third-party nodes use.
      if (types.has(definition.type, definition.typeVersion)) return;
      try {
        types.register(definition);
      } catch (cause) {
        // Stay defensive: if the underlying registry rejects for any
        // reason other than version conflict, surface it loudly so the
        // misbehaving node is easy to spot.
        if (
          cause instanceof RuntimeErrorException &&
          cause.error.code === "registry.version_conflict"
        ) {
          return;
        }
        throw cause;
      }
    },
    registerRunner(type, typeVersion, runner): void {
      // The SDK's `SdkInternalRunner` is structurally compatible with
      // the runtime's `NodeRunner` (same call signature, same return
      // shape modulo the runtime-specific `RuntimeError` factory).
      // `installNode` always feeds us the runner produced by
      // `defineNode`'s `buildRunner`, which already calls Zod and
      // surfaces validation failures as `{ kind: "error", error }`.
      runners.register(type, typeVersion, runner as unknown as NodeRunner);
    },
  };
}

export function createBuiltinRunnerRegistry(
  options: CreateBuiltinRunnerRegistryOptions = {},
): InMemoryNodeRunnerRegistry {
  const registry = new InMemoryNodeRunnerRegistry(
    options.sandboxAdapter ? { sandboxAdapter: options.sandboxAdapter } : {},
  );
  const llmProvider = options.llmProvider ?? new AiSdkOpenAICompatibleLlmProvider();
  const target = makeInstallTarget(registry, options.nodeTypeRegistry);

  installNode(target, startNode);
  installNode(target, endNode);
  installNode(target, transformNode);
  installNode(target, circuitBreakerNode);
  installNode(target, compensationNode);
  installNode(target, conditionNode);
  installNode(target, delayNode);
  installNode(target, filterItemsNode);
  installNode(target, httpNode);
  installNode(target, joinNode);
  installNode(target, mapItemsNode);
  installNode(target, mergeNode);
  installNode(target, parallelNode);
  installNode(target, reduceItemsNode);
  installNode(target, retryPolicyNode);
  installNode(target, switchCaseNode);
  installNode(target, toolNode);
  installNode(target, textInputNode);
  installNode(target, waitSignalNode);
  installNode(target, llmNode, { llmProvider });
  installNode(target, agentNode, {
    llmProvider,
    toolHost: createNodeAgentToolHost(),
  });
  installNode(target, eventTriggerNode);
  installNode(target, sendEventNode);
  installNode(target, stateGetNode);
  installNode(target, stateSetNode);
  installNode(target, foreachBeginNode);
  installNode(target, foreachEndNode);
  installNode(target, forBeginNode);
  installNode(target, forEndNode);
  installNode(target, loopBeginNode);
  installNode(target, loopBreakNode);
  installNode(target, loopContinueNode);
  installNode(target, loopEndNode);

  return registry;
}
