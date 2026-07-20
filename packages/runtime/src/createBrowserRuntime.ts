/** Browser/mobile factory that never imports filesystem, SQLite, or process tools. */
import { InMemoryEventBus, type EventBus } from "@ai-native-flow/event-bus";
import {
  createDefaultRegistry,
  type InMemoryNodeTypeRegistry,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import {
  installNode,
  type DefinedNode,
  type InstallTarget,
} from "@ai-native-flow/node-sdk";
import {
  InMemoryVariableStore,
  chainVariableStores,
  type SecretStore,
  type VariableStore,
} from "@ai-native-flow/variable-store/browser";
import { InvocationRouter } from "./invocationRouter.js";
import type { NodeRunner } from "./nodeContext.js";
import type { NodeRunnerRegistry } from "./nodeRunnerRegistry.js";
import type { AgentToolHost } from "./nodes/builtin/agent.js";
import { createBrowserBuiltinRunnerRegistry } from "./nodes/createBrowserBuiltinRunnerRegistry.js";
import {
  AiSdkOpenAICompatibleLlmProvider,
  type LlmProvider,
} from "./nodes/llmProvider.js";
import { RuntimeRegistry } from "./registry.js";
import { RunManager } from "./runManager.js";
import {
  InMemoryArtifactStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  type ArtifactStore,
  type RegistryStore,
  type RunStore,
} from "./storage/browser.js";
import type { Runtime } from "./createRuntime.js";

export interface CreateBrowserRuntimeOptions {
  variables?: VariableStore;
  /** @deprecated Use `variables`. */
  secrets?: SecretStore;
  eventBus?: EventBus;
  runStore?: RunStore;
  registryStore?: RegistryStore;
  artifactStore?: ArtifactStore;
  nodes?: ReadonlyArray<DefinedNode>;
  llmProvider?: LlmProvider;
  /** Inject only native capabilities explicitly approved for mobile. */
  toolHost?: AgentToolHost;
  hashText?: (input: string) => Promise<string>;
  generateRunId?: () => string;
}

export function createBrowserRuntime(
  options: CreateBrowserRuntimeOptions = {},
): Runtime {
  const variables =
    options.variables && options.secrets && options.secrets !== options.variables
      ? chainVariableStores(options.variables, options.secrets)
      : options.variables ?? options.secrets ?? new InMemoryVariableStore();
  const secrets = variables;
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const runStore = options.runStore ?? new InMemoryRunStore();
  const registryStore = options.registryStore ?? new InMemoryRegistryStore();
  const artifactStore = options.artifactStore ?? new InMemoryArtifactStore({
    ...(options.hashText ? { hashText: options.hashText } : {}),
  });
  const llmProvider = options.llmProvider ?? new AiSdkOpenAICompatibleLlmProvider();
  const nodeTypeRegistry: InMemoryNodeTypeRegistry = createDefaultRegistry();
  const runners = createBrowserBuiltinRunnerRegistry({
    llmProvider,
    nodeTypeRegistry,
    ...(options.toolHost ? { toolHost: options.toolHost } : {}),
  });
  const registry = new RuntimeRegistry({
    registryStore,
    artifactStore,
    nodeTypeRegistry,
    ...(options.hashText ? { hashText: options.hashText } : {}),
  });

  if (options.nodes && options.nodes.length > 0) {
    const target: InstallTarget = {
      registerType(definition: NodeTypeDefinition): void {
        nodeTypeRegistry.register(definition);
      },
      registerRunner(type, typeVersion, runner): void {
        runners.register(type, typeVersion, runner as unknown as NodeRunner);
      },
    };
    for (const node of options.nodes) installNode(target, node);
  }

  let invocationRouter!: InvocationRouter;
  const runManager = new RunManager({
    runStore,
    eventBus,
    runners,
    variables,
    secrets,
    ...(options.generateRunId ? { generateRunId: options.generateRunId } : {}),
    triggerEvent: async (event) => invocationRouter.triggerEvent({ event }),
    invokeFlow: async (args) => invocationRouter.invoke(args),
  });
  invocationRouter = new InvocationRouter({ registry, runManager });

  return {
    variables,
    secrets,
    eventBus,
    runStore,
    registryStore,
    artifactStore,
    runners: runners as NodeRunnerRegistry,
    nodeTypeRegistry,
    registry,
    runManager,
    invocationRouter,
  };
}
