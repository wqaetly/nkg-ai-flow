import type { AiStreamAsyncIterable } from "@ai-native-flow/ai-stream";
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "../../src/nodes/llmProvider.js";

export interface DeterministicLlmProviderOptions {
  respond?: (req: LlmCompletionRequest) => string;
  streamRespond?: (req: LlmCompletionRequest) => AiStreamAsyncIterable;
}

export class DeterministicLlmProvider implements LlmProvider {
  constructor(private readonly options: DeterministicLlmProviderOptions = {}) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const responder = this.options.respond ?? ((r) => `echo: ${r.prompt}`);
    return { text: responder(req) };
  }

  async completeStream(
    req: LlmCompletionRequest,
  ): Promise<AiStreamAsyncIterable> {
    if (this.options.streamRespond) return this.options.streamRespond(req);
    const responder = this.options.respond ?? ((r) => `echo: ${r.prompt}`);
    return chunkText(responder(req));
  }
}

async function* chunkText(text: string): AiStreamAsyncIterable {
  const size = 4;
  for (let i = 0; i < text.length; i += size) {
    yield { kind: "text_delta", text: text.slice(i, i + size) };
  }
  yield { kind: "done", text, finishReason: "stop" };
}
