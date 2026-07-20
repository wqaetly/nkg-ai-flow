import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import type { LlmProvider } from "@ai-native-flow/runtime/browser";
import { createPortableHttpRuntime } from "../src/index.js";

describe("portable HTTP Runtime composition", () => {
  it("registers Flow objects before exposing an in-process handler", async () => {
    const provider: LlmProvider = {
      async complete(request) {
        return { text: `portable:${request.prompt}` };
      },
    };
    const definition = await createPortableHttpRuntime({ llmProvider: provider });
    const flow = defineFlow({
      id: "portable_http_runtime",
      version: "1.0.0",
      registry: definition.runtime.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const llm = flow.node("llm", {
      id: "llm",
      position: { x: 120, y: 0 },
      config: {
        prompt: "hello ${input.name}",
        baseUrl: "https://example.invalid/v1",
        apiKey: "user-key",
        model: "user-model",
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), llm.in("in"));
    flow.connect(llm.out("out"), end.in("in"));

    const portable = await createPortableHttpRuntime({
      llmProvider: provider,
      generateRunId: () => "portable_runtime_run",
      flows: [flow.dump()],
      http: { basePath: "/runtime" },
    });
    const response = await portable.handler(new Request(
      "http://runtime.local/runtime/flows/portable_http_runtime/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { name: "mobile" } }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: "portable_runtime_run",
      output: "portable:hello mobile",
    });
  });
});
