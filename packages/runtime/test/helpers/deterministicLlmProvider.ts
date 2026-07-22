import type { AiStreamAsyncIterable } from "@ai-native-flow/ai-stream";
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmToolLoopRequest,
  LlmToolLoopResponse,
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

  async completeWithTools(req: LlmToolLoopRequest): Promise<LlmToolLoopResponse> {
    const responder = this.options.respond ?? ((r) => `echo: ${r.prompt}`);
    const observations: string[] = [];
    for (let step = 1; step <= req.maxSteps; step += 1) {
      const prompt = observations.length === 0
        ? req.prompt
        : req.prompt.replace(
          "Previous observations: none",
          `Previous observations:\n${observations.join("\n\n")}`,
        );
      const text = responder({ ...req, prompt });
      const decision = legacyDecision(text);
      if (!decision) {
        if (!text.trim().startsWith("{")) return { text, steps: step, finishReason: "stop" };
        observations.push(`Step ${step} model output was not a valid tool call: ${text}`);
        continue;
      }
      if (decision.kind === "final") {
        return {
          text: decision.summary,
          steps: step,
          finishReason: "stop",
          ...(decision.context ? { context: decision.context } : {}),
        };
      }
      const definition = req.tools[decision.action];
      if (!definition) {
        observations.push(`Step ${step} requested unavailable tool ${decision.action}`);
        continue;
      }
      const result = await definition.execute(decision.args);
      observations.push(
        `Step ${step} tool ${decision.action}\nargs: ${JSON.stringify(decision.args)}\nobservation: ${JSON.stringify(result)}`,
      );
    }
    return { text: "", steps: req.maxSteps, finishReason: "tool-calls" };
  }
}

function legacyDecision(text: string):
  | { kind: "final"; action: "final"; summary: string; context?: Record<string, unknown> }
  | { kind: "tool"; action: string; args: Record<string, unknown> }
  | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.action === "final") {
      return {
        kind: "final",
        action: "final",
        summary: typeof value.summary === "string" ? value.summary : "",
        ...(value.context && typeof value.context === "object"
          ? { context: value.context as Record<string, unknown> }
          : {}),
      };
    }
    if (typeof value.action !== "string") return undefined;
    return {
      kind: "tool",
      action: value.action,
      args: value.args && typeof value.args === "object"
        ? value.args as Record<string, unknown>
        : {},
    };
  } catch {
    return undefined;
  }
}

async function* chunkText(text: string): AiStreamAsyncIterable {
  const size = 4;
  for (let i = 0; i < text.length; i += size) {
    yield { kind: "text_delta", text: text.slice(i, i + size) };
  }
  yield { kind: "done", text, finishReason: "stop" };
}
