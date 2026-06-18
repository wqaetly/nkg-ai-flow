/**
 * Public exports of the Runtime package.
 *
 * Authors building a transport (HTTP, CLI, MCP) should pull
 * `createRuntime()` to get a wired-up bundle of Registry + RunManager +
 * InvocationRouter + EventBus.
 *
 * **Custom nodes**: declare them with `defineNode` /
 * `defineNodeFactory` from `@ai-native-flow/node-sdk`, then pass them
 * via `createRuntime({ nodes: [...] })`. The legacy `NodeRunnerRegistry`
 * surface is no longer exported as a public API; the SDK is the single
 * supported entry-point.
 */

export * from "./types.js";
export * from "./nodeContext.js";
export * from "./nodeEventChannel.js";
export * from "./registry.js";
export * from "./runManager.js";
export * from "./invocationRouter.js";
export * from "./executionEngine.js";
export * from "./storage/index.js";
export {
  // Provider abstraction for the `llm` node. The built-in production
  // provider delegates OpenAI-compatible calls to Vercel AI SDK.
  AiSdkOpenAICompatibleLlmProvider,
  generateJsonCompletion,
  streamCompletion,
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
  type AiSdkOpenAICompatibleLlmProviderOptions,
  type GenerateCompletionParams,
  type LlmProvider,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
} from "./nodes/llmProvider.js";
export {
  // Snapshot of every built-in node's `NodeTypeDefinition` (data
  // track), reflected from the `defineNode` calls. Useful for hosts
  // that want a Studio palette without spinning up a full Runtime.
  // Browser-only consumers should import from
  // `@ai-native-flow/runtime/builtin-definitions` instead so they
  // don't pull in `createRuntime`'s `node:fs` / `node:path` deps.
  getBuiltinNodeDefinitions,
} from "./builtinDefinitions.js";
export * from "./createRuntime.js";
