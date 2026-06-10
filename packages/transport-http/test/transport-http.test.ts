/**
 * HTTP transport tests. Uses the in-process Request/Response pair directly
 * so we don't need to bind a TCP port.
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

function buildRuntimeAndHandler() {
  const rt = createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
  const handler = createHttpHandler({ runtime: rt });
  return { rt, handler };
}

async function registerHello(rt: ReturnType<typeof createRuntime>) {
  const flow = defineFlow({
    id: "http_hello",
    version: "1.0.0",
    inputSchema: { type: "object", required: ["name"] },
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
  const json = flow.dump();
  await rt.registry.register({ graph: JSON.parse(json), json, status: "staging" });
  await rt.registry.promote("http_hello", "1.0.0");
}

describe("transport-http / handler", () => {
  it("POST /flows/:id/invoke returns the final output on success", async () => {
    const { rt, handler } = buildRuntimeAndHandler();
    await registerHello(rt);
    const res = await handler(
      new Request("http://test/flows/http_hello/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { name: "Node" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; output: unknown };
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("Hi Node");
  });

  it("POST /flows/:id/invoke returns 400 when inputSchema fails", async () => {
    const { rt, handler } = buildRuntimeAndHandler();
    await registerHello(rt);
    const res = await handler(
      new Request("http://test/flows/http_hello/invoke", {
        method: "POST",
        body: JSON.stringify({ input: {} }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /runs/:id and /runs/:id/events return data", async () => {
    const { rt, handler } = buildRuntimeAndHandler();
    await registerHello(rt);
    const invoke = await handler(
      new Request("http://test/flows/http_hello/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "X" } }),
      }),
    );
    const { runId } = (await invoke.json()) as { runId: string };

    const runRes = await handler(new Request(`http://test/runs/${runId}`));
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { runId: string; status: string };
    expect(runBody.runId).toBe(runId);
    expect(runBody.status).toBe("succeeded");

    const evtRes = await handler(new Request(`http://test/runs/${runId}/events`));
    expect(evtRes.status).toBe(200);
    const evtBody = (await evtRes.json()) as { events: { kind: string }[] };
    expect(evtBody.events[0]?.kind).toBe("run_started");
  });

  it("returns 404 for unknown runs", async () => {
    const { handler } = buildRuntimeAndHandler();
    const res = await handler(new Request("http://test/runs/nope"));
    expect(res.status).toBe(404);
  });
});

