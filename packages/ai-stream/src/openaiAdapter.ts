/**
 * OpenAI-compatible Chat Completions streaming adapter.
 *
 * Source format: a `Response` whose body is a Server-Sent Events stream
 * shaped like the OpenAI Chat Completions API (`stream: true`):
 *
 *   data: { "choices": [{ "delta": { "content": "Hel" } }] }
 *   data: { "choices": [{ "delta": { "content": "lo" } }] }
 *   data: { "choices": [{ "finish_reason": "stop" }], "usage": { ... } }
 *   data: [DONE]
 *
 * The adapter is provider-agnostic enough to cover OpenAI itself,
 * DeepSeek's official stream, Azure OpenAI, the user's
 * `https://api.lfzxb.top/v1` proxy, and any other OpenAI-compatible
 * gateway. It emits:
 *
 *   - `text_delta` for every `choices[i].delta.content` chunk,
 *   - `tool_call_started` / `tool_call_delta` for `choices[i].delta.tool_calls[*]`
 *     (the OpenAI streaming protocol delivers tool call arguments as
 *     incremental JSON strings, so we forward them verbatim),
 *   - `usage` once the final chunk carrying `usage` arrives,
 *   - `done` when the stream closes (the engine still wraps this in a
 *     `stream_close`).
 */

import type {
  AiStreamAdapter,
  AiStreamAdaptOptions,
  AiStreamAsyncIterable,
  AiStreamEvent,
} from "./types.js";

export class OpenAICompatibleStreamAdapter
  implements AiStreamAdapter<Response>
{
  readonly id = "openai-chat-completions";

  adapt(source: Response, options: AiStreamAdaptOptions = {}): AiStreamAsyncIterable {
    return iterate(source, options);
  }
}

async function* iterate(
  response: Response,
  options: AiStreamAdaptOptions,
): AsyncGenerator<AiStreamEvent, void, unknown> {
  if (!response.body) {
    yield { kind: "warning", message: "openai stream: response has no body" };
    yield { kind: "done" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Track tool call ids that we've already announced so each one only
  // yields a single `tool_call_started`.
  const announcedToolCalls = new Set<string>();
  // Map a tool-call `index` (the OpenAI streaming protocol's stable
  // handle) to the id we use across yields, so subsequent chunks that
  // omit `id` still resolve to the same tool call.
  const toolIdsByIndex = new Map<number, string>();
  let finishReason: string | undefined;
  let aggregatedText = "";
  let usageEmitted = false;

  const onAbort = (): void => {
    void reader.cancel().catch(() => {
      /* swallow: cancellation is best-effort */
    });
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (options.signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            // Mark explicit termination; the surrounding finally block
            // emits the `done` event.
            return finalize(aggregatedText, finishReason);
          }
          let json: OpenAiStreamChunk;
          try {
            json = JSON.parse(payload) as OpenAiStreamChunk;
          } catch (cause) {
            yield {
              kind: "warning",
              message: "openai stream: failed to parse chunk JSON",
              meta: { error: cause instanceof Error ? cause.message : String(cause) },
            };
            continue;
          }

          for (const event of mapChunk(json, announcedToolCalls, toolIdsByIndex)) {
            if (event.kind === "text_delta") {
              aggregatedText += event.text;
            }
            if (event.kind === "usage") {
              usageEmitted = true;
            }
            if (event.kind === "done") {
              finishReason = event.finishReason ?? finishReason;
              continue; // we synthesise the final `done` ourselves below
            }
            options.tap?.(event);
            yield event;
          }
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* readers from cancelled streams cannot release */
    }
    if (!usageEmitted) {
      // Some providers omit usage on stream; silent.
    }
    const doneEvent: AiStreamEvent = {
      kind: "done",
      text: aggregatedText || undefined,
      finishReason,
    };
    options.tap?.(doneEvent);
    yield doneEvent;
  }
}

function* mapChunk(
  chunk: OpenAiStreamChunk,
  announcedToolCalls: Set<string>,
  toolIdsByIndex: Map<number, string>,
): Generator<AiStreamEvent> {
  // Some providers wrap usage in a separate chunk where `choices` is
  // empty/missing; emit it before scanning choices so consumers see
  // usage even if they break out of the loop early.
  if (chunk.usage) {
    yield {
      kind: "usage",
      promptTokens: chunk.usage.prompt_tokens,
      completionTokens: chunk.usage.completion_tokens,
      totalTokens: chunk.usage.total_tokens,
      meta: { model: chunk.model },
    };
  }
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { kind: "text_delta", text: delta.content };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      yield { kind: "thinking_delta", text: delta.reasoning_content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        // OpenAI's protocol delivers a tool call's `id` only on the
        // first chunk; later chunks reference the same call by `index`.
        // We resolve the canonical id from the index map first to avoid
        // accidentally announcing the same tool call twice.
        let id: string | undefined;
        if (typeof tc.index === "number") {
          id = toolIdsByIndex.get(tc.index);
          if (!id && tc.id) {
            id = tc.id;
            toolIdsByIndex.set(tc.index, id);
          } else if (!id) {
            id = `tool_${tc.index}`;
            toolIdsByIndex.set(tc.index, id);
          }
        } else if (tc.id) {
          id = tc.id;
        } else {
          id = "tool_unknown";
        }
        if (!announcedToolCalls.has(id)) {
          announcedToolCalls.add(id);
          yield {
            kind: "tool_call_started",
            toolCallId: id,
            toolName: tc.function?.name ?? "<unknown>",
          };
        }
        if (tc.function?.arguments !== undefined) {
          yield {
            kind: "tool_call_delta",
            toolCallId: id,
            argumentsDelta: tc.function.arguments,
          };
        }
      }
    }
    if (choice.finish_reason) {
      // Surface as a sentinel; outer loop merges it into the synthesised
      // `done` event.
      yield { kind: "done", finishReason: choice.finish_reason };
    }
  }
}

function finalize(_text: string, _finishReason: string | undefined): void {
  // Helper exists so we have a single labelled exit point. The outer
  // generator's `finally` block emits the synthesised `done` event.
}

/* -------------------------------------------------------------------------- */
/* OpenAI chunk types (just what we touch).                                    */
/* -------------------------------------------------------------------------- */

interface OpenAiStreamChunk {
  model?: string;
  choices?: OpenAiStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAiStreamChoice {
  index?: number;
  finish_reason?: string;
  delta?: {
    role?: string;
    content?: string;
    /** Some providers (DeepSeek, etc.) emit a separate reasoning channel. */
    reasoning_content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
}
