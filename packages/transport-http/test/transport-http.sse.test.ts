/**
 * Phase 2 SSE transport tests.
 *
 * Covers:
 *   - POST /flows/:id/stream starts a Run, streams its events as SSE
 *     frames terminated by `event: run_finished`;
 *   - GET /runs/:id/events/stream replays from a cursor and stops at
 *     a terminal event;
 *   - cursor-based resume (`?cursor=` and `Last-Event-ID:`).
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import {
  createRuntime,
} from "@ai-native-flow/runtime";
import { defineNode } from "@ai-native-flow/node-sdk";
import { DeterministicLlmProvider } from "../../runtime/test/helpers/deterministicLlmProvider.js";
import { createHttpHandler } from "../src/index.js";

interface ParsedSseEvent {
  id?: string;
  event?: string;
  data?: string;
}

function parseSseStream(body: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of body.split("\n\n")) {
    if (!block.trim()) continue;
    if (block.startsWith(":")) continue; // heartbeat
    const event: ParsedSseEvent = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) event.id = line.slice(3).trim();
      else if (line.startsWith("event:")) event.event = line.slice(6).trim();
      else if (line.startsWith("data:")) event.data = line.slice(5).trim();
    }
    if (event.event || event.data) events.push(event);
  }
  return events;
}

async function readResponseBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

async function readOneSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer.slice(0, buffer.indexOf("\n\n") + 2);
}

const slowNode = defineNode({
  type: "test_slow",
  typeVersion: "1.0.0",
  title: "Test Slow",
  ports: [
    { id: "result", direction: "output", kind: "data", label: "Result" },
  ],
  validateInput: false,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { kind: "success", outputs: { out: null, result: "slow-done" } };
  },
});

function buildHandler(options: { slow?: boolean } = {}) {
  const rt = createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
    nodes: options.slow ? [slowNode] : [],
  });
  return { rt, handler: createHttpHandler({ runtime: rt }) };
}

async function registerHello(rt: ReturnType<typeof createRuntime>) {
  const flow = defineFlow({
    id: "sse_hello",
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const t = flow.node("transform", {
    id: "t",
    position: { x: 100, y: 0 },
    config: { template: "Hi ${input.name}" },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), t.in("in"));
  flow.connect(t.out("out"), end.in("in"));
  await rt.registry.register({
    graph: JSON.parse(flow.dump()),
    json: flow.dump(),
    status: "staging",
  });
  await rt.registry.promote("sse_hello", "1.0.0");
}

describe("transport-http / SSE", () => {
  it("exposes an active, cancellable run before the first SSE frame is read", async () => {
    const { rt, handler } = buildHandler({ slow: true });
    const flow = defineFlow({ id: "sse_live_start", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const slow = flow.node("test_slow", { id: "slow", position: { x: 100, y: 0 } });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), slow.in("in"));
    flow.connect(slow.out("out"), end.in("in"));
    await rt.registry.register({
      graph: JSON.parse(flow.dump()),
      json: flow.dump(),
      status: "staging",
    });
    await rt.registry.promote("sse_live_start", "1.0.0");

    const res = await handler(
      new Request("http://test/flows/sse_live_start/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      }),
    );
    const runId = res.headers.get("x-nkg-run-id");
    expect(runId).toBeTypeOf("string");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-nkg-run-id");
    const record = await rt.runManager.get(runId!);
    expect(record?.status).toBe("running");

    const cancelled = await handler(new Request(`http://test/runs/${runId}/cancel`, {
      method: "POST",
    }));
    expect(cancelled.status).toBe(202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await rt.runManager.get(runId!))?.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await rt.runManager.get(runId!))?.status).toBe("cancelled");
    await res.body?.cancel();
  });

  it("POST /flows/:id/stream pushes run lifecycle events and terminates", async () => {
    const { rt, handler } = buildHandler();
    await registerHello(rt);
    const res = await handler(
      new Request("http://test/flows/sse_hello/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { name: "Node" } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await readResponseBody(res);
    const events = parseSseStream(body);

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("run_started");
    expect(kinds[kinds.length - 1]).toBe("run_finished");
    expect(kinds).toContain("node_started");
    expect(kinds).toContain("node_finished");

    // Every frame carries an id (the eventId cursor) so EventSource can
    // resume.
    expect(events.every((e) => typeof e.id === "string" && e.id!.length > 0)).toBe(true);
  });

  it("streams every fan-out branch end before run_finished", async () => {
    const { rt, handler } = buildHandler();
    const flow = defineFlow({ id: "sse_fan_out", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const start = flow.node("start", { id: "node_start", position: { x: 0, y: 200 } });
    const upper = flow.node("transform", {
      id: "node_upper",
      position: { x: 100, y: 80 },
      config: { template: "UP:${input.text}" },
    });
    const lower = flow.node("transform", {
      id: "node_lower",
      position: { x: 100, y: 320 },
      config: { template: "LO:${input.text}" },
    });
    const endUpper = flow.node("end", { id: "node_end_upper", position: { x: 200, y: 80 } });
    const endLower = flow.node("end", { id: "node_end_lower", position: { x: 200, y: 320 } });
    flow.connect(start.out("out"), upper.in("in"));
    flow.connect(start.out("out"), lower.in("in"));
    flow.connect(upper.out("out"), endUpper.in("in"));
    flow.connect(lower.out("out"), endLower.in("in"));

    const register = await handler(
      new Request("http://test/flows/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph: JSON.parse(flow.dump()) }),
      }),
    );
    expect(register.status).toBe(204);

    const res = await handler(
      new Request("http://test/flows/sse_fan_out/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { text: "Hi" } }),
      }),
    );
    expect(res.status).toBe(200);

    const events = parseSseStream(await readResponseBody(res));
    const parsedEvents = events.map((event) => JSON.parse(event.data ?? "{}") as { kind: string; nodeId?: string });
    const finishedNodeIds = parsedEvents
      .filter((event) => event.kind === "node_finished")
      .map((event) => event.nodeId);

    expect(finishedNodeIds).toContain("node_end_upper");
    expect(finishedNodeIds).toContain("node_end_lower");
    expect(events[events.length - 1]?.event).toBe("run_finished");
  });

  it("GET /runs/:id/events/stream replays from a cursor", async () => {
    const { rt, handler } = buildHandler();
    await registerHello(rt);
    // First, run to completion.
    const invoke = await handler(
      new Request("http://test/flows/sse_hello/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "X" } }),
      }),
    );
    const { runId } = (await invoke.json()) as { runId: string };

    // Drain the SSE stream for the finished run.
    const sseRes = await handler(
      new Request(`http://test/runs/${runId}/events/stream`),
    );
    expect(sseRes.status).toBe(200);
    const body = await readResponseBody(sseRes);
    const allEvents = parseSseStream(body);
    expect(allEvents[0]?.event).toBe("run_started");
    expect(allEvents[allEvents.length - 1]?.event).toBe("run_finished");

    // Pick the first eventId as cursor; resumed stream must skip it.
    const firstId = allEvents[0]!.id!;
    const resumedRes = await handler(
      new Request(`http://test/runs/${runId}/events/stream?cursor=${firstId}`),
    );
    const resumedBody = await readResponseBody(resumedRes);
    const resumedEvents = parseSseStream(resumedBody);
    expect(resumedEvents.find((e) => e.id === firstId)).toBeUndefined();
    expect(resumedEvents[resumedEvents.length - 1]?.event).toBe("run_finished");
  });

  it("returns 404 for /runs/:id/events/stream when the run is unknown", async () => {
    const { handler } = buildHandler();
    const res = await handler(
      new Request("http://test/runs/run_does_not_exist/events/stream"),
    );
    expect(res.status).toBe(404);
  });

  it("treats malformed stream request bodies as empty JSON objects", async () => {
    const { rt, handler } = buildHandler();
    await registerHello(rt);
    const res = await handler(
      new Request("http://test/flows/sse_hello/stream", {
        method: "POST",
        body: "not-json",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("honours Last-Event-ID header for resume", async () => {
    const { rt, handler } = buildHandler();
    await registerHello(rt);
    const invoke = await handler(
      new Request("http://test/flows/sse_hello/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "Y" } }),
      }),
    );
    const { runId } = (await invoke.json()) as { runId: string };
    const allRes = await handler(
      new Request(`http://test/runs/${runId}/events/stream`),
    );
    const all = parseSseStream(await readResponseBody(allRes));
    const cursor = all[0]!.id!;
    const resumedRes = await handler(
      new Request(`http://test/runs/${runId}/events/stream`, {
        headers: { "last-event-id": cursor },
      }),
    );
    const resumed = parseSseStream(await readResponseBody(resumedRes));
    expect(resumed.find((e) => e.id === cursor)).toBeUndefined();
    expect(resumed.length).toBeLessThan(all.length);
  });
});

