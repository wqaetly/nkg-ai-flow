/**
 * Step 8 - transport-http: per-invocation `nodeOverrides`.
 *
 * The transport must accept a Langflow-style "tweaks" payload
 * (`nodeOverrides`) on every invoke / stream entry point and route the
 * Run through a freshly registered, content-addressed Flow Version so
 * the Registry's active pointer is never touched. The tests below
 * assert four invariants:
 *
 *   1. Overrides feed through to invoke / invokeNode / stream.
 *   2. Concurrent requests with different overrides see different
 *      outputs (no shared mutable graph between runs).
 *   3. The active version after a tweak'd run is still the original
 *      version (no implicit promote).
 *   4. Unknown node ids are rejected with a 400 validation error.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../runtime/test/helpers/deterministicLlmProvider.js";
import { createHttpHandler } from "../src/index.js";

function build() {
  const rt = createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
  const handler = createHttpHandler({ runtime: rt });
  return { rt, handler };
}

async function registerHello(
  rt: Runtime,
  id = "ov_hello",
  template = "Hi ${input.name}",
) {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const t = flow.node("transform", {
    id: "t",
    position: { x: 100, y: 0 },
    config: { template },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), t.in("in"));
  flow.connect(t.out("out"), end.in("in"));
  await rt.registry.register({
    graph: JSON.parse(flow.dump()),
    json: flow.dump(),
    status: "staging",
  });
  await rt.registry.promote(id, "1.0.0");
}

describe("transport-http / nodeOverrides", () => {
  it("invoke applies a config override for one call only", async () => {
    const { rt, handler } = build();
    await registerHello(rt);

    const overridden = await handler(
      new Request("http://t/flows/ov_hello/invoke", {
        method: "POST",
        body: JSON.stringify({
          input: { name: "World" },
          nodeOverrides: {
            t: { config: { template: "Hello ${input.name}" } },
          },
        }),
      }),
    );
    expect(overridden.status).toBe(200);
    const a = (await overridden.json()) as { output: unknown };
    expect(a.output).toBe("Hello World");

    // Active version is unchanged: a follow-up call without overrides
    // hits the original "Hi" template.
    const baseline = await handler(
      new Request("http://t/flows/ov_hello/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "World" } }),
      }),
    );
    const b = (await baseline.json()) as { output: unknown };
    expect(b.output).toBe("Hi World");

    // The Registry's active pointer must still resolve to 1.0.0.
    const active = await rt.registry.getActive("ov_hello");
    expect(active.version).toBe("1.0.0");
  });

  it("two concurrent invocations with different overrides do not interfere", async () => {
    const { rt, handler } = build();
    await registerHello(rt);

    const callA = handler(
      new Request("http://t/flows/ov_hello/invoke", {
        method: "POST",
        body: JSON.stringify({
          input: { name: "Alpha" },
          nodeOverrides: {
            t: { config: { template: "[A] ${input.name}" } },
          },
        }),
      }),
    );
    const callB = handler(
      new Request("http://t/flows/ov_hello/invoke", {
        method: "POST",
        body: JSON.stringify({
          input: { name: "Beta" },
          nodeOverrides: {
            t: { config: { template: "[B] ${input.name}" } },
          },
        }),
      }),
    );
    const [resA, resB] = await Promise.all([callA, callB]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const a = (await resA.json()) as {
      output: unknown;
      flowVersion: string;
    };
    const b = (await resB.json()) as {
      output: unknown;
      flowVersion: string;
    };
    expect(a.output).toBe("[A] Alpha");
    expect(b.output).toBe("[B] Beta");
    // Each Run gets its own derived version so observers can tell them
    // apart, and neither equals the original active version.
    expect(a.flowVersion).not.toBe("1.0.0");
    expect(b.flowVersion).not.toBe("1.0.0");
    expect(a.flowVersion).not.toBe(b.flowVersion);
  });

  it("invokeNode honours nodeOverrides on the targeted sub-graph", async () => {
    const { rt, handler } = build();
    await registerHello(rt);

    const res = await handler(
      new Request("http://t/flows/ov_hello/nodes/t/invoke", {
        method: "POST",
        body: JSON.stringify({
          input: { name: "Sub" },
          nodeOverrides: {
            t: { config: { template: "Sub ${input.name}" } },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: unknown };
    expect(body.output).toBe("Sub Sub");
  });

  it("stream endpoint applies overrides and emits a normal NodeEvent stream", async () => {
    const { rt, handler } = build();
    await registerHello(rt);

    const res = await handler(
      new Request("http://t/flows/ov_hello/stream", {
        method: "POST",
        body: JSON.stringify({
          input: { name: "Stream" },
          nodeOverrides: {
            t: { config: { template: "S ${input.name}" } },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain(
      "text/event-stream",
    );
    const text = await res.text();
    // The transformed output appears as part of a node_finished /
    // run_finished SSE frame; checking for the token is enough to
    // confirm overrides reached the executing graph.
    expect(text).toContain("S Stream");
  });

  it("rejects nodeOverrides targeting an unknown node id with 400", async () => {
    const { rt, handler } = build();
    await registerHello(rt);

    const res = await handler(
      new Request("http://t/flows/ov_hello/invoke", {
        method: "POST",
        body: JSON.stringify({
          input: { name: "X" },
          nodeOverrides: {
            does_not_exist: { config: { template: "nope" } },
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(
      "transport.node_overrides.unknown_node",
    );
  });
});

