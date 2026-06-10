/**
 * LLM Provider abstraction.
 *
 * The runtime never hand-rolls a vendor protocol. Every built-in LLM node
 * calls a `LlmProvider`, and the production provider below delegates
 * OpenAI-compatible communication to Vercel AI SDK.
 *
 * The provider consumes configuration through the standard `VariableStore`
 * interface - this is what makes the "any node, any logic, single env
 * interface" rule concrete:
 *
 *     LLM_BASE_URL          -> VariableStore (non-sensitive)
 *     LLM_DEFAULT_MODEL     -> VariableStore (non-sensitive)
 *     LLM_API_KEY           -> VariableStore
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  normalizeError,
} from "@ai-native-flow/flow-ir";
import type { AiStreamAsyncIterable } from "@ai-native-flow/ai-stream";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import type { VariableStore } from "@ai-native-flow/variable-store";
import type { NodeContext } from "../nodeContext.js";

export const DEFAULT_LLM_BASE_URL_REF = "$var:LLM_BASE_URL";
export const DEFAULT_LLM_API_KEY_REF = "$var:LLM_API_KEY";
export const DEFAULT_LLM_MODEL_REF = "$var:LLM_DEFAULT_MODEL";
export const DEFAULT_LLM_TEMPERATURE = 0;
export const DEFAULT_LLM_MAX_TOKENS = 4096;

export interface LlmCompletionRequest {
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** When true the provider must use a streaming endpoint and emit token deltas. */
  stream?: boolean;
  /**
   * Per-call override for the OpenAI-compatible base URL. When set, the
   * provider uses this verbatim instead of resolving its configured
   * `baseUrlVariable`. Lets a single LLM node target a different
   * endpoint without spinning up a new provider instance.
   */
  baseUrl?: string;
  /**
   * Per-call override for the bearer token. Use `$var` references in node
   * configs; legacy `$secret` references resolve through the same VariableStore.
   */
  apiKey?: string;
}

export interface LlmCompletionResponse {
  text: string;
  /** Optional raw vendor response for debugging / artifacts. */
  raw?: unknown;
  /** Optional usage metadata (tokens, etc.). */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface LlmProvider {
  complete(
    req: LlmCompletionRequest,
    ctx: NodeContext,
  ): Promise<LlmCompletionResponse>;
  /**
   * Optional streaming surface. When implemented, the `llm` builtin
   * forwards each `AiStreamEvent` to `ctx.stream(...).write(...)` so
   * downstream subscribers see token deltas as they arrive. Providers
   * that only support synchronous completion can omit this method; the
   * runner falls back to `complete()` and emits the full text as a
   * single `stream_delta` for consistency.
   */
  completeStream?(
    req: LlmCompletionRequest,
    ctx: NodeContext,
  ): Promise<AiStreamAsyncIterable>;
}

export interface AiSdkOpenAICompatibleLlmProviderOptions {
  /**
   * Variable name that holds the base URL. Defaults to "LLM_BASE_URL".
   * Resolved through `ctx.variables` at call time so a Run-scoped override
   * (e.g. tenant-specific endpoint) takes effect without restarting the
   * runtime.
   */
  baseUrlVariable?: string;
  /** Variable name for the default model id. Defaults to "LLM_DEFAULT_MODEL". */
  defaultModelVariable?: string;
  /** Variable name for the bearer token. Defaults to "LLM_API_KEY". */
  apiKeySecret?: string;
  /** Optional fallback values used if the variable is absent. */
  fallback?: {
    baseUrl?: string;
    defaultModel?: string;
  };
  /** Provider label passed to `createOpenAICompatible`. */
  providerName?: string;
}

/**
 * AI SDK backed OpenAI-compatible provider.
 *
 * This keeps the runtime's public `LlmProvider` boundary intact while
 * delegating model invocation and streaming to Vercel AI SDK.
 */
export class AiSdkOpenAICompatibleLlmProvider implements LlmProvider {
  constructor(private readonly options: AiSdkOpenAICompatibleLlmProviderOptions = {}) {}

  async complete(
    req: LlmCompletionRequest,
    ctx: NodeContext,
  ): Promise<LlmCompletionResponse> {
    const { variables } = ctx;
    const baseUrl =
      resolveConfigString(req.baseUrl, variables, "baseUrl", ctx.nodeId) ??
      pickBaseUrl(variables, this.options);
    const apiKey =
      resolveConfigString(req.apiKey, variables, "apiKey", ctx.nodeId) ??
      pickApiKey(variables, this.options);
    const requestModel = resolveConfigString(
      req.model,
      variables,
      "model",
      ctx.nodeId,
    );
    const defaultModel = pickDefaultModel(variables, this.options);
    const modelId = requestModel ?? defaultModel;
    if (!modelId) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "node.llm.no_model",
          kind: "validation",
          category: "author",
          message:
            "LLM node has no model: provide it via `node.config.model`, the `LLM_DEFAULT_MODEL` variable, or `AiSdkOpenAICompatibleLlmProviderOptions.fallback.defaultModel`.",
          source: { module: "node_logic", nodeId: ctx.nodeId },
        }),
      );
    }

    try {
      const provider = createOpenAICompatible({
        name: this.options.providerName ?? "openai-compatible",
        baseURL: baseUrl,
        apiKey,
      });
      const result = await generateText({
        model: provider(modelId),
        prompt: req.prompt,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
        abortSignal: ctx.signal,
      });
      if (!result.text.trim()) {
        throw new RuntimeErrorException(
          createRuntimeError({
            code: "node.llm.empty_response",
            kind: "unavailable",
            category: "external",
            retryable: true,
            message: "AI SDK LLM provider returned an empty completion",
            source: { module: "node_logic", nodeId: ctx.nodeId },
            context: { model: modelId, provider: this.options.providerName ?? "openai-compatible" },
          }),
        );
      }
      const usage = result.usage as
        | {
            promptTokens?: number;
            completionTokens?: number;
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          }
        | undefined;
      return {
        text: result.text,
        raw: result,
        usage: {
          promptTokens: usage?.promptTokens ?? usage?.inputTokens,
          completionTokens: usage?.completionTokens ?? usage?.outputTokens,
          totalTokens: usage?.totalTokens,
        },
      };
    } catch (cause) {
      if (cause instanceof RuntimeErrorException) throw cause;
      throw new RuntimeErrorException(
        normalizeError(cause, { module: "node_logic", nodeId: ctx.nodeId }),
      );
    }
  }

  async completeStream(
    req: LlmCompletionRequest,
    ctx: NodeContext,
  ): Promise<AiStreamAsyncIterable> {
    const { variables } = ctx;
    const baseUrl =
      resolveConfigString(req.baseUrl, variables, "baseUrl", ctx.nodeId) ??
      pickBaseUrl(variables, this.options);
    const apiKey =
      resolveConfigString(req.apiKey, variables, "apiKey", ctx.nodeId) ??
      pickApiKey(variables, this.options);
    const requestModel = resolveConfigString(
      req.model,
      variables,
      "model",
      ctx.nodeId,
    );
    const defaultModel = pickDefaultModel(variables, this.options);
    const modelId = requestModel ?? defaultModel;
    if (!modelId) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "node.llm.no_model",
          kind: "validation",
          category: "author",
          message:
            "LLM node has no model: provide it via `node.config.model`, the `LLM_DEFAULT_MODEL` variable, or `AiSdkOpenAICompatibleLlmProviderOptions.fallback.defaultModel`.",
          source: { module: "node_logic", nodeId: ctx.nodeId },
        }),
      );
    }

    try {
      const provider = createOpenAICompatible({
        name: this.options.providerName ?? "openai-compatible",
        baseURL: baseUrl,
        apiKey,
      });
      return aiSdkTextStreamToEvents(
        () =>
          streamText({
            model: provider(modelId),
            prompt: req.prompt,
            temperature: req.temperature,
            maxOutputTokens:
              this.options.providerName === "lfzxb" ? undefined : req.maxTokens,
            abortSignal: ctx.signal,
          }).textStream,
        { nodeId: ctx.nodeId, maxAttempts: 2 },
      );
    } catch (cause) {
      if (cause instanceof RuntimeErrorException) throw cause;
      throw new RuntimeErrorException(
        normalizeError(cause, { module: "node_logic", nodeId: ctx.nodeId }),
      );
    }
  }
}

async function* aiSdkTextStreamToEvents(
  createTextStream: () => AsyncIterable<string>,
  options: { nodeId?: string; maxAttempts: number },
): AiStreamAsyncIterable {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let text = "";
    for await (const delta of createTextStream()) {
      if (!delta) continue;
      text += delta;
      yield { kind: "text_delta", text: delta };
    }
    if (text.trim()) {
      yield { kind: "done", text, finishReason: "stop" };
      return;
    }
    if (attempt < options.maxAttempts) continue;
  }
  throw new RuntimeErrorException(
    createRuntimeError({
      code: "node.llm.empty_response",
      kind: "unavailable",
      category: "external",
      retryable: true,
      message: "AI SDK LLM provider returned an empty streamed completion",
      source: { module: "node_logic", nodeId: options.nodeId },
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function resolveConfigString(
  value: string | undefined,
  variables: VariableStore,
  field: "baseUrl" | "apiKey" | "model",
  nodeId: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const ref = /^\$(?:var|secret):([A-Za-z0-9_.:-]+)$/.exec(trimmed);
  if (!ref?.[1]) return value;
  const resolved = variables.getString(ref[1]);
  if (!resolved) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "node.llm.missing_config_ref",
        kind: "validation",
        category: "user_input",
        message: `LLM ${field} references missing variable "${ref[1]}"`,
        source: { module: "node_logic", nodeId },
        context: { field, variable: ref[1] },
      }),
    );
  }
  return resolved;
}

function pickBaseUrl(
  variables: VariableStore,
  options: AiSdkOpenAICompatibleLlmProviderOptions,
): string {
  const name = options.baseUrlVariable ?? "LLM_BASE_URL";
  const fromVar = variables.getString(name);
  const url = fromVar ?? options.fallback?.baseUrl;
  if (!url) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "node.llm.no_base_url",
        kind: "validation",
        category: "user_input",
        message: `LLM provider needs a base URL via variable "${name}" or fallback.baseUrl`,
        source: { module: "node_logic" },
        context: { variable: name },
      }),
    );
  }
  return url;
}

function pickDefaultModel(
  variables: VariableStore,
  options: AiSdkOpenAICompatibleLlmProviderOptions,
): string | undefined {
  const name = options.defaultModelVariable ?? "LLM_DEFAULT_MODEL";
  return variables.getString(name) ?? options.fallback?.defaultModel;
}

function pickApiKey(
  variables: VariableStore,
  options: AiSdkOpenAICompatibleLlmProviderOptions,
): string {
  const name = options.apiKeySecret ?? "LLM_API_KEY";
  const apiKey = variables.getString(name);
  if (!apiKey) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "node.llm.no_api_key",
        kind: "permission",
        category: "user_input",
        message: `LLM provider needs variable "${name}"`,
        source: { module: "node_logic" },
        context: { variable: name },
      }),
    );
  }
  return apiKey;
}
