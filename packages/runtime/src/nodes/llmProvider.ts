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
import type { ProviderOptions } from "@ai-sdk/provider-utils";
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
  /**
   * When true, ask the model for strict JSON output. Translated to the
   * OpenAI-compatible `response_format: { type: "json_object" }` body field
   * (DeepSeek "JSON Output"). Default false keeps the legacy plain-text behavior
   * so built-in `llm` nodes are unaffected.
   */
  jsonOutput?: boolean;
  /**
   * Vendor-specific request fields passed through verbatim, keyed by provider
   * name (e.g. `{ lfzxb: { thinking: { type: "disabled" } } }`). The
   * OpenAI-compatible adapter spreads any key not in its own option schema
   * straight into the request body, so this is the supported escape hatch for
   * fields the SDK does not model (thinking toggles, reasoning effort, etc.).
   */
  providerOptions?: ProviderOptions;
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

/**
 * Boundary between node logic and a concrete model backend.
 *
 * Retry contract: transport-level retries (5xx / network / rate limit) are the
 * backend's responsibility (the AI SDK provider applies its own `maxRetries`);
 * business-level retries — a successful call that yields an empty body — are
 * handled here in the provider (`complete` rejects empty text; `completeStream`
 * re-pulls the stream up to `maxAttempts`).
 */
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
 * Shared parameters for the two NodeContext-free AI SDK entry points
 * ({@link generateJsonCompletion} and {@link streamCompletion}).
 */
export interface GenerateCompletionParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** Optional system instruction. Forwarded to the SDK's `system` only when set. */
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Provider label for `createOpenAICompatible`. Must match the `providerOptions` key. */
  providerName?: string;
  /** When true, request strict JSON via `response_format: { type: "json_object" }`. */
  jsonOutput?: boolean;
  /** Vendor-specific body fields, keyed by provider name (spread verbatim by the adapter). */
  providerOptions?: ProviderOptions;
  /**
   * Retry budget handed to the AI SDK. Defaults to the SDK default (2).
   *
   * Retry responsibilities are split deliberately:
   *   - transport-level retries (5xx / network / rate limit) are owned by the
   *     AI SDK via this `maxRetries`;
   *   - business-level retries (e.g. a successful HTTP call that returns an
   *     empty body) are owned by the provider/caller — see the empty-response
   *     checks in `complete()` / `streamCompletion`.
   */
  maxRetries?: number;
  abortSignal?: AbortSignal;
  /**
   * Custom fetch, forwarded to `createOpenAICompatible`. Production callers omit
   * this (the SDK uses global fetch); tests inject a stub to assert the outgoing
   * request body without hitting the network.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the provider name and assemble the final `providerOptions` map.
 *
 * The OpenAI-compatible adapter only spreads the `providerOptions` bucket
 * **whose key equals the provider name**; any other bucket is silently ignored.
 * A mismatched key therefore drops vendor fields without any error — the exact
 * trap that masked a missing `reasoningEffort`. So we validate it loudly here.
 */
function buildProviderOptions(
  params: Pick<
    GenerateCompletionParams,
    "providerName" | "providerOptions" | "jsonOutput"
  >,
): { providerName: string; providerOptions: ProviderOptions } {
  const providerName = params.providerName ?? "openai-compatible";
  const providerOptions: ProviderOptions = {};
  for (const [key, value] of Object.entries(params.providerOptions ?? {})) {
    if (key !== providerName) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "node.llm.provider_options_key_mismatch",
          kind: "validation",
          category: "author",
          message:
            `providerOptions key "${key}" does not match providerName "${providerName}". ` +
            "The OpenAI-compatible adapter only forwards the bucket matching the provider " +
            "name, so these fields would be silently dropped.",
          source: { module: "node_logic" },
          context: { providerName, offendingKey: key },
        }),
      );
    }
    providerOptions[key] = { ...value };
  }
  if (params.jsonOutput) {
    const bucket = (providerOptions[providerName] ??= {});
    // Only set when the caller hasn't already provided a response_format.
    if (!("response_format" in bucket)) {
      bucket.response_format = { type: "json_object" };
    }
  }
  return { providerName, providerOptions };
}

/** Normalize AI SDK usage across SDK v4 (`promptTokens`) and v6 (`inputTokens`) field names. */
function normalizeUsage(raw: unknown): LlmCompletionResponse["usage"] {
  const usage = raw as
    | {
        promptTokens?: number;
        completionTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  return {
    promptTokens: usage?.promptTokens ?? usage?.inputTokens,
    completionTokens: usage?.completionTokens ?? usage?.outputTokens,
    totalTokens: usage?.totalTokens,
  };
}

/**
 * Build everything the two SDK calls share: the resolved provider instance and
 * the common argument object handed to `generateText` / `streamText`. The only
 * thing that differs between the JSON and streaming paths is which SDK function
 * consumes these args, so everything else is computed here exactly once.
 */
function buildCallArgs(params: GenerateCompletionParams) {
  const { providerName, providerOptions } = buildProviderOptions(params);
  const provider = createOpenAICompatible({
    name: providerName,
    baseURL: params.baseUrl,
    apiKey: params.apiKey,
    ...(params.fetchImpl ? { fetch: params.fetchImpl } : {}),
  });
  const args = {
    model: provider(params.model),
    ...(params.system ? { system: params.system } : {}),
    prompt: params.prompt,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens,
    abortSignal: params.abortSignal,
    ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
  return args;
}

/**
 * NodeContext-free entry point to the AI SDK OpenAI-compatible path.
 *
 * Both {@link AiSdkOpenAICompatibleLlmProvider.complete} and external callers
 * funnel through here so there is a single place that talks to Vercel AI SDK.
 *
 * JSON Output + vendor private fields are delivered through `providerOptions`:
 * the OpenAI-compatible adapter spreads any key that is not part of its own
 * option schema straight into the request body. So `response_format` and e.g.
 * `thinking` ride along untouched, while schema-known keys like `reasoningEffort`
 * are mapped by the adapter (`reasoning_effort`). Callers therefore pass
 * `reasoningEffort` (camelCase) but `response_format` / `thinking` (raw).
 */
export async function generateJsonCompletion(
  params: GenerateCompletionParams,
): Promise<LlmCompletionResponse> {
  const result = await generateText(buildCallArgs(params));
  return {
    text: result.text,
    raw: result,
    usage: normalizeUsage(result.usage),
  };
}

/**
 * Streaming sibling of {@link generateJsonCompletion}: the single place that
 * calls `streamText`. Returns a factory that opens the AI SDK text stream, so
 * the provider class can wrap each delta into the runtime's `AiStreamEvent`
 * protocol (and re-pull on an empty stream).
 */
export function streamCompletion(
  params: GenerateCompletionParams,
): () => AsyncIterable<string> {
  const args = buildCallArgs(params);
  return () => streamText(args).textStream;
}

/**
 * AI SDK backed OpenAI-compatible provider.
 *
 * This keeps the runtime's public `LlmProvider` boundary intact while
 * delegating model invocation and streaming to Vercel AI SDK.
 */
export class AiSdkOpenAICompatibleLlmProvider implements LlmProvider {
  constructor(private readonly options: AiSdkOpenAICompatibleLlmProviderOptions = {}) {}

  /**
   * Resolve base URL / API key / model from the per-call request (with `$var`
   * shorthand) falling back to the configured variables. Shared by `complete`
   * and `completeStream` so the resolution + `no_model` guard live in one place.
   */
  private resolveCallConfig(
    req: LlmCompletionRequest,
    ctx: NodeContext,
  ): { baseUrl: string; apiKey: string; modelId: string } {
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
    const modelId = requestModel ?? pickDefaultModel(variables, this.options);
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
    return { baseUrl, apiKey, modelId };
  }

  async complete(
    req: LlmCompletionRequest,
    ctx: NodeContext,
  ): Promise<LlmCompletionResponse> {
    const { baseUrl, apiKey, modelId } = this.resolveCallConfig(req, ctx);

    try {
      const completion = await generateJsonCompletion({
        baseUrl,
        apiKey,
        model: modelId,
        prompt: req.prompt,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        providerName: this.options.providerName,
        jsonOutput: req.jsonOutput,
        providerOptions: req.providerOptions,
        abortSignal: ctx.signal,
      });
      if (!completion.text.trim()) {
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
      return completion;
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
    const { baseUrl, apiKey, modelId } = this.resolveCallConfig(req, ctx);

    try {
      return aiSdkTextStreamToEvents(
        streamCompletion({
          baseUrl,
          apiKey,
          model: modelId,
          prompt: req.prompt,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          providerName: this.options.providerName,
          jsonOutput: req.jsonOutput,
          providerOptions: req.providerOptions,
          abortSignal: ctx.signal,
        }),
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
