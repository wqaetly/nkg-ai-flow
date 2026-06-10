import { z } from "zod";
import {
  AiSdkOpenAICompatibleLlmProvider,
  type LlmCompletionRequest,
  type NodeContext,
} from "@ai-native-flow/runtime";

export interface ChatOptions {
  system?: string;
  user: string;
  model?: string;
  temperature?: number;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  ctx: unknown;
  jsonMode?: boolean;
  logger?: {
    info?: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
  };
}

export interface ChatResult {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
}

const provider = new AiSdkOpenAICompatibleLlmProvider({
  providerName: "skill-to-flow",
});

function buildPrompt(options: ChatOptions): string {
  const parts: string[] = [];
  if (options.system?.trim()) parts.push(`System:\n${options.system}`);
  const user = options.jsonMode
    ? `${options.user}\n\nReturn ONLY one valid JSON object. No prose, no markdown fences.`
    : options.user;
  parts.push(`User:\n${user}`);
  return parts.join("\n\n");
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const request: LlmCompletionRequest = {
    prompt: buildPrompt(options),
    ...(options.model !== undefined ? { model: options.model } : {}),
    temperature: options.temperature ?? 0,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  };
  let result;
  try {
    result = await provider.complete(request, options.ctx as NodeContext);
  } catch (cause) {
    throw new Error(`skill-to-flow LLM: ${(cause as Error).message}`);
  }

  options.logger?.info?.("llm chat ok", {
    model: request.model ?? "<default>",
    chars: result.text.length,
    usage: result.usage,
  });
  return {
    text: result.text,
    usage: result.usage,
    raw: result.raw,
  };
}

export interface ChatJsonOptions<T> extends Omit<ChatOptions, "jsonMode"> {
  schema: z.ZodType<T>;
  maxRetries?: number;
}

export async function chatJson<T>(options: ChatJsonOptions<T>): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseUserPrompt = options.user;
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const userPrompt =
      attempt === 0
        ? baseUserPrompt
        : `${baseUserPrompt}\n\nThe previous response failed validation:\n${lastError}\n\nReturn ONLY a valid JSON object that matches the schema.`;
    const result = await chat({ ...options, user: userPrompt, jsonMode: true });
    const text = stripJsonFences(result.text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      lastError = `JSON.parse failed: ${(cause as Error).message}\nReceived: ${truncate(text, 400)}`;
      options.logger?.warn?.(`llm chatJson parse failed on attempt ${attempt + 1}`, { error: lastError });
      continue;
    }

    const check = options.schema.safeParse(parsed);
    if (check.success) return check.data;
    lastError = `zod validation failed: ${check.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ")}`;
    options.logger?.warn?.(`llm chatJson schema failed on attempt ${attempt + 1}`, { error: lastError });
  }

  throw new Error(`skill-to-flow LLM: chatJson exhausted ${maxRetries + 1} attempts. Last error: ${lastError}`);
}

export async function runWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let cursor = 0;

  async function pull(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => pull()));
  return results;
}

function stripJsonFences(text: string): string {
  let value = text.trim();
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  if (fence?.[1]) return fence[1].trim();
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return value.slice(firstBrace, lastBrace + 1);
  return value;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
