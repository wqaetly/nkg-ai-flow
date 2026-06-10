/**
 * Step 7 \u2014 transport-http: `/flows/register` convenience route + CORS.
 *
 * Studio talks to the sidecar from a different origin during local
 * development (Vite on :3000 \u2192 sidecar on :5173), so the handler must
 * answer OPTIONS preflight, advertise the right Access-Control-* headers
 * and accept a `{ graph }` body to register-and-promote in one call.
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

function build(corsValue?: "*" | readonly string[] | "OFF") {
  const rt = createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
  const opts: Parameters<typeof createHttpHandler>[0] = { runtime: rt };
  // Treat the explicit "OFF" sentinel as "user wants CORS disabled" so
  // we can still tell apart "default = wildcard" from "explicitly off".
  if (corsValue !== "OFF") {
    opts.cors = corsValue ?? "*";
  }
  const handler = createHttpHandler(opts);
  return { rt, handler };
}

function helloFlowJson(
  rt: ReturnType<typeof createRuntime>,
  id = "register_hello",
): unknown {
  const flow = defineFlow({ id, version: "1.0.0", registry: rt.nodeTypeRegistry });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const t = flow.node("transform", {
    id: "t",
    position: { x: 100, y: 0 },
    config: { template: "Hi ${input.name}" },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), t.in("in"));
  flow.connect(t.out("out"), end.in("in"));
  return JSON.parse(flow.dump());
}

describe("transport-http / POST /flows/register", () => {
  it("registers and promotes a graph; subsequent invoke uses it", async () => {
    const { rt, handler } = build();
    const res = await handler(
      new Request("http://test/flows/register", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://ui" },
        body: JSON.stringify({ graph: helloFlowJson(rt) }),
      }),
    );
    expect(res.status).toBe(204);

    // Now the flow should be invokeable without any explicit promote.
    const invoke = await handler(
      new Request("http://test/flows/register_hello/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "Node" } }),
      }),
    );
    expect(invoke.status).toBe(200);
    const body = (await invoke.json()) as { output: unknown; status: string };
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("Hi Node");
  });

  it("re-registering the same id+version after a Studio edit overwrites it", async () => {
    const { rt, handler } = build();
    // First register: template says "v1".
    const flowA = defineFlow({ id: "register_overwrite", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const sa = flowA.node("start", { id: "s", position: { x: 0, y: 0 } });
    const ta = flowA.node("transform", {
      id: "t",
      position: { x: 100, y: 0 },
      config: { template: "v1" },
    });
    const ea = flowA.node("end", { id: "e", position: { x: 200, y: 0 } });
    flowA.connect(sa.out("out"), ta.in("in"));
    flowA.connect(ta.out("out"), ea.in("in"));
    await handler(
      new Request("http://test/flows/register", {
        method: "POST",
        body: JSON.stringify({ graph: JSON.parse(flowA.dump()) }),
      }),
    );
    // Second register: same id+version, different template.
    const flowB = defineFlow({ id: "register_overwrite", version: "1.0.0", registry: rt.nodeTypeRegistry });
    const sb = flowB.node("start", { id: "s", position: { x: 0, y: 0 } });
    const tb = flowB.node("transform", {
      id: "t",
      position: { x: 100, y: 0 },
      config: { template: "v2" },
    });
    const eb = flowB.node("end", { id: "e", position: { x: 200, y: 0 } });
    flowB.connect(sb.out("out"), tb.in("in"));
    flowB.connect(tb.out("out"), eb.in("in"));
    const res = await handler(
      new Request("http://test/flows/register", {
        method: "POST",
        body: JSON.stringify({ graph: JSON.parse(flowB.dump()) }),
      }),
    );
    expect(res.status).toBe(204);

    const invoke = await handler(
      new Request("http://test/flows/register_overwrite/invoke", {
        method: "POST",
        body: JSON.stringify({ input: null }),
      }),
    );
    const body = (await invoke.json()) as { output: unknown };
    expect(body.output).toBe("v2");
  });

  it("rejects malformed bodies with a transport.invalid_input error", async () => {
    const { handler } = build();
    const res = await handler(
      new Request("http://test/flows/register", {
        method: "POST",
        body: JSON.stringify({ graph: { id: "x" /* missing fields */ } }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("transport.invalid_input");
  });
});

describe("transport-http / CORS", () => {
  it("answers OPTIONS preflight with the configured allow-origin", async () => {
    const { handler } = build("*");
    const res = await handler(
      new Request("http://test/flows/register", {
        method: "OPTIONS",
        headers: { origin: "http://ui:3000" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
  });

  it("decorates real responses with Access-Control-Allow-Origin", async () => {
    const { handler } = build("*");
    const res = await handler(
      new Request("http://test/runs/nope", {
        headers: { origin: "http://ui" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("only allows whitelisted origins when an explicit list is configured", async () => {
    const { handler } = build(["http://ui"]);
    const allowed = await handler(
      new Request("http://test/runs/x", { headers: { origin: "http://ui" } }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://ui",
    );
    const denied = await handler(
      new Request("http://test/runs/x", {
        headers: { origin: "http://evil" },
      }),
    );
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("emits no CORS headers when `cors` is omitted", async () => {
    const { handler } = build("OFF");
    const res = await handler(
      new Request("http://test/runs/x", { headers: { origin: "http://ui" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

