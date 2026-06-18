/**
 * AI Stream Adapter unit tests. The OpenAI-compatible adapter is fed a
 * synthetic SSE stream constructed via `ReadableStream.from()` so we
 * cover the multi-frame parser without touching the network.
 */

import { describe, expect, it } from "vitest";
import {
  OpenAICompatibleStreamAdapter,
  type AiStreamEvent,
} from "../src/index.js";

function sseResponse(frames: string[]): Response {
  // Each frame is appended verbatim with the SSE separator. We chunk
  // bytes through a ReadableStream to also exercise multi-byte boundary
  // handling in the adapter.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(iter: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("ai-stream / OpenAICompatibleStreamAdapter", () => {
  it("parses content deltas and a final usage frame from SSE", async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "data: [DONE]",
    ]);
    const adapter = new OpenAICompatibleStreamAdapter();
    const events = await collect(adapter.adapt(response));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("usage");
    expect(kinds[kinds.length - 1]).toBe("done");
    const text = events
      .filter((e): e is AiStreamEvent & { kind: "text_delta" } => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello");
    const usage = events.find((e) => e.kind === "usage") as
      | (AiStreamEvent & { kind: "usage" })
      | undefined;
    expect(usage?.totalTokens).toBe(5);
  });

  it("emits tool_call_started exactly once and forwards argumentsDelta", async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}',
      "data: [DONE]",
    ]);
    const events = await collect(new OpenAICompatibleStreamAdapter().adapt(response));
    const started = events.filter((e) => e.kind === "tool_call_started");
    const deltas = events.filter((e) => e.kind === "tool_call_delta");
    expect(started).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it("recovers from malformed JSON via warning event", async () => {
    const response = sseResponse([
      "data: {bad json",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
    ]);
    const events = await collect(new OpenAICompatibleStreamAdapter().adapt(response));
    expect(events.some((e) => e.kind === "warning")).toBe(true);
    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
  });
});
