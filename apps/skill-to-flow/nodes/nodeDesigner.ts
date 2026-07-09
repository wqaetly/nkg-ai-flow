/**
 * `node_designer` — second LLM stage.
 *
 * Input  : SkillDefinition + ExecutionPlan
 * Output : NodeSpec[] (one per plan step), each strictly validated.
 *
 * For every step in the plan we fan out a focused LLM call that
 * decides:
 *   • the runtime `nodeType` id (lower_snake_case, unique);
 *   • the zod-shaped config fields;
 *   • input / output data ports (matched against the plan's IO names);
 *   • the implementation strategy (`llm_prompt` / `transform` /
 *     `external_call`) plus the parameters that strategy needs;
 *   • a pseudocode body that the next stage (`code_synthesizer`) will
 *     turn into real TypeScript.
 *
 * Calls are bounded by `max_concurrency` so a 30-step plan doesn't
 * fan out 30 simultaneous requests at the LLM provider.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import {
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
  getBuiltinNodeDefinitions,
} from "@ai-native-flow/runtime";
import { z } from "zod";

import { chatJson, runWithConcurrency } from "./_llm.js";
import {
  type ExecutionPlan,
  type NodeSpec,
  type PlanStep,
  type SkillDefinition,
  nodeSpecSchema,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

const nodeDesignerConfig = z
  .object({
    /** Per-call base URL; may be a `$var:NAME` reference. */
    base_url: z.string().min(1).default(DEFAULT_LLM_BASE_URL_REF),
    /** Per-call bearer token; may be a `$var:NAME` reference. */
    api_key: z.string().min(1).default(DEFAULT_LLM_API_KEY_REF),
    /** Per-call model id; may be a `$var:NAME` reference. */
    model: z.string().min(1).default(DEFAULT_LLM_MODEL_REF),
    temperature: z.number().min(0).max(2).default(DEFAULT_LLM_TEMPERATURE),
    max_tokens: z.number().int().min(1).max(32_000).default(DEFAULT_LLM_MAX_TOKENS),
    /** Max parallel LLM calls. Default 3 — same as parallel_batch_reviewer. */
    max_concurrency: z.number().int().min(1).max(16).default(3),
    /** Schema-failure retries per call. */
    max_retries: z.number().int().min(0).default(2),
  })
  .passthrough();
type NodeDesignerConfig = z.infer<typeof nodeDesignerConfig>;

const RUNTIME_BUILTIN_NODE_TYPES = getBuiltinNodeDefinitions().map((definition) => definition.type);

/* -------------------------------------------------------------------------- */
/* node                                                                       */
/* -------------------------------------------------------------------------- */

export const nodeDesignerNode = defineNode({
  type: "node_designer",
  typeVersion: "1.0.0",
  title: "节点设计器（LLM·并发）",
  description:
    "针对执行计划的每个步骤并发调用 LLM，输出严格 JSON 的 NodeSpec[]：包含 nodeType/config/ports/实现策略/伪码。",
  config: nodeDesignerConfig,
  fieldMeta: {
    base_url: {
      label: "URL",
      placeholder: DEFAULT_LLM_BASE_URL_REF,
      order: 1,
    },
    api_key: {
      label: "APIKEY",
      placeholder: DEFAULT_LLM_API_KEY_REF,
      secret: true,
      order: 2,
    },
    model: { label: "Model", placeholder: DEFAULT_LLM_MODEL_REF, order: 3 },
    temperature: { label: "Temperature", order: 4 },
    max_tokens: { label: "Max Tokens", order: 5 },
    max_concurrency: { label: "最大并发", order: 6 },
    max_retries: { label: "JSON 重试次数", order: 7 },
  },
  ports: [
    {
      id: "skill_def",
      direction: "input",
      kind: "data",
      label: "SkillDefinition",
    },
    { id: "plan", direction: "input", kind: "data", label: "ExecutionPlan" },
    {
      id: "node_specs",
      direction: "output",
      kind: "data",
      label: "NodeSpec[]",
      schema: { type: "array" },
    },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const cfg = config as NodeDesignerConfig;
    const raw = input as Record<string, unknown>;
    const skill = raw.skill_def as SkillDefinition | undefined;
    const plan = raw.plan as ExecutionPlan | undefined;
    if (!skill || !plan) {
      return {
        kind: "error",
        error: {
          code: "node.node_designer.missing_input",
          message:
            "node_designer needs both `skill_def` and `plan` ports wired.",
          kind: "validation",
          category: "author",
        },
      };
    }

    const logger = {
      info: (m: string, d?: Record<string, unknown>) => ctx.log.info(m, d),
      warn: (m: string, d?: Record<string, unknown>) => ctx.log.warn(m, d),
    };

    const system = buildSystemPrompt();

    let specs: NodeSpec[];
    try {
      specs = await runWithConcurrency(
        plan.steps,
        cfg.max_concurrency,
        async (step, idx) => {
          ctx.log.info(
            `node_designer: designing step ${idx + 1}/${plan.steps.length}`,
            { stepId: step.id, kind: step.kind },
          );
          const user = buildUserPrompt(skill, plan, step);
          const designed = await chatJson({
            system,
            user,
            schema: nodeSpecSchema as z.ZodType<NodeSpec>,
            baseUrl: cfg.base_url || undefined,
            apiKey: cfg.api_key || undefined,
            model: cfg.model || undefined,
            temperature: cfg.temperature,
            maxTokens: cfg.max_tokens,
            maxRetries: cfg.max_retries,
            signal: ctx.signal,
            ctx,
            logger,
          });
          return normalizeDesignedSpec(designed, step);
        },
      );
    } catch (cause) {
      return {
        kind: "error",
        error: {
          code: "node.node_designer.llm_failed",
          message: `node_designer: ${(cause as Error).message}`,
          kind: "external",
          category: "external",
        },
      };
    }

    const specError = validateDesignedSpecs(specs);
    if (specError) {
      return {
        kind: "error",
        error: {
          code: specError.code,
          message: specError.message,
          kind: "validation",
          category: "author",
        },
      };
    }

    ctx.log.info("node_designer: all specs ready", {
      total: specs.length,
      llmNodes: specs.filter((s) => s.requiresLlm).length,
    });

    return {
      kind: "success",
      outputs: { out: null, node_specs: specs },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* prompts                                                                    */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(): string {
  return [
    "You are a senior flow node designer. Given a single step from an",
    "execution plan, produce a concrete NodeSpec that the next stage",
    "(`code_synthesizer`) can turn into real TypeScript.",
    "",
    "OUTPUT CONTRACT — return ONE JSON object, no prose, no fences:",
    "",
    "{",
    '  "stepId": string,                              // echo the input step id',
    '  "nodeType": string,                            // lower_snake_case, globally unique runtime id',
    '  "typeVersion": "1.0.0",',
    '  "title": string,                               // short Chinese label, <= 30 chars',
    '  "description": string,                         // 1-line for the node card',
    '  "configFields": [',
    "     {",
    '       "name": string,                           // lower_snake_case',
    '       "type": "string"|"number"|"boolean"|"array"|"object",',
    '       "required": boolean,',
    '       "default": any,                          // omit if no sensible default',
    '       "description": string',
    "     }",
    "  ],",
    '  "inputPorts":  [{ "id": string, "kind": "data", "direction": "input",  "label": string, "dataType": "string"|"number"|"boolean"|"object"|"array"|"any", "multiple"?: boolean }],',
    '  "outputPorts": [{ "id": string, "kind": "data"|"error", "direction": "output", "label": string, "dataType": "string"|"number"|"boolean"|"object"|"array"|"any", "multiple"?: boolean }],',
    '  "implementation": {',
    '     "strategy": "llm_prompt"|"transform"|"external_call",',
    '     "promptTemplate": string,                   // required when strategy === "llm_prompt"',
    '     "responseFormat": "text"|"json",            // required when strategy === "llm_prompt"',
    '     "transformLogic": string,                   // required when strategy === "transform"',
    '     "tool": string,                             // required when strategy === "external_call"',
    '     "callDescription": string                   // optional free-form note',
    "  },",
    '  "pseudocode": string,                          // multi-line; how run() should behave',
    '  "requiresLlm": boolean                         // true iff strategy === "llm_prompt"',
    "}",
    "",
    "HARD RULES:",
    "1. `nodeType` must be lower_snake_case and unique within the flow. Encode the skill scope in it (e.g. `<skill_name>_<step_kind>` or `<skill_name>_<step_id>`).",
    `   Do not use runtime built-in node type names for generated custom nodes: ${RUNTIME_BUILTIN_NODE_TYPES.join(", ")}.`,
    "2. Port `id` values must be lower_snake_case. Match input port ids against upstream output port ids (same name) so the assembler can wire them automatically.",
    '3. The input port matching the upstream step\'s output should reuse that name verbatim. The control "in"/"out" ports are added automatically — do NOT include them.',
    "4. Root steps (`dependencies: []`) receive the caller's original Run input implicitly. For root steps, keep `inputPorts` empty and state in pseudocode that `run()` reads `raw.__runInput__` (fallback `raw.input` / `raw.in`).",
    '5. Preserve context across the whole flow. If an upstream output named "context" is available, add an input port named "context" and use it in prompts/transforms. If this step creates or enriches shared state, add an output port named "context".',
    '6. If a step has multiple dependencies and consumes shared context, set the "context" input port to `multiple: true` and merge the resulting array in pseudocode.',
    "7. LLM prompt templates must include every upstream value needed by the model. Use `${input.context}` for cumulative context and `${input.<port>}` for specific values.",
    '8. Pick the `implementation.strategy` honestly:',
    '   - "llm_prompt"   when the step\'s value comes from a model call.',
    '         You MUST provide `promptTemplate` (use `${input.fieldName}` placeholders) and `responseFormat`.',
    '         Set requiresLlm: true.',
    '   - "transform"    when the run() function can be written in pure TS without IO.',
    '         You MUST provide `transformLogic` describing the algorithm.',
    '         Set requiresLlm: false.',
    '   - "external_call" when the step calls an HTTP / MCP / shell tool.',
    '         You MUST provide `tool` (one of the allowed-tools) and `callDescription`.',
    '         Set requiresLlm: false.',
    "9. Pseudocode must be precise enough for another model to generate the run() body without ambiguity, including exactly how context is read, merged, and emitted.",
    "10. Output JSON only.",
  ].join("\n");
}

function buildUserPrompt(
  skill: SkillDefinition,
  plan: ExecutionPlan,
  step: PlanStep,
): string {
  // Collect upstream output ports so the model can name inputs consistently.
  const upstreamCatalog = plan.steps
    .filter((s) => step.dependencies.includes(s.id))
    .flatMap((s) =>
      s.outputs.map((o) => `${s.id}.${o.name} (${o.dataType}) — ${o.description}`),
    );

  return [
    `# CONTEXT`,
    `Skill name: ${skill.name}`,
    `Skill description: ${skill.description || "(empty)"}`,
    `Allowed tools: ${skill.allowedTools.join(", ") || "(none)"}`,
    "",
    `# PLAN SUMMARY`,
    `${plan.summary}`,
    "",
    `# REQUIREMENTS`,
    formatRequirements(plan),
    "",
    `# THIS STEP`,
    `id: ${step.id}`,
    `kind: ${step.kind}`,
    `label: ${step.label}`,
    `description: ${step.description}`,
    `intent: ${step.intent}`,
    `requiredTools: ${step.requiredTools.join(", ") || "(none)"}`,
    `dependencies: ${step.dependencies.join(", ") || "(none — root)"}`,
    "",
    `## Declared inputs`,
    step.inputs.length === 0
      ? "(none — root step)"
      : step.inputs
          .map((i) => `- ${i.name} (${i.dataType}) — ${i.description}`)
          .join("\n"),
    "",
    `## Declared outputs`,
    step.outputs.length === 0
      ? "(none)"
      : step.outputs
          .map((o) => `- ${o.name} (${o.dataType}) — ${o.description}`)
          .join("\n"),
    "",
    `## Upstream outputs available to wire as inputs`,
    upstreamCatalog.length === 0
      ? "(none — depends on flow start)"
      : upstreamCatalog.map((s) => `- ${s}`).join("\n"),
    "",
    `## Runtime input rule`,
    step.dependencies.length === 0
      ? "This is a root step. Do not declare synthetic data input ports; read the original caller payload from raw.__runInput__ in pseudocode."
      : step.dependencies.length > 1
        ? "This is not a root step and it has multiple dependencies. If it consumes upstream context, declare `context` with multiple: true and merge the array in pseudocode."
        : "This is not a root step. It should consume upstream outputs through data input ports, especially a `context` object when available.",
    "",
    "Produce the JSON NodeSpec now.",
  ].join("\n");
}

function formatRequirements(plan: ExecutionPlan): string {
  const req = plan.requirements;
  if (!req) return "(none supplied)";
  return [
    `Goals: ${req.goals.length ? req.goals.join("; ") : "(none)"}`,
    `Input contract: ${
      req.inputContract.length
        ? req.inputContract
            .map((item) => `${item.name} (${item.dataType}) — ${item.description}`)
            .join("; ")
        : "(none)"
    }`,
    `Output contract: ${
      req.outputContract.length
        ? req.outputContract
            .map((item) => `${item.name} (${item.dataType}) — ${item.description}`)
            .join("; ")
        : "(none)"
    }`,
    `Acceptance criteria: ${
      req.acceptanceCriteria.length ? req.acceptanceCriteria.join("; ") : "(none)"
    }`,
    `Constraints: ${req.constraints.length ? req.constraints.join("; ") : "(none)"}`,
    `Context handoff: ${req.contextHandoff || "(none)"}`,
  ].join("\n");
}

function normalizeDesignedSpec(spec: NodeSpec, step: PlanStep): NodeSpec {
  // Pin fields that must follow the planner. The model occasionally rewrites
  // these while still producing schema-valid JSON.
  spec.stepId = step.id;
  if (shouldUseLlmPrompt(step) && spec.implementation.strategy !== "llm_prompt") {
    spec.implementation = {
      ...spec.implementation,
      strategy: "llm_prompt",
      promptTemplate:
        spec.implementation.promptTemplate ?? buildFallbackPromptTemplate(step),
      responseFormat: spec.implementation.responseFormat ?? "json",
    };
    spec.pseudocode = appendOnce(
      spec.pseudocode,
      `This ${step.kind} step is judgment-heavy; render the promptTemplate with all declared inputs and call the LLM.`,
    );
  }
  spec.requiresLlm = spec.implementation.strategy === "llm_prompt";

  if (step.dependencies.length === 0) {
    spec.inputPorts = [];
    spec.pseudocode = appendOnce(
      spec.pseudocode,
      "Root input rule: read the caller payload from raw.__runInput__; if absent, fall back to raw.input or raw.in. Do not expect a data input port from start.",
    );
    if (spec.implementation.strategy === "llm_prompt") {
      const current = spec.implementation.promptTemplate ?? "";
      if (!current.includes("__runInput__")) {
        spec.implementation.promptTemplate = appendOnce(
          current,
          "Caller runtime input: ${input.__runInput__}",
        );
      }
    }
  } else {
    for (const input of step.inputs) {
      if (spec.inputPorts.some((p) => p.id === input.name)) continue;
      spec.inputPorts.push({
        id: input.name,
        kind: "data",
        direction: "input",
        label: input.name,
        dataType: input.dataType,
      });
      spec.pseudocode = appendOnce(
        spec.pseudocode,
        `Read plan-declared input port "${input.name}" from raw.${input.name}.`,
      );
    }
    const contextInput = spec.inputPorts.find((p) => p.id === "context");
    const planConsumesContext = step.inputs.some((p) => p.name === "context");
    if (planConsumesContext && !contextInput) {
      spec.inputPorts.unshift({
        id: "context",
        kind: "data",
        direction: "input",
        label: "Context",
        dataType: "object",
        multiple: step.dependencies.length > 1,
      });
      if (step.dependencies.length > 1) {
        spec.pseudocode = appendOnce(
          spec.pseudocode,
          'If raw.context is an array, merge all context objects before applying this step.',
        );
      }
    } else if (contextInput && step.dependencies.length > 1) {
      contextInput.multiple = true;
      spec.pseudocode = appendOnce(
        spec.pseudocode,
        'If raw.context is an array, merge all context objects before applying this step.',
      );
    }
  }

  if (step.dependencies.length > 0) {
    ensureLlmPromptIncludesPlanInputs(spec, step);
  }

  for (const output of step.outputs) {
    if (spec.outputPorts.some((p) => p.id === output.name)) continue;
    spec.outputPorts.push({
      id: output.name,
      kind: "data",
      direction: "output",
      label: output.name,
      dataType: output.dataType,
    });
    spec.pseudocode = appendOnce(
      spec.pseudocode,
      `Emit plan-declared output port "${output.name}".`,
    );
  }

  const planEmitsContext = step.outputs.some((p) => p.name === "context");
  const hasContextOutput = spec.outputPorts.some((p) => p.id === "context");
  if (planEmitsContext && !hasContextOutput) {
    spec.outputPorts.unshift({
      id: "context",
      kind: "data",
      direction: "output",
      label: "Context",
      dataType: "object",
    });
    spec.pseudocode = appendOnce(
      spec.pseudocode,
      `Emit output port "context" as an object containing the previous context plus this step's result under key "${step.id}".`,
    );
  }

  return spec;
}

function validateDesignedSpecs(
  specs: readonly NodeSpec[],
): { code: string; message: string } | null {
  const reserved = new Set<string>(RUNTIME_BUILTIN_NODE_TYPES);
  const seen = new Set<string>();
  for (const spec of specs) {
    if (reserved.has(spec.nodeType)) {
      return {
        code: "node.node_designer.reserved_node_type",
        message: `node_designer: nodeType "${spec.nodeType}" is a runtime built-in. The model must pick a skill-scoped custom lower_snake_case id instead.`,
      };
    }
    if (seen.has(spec.nodeType)) {
      return {
        code: "node.node_designer.duplicate_node_type",
        message: `node_designer: duplicate nodeType "${spec.nodeType}". The model must pick a unique lower_snake_case id per step.`,
      };
    }
    seen.add(spec.nodeType);
  }
  return null;
}

function shouldUseLlmPrompt(step: PlanStep): boolean {
  if (step.requiredTools.length > 0) return false;
  return ["analyze", "llm_call", "validate", "report"].includes(step.kind);
}

function ensureLlmPromptIncludesPlanInputs(
  spec: NodeSpec,
  step: PlanStep,
): void {
  if (spec.implementation.strategy !== "llm_prompt") return;
  let promptTemplate =
    spec.implementation.promptTemplate ?? buildFallbackPromptTemplate(step);
  for (const input of step.inputs) {
    if (promptTemplate.includes(`input.${input.name}`)) continue;
    promptTemplate = appendOnce(
      promptTemplate,
      `Input ${input.name}: ${inputPlaceholder(input.name)}`,
    );
  }
  spec.implementation.promptTemplate = promptTemplate;
}

function buildFallbackPromptTemplate(step: PlanStep): string {
  const inputs =
    step.dependencies.length === 0
      ? ["- runtime_input: ${input.__runInput__}"]
      : step.inputs.map(
          (input) => `- ${input.name}: ${inputPlaceholder(input.name)}`,
        );
  const outputs = step.outputs.map((output) => output.name).join(", ") || "result";
  return [
    `Flow step: ${step.id}`,
    `Intent: ${step.intent || step.description}`,
    "Use the provided inputs and preserve any cumulative context.",
    "Inputs:",
    ...(inputs.length > 0 ? inputs : ["- none"]),
    `Return JSON with these output keys: ${outputs}.`,
  ].join("\n");
}

function inputPlaceholder(inputName: string): string {
  return `${"${input."}${inputName}${"}"}`;
}

function appendOnce(base: string, addition: string): string {
  if (base.includes(addition)) return base;
  return base.trim() ? `${base.trim()}\n\n${addition}` : addition;
}

export const __testing = {
  buildSystemPrompt,
  buildUserPrompt,
  normalizeDesignedSpec,
  runtimeBuiltinNodeTypes: RUNTIME_BUILTIN_NODE_TYPES,
  validateDesignedSpecs,
};
