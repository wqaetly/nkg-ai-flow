import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import { InMemorySecretStore, InMemoryVariableStore } from "@ai-native-flow/variable-store";
import { AiSdkOpenAICompatibleLlmProvider } from "../src/nodes/llmProvider.js";
import type { NodeContext } from "../src/nodeContext.js";

const mocks = vi.hoisted(() => {
  const providerModel = vi.fn((modelId: string) => ({ modelId }));
  const createOpenAICompatible = vi.fn(() => providerModel);
  const textStreamOf = (chunks: string[]): AsyncIterable<string> =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  const generateText = vi.fn(async () => ({
    text: "{\"ok\":true}",
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    },
  }));
  const streamText = vi.fn(() => ({
    textStream: textStreamOf(["{\"ok\"", ":true}"]),
  }));
  return { providerModel, createOpenAICompatible, generateText, streamText, textStreamOf };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  streamText: mocks.streamText,
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
    mocks.streamText.mockClear();
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

  it("retries empty AI SDK streams before failing", async () => {
    mocks.streamText
      .mockReturnValueOnce({
        textStream: mocks.textStreamOf([]),
      })
      .mockReturnValueOnce({
        textStream: mocks.textStreamOf(["{\"ok\":true}"]),
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
});
