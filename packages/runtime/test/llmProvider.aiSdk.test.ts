import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import { InMemorySecretStore, InMemoryVariableStore } from "@ai-native-flow/variable-store";
import { AiSdkOpenAICompatibleLlmProvider } from "../src/nodes/llmProvider.js";
import type { NodeContext } from "../src/nodeContext.js";

const mocks = vi.hoisted(() => {
  const providerModel = vi.fn((modelId: string) => ({ modelId }));
  const createOpenAICompatible = vi.fn(() => providerModel);
  const jsonSchema = vi.fn((schema: unknown) => ({ schema }));
  const stepCountIs = vi.fn((maxSteps: number) => ({ maxSteps }));
  const tool = vi.fn((definition: unknown) => definition);
  const textStreamOf = (chunks: string[]): AsyncIterable<string> =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  const fullStreamOf = (
    parts: Array<
      | { type: "text-delta"; text: string }
      | { type: "reasoning-delta"; text: string }
      | { type: "error"; error: unknown }
    >,
  ): AsyncIterable<
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "error"; error: unknown }
  > => (async function* () {
    for (const part of parts) yield part;
  })();
  const textPartsOf = (chunks: string[]) =>
    fullStreamOf(chunks.map((text) => ({ type: "text-delta" as const, text })));
  const generateText = vi.fn(async () => ({
    text: "{\"ok\":true}",
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    },
  }));
  const streamText = vi.fn(() => ({
    fullStream: textPartsOf(["{\"ok\"", ":true}"]),
  }));
  return {
    providerModel,
    createOpenAICompatible,
    jsonSchema,
    stepCountIs,
    tool,
    generateText,
    streamText,
    textStreamOf,
    fullStreamOf,
    textPartsOf,
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  jsonSchema: mocks.jsonSchema,
  stepCountIs: mocks.stepCountIs,
  streamText: mocks.streamText,
  tool: mocks.tool,
}));

function context(args: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): NodeContext {
  const variables = new InMemoryVariableStore(
    [
      args.baseUrl ? { name: "LLM_BASE_URL", value: args.baseUrl } : undefined,
      args.model ? { name: "LLM_DEFAULT_MODEL", value: args.model } : undefined,
      args.apiKey ? { name: "LLM_API_KEY", value: args.apiKey } : undefined,
    ].filter(Boolean) as Array<{ name: string; value: string }>,
  );
  const secrets = new InMemorySecretStore();
  return {
    runId: "run_test",
    flowId: "flow_test",
    flowVersion: "1.0.0",
    nodeId: "node_llm",
    nodeType: "llm",
    nodeVersion: "1.0.0",
    attempt: 1,
    signal: new AbortController().signal,
    variables,
    secrets,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    emit: vi.fn(),
    stream: vi.fn(),
  } as unknown as NodeContext;
}

describe("AiSdkOpenAICompatibleLlmProvider", () => {
  beforeEach(() => {
    mocks.createOpenAICompatible.mockClear();
    mocks.providerModel.mockClear();
    mocks.generateText.mockClear();
    mocks.jsonSchema.mockClear();
    mocks.stepCountIs.mockClear();
    mocks.streamText.mockClear();
    mocks.tool.mockClear();
  });

  it("delegates OpenAI-compatible completion to AI SDK", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = new AiSdkOpenAICompatibleLlmProvider({
      providerName: "lfzxb",
      fetchImpl,
    });
    const result = await provider.complete(
      {
        prompt: "hello",
        temperature: 0.2,
        maxTokens: 1200,
      },
      context({
        baseUrl: "https://api.lfzxb.top/v1",
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
      }),
    );

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "lfzxb",
      baseURL: "https://api.lfzxb.top/v1",
      apiKey: "sk-test",
      fetch: fetchImpl,
    });
    expect(mocks.providerModel).toHaveBeenCalledWith("deepseek-v4-flash");
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: { modelId: "deepseek-v4-flash" },
      prompt: "hello",
      temperature: 0.2,
      maxOutputTokens: 1200,
      abortSignal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      text: "{\"ok\":true}",
      raw: expect.objectContaining({ text: "{\"ok\":true}" }),
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });
  });

  it("allows per-call model/baseUrl/apiKey overrides", async () => {
    const provider = new AiSdkOpenAICompatibleLlmProvider();
    await provider.complete(
      {
        prompt: "override",
        baseUrl: "https://override.example/v1",
        apiKey: "sk-override",
        model: "override-model",
      },
      context({
        baseUrl: "https://api.lfzxb.top/v1",
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
      }),
    );

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "openai-compatible",
      baseURL: "https://override.example/v1",
      apiKey: "sk-override",
    });
    expect(mocks.providerModel).toHaveBeenCalledWith("override-model");
  });

  it("delegates the complete agent tool loop to AI SDK", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({ input, ok: true }));
    mocks.generateText.mockResolvedValueOnce({
      text: "工具执行完成",
      finishReason: "stop",
      steps: [{}, {}],
      totalUsage: {
        inputTokens: 21,
        outputTokens: 8,
        totalTokens: 29,
      },
    } as never);
    const provider = new AiSdkOpenAICompatibleLlmProvider();

    const result = await provider.completeWithTools!({
      prompt: "查找项目状态",
      maxSteps: 5,
      tools: {
        lookup_status: {
          description: "查找项目状态",
          inputSchema: {
            type: "object",
            properties: { projectId: { type: "string" } },
            required: ["projectId"],
            additionalProperties: false,
          },
          execute,
        },
      },
    }, context({
      baseUrl: "https://api.example.test/v1",
      model: "tool-model",
      apiKey: "sk-test",
    }));

    expect(mocks.stepCountIs).toHaveBeenCalledWith(5);
    expect(mocks.jsonSchema).toHaveBeenCalledWith(expect.objectContaining({ type: "object" }));
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { modelId: "tool-model" },
      prompt: "查找项目状态",
      stopWhen: { maxSteps: 5 },
      tools: { lookup_status: expect.objectContaining({ description: "查找项目状态" }) },
    }));
    const sdkTool = mocks.tool.mock.calls[0]![0] as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(sdkTool.execute({ projectId: "nkg" })).resolves.toEqual({
      input: { projectId: "nkg" },
      ok: true,
    });
    expect(execute).toHaveBeenCalledWith({ projectId: "nkg" });
    expect(result).toMatchObject({
      text: "工具执行完成",
      finishReason: "stop",
      steps: 2,
      usage: { promptTokens: 21, completionTokens: 8, totalTokens: 29 },
    });
  });

  it("resolves $var shorthand overrides before calling AI SDK", async () => {
    const provider = new AiSdkOpenAICompatibleLlmProvider();
    await provider.complete(
      {
        prompt: "ref override",
        baseUrl: "$var:LLM_BASE_URL",
        apiKey: "$var:LLM_API_KEY",
        model: "$var:LLM_DEFAULT_MODEL",
      },
      context({
        baseUrl: "https://api.lfzxb.top/v1",
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
      }),
    );

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "openai-compatible",
      baseURL: "https://api.lfzxb.top/v1",
      apiKey: "sk-test",
    });
    expect(mocks.providerModel).toHaveBeenCalledWith("deepseek-v4-flash");
  });

  it("rejects empty AI SDK completions as retryable provider failures", async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: "   ",
      usage: {
        inputTokens: 11,
        outputTokens: 0,
        totalTokens: 11,
      },
    });
    const provider = new AiSdkOpenAICompatibleLlmProvider({
      providerName: "lfzxb",
    });

    try {
      await provider.complete(
        { prompt: "hello" },
        context({
          baseUrl: "https://api.lfzxb.top/v1",
          model: "deepseek-v4-flash",
          apiKey: "sk-test",
        }),
      );
      throw new Error("expected provider to reject empty completions");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeErrorException);
      expect((err as RuntimeErrorException).error.code).toBe(
        "node.llm.empty_response",
      );
      expect((err as RuntimeErrorException).error.retryable).toBe(true);
    }
  });

  it("streams completions through AI SDK streamText", async () => {
    const provider = new AiSdkOpenAICompatibleLlmProvider({
      providerName: "lfzxb",
    });
    const events = [];

    for await (const event of await provider.completeStream!(
      { prompt: "stream me", temperature: 0.1, maxTokens: 50 },
      context({
        baseUrl: "https://api.lfzxb.top/v1",
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
      }),
    )) {
      events.push(event);
    }

    expect(mocks.streamText).toHaveBeenCalledWith({
      model: { modelId: "deepseek-v4-flash" },
      prompt: "stream me",
      temperature: 0.1,
      maxOutputTokens: 50,
      abortSignal: expect.any(AbortSignal),
    });
    expect(events).toEqual([
      { kind: "text_delta", text: "{\"ok\"" },
      { kind: "text_delta", text: ":true}" },
      { kind: "done", text: "{\"ok\":true}", finishReason: "stop" },
    ]);
  });

  it("preserves model reasoning as thinking deltas before the answer", async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: mocks.fullStreamOf([
        { type: "reasoning-delta", text: "先分析约束。" },
        { type: "reasoning-delta", text: "再核对答案。" },
        { type: "text-delta", text: "最终答案" },
      ]),
    });
    const provider = new AiSdkOpenAICompatibleLlmProvider();
    const events = [];

    for await (const event of await provider.completeStream!(
      { prompt: "请认真回答" },
      context({
        baseUrl: "https://api.example.test/v1",
        model: "reasoning-model",
        apiKey: "sk-test",
      }),
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { kind: "thinking_delta", text: "先分析约束。" },
      { kind: "thinking_delta", text: "再核对答案。" },
      { kind: "text_delta", text: "最终答案" },
      { kind: "done", text: "最终答案", finishReason: "stop" },
    ]);
  });

  it("retries empty AI SDK streams before failing", async () => {
    mocks.streamText
      .mockReturnValueOnce({
        fullStream: mocks.textPartsOf([]),
      })
      .mockReturnValueOnce({
        fullStream: mocks.textPartsOf(["{\"ok\":true}"]),
      });
    const provider = new AiSdkOpenAICompatibleLlmProvider({
      providerName: "lfzxb",
    });
    const events = [];

    for await (const event of await provider.completeStream!(
      { prompt: "retry stream" },
      context({
        baseUrl: "https://api.lfzxb.top/v1",
        model: "deepseek-v4-flash",
        apiKey: "sk-test",
      }),
    )) {
      events.push(event);
    }

    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({
      kind: "done",
      text: "{\"ok\":true}",
      finishReason: "stop",
    });
  });

  it("maps base64 images to AI SDK multimodal user content", async () => {
    const provider = new AiSdkOpenAICompatibleLlmProvider();
    await provider.complete(
      {
        prompt: "describe the image",
        images: [{ data: "aW1hZ2U=", mediaType: "image/png" }],
      },
      context({
        baseUrl: "https://api.lfzxb.top/v1",
        model: "vision-model",
        apiKey: "sk-test",
      }),
    );

    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [{
        role: "user",
        content: [
          { type: "text", text: "describe the image" },
          { type: "image", image: "aW1hZ2U=", mediaType: "image/png" },
        ],
      }],
    }));
  });

  it("propagates AI SDK stream errors instead of misreporting an empty response", async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: mocks.fullStreamOf([
        { type: "error", error: new Error("WebView fetch blocked by CSP") },
      ]),
    });
    const provider = new AiSdkOpenAICompatibleLlmProvider({
      providerName: "lfzxb",
    });

    await expect(async () => {
      for await (const _event of await provider.completeStream!(
        { prompt: "surface transport error" },
        context({
          baseUrl: "https://api.lfzxb.top/v1",
          model: "deepseek-v4-pro",
          apiKey: "sk-test",
        }),
      )) {
        // Consume the iterable so the AI SDK error part is observed.
      }
    }).rejects.toThrow("WebView fetch blocked by CSP");
  });
});
