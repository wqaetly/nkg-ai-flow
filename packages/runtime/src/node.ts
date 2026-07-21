/**
 * Explicit Node.js Runtime entry point.
 *
 * This host includes filesystem-backed artifacts plus filesystem/process
 * agent tools. Portable business code should import the package root.
 */
export * from "./types.js";
export * from "./capabilities.js";
export * from "./nodeContext.js";
export * from "./nodeEventChannel.js";
export * from "./registry.js";
export * from "./runManager.js";
export * from "./invocationRouter.js";
export * from "./executionEngine.js";
export * from "./storage/index.js";
export {
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
export { getBuiltinNodeDefinitions } from "./builtinDefinitions.js";
export type {
  AgentToolCall,
  AgentToolHost,
  AgentToolName,
  AgentToolResult,
} from "./nodes/builtin/agent.js";
export * from "./createRuntime.js";
export {
  createRuntime as createNodeRuntime,
  type CreateRuntimeOptions as CreateNodeRuntimeOptions,
} from "./createRuntime.js";
