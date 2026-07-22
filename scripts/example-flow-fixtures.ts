import type { DefinedNode } from "@ai-native-flow/node-sdk";
import type {
  AgentToolCall,
  AgentToolHost,
  AgentToolName,
  AgentToolResult,
  LlmCompletionRequest,
  LlmProvider,
} from "@ai-native-flow/runtime/browser";
import createSkillToFlowNodes from "../apps/skill-to-flow/nodes/index.js";

const PLAN = {
  skillName: "fixture-skill",
  summary: "Convert a deterministic fixture request into a result.",
  requirements: {
    goals: ["Return a deterministic result"],
    inputContract: [{ name: "request", description: "request", dataType: "string" }],
    outputContract: [{ name: "result", description: "result", dataType: "string" }],
    acceptanceCriteria: ["The generated flow exposes result"],
    constraints: ["No external services"],
    contextHandoff: "Pass named outputs between adjacent steps.",
  },
  steps: [
    step("intake", "input", [], [], "request"),
    step("analyze", "analyze", ["intake"], ["request"], "analysis"),
    step("report", "report", ["analyze"], ["analysis"], "result"),
  ],
  parallelGroups: [],
};

export function createDeterministicExampleProvider(): LlmProvider {
  return {
    async complete(request) {
      return { text: responseFor(request) };
    },
    async completeWithTools(request) {
      return runDeterministicToolLoop(request);
    },
  };
}

async function runDeterministicToolLoop(
  request: Parameters<NonNullable<LlmProvider["completeWithTools"]>>[0],
): Promise<Awaited<ReturnType<NonNullable<LlmProvider["completeWithTools"]>>>> {
  const observations: string[] = [];
  for (let step = 1; step <= request.maxSteps; step += 1) {
    const prompt = observations.length === 0
      ? request.prompt
      : request.prompt.replace(
        "Previous observations: none",
        `Previous observations:\n${observations.join("\n\n")}`,
      );
    const response = responseFor({ ...request, prompt });
    const decision = parseLegacyAgentDecision(response);
    if (decision?.kind === "final") {
      return {
        text: decision.summary,
        context: decision.context,
        steps: step,
        finishReason: "stop",
      };
    }
    if (!decision) return { text: response, steps: step, finishReason: "stop" };
    const definition = request.tools[decision.action];
    if (!definition) throw new Error(`fixture requested unavailable tool ${decision.action}`);
    const output = await definition.execute(decision.args);
    observations.push(
      `Step ${step} tool ${decision.action}\nargs: ${JSON.stringify(decision.args)}\nobservation: ${JSON.stringify(output)}`,
    );
  }
  return { text: "", steps: request.maxSteps, finishReason: "tool-calls" };
}

function parseLegacyAgentDecision(value: string):
  | { kind: "final"; action: "final"; summary: string; context?: Record<string, unknown> }
  | { kind: "tool"; action: string; args: Record<string, unknown> }
  | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.action === "final") {
      return {
        kind: "final",
        action: "final",
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        ...(parsed.context && typeof parsed.context === "object"
          ? { context: parsed.context as Record<string, unknown> }
          : {}),
      };
    }
    if (typeof parsed.action !== "string") return undefined;
    return {
      kind: "tool",
      action: parsed.action,
      args: parsed.args && typeof parsed.args === "object"
        ? parsed.args as Record<string, unknown>
        : {},
    };
  } catch {
    return undefined;
  }
}

export function createDeterministicSkillToFlowNodes(
  llmProvider: LlmProvider,
): DefinedNode[] {
  return createSkillToFlowNodes({ llmProvider });
}

export class InMemoryAgentToolHost implements AgentToolHost {
  readonly files = new Map<string, string>();

  async callTool(
    call: AgentToolCall,
    env: {
      workingDir: string;
      allowedTools: readonly AgentToolName[];
      allowBash: boolean;
      timeoutMs: number;
      maxOutputChars: number;
      context?: Record<string, unknown>;
    },
  ): Promise<AgentToolResult> {
    if (!env.allowedTools.includes(call.tool)) {
      return { ok: false, error: `tool not allowed: ${call.tool}` };
    }
    if (call.tool === "run_bash") {
      return env.allowBash
        ? { ok: true, output: { stdout: "fixture verification passed", exitCode: 0 } }
        : { ok: false, error: "bash disabled" };
    }
    if (call.tool === "edit_file") {
      const path = String(call.args.path ?? "");
      const contents = String(call.args.new_text ?? "");
      this.files.set(path, contents);
      return { ok: true, output: { path }, changedFiles: [path] };
    }
    if (call.tool === "write_files") {
      const planned = env.context?.materializationPlan as
        | { files?: Array<{ path?: string; contents?: string }> }
        | undefined;
      const files = Array.isArray(call.args.files)
        ? call.args.files as Array<{ path?: string; contents?: string }>
        : planned?.files ?? [];
      const changedFiles = files.map((file) => String(file.path ?? "fixture.txt"));
      for (const [index, path] of changedFiles.entries()) {
        this.files.set(path, String(files[index]?.contents ?? ""));
      }
      return { ok: true, output: { written: changedFiles }, changedFiles };
    }
    if (call.tool === "list_files") {
      return { ok: true, output: [...this.files.keys()].sort() };
    }
    if (call.tool === "read_file") {
      const path = String(call.args.path ?? "");
      return this.files.has(path)
        ? { ok: true, output: this.files.get(path) }
        : { ok: false, error: `missing file: ${path}` };
    }
    return { ok: true, output: [] };
  }
}

function responseFor(request: LlmCompletionRequest): string {
  const prompt = request.prompt;
  if (prompt.includes("senior flow architect for the AI Native Flow runtime")) {
    return JSON.stringify(PLAN);
  }
  if (prompt.includes("senior flow node designer")) {
    const id = capture(prompt, /# THIS STEP\s+id: ([a-z0-9_]+)/);
    const planStep = PLAN.steps.find((item) => item.id === id)!;
    return JSON.stringify({
      stepId: id,
      nodeType: `fixture_${id}`,
      typeVersion: "1.0.0",
      title: `Fixture ${id}`,
      description: `Deterministic ${id} node`,
      configFields: [],
      inputPorts: planStep.inputs.map((input) => ({
        id: input.name,
        kind: "data",
        direction: "input",
        label: input.name,
        dataType: input.dataType,
      })),
      outputPorts: planStep.outputs.map((output) => ({
        id: output.name,
        kind: "data",
        direction: "output",
        label: output.name,
        dataType: output.dataType,
      })),
      implementation: {
        strategy: id === "intake" ? "transform" : "llm_prompt",
        ...(id === "intake"
          ? { transformLogic: "Return the runtime request." }
          : { promptTemplate: `Process ${id}`, responseFormat: "text" }),
      },
      pseudocode: `Produce ${planStep.outputs[0]!.name}.`,
      requiresLlm: id !== "intake",
    });
  }
  if (prompt.includes("senior TypeScript engineer for the AI Native Flow project")) {
    const id = capture(prompt, /# PLAN STEP\s+id: ([a-z0-9_]+)/);
    const nodeType = `fixture_${id}`;
    return JSON.stringify({
      filePath: `${nodeType}.ts`,
      source: [
        'import { defineNode } from "@ai-native-flow/node-sdk";',
        `export const ${id}Node = defineNode({`,
        `  type: "${nodeType}", typeVersion: "1.0.0", title: "${id}",`,
        "  config: {}, ports: [], async run() { return { kind: \"success\", outputs: { out: null } }; }",
        "});",
      ].join("\n"),
    });
  }
  if (prompt.includes("Previous observations: none")) {
    if (prompt.includes("Materialize the generated Flow package")) {
      return JSON.stringify({
        action: "write_files",
        args: { files_ref: "materializationPlan.files", create: true },
      });
    }
    return JSON.stringify({
      action: "edit_file",
      args: {
        path: "helloagent.cs",
        create: true,
        new_text: 'using System;\nConsole.WriteLine("HelloAgent");\n',
      },
    });
  }
  return JSON.stringify({
    action: "final",
    summary: "deterministic fixture completed",
    context: { fixture: true },
  });
}

function step(
  id: string,
  kind: "input" | "analyze" | "report",
  dependencies: string[],
  inputNames: string[],
  outputName: string,
) {
  return {
    id,
    label: id,
    kind,
    description: `Fixture ${id}`,
    intent: `Deterministically execute ${id}`,
    requiredTools: [],
    dependencies,
    inputs: inputNames.map((name) => ({ name, description: name, dataType: "string" as const })),
    outputs: [{ name: outputName, description: outputName, dataType: "string" as const }],
  };
}

function capture(value: string, pattern: RegExp): string {
  const result = pattern.exec(value)?.[1];
  if (!result) throw new Error(`fixture could not classify prompt: ${value.slice(0, 160)}`);
  return result;
}
