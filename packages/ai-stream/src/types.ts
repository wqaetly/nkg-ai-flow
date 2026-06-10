/**
 * AI Stream Adapter contracts.
 *
 * Different vendor SDKs (OpenAI, Anthropic, Gemini, AI Coding IDE
 * SDK, local CLI agents...) emit very different stream shapes. Per
 * `docs/specs/streaming-and-node-communication.md` §"AI Stream Adapter",
 * the runtime never lets vendor-specific chunks leak past the adapter
 * boundary. Instead each adapter consumes its native stream and produces
 * a sequence of normalised `AiStreamEvent`s that node logic can hand
 * straight to `ctx.stream(...).write(...)` / `ctx.emit(...)`.
 *
 * The adapter is intentionally decoupled from `NodeEvent` so this
 * package does not depend on `runtime`. The mapping happens inside the
 * llm node runner: each `AiStreamEvent` becomes a `stream_delta`,
 * `stream_artifact`, `stream_usage`, `tool_call_*` or `node_warning`
 * event with the node's identity stamped on by the channel.
 */

/* -------------------------------------------------------------------------- */
/* Normalised event surface                                                    */
/* -------------------------------------------------------------------------- */

export interface AiStreamTextDelta {
  kind: "text_delta";
  /** Incremental text chunk. */
  text: string;
  /** Optional per-chunk metadata (e.g. role, finish reason). */
  meta?: Record<string, unknown>;
}

export interface AiStreamThinkingDelta {
  kind: "thinking_delta";
  text: string;
  meta?: Record<string, unknown>;
}

export interface AiStreamToolCallStarted {
  kind: "tool_call_started";
  toolCallId: string;
  toolName: string;
  meta?: Record<string, unknown>;
}

export interface AiStreamToolCallDelta {
  kind: "tool_call_delta";
  toolCallId: string;
  /** Either `argumentsDelta` (partial JSON string) or `outputDelta`. */
  argumentsDelta?: string;
  outputDelta?: unknown;
  meta?: Record<string, unknown>;
}

export interface AiStreamToolCallFinished {
  kind: "tool_call_finished";
  toolCallId: string;
  arguments?: unknown;
  output?: unknown;
  meta?: Record<string, unknown>;
}

export interface AiStreamArtifact {
  kind: "artifact";
  /** Free-form artifact label (e.g. "patch", "code_block", "image"). */
  label: string;
  data: unknown;
  contentType?: string;
}

export interface AiStreamUsage {
  kind: "usage";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Provider-supplied cost / latency / model fields. */
  meta?: Record<string, unknown>;
}

export interface AiStreamWarning {
  kind: "warning";
  message: string;
  meta?: Record<string, unknown>;
}

export interface AiStreamDone {
  kind: "done";
  /** Final aggregated text, if the adapter accumulated one. */
  text?: string;
  finishReason?: string;
  meta?: Record<string, unknown>;
}

/**
 * Discriminated union the runtime consumes. Adapters MAY produce extra
 * `meta` fields, but the discriminator must be one of these.
 */
export type AiStreamEvent =
  | AiStreamTextDelta
  | AiStreamThinkingDelta
  | AiStreamToolCallStarted
  | AiStreamToolCallDelta
  | AiStreamToolCallFinished
  | AiStreamArtifact
  | AiStreamUsage
  | AiStreamWarning
  | AiStreamDone;

/**
 * Async-iterable surface every adapter must implement. Returning an
 * AsyncIterable (not a Promise of array) keeps backpressure intact:
 * downstream code can `for await` and pause the producer naturally.
 */
export type AiStreamAsyncIterable = AsyncIterable<AiStreamEvent>;

/**
 * Generic adapter shape: take a vendor-native source (chunks of bytes,
 * SSE frames, an SDK iterable, ...) and yield `AiStreamEvent`s.
 */
export interface AiStreamAdapter<TSource = unknown> {
  /** Stable id for diagnostics, e.g. "openai-chat-completions". */
  readonly id: string;
  adapt(source: TSource, options?: AiStreamAdaptOptions): AiStreamAsyncIterable;
}

export interface AiStreamAdaptOptions {
  /** Cancellation hook. Adapters MUST honour it and stop yielding. */
  signal?: AbortSignal;
  /** Optional per-chunk hook for debug taps (does not change the stream). */
  tap?: (event: AiStreamEvent) => void;
}
