/**
 * One-shot factory that wires the default in-memory Runtime.
 *
 * Used by the HTTP transport, the CLI, and tests that don't need to
 * customise individual parts. Authors who need to register custom
 * nodes pass them through `options.nodes` as `DefinedNode`s produced
 * by `defineNode` / `defineNodeFactory` from `@ai-native-flow/node-sdk`
 * — the SDK is the **single supported entry-point** for declaring new
 * node types.
 */

import { InMemoryEventBus, type EventBus } from "@ai-native-flow/event-bus";
import {
  installNode,
  type DefinedNode,
  type InstallTarget,
} from "@ai-native-flow/node-sdk";
import {
  createDefaultRegistry,
  type InMemoryNodeTypeRegistry,
  type NodeCapabilities,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import {
  bootstrapDefaults,
  chainVariableStores,
  getDefaultVariableStore,
  type SecretStore,
  type VariableStore,
} from "@ai-native-flow/variable-store";
import { InvocationRouter } from "./invocationRouter.js";
import { createBuiltinRunnerRegistry } from "./nodes/createBuiltinRunnerRegistry.js";
import { AiSdkOpenAICompatibleLlmProvider, type LlmProvider } from "./nodes/llmProvider.js";
import type { NodeRunner } from "./nodeContext.js";
import type { NodeRunnerRegistry } from "./nodeRunnerRegistry.js";
import type { RuntimeCapabilityManifest } from "./capabilities.js";
import { RuntimeRegistry } from "./registry.js";
import { RunManager } from "./runManager.js";
import {
  FsArtifactStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  type ArtifactStore,
  type RegistryStore,
  type RunStore,
} from "./storage/index.js";

export interface CreateRuntimeOptions {
  /** Variable store; defaults to the process-wide default. */
  variables?: VariableStore;
  /** @deprecated Use `variables`; this is treated as the same store. */
  secrets?: SecretStore;
  /** EventBus; defaults to a fresh InMemoryEventBus. */
  eventBus?: EventBus;
  /** RunStore; defaults to InMemoryRunStore. */
  runStore?: RunStore;
  /** RegistryStore; defaults to InMemoryRegistryStore. */
  registryStore?: RegistryStore;
  /** ArtifactStore; defaults to FsArtifactStore at `<cwd>/artifacts/flows`. */
  artifactStore?: ArtifactStore;
  /**
   * Custom nodes authored via `defineNode` / `defineNodeFactory`. They
   * are installed *after* the built-in catalogue, so a custom node may
   * shadow a built-in by reusing its `(type, typeVersion)` pair.
   *
   * For dependency-injected nodes (factories), call the factory with
   * its deps before passing it in:
   *
   *   ```ts
   *   import { myDbNode } from "./my-db-node.js";
   *   createRuntime({ nodes: [myDbNode({ db })] });
   *   ```
   */
  nodes?: ReadonlyArray<DefinedNode>;
  /**
   * LLM provider for the `llm` node. Defaults to the AI SDK backed
   * OpenAI-compatible provider that reads its config through
   * `ctx.variables` (see `./nodes/llmProvider.ts`).
   */
  llmProvider?: LlmProvider;
  /**
   * If true, call `bootstrapDefaults` automatically when neither
   * `variables` nor `secrets` is supplied. Defaults to false to keep
   * lifecycle explicit; CLIs and HTTP transports usually want true.
   */
  autoBootstrap?: boolean;
  /** Optional capability gate for hosts that need registration preflight. */
  capabilities?: RuntimeCapabilityManifest;
  /** Explicit host HTTP implementation for HTTP and LLM nodes. */
  fetch?: typeof fetch;
}

export interface Runtime {
  variables: VariableStore;
  secrets: SecretStore;
  eventBus: EventBus;
  runStore: RunStore;
  registryStore: RegistryStore;
  artifactStore: ArtifactStore;
  /**
   * The internal runner registry. Exposed read-only on the Runtime
   * bundle so transports can inspect what's wired, but the supported
   * way to *add* nodes is `options.nodes` (the SDK route).
   */
  runners: NodeRunnerRegistry;
  /**
   * Shared `NodeTypeRegistry` populated with both built-ins and any
   * custom nodes installed via `options.nodes`. Transports / tests
   * that need to author flows referencing those custom types should
   * pass this to `defineFlow({ registry })` so the Builder accepts
   * the new types.
   */
  nodeTypeRegistry: InMemoryNodeTypeRegistry;
  registry: RuntimeRegistry;
  runManager: RunManager;
  invocationRouter: InvocationRouter;
}

export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  if (options.autoBootstrap && !options.variables && !options.secrets) {
    bootstrapDefaults();
  }
  const variables =
    options.variables && options.secrets && options.secrets !== options.variables
      ? chainVariableStores(options.variables, options.secrets)
      : options.variables ?? options.secrets ?? getDefaultVariableStore();
  const secrets = variables;
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const runStore = options.runStore ?? new InMemoryRunStore();
  const registryStore = options.registryStore ?? new InMemoryRegistryStore();
  const artifactStore =
    options.artifactStore ?? new FsArtifactStore("artifacts/flows");
  const llmProvider = options.llmProvider ?? new AiSdkOpenAICompatibleLlmProvider({
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
  });
  const nodeTypeRegistry: InMemoryNodeTypeRegistry = createDefaultRegistry();
  const runners = createBuiltinRunnerRegistry({
    llmProvider,
    nodeTypeRegistry,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const registry = new RuntimeRegistry({
    registryStore,
    artifactStore,
    nodeTypeRegistry,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });

  // Install user-supplied custom nodes (SDK route). Their data track
  // is registered into the shared NodeTypeRegistry (so the validator
  // accepts flows that reference them); their runner track lands in
  // the runner registry. Built-ins already populated both halves.
  if (options.nodes && options.nodes.length > 0) {
    const target: InstallTarget = {
      registerType(definition: NodeTypeDefinition, capabilities?: NodeCapabilities): void {
        nodeTypeRegistry.register(definition, capabilities);
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
    triggerEvent: async (event) => {
      return invocationRouter.triggerEvent({ event });
    },
    invokeFlow: async (args) => {
      return invocationRouter.invoke(args);
    },
  });
  invocationRouter = new InvocationRouter({ registry, runManager });

  return {
    variables,
    secrets,
    eventBus,
    runStore,
    registryStore,
    artifactStore,
    runners,
    nodeTypeRegistry,
    registry,
    runManager,
    invocationRouter,
  };
}
