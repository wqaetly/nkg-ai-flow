import type { AiStreamAsyncIterable } from "@ai-native-flow/ai-stream";
import type { NodeContext } from "../nodeContext.js";
import type {
  AiSdkOpenAICompatibleLlmProviderOptions,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "./llmProvider.js";

/** Loads the AI SDK provider chunk only when a Flow actually reaches an LLM node. */
export class LazyAiSdkOpenAICompatibleLlmProvider implements LlmProvider {
  private provider: Promise<LlmProvider> | undefined;

  constructor(private readonly options: AiSdkOpenAICompatibleLlmProviderOptions = {}) {}

  complete(
    request: LlmCompletionRequest,
    context: NodeContext,
  ): Promise<LlmCompletionResponse> {
    return this.load().then((provider) => provider.complete(request, context));
  }

  async completeStream(
    request: LlmCompletionRequest,
    context: NodeContext,
  ): Promise<AiStreamAsyncIterable> {
    const provider = await this.load();
    if (provider.completeStream) return provider.completeStream(request, context);
    const response = await provider.complete(request, context);
    return oneShotStream(response.text);
  }

  private load(): Promise<LlmProvider> {
    this.provider ??= import("./llmProvider.js").then(
      ({ AiSdkOpenAICompatibleLlmProvider }) =>
        new AiSdkOpenAICompatibleLlmProvider(this.options),
    );
    return this.provider;
  }
}

async function* oneShotStream(text: string): AiStreamAsyncIterable {
  yield { kind: "text_delta", text };
  yield { kind: "done", text, finishReason: "stop" };
}
