/**
 * Step 3 \u2014 transport-http sub-graph (sink-node) endpoint tests.
 *
 * Covers:
 *   - POST /flows/:flowId/nodes/:nodeId/invoke returns the sink output
 *     and a RunRecord pinned to the original flow id/version.
 *   - The endpoint bypasses the flow-level inputSchema (matches
 *     `invocationRouter.invokeNode` semantics).
 *   - Unknown nodeId returns 404 with `flow.node.not_found`.
 *   - POST /flows/:flowId/nodes/:nodeId/stream starts a sub-graph Run
 *     and streams its events as SSE, terminating on run_finished.
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
    if (block.startsWith(":")) continue;
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

function buildHandler() {
  const rt = createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
  return { rt, handler: createHttpHandler({ runtime: rt }) };
}

async function registerSubGraphFlow(
  rt: ReturnType<typeof createRuntime>,
  id = "sg_http",
) {
  // Flow with a strict inputSchema so we can prove the node endpoint
  // bypasses it. start -> upper -> tail -> end.
  const flow = defineFlow({
    id,
    version: "1.0.0",
    inputSchema: { type: "object", required: ["name"] },
    registry: rt.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const upper = flow.node("transform", {
    id: "upper",
    position: { x: 100, y: 0 },
    config: { template: "Hi ${input.name}" },
  });
  const tail = flow.node("transform", {
    id: "tail",
    position: { x: 200, y: 0 },
    config: { template: "${input}!" },
  });
  const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
  flow.connect(start.out("out"), upper.in("in"));
  flow.connect(upper.out("out"), tail.in("in"));
  flow.connect(tail.out("out"), end.in("in"));
  const json = flow.dump();
  await rt.registry.register({ graph: JSON.parse(json), json, status: "staging" });
  await rt.registry.promote(id, "1.0.0");
}

async function registerResumeFlow(
  rt: ReturnType<typeof createRuntime>,
  id = "resume_http",
) {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const prep = flow.node("transform", {
    id: "prep",
    position: { x: 100, y: 0 },
    config: { template: "prep:${input.name}" },
  });
  const recover = flow.node("transform", {
    id: "recover",
    position: { x: 220, y: 0 },
    config: { template: "recover:${input.orderId}" },
  });
  const end = flow.node("end", { id: "e", position: { x: 340, y: 0 } });
  flow.connect(start.out("out"), prep.in("in"));
  flow.connect(prep.out("output"), recover.in("input"));
  flow.connect(recover.out("out"), end.in("in"));
  const json = flow.dump();
  await rt.registry.register({ graph: JSON.parse(json), json, status: "staging" });
  await rt.registry.promote(id, "1.0.0");
}

describe("transport-http / nodes invoke endpoint", () => {
  it("POST /flows/:id/nodes/:id/invoke returns the sink's output", async () => {
    const { rt, handler } = buildHandler();
    await registerSubGraphFlow(rt);

    const res = await handler(
      new Request("http://test/flows/sg_http/nodes/upper/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { name: "Node" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string;
      flowId: string;
      flowVersion: string;
      nodeId: string;
      status: string;
      output: unknown;
    };
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("Hi Node");
    expect(body.flowId).toBe("sg_http");
    expect(body.flowVersion).toBe("1.0.0");
    expect(body.nodeId).toBe("upper");
    // Run is recorded under the original flowId, not a synthetic one.
    const list = await rt.runStore.listByFlow("sg_http");
    expect(list).toHaveLength(1);
  });

  it("bypasses the flow-level inputSchema (sub-graph mode is mid-edit-friendly)", async () => {
    const { rt, handler } = buildHandler();
    await registerSubGraphFlow(rt, "sg_http_bypass");

    // Body deliberately omits `name` \u2014 a full flow invoke would 400.
    const res = await handler(
      new Request("http://test/flows/sg_http_bypass/nodes/upper/invoke", {
        method: "POST",
        body: JSON.stringify({ input: {} }),
      }),
    );
    // Schema check is skipped, run still succeeds (template just
    // resolves `${input.name}` to an empty string).
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; output: unknown };
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("Hi ");
  });

  it("returns 404 for an unknown nodeId", async () => {
    const { rt, handler } = buildHandler();
    await registerSubGraphFlow(rt, "sg_http_404");

    const res = await handler(
      new Request("http://test/flows/sg_http_404/nodes/ghost/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "x" } }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("flow.node.not_found");
  });
});

describe("transport-http / nodes stream endpoint", () => {
  it("POST /flows/:id/nodes/:id/stream emits run_started -> run_finished SSE", async () => {
    const { rt, handler } = buildHandler();
    await registerSubGraphFlow(rt, "sg_http_stream");

    const res = await handler(
      new Request("http://test/flows/sg_http_stream/nodes/upper/stream", {
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
    expect(kinds).toContain("node_started");
    expect(kinds).toContain("node_finished");
    expect(kinds[kinds.length - 1]).toBe("run_finished");

    // The terminal run_finished payload should carry the sink's primary
    // data output.
    const last = events[events.length - 1];
    expect(last?.data).toContain('"output":"Hi Node"');
  });
});

describe("transport-http / resume endpoint", () => {
  it("POST /flows/:id/resume starts from the saved resume_point target", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const handler = createHttpHandler({ runtime: rt });
    const now = Date.now();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "recover",
      snapshot: { orderId: "order-1" },
      reason: "manual resume",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
    await registerResumeFlow(rt, "resume_http");

    const res = await handler(
      new Request("http://test/flows/resume_http/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resumePointName: "ORDER_RESUME_POINT" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      output: unknown;
      resumePointName: string;
    };
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("recover:order-1");
    expect(body.resumePointName).toBe("ORDER_RESUME_POINT");
  });

  it("POST /flows/:id/resume/stream emits resume-point run events", async () => {
    const variables = new InMemoryVariableStore();
    const rt = createRuntime({
      variables,
      llmProvider: new DeterministicLlmProvider(),
    });
    const handler = createHttpHandler({ runtime: rt });
    const now = Date.now();
    variables.set("ORDER_RESUME_POINT", {
      name: "ORDER_RESUME_POINT",
      status: "ready",
      targetNodeId: "recover",
      snapshot: { orderId: "order-2" },
      reason: "stream resume",
      sourceRunId: "run_original",
      version: 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
    await registerResumeFlow(rt, "resume_http_stream");

    const res = await handler(
      new Request("http://test/flows/resume_http_stream/resume/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resumePointName: "ORDER_RESUME_POINT" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await readResponseBody(res);
    const events = parseSseStream(body);
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("run_started");
    expect(kinds[kinds.length - 1]).toBe("run_finished");
    expect(events[events.length - 1]?.data).toContain('"output":"recover:order-2"');
  });
});

