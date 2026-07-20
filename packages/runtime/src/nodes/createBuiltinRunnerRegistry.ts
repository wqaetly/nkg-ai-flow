/** Node-hosted built-in catalogue, including filesystem/process agent tools. */
import type { InMemoryNodeTypeRegistry } from "@ai-native-flow/flow-ir";
import type { SandboxAdapter } from "@ai-native-flow/sandbox";
import { createNodeAgentToolHost } from "./builtin/agentTools.node.js";
import {
  createBrowserBuiltinRunnerRegistry,
} from "./createBrowserBuiltinRunnerRegistry.js";
import type { LlmProvider } from "./llmProvider.js";

export interface CreateBuiltinRunnerRegistryOptions {
  llmProvider?: LlmProvider;
  sandboxAdapter?: SandboxAdapter;
  nodeTypeRegistry?: InMemoryNodeTypeRegistry;
}

export function createBuiltinRunnerRegistry(
  options: CreateBuiltinRunnerRegistryOptions = {},
) {
  return createBrowserBuiltinRunnerRegistry({
    ...options,
    toolHost: createNodeAgentToolHost(),
  });
}
