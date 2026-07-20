import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  createBrowserRuntime,
  type LlmCompletionRequest,
  type LlmProvider,
} from "../src/browser.js";

class EchoProvider implements LlmProvider {
  requests: LlmCompletionRequest[] = [];

  async complete(request: LlmCompletionRequest) {
    this.requests.push(request);
    return { text: `mobile:${request.prompt}` };
  }
}

describe("browser runtime", () => {
  it("runs text_input -> llm -> end with browser-safe defaults", async () => {
    const provider = new EchoProvider();
    const runtime = createBrowserRuntime({
      llmProvider: provider,
      generateRunId: () => "run_mobile_contract",
    });
    const flow = defineFlow({
      id: "mobile_chat",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const input = flow.node("text_input", {
      id: "prompt",
      position: { x: 0, y: 0 },
      config: { value: "你好" },
    });
    const llm = flow.node("llm", {
      id: "model",
      position: { x: 160, y: 0 },
      config: {
        prompt: "fallback",
        baseUrl: "https://example.invalid/v1",
        apiKey: "user-key",
        model: "user-model",
      },
    });
    const end = flow.node("end", {
      id: "end",
      position: { x: 320, y: 0 },
    });
    flow.connect(input.out("out"), llm.in("in"));
    flow.connect(input.out("text"), llm.in("prompt"));
    flow.connect(llm.out("out"), end.in("in"));

    const graph = JSON.parse(flow.dump());
    await runtime.registry.register({ graph, json: flow.dump() });
    await runtime.registry.promote(graph.id, graph.version);
    const result = await runtime.invocationRouter.invoke({
      flowId: graph.id,
      input: null,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("mobile:你好");
    expect(provider.requests).toMatchObject([{
      prompt: "你好",
      baseUrl: "https://example.invalid/v1",
      apiKey: "user-key",
      model: "user-model",
    }]);
  });

  it("does not register filesystem/process agent nodes without a native tool host", () => {
    const runtime = createBrowserRuntime({ llmProvider: new EchoProvider() });

    expect(runtime.runners.list().some((entry) => entry.type === "tool")).toBe(false);
    expect(runtime.runners.list().some((entry) => entry.type === "agent")).toBe(false);
    expect(runtime.runners.has("llm", "1.0.0")).toBe(true);
  });
});
