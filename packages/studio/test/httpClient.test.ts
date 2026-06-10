/**
 * SidecarClient unit tests.
 *
 * `httpClient.ts` is the only Studio surface that talks to the network,
 * so we mock global `fetch` and assert that:
 *   - URLs target the documented runtime endpoints exactly,
 *   - request bodies serialize the user input and run env overrides,
 *   - errors surface the sidecar's structured `{ error: { code } }` shape,
 *   - cancel() is no-op when no run started yet.
 *
 * Live SSE behaviour is exercised in `FlowRunController` integration
 * tests where a fake SidecarClient is injected.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidecarClient } from "../src/httpClient.js";

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

const captured: FetchCall[] = [];

function installFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? (init.body as string) : null,
    });
    return responder(url, init);
  };
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

describe("SidecarClient / invokeFlow", () => {
  it("POSTs the documented invoke endpoint with serialized input", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          runId: "run_1",
          flowId: "f",
          flowVersion: "1.0.0",
          status: "succeeded",
          output: "ok",
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SidecarClient({ baseUrl: "http://localhost:5173/" });
    const result = await client.invokeFlow("flow_a", { name: "Node" });

    expect(result.runId).toBe("run_1");
    expect(result.output).toBe("ok");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("http://localhost:5173/flows/flow_a/invoke");
    expect(captured[0]!.method).toBe("POST");
    expect(JSON.parse(captured[0]!.body!)).toEqual({ input: { name: "Node" } });
  });

  it("serializes run-scoped envOverrides", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          runId: "run_env",
          flowId: "f",
          flowVersion: "1.0.0",
          status: "succeeded",
          output: null,
          error: null,
        }),
        { status: 200 },
      ),
    );
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    await client.invokeFlow("flow_env", null, undefined, {
      variables: { LLM_BASE_URL: "https://example.test/v1" },
      secrets: { LLM_API_KEY: "sk-test" },
    });
    expect(JSON.parse(captured[0]!.body!)).toEqual({
      input: null,
      envOverrides: {
        variables: { LLM_BASE_URL: "https://example.test/v1" },
        secrets: { LLM_API_KEY: "sk-test" },
      },
    });
  });

  it("surfaces sidecar error envelopes verbatim", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          error: { code: "flow.input.invalid", message: "missing name" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    let captured: unknown = null;
    try {
      await client.invokeFlow("flow_b", {});
    } catch (e) {
      captured = e;
    }
    expect(String(captured)).toContain("flow.input.invalid");
    expect(String(captured)).toContain("missing name");
  });
});

describe("SidecarClient / invokeNode", () => {
  it("POSTs the sub-graph endpoint with `{flowId, nodeId}`", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          runId: "run_2",
          flowId: "f",
          flowVersion: "1.0.0",
          nodeId: "upper",
          status: "succeeded",
          output: "Hi Node",
          error: null,
        }),
        { status: 200 },
      ),
    );
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    const result = await client.invokeNode("flow_a", "upper", { name: "Node" });

    expect(result.output).toBe("Hi Node");
    expect(result.nodeId).toBe("upper");
    expect(captured[0]!.url).toBe(
      "http://localhost:5173/flows/flow_a/nodes/upper/invoke",
    );
    expect(JSON.parse(captured[0]!.body!).input).toEqual({ name: "Node" });
  });
});

describe("SidecarClient / cancelRun", () => {
  it("swallows 404 (run already terminal) but rethrows other failures", async () => {
    installFetch((_url, init) => {
      if (init?.method === "POST") {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 500 });
    });
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    // 404 is benign \u2014 should resolve without throwing.
    await client.cancelRun("run_99");
  });

  it("rethrows on non-404 failures with the response status in the message", async () => {
    installFetch(() => new Response("nope", { status: 502 }));
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    let err: unknown = null;
    try {
      await client.cancelRun("run_99");
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("502");
  });
});

describe("SidecarClient / flow env sidecar", () => {
  it("loads a flow env sidecar from the Studio endpoint", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          variables: { "刀哥Key": "sk-test" },
          path: "team-advisor.flow.local.env.json",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SidecarClient({ baseUrl: "http://localhost:5173/" });
    const result = await client.loadFlowEnv("kesmj-team-advisor/0.1.0.flow.json");

    expect(result.variables).toEqual({ "刀哥Key": "sk-test" });
    expect(captured[0]!.url).toBe(
      "http://localhost:5173/studio/flows/env?path=kesmj-team-advisor%2F0.1.0.flow.json",
    );
    expect(captured[0]!.method).toBe("GET");
  });

  it("saves variables to a flow env sidecar", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({ ok: true, paths: ["team-advisor.flow.local.env.json"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    await client.saveFlowEnv("kesmj-team-advisor/0.1.0.flow.json", {
      "刀哥Model": "gpt-test",
    });

    expect(captured[0]!.url).toBe(
      "http://localhost:5173/studio/flows/env?path=kesmj-team-advisor%2F0.1.0.flow.json",
    );
    expect(captured[0]!.method).toBe("PUT");
    expect(JSON.parse(captured[0]!.body!)).toEqual({
      variables: { "刀哥Model": "gpt-test" },
    });
  });
});

describe("SidecarClient / streamFlow", () => {
  it("POSTs the stream endpoint with envOverrides and dispatches SSE events", async () => {
    const encoder = new TextEncoder();
    installFetch((url, init) => {
      if (url.endsWith("/cancel")) return new Response("", { status: 202 });
      expect(init?.method).toBe("POST");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'id: evt-1\nevent: run_started\ndata: {"eventId":"evt-1","runId":"run_stream","kind":"run_started","ts":1}\n\n' +
                  'id: evt-2\nevent: run_finished\ndata: {"eventId":"evt-2","runId":"run_stream","kind":"run_finished","ts":2,"payload":{"output":"ok"}}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = new SidecarClient({ baseUrl: "http://localhost:5173" });
    const events: string[] = [];
    client.streamFlow(
      "flow_stream",
      { q: "hello" },
      { onEvent: (event) => events.push(event.kind) },
      undefined,
      { variables: { MODEL: "x" }, secrets: { TOKEN: "y" } },
    );
    await waitFor(() => events.includes("run_finished"));

    expect(captured[0]!.url).toBe("http://localhost:5173/flows/flow_stream/stream");
    expect(captured[0]!.method).toBe("POST");
    expect(JSON.parse(captured[0]!.body!)).toEqual({
      input: { q: "hello" },
      envOverrides: {
        variables: { MODEL: "x" },
        secrets: { TOKEN: "y" },
      },
    });
    expect(events).toEqual(["run_started", "run_finished"]);
  });
});

describe("SidecarClient / withBaseUrl", () => {
  it("returns a fresh client pointed at the new base URL", async () => {
    const a = new SidecarClient({ baseUrl: "http://a.test" });
    const b = a.withBaseUrl("http://b.test");
    expect(a).not.toBe(b);
    installFetch(() =>
      new Response(
        JSON.stringify({
          runId: "x",
          flowId: "f",
          flowVersion: "1",
          status: "succeeded",
          output: null,
          error: null,
        }),
        { status: 200 },
      ),
    );
    await b.invokeFlow("f", null);
    expect(captured[0]!.url.startsWith("http://b.test/")).toBe(true);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
