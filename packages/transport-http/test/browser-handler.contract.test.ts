import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  createBrowserRuntime,
  type LlmProvider,
} from "@ai-native-flow/runtime/browser";
import { createHttpHandler } from "../src/index.js";

describe("browser runtime HTTP contract", () => {
  it("uses the same register/invoke/events routes entirely in process", async () => {
    const provider: LlmProvider = {
      async complete(request) {
        return { text: `reply:${request.prompt}` };
      },
    };
    const runtime = createBrowserRuntime({
      llmProvider: provider,
      generateRunId: () => "run_browser_http",
    });
    const flow = defineFlow({
      id: "browser_http_chat",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const llm = flow.node("llm", {
      id: "llm",
      position: { x: 120, y: 0 },
      config: {
        prompt: "hello ${input.name}",
        baseUrl: "https://example.invalid/v1",
        apiKey: "key",
        model: "model",
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), llm.in("in"));
    flow.connect(llm.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());
    const handler = createHttpHandler({ runtime });

    const registered = await handler(new Request("http://runtime.local/flows/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph }),
    }));
    expect(registered.status).toBe(204);

    const invoked = await handler(new Request(
      "http://runtime.local/flows/browser_http_chat/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { name: "mobile" } }),
      },
    ));
    expect(invoked.status).toBe(200);
    const result = await invoked.json() as { runId: string; output: unknown };
    expect(result).toMatchObject({
      runId: "run_browser_http",
      output: "reply:hello mobile",
    });

    const events = await handler(new Request(
      `http://runtime.local/runs/${result.runId}/events`,
    ));
    expect(events.status).toBe(200);
    const body = await events.json() as { events: Array<{ kind: string }> };
    expect(body.events.map((event) => event.kind)).toContain("run_finished");
  });
});
