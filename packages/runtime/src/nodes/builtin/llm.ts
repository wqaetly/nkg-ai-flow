/**
 * `llm` — model call with prompt template and optional streaming.
 *
 * Defined via `defineNodeFactory` so the actual `LlmProvider` is
 * injected at registry-build time:
 *
 *   - tests inject a local deterministic provider,
 *   - production wiring uses `AiSdkOpenAICompatibleLlmProvider`, which
 *     reads base URL / model / API key through the standard
 *     VariableStore (see `../llmProvider.ts`) and delegates
 *     transport to Vercel AI SDK.
 *
 * Phase 2 streaming behaviour is preserved verbatim from the original
 * runner: when `config.stream === true` and the provider implements
 * `completeStream`, deltas are forwarded to a `ctx.stream("answer")`;
 * `usage`, `tool_call_*` and `artifact` events from the adapter map
 * to `stream_usage`, `tool_call_*` and `stream_artifact` events. The
 * aggregated text is still returned on the `result` data port so that
 * downstream non-streaming consumers see a complete value.
 */

import { z } from "zod";
import { normalizeError } from "@ai-native-flow/flow-ir";
import { defineNode, defineNodeFactory } from "@ai-native-flow/node-sdk";
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "../llmProvider.js";
import {
  DEFAULT_LLM_API_KEY_REF as DEFAULT_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF as DEFAULT_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS as DEFAULT_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF as DEFAULT_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE as DEFAULT_TEMPERATURE,
} from "../llmProvider.js";
import { renderTemplate } from "./_helpers.js";

const llmConfig = z
  .object({
    baseUrl: z
      .string()
      .min(1)
      .default(DEFAULT_BASE_URL_REF)
      .describe(
        "OpenAI-compatible base URL (e.g. https://api.openai.com/v1) or $var:LLM_BASE_URL.",
      ),
    apiKey: z
      .string()
      .min(1)
      .default(DEFAULT_API_KEY_REF)
      .describe(
        "Bearer token. Plain string, `$var:NAME`, or legacy `$secret:NAME` reference.",
      ),
    model: z
      .string()
      .min(1)
      .default(DEFAULT_MODEL_REF)
      .describe("Model id or $var:LLM_DEFAULT_MODEL."),
    prompt: z
      .string()
      .default("")
      .describe(
        "Prompt template; supports `${input.path}` placeholders unless the prompt port is wired.",
      ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .default(DEFAULT_TEMPERATURE)
      .describe("Sampling temperature (0 = deterministic, 2 = wild)."),
    maxTokens: z
      .number()
      .min(1)
      .max(32_000)
      .default(DEFAULT_MAX_TOKENS)
      .describe("Maximum output tokens."),
    stream: z
      .boolean()
      .optional()
      .describe("Stream tokens to the `answer` port as they arrive."),
  })
  .passthrough();

export const llmNode = defineNodeFactory<{ llmProvider: LlmProvider }>(
  ({ llmProvider }) =>
    defineNode({
      type: "llm",
      typeVersion: "1.0.0",
      title: "LLM",
      description: "Model call with prompt template and structured output.",
      config: llmConfig,
      fieldMeta: {
        baseUrl: {
          label: "URL",
          placeholder: DEFAULT_BASE_URL_REF,
          order: 1,
        },
        apiKey: {
          label: "APIKEY",
          placeholder: DEFAULT_API_KEY_REF,
          order: 2,
        },
        model: { label: "Model", placeholder: DEFAULT_MODEL_REF, order: 3 },
        prompt: {
          control: "textarea",
          placeholder: "Write the prompt template…",
          order: 6,
        },
        temperature: { label: "Temperature", order: 4 },
        maxTokens: { label: "Max Tokens", order: 5 },
        stream: { label: "Stream", control: "switch", order: 7 },
      },
      ports: [
        {
          id: "result",
          direction: "output",
          kind: "data",
          label: "Result",
          schema: { type: "string" },
        },
      ],
      validateInput: false,
      async run({ input, config, ctx }) {
        const raw = input as Record<string, unknown>;
        // Resolution order for the prompt:
        //   1. The `prompt` data input port (string from an upstream node).
        //      When wired, the value flows through verbatim — the legacy
        //      `${path}` template substitution is intentionally skipped so
        //      that authors who feed dynamic prompts don't have to escape
        //      every literal `${` in their text.
        //   2. The `config.prompt` template, rendered against `input` so
        //      placeholders like `${input.text}` keep working for flows
        //      authored before the data port existed.
        const wiredPrompt =
          typeof raw.prompt === "string" ? (raw.prompt as string) : undefined;
        const prompt =
          wiredPrompt !== undefined
            ? wiredPrompt
            : renderTemplate(config.prompt ?? "", raw);

        // Resolution order: explicit `node.config.model` -> ambient
        // `LLM_DEFAULT_MODEL` -> provider-default.
        const explicitModel = resolveConfigStringRef(config.model, ctx);
        const ambientModel = ctx.variables.getString("LLM_DEFAULT_MODEL");
        const model = explicitModel ?? ambientModel;

        const wantStream =
          config.stream === true &&
          typeof llmProvider.completeStream === "function";
        const request: LlmCompletionRequest = {
          prompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          stream: wantStream || undefined,
        };
        if (model !== undefined) request.model = model;
        const baseUrl = resolveConfigStringRef(config.baseUrl, ctx);
        const apiKey = resolveConfigStringRef(config.apiKey, ctx);
        if (baseUrl !== undefined && baseUrl !== "") request.baseUrl = baseUrl;
        if (apiKey !== undefined && apiKey !== "") request.apiKey = apiKey;

        // Re-cast ctx to the runtime NodeContext shape that LlmProvider
        // expects. The SDK's SdkNodeContext is a structural subset, so
        // this is a safe widening at the boundary.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const runtimeCtx = ctx as any;

        if (wantStream) {
          try {
            const iterable = await llmProvider.completeStream!(
              request,
              runtimeCtx,
            );
            const stream = (await ctx.stream("answer", {
              contentType: "text/markdown",
              metadata: { model },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            })) as any;
            let aggregated = "";
            let usage: LlmCompletionResponse["usage"] | undefined;
            let finishReason: string | undefined;
            for await (const event of iterable) {
              if (ctx.signal.aborted) break;
              switch (event.kind) {
                case "text_delta":
                  aggregated += event.text;
                  await stream.write({ text: event.text });
                  break;
                case "thinking_delta":
                  await ctx.emit({
                    kind: "stream_artifact",
                    portId: "answer",
                    streamId: stream.id,
                    payload: { kind: "thinking_delta", text: event.text },
                  });
                  break;
                case "tool_call_started":
                  await ctx.emit({
                    kind: "tool_call_started",
                    streamId: stream.id,
                    payload: {
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                    },
                  });
                  break;
                case "tool_call_delta":
                  await ctx.emit({
                    kind: "tool_call_delta",
                    streamId: stream.id,
                    payload: {
                      toolCallId: event.toolCallId,
                      argumentsDelta: event.argumentsDelta,
                      outputDelta: event.outputDelta,
                    },
                  });
                  break;
                case "tool_call_finished":
                  await ctx.emit({
                    kind: "tool_call_finished",
                    streamId: stream.id,
                    payload: {
                      toolCallId: event.toolCallId,
                      arguments: event.arguments,
                      output: event.output,
                    },
                  });
                  break;
                case "artifact":
                  await ctx.emit({
                    kind: "stream_artifact",
                    portId: "answer",
                    streamId: stream.id,
                    payload: {
                      label: event.label,
                      data: event.data,
                      contentType: event.contentType,
                    },
                  });
                  break;
                case "usage":
                  usage = {
                    promptTokens: event.promptTokens,
                    completionTokens: event.completionTokens,
                    totalTokens: event.totalTokens,
                  };
                  await ctx.emit({
                    kind: "stream_usage",
                    streamId: stream.id,
                    payload: usage,
                  });
                  break;
                case "warning":
                  await ctx.emit({
                    kind: "node_warning",
                    payload: { message: event.message, meta: event.meta },
                  });
                  break;
                case "done":
                  finishReason = event.finishReason;
                  break;
              }
            }
            await stream.close({ text: aggregated, finishReason, usage });
            return {
              kind: "success",
              outputs: { out: null, result: aggregated },
            };
          } catch (cause) {
            return {
              kind: "error",
              error: normalizeError(cause, {
                module: "node_logic",
                nodeId: ctx.nodeId,
              }) as unknown as {
                code: string;
                message: string;
                [k: string]: unknown;
              },
            };
          }
        }

        try {
          const response = await llmProvider.complete(request, runtimeCtx);
          return {
            kind: "success",
            outputs: { out: null, result: response.text },
          };
        } catch (cause) {
          return {
            kind: "error",
            error: normalizeError(cause, {
              module: "node_logic",
              nodeId: ctx.nodeId,
            }) as unknown as {
              code: string;
              message: string;
              [k: string]: unknown;
            },
          };
        }
      },
    }),
);

function resolveConfigStringRef(
  value: string | undefined,
  ctx: { variables: { getString(name: string): string | undefined } },
): string | undefined {
  if (value === undefined) return undefined;
  const ref = /^\$(?:var|secret):([A-Za-z0-9_.:-]+)$/.exec(value.trim());
  if (!ref?.[1]) return value;
  return ctx.variables.getString(ref[1]) ?? value;
}
