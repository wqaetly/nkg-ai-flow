/**
 * `skill_planner` — first LLM stage of the pipeline.
 *
 * Reads a `SkillDefinition` (frontmatter + body + allowedTools) and
 * asks the model to design a directed-acyclic execution plan as a
 * strict JSON object. The output is validated with `executionPlanSchema`
 * before being passed downstream — any drift / hallucination becomes a
 * node-level error rather than a cascading silent failure.
 *
 * The planner does NOT pick concrete node types or write code. It only
 * decomposes the skill into named steps with explicit kinds, intents,
 * IO contracts and dependencies. The next stage (`node_designer`) is
 * responsible for materialising each step into a NodeSpec.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import {
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
  type LlmProvider,
} from "@ai-native-flow/runtime";
import { z } from "zod";

import { chatJson } from "./_llm.js";
import {
  type ExecutionPlan,
  type SkillRequirements,
  type SkillDefinition,
  executionPlanSchema,
  skillRequirementsSchema,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

const skillPlannerConfig = z
  .object({
    /** Per-call base URL; may be a `$var:NAME` reference. */
    base_url: z.string().min(1).default(DEFAULT_LLM_BASE_URL_REF),
    /** Per-call bearer token; may be a `$var:NAME` reference. */
    api_key: z.string().min(1).default(DEFAULT_LLM_API_KEY_REF),
    /** Per-call model id; may be a `$var:NAME` reference. */
    model: z.string().min(1).default(DEFAULT_LLM_MODEL_REF),
    /** Sampling temperature; defaults to 0 for stable plans. */
    temperature: z.number().min(0).max(2).default(DEFAULT_LLM_TEMPERATURE),
    /** Maximum output tokens for each planner response. */
    max_tokens: z.number().int().min(1).max(32_000).default(DEFAULT_LLM_MAX_TOKENS),
    /** Soft caps the planner re-states in the prompt. */
    min_steps: z.number().int().min(1).default(3),
    max_steps: z.number().int().min(1).default(12),
    /** How many times the LLM may retry on schema failure. */
    max_retries: z.number().int().min(0).default(2),
  })
  .passthrough();
type SkillPlannerConfig = z.infer<typeof skillPlannerConfig>;

/* -------------------------------------------------------------------------- */
/* node                                                                       */
/* -------------------------------------------------------------------------- */

export function createSkillPlannerNode(llmProvider?: LlmProvider) {
  return defineNode({
  type: "skill_planner",
  typeVersion: "1.0.0",
  title: "Skill 规划器（LLM）",
  description:
    "使用 LLM 把 SKILL 分解为有向无环执行计划：每个步骤含 kind/intent/IO/依赖，输出严格 JSON。",
  capabilities: {
    requiredPermissions: ["network.http", "secret.read"],
  },
  config: skillPlannerConfig,
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
    model: {
      label: "Model",
      placeholder: DEFAULT_LLM_MODEL_REF,
      order: 3,
    },
    temperature: { label: "Temperature", order: 4 },
    max_tokens: { label: "Max Tokens", order: 5 },
    min_steps: { label: "最少步骤数", order: 6 },
    max_steps: { label: "最多步骤数", order: 7 },
    max_retries: { label: "JSON 校验失败重试次数", order: 8 },
  },
  ports: [
    {
      id: "skill_def",
      direction: "input",
      kind: "data",
      label: "SkillDefinition",
    },
    {
      id: "plan",
      direction: "output",
      kind: "data",
      label: "ExecutionPlan",
      schema: { type: "object" },
    },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const cfg = config as SkillPlannerConfig;
    const raw = input as Record<string, unknown>;
    const skill = raw.skill_def as SkillDefinition | undefined;
    if (cfg.max_steps < cfg.min_steps) {
      return {
        kind: "error",
        error: {
          code: "node.skill_planner.invalid_step_range",
          message:
            "skill_planner: max_steps must be greater than or equal to min_steps.",
          kind: "validation",
          category: "author",
        },
      };
    }
    if (!skill || !skill.name) {
      return {
        kind: "error",
        error: {
          code: "node.skill_planner.missing_skill",
          message:
            "skill_planner: input port `skill_def` is empty. Wire it from `skill_parser`.",
          kind: "validation",
          category: "author",
        },
      };
    }

    const system = buildSystemPrompt(cfg.min_steps, cfg.max_steps);
    const user = buildUserPrompt(skill);

    const logger = {
      info: (m: string, d?: Record<string, unknown>) => ctx.log.info(m, d),
      warn: (m: string, d?: Record<string, unknown>) => ctx.log.warn(m, d),
    };

    let plan: ExecutionPlan;
    try {
      plan = await chatJson({
        llmProvider,
        system,
        user,
        schema: executionPlanSchema as z.ZodType<ExecutionPlan>,
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
    } catch (cause) {
      return {
        kind: "error",
        error: {
          code: "node.skill_planner.llm_failed",
          message: `skill_planner: LLM call failed: ${(cause as Error).message}`,
          kind: "external",
          category: "external",
        },
      };
    }

    // Cross-check: every dependency id must exist; no self-loops; no cycles.
    const validation = validatePlanIntegrity(plan, skill, {
      minSteps: cfg.min_steps,
      maxSteps: cfg.max_steps,
    });
    if (validation.length > 0) {
      return {
        kind: "error",
        error: {
          code: "node.skill_planner.invalid_plan",
          message: `skill_planner: plan integrity check failed: ${validation.join("; ")}`,
          kind: "validation",
          category: "author",
        },
      };
    }

    // Normalise: force skillName and keep downstream prompts stable.
    plan.skillName = skill.name;
    plan.requirements = normalizeRequirements(plan.requirements, plan);

    ctx.log.info("skill_planner: plan ready", {
      steps: plan.steps.length,
      groups: plan.parallelGroups.length,
    });

    return {
      kind: "success",
      outputs: { out: null, plan },
    };
  },
  });
}

export const skillPlannerNode = createSkillPlannerNode();

/* -------------------------------------------------------------------------- */
/* prompt construction                                                        */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(minSteps: number, maxSteps: number): string {
  return [
    "You are a senior flow architect for the AI Native Flow runtime.",
    "Your job is to read a CodeBuddy SKILL.md and decompose it into a",
    "directed acyclic execution plan that can later be materialised as",
    "first-class TypeScript flow nodes.",
    "",
    "OUTPUT CONTRACT — return ONE JSON object, no prose, no fences:",
    "",
    "{",
    '  "skillName": string,           // echo the skill name',
    '  "summary": string,             // <= 200 chars; what the skill does',
    '  "requirements": {',
    '    "goals": string[],',
    '    "inputContract":  [{ "name": string, "description": string, "dataType": "string"|"number"|"boolean"|"object"|"array"|"any" }],',
    '    "outputContract": [{ "name": string, "description": string, "dataType": "string"|"number"|"boolean"|"object"|"array"|"any" }],',
    '    "acceptanceCriteria": string[],',
    '    "constraints": string[],',
    '    "contextHandoff": string',
    '  },',
    '  "steps": [                     // 3..12 atomic steps',
    "    {",
    '      "id": string,              // lower_snake_case, unique, e.g. "parse_input"',
    '      "label": string,           // short Chinese-friendly UI label',
    '      "kind": "input"|"analyze"|"execute"|"transform"|"llm_call"|"validate"|"report",',
    '      "description": string,     // 1-line what this step does',
    '      "intent": string,          // 1-3 sentences why this step exists',
    '      "requiredTools": string[], // subset of allowed-tools, may be []',
    '      "dependencies": string[],  // upstream step ids; [] = depends on start',
    '      "inputs":  [{ "name": string, "description": string, "dataType": "string"|"number"|"boolean"|"object"|"array"|"any" }],',
    '      "outputs": [{ "name": string, "description": string, "dataType": "string"|"number"|"boolean"|"object"|"array"|"any" }]',
    "    }",
    "  ],",
    '  "parallelGroups": string[][]   // optional; same-rank groups, may be []',
    "}",
    "",
    `HARD RULES:`,
    `1. Use between ${minSteps} and ${maxSteps} steps. Prefer fewer if the skill is simple.`,
    "2. `id` must be lower_snake_case and unique. Reference ids exactly in `dependencies`.",
    "3. Choose `kind` honestly:",
    '   - "input"     parse / validate user input',
    '   - "analyze"   classify or extract structure (no IO)',
    '   - "execute"   call an external tool / MCP / shell / HTTP',
    '   - "transform" deterministic data plumbing (map / filter / merge)',
    '   - "llm_call"  send a prompt to an LLM and consume the answer',
    '   - "validate"  quality gate / schema check',
    '   - "report"    produce the final user-facing output',
    "4. The graph must be acyclic. The first step has dependencies: [].",
    "5. Every output name should appear (with the same name) as an input on the step that consumes it — keep the data contracts coherent.",
    "6. requiredTools must be a subset of the skill's allowed-tools; never invent new tools.",
    "7. Do not pick concrete node types or write any code. Stay at the planning level.",
    "8. Root steps (`dependencies: []`) consume the runtime input implicitly. Do not invent a fake upstream dependency for the user's request.",
    "9. Preserve context deliberately: every non-root step must consume at least one upstream output, and LLM/report steps should receive the full upstream context needed to answer without rereading the original SKILL.md.",
    '10. Prefer a cumulative object output named "context" when several downstream steps need shared state; specific outputs are still fine for narrow values.',
    '11. For a generic SKILL.md conversion there is little deterministic work to invent. Use LLM-bearing "analyze", "llm_call", "validate", and "report" steps for judgment-heavy work; use "transform" only for simple data plumbing.',
    "12. `requirements` must capture the actual user-facing goal, flow input/output contract, acceptance criteria, constraints, and context handoff policy before decomposing steps.",
    "13. Output JSON only — no markdown, no commentary.",
  ].join("\n");
}

function buildUserPrompt(skill: SkillDefinition): string {
  const fm = skill.frontmatter ?? {};
  const tools =
    skill.allowedTools.length === 0
      ? "(none declared)"
      : skill.allowedTools.join(", ");
  return [
    `# SKILL TO PLAN`,
    "",
    `**name**: ${skill.name}`,
    `**description**: ${skill.description || "(empty)"}`,
    `**allowed-tools**: ${tools}`,
    `**context**: ${fm.context ?? "default"}`,
    `**agent**: ${fm.agent ?? "(n/a)"}`,
    `**model**: ${fm.model ?? "(default)"}`,
    "",
    "## Body (verbatim)",
    "```markdown",
    skill.body,
    "```",
    "",
    "Produce the JSON ExecutionPlan now.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* integrity check                                                            */
/* -------------------------------------------------------------------------- */

function validatePlanIntegrity(
  plan: ExecutionPlan,
  skill?: Pick<SkillDefinition, "allowedTools">,
  limits: { minSteps?: number; maxSteps?: number } = {},
): string[] {
  const errors: string[] = [];
  if (
    limits.minSteps !== undefined &&
    plan.steps.length < limits.minSteps
  ) {
    errors.push(
      `plan has ${plan.steps.length} steps, below min_steps ${limits.minSteps}`,
    );
  }
  if (
    limits.maxSteps !== undefined &&
    plan.steps.length > limits.maxSteps
  ) {
    errors.push(
      `plan has ${plan.steps.length} steps, above max_steps ${limits.maxSteps}`,
    );
  }
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      errors.push(`duplicate step id "${step.id}"`);
    }
    ids.add(step.id);
  }

  const allowedTools = new Set(skill?.allowedTools ?? []);
  for (const step of plan.steps) {
    validateStepIoNames(step, errors);
    for (const tool of step.requiredTools) {
      if (!allowedTools.has(tool)) {
        errors.push(
          `step "${step.id}" requires undeclared tool "${tool}"`,
        );
      }
    }
    for (const dep of step.dependencies) {
      if (dep === step.id) {
        errors.push(`step "${step.id}" depends on itself`);
        continue;
      }
      if (!ids.has(dep)) {
        errors.push(`step "${step.id}" depends on unknown id "${dep}"`);
      }
    }
    if (step.dependencies.length > 0 && step.inputs.length === 0) {
      errors.push(
        `step "${step.id}" depends on upstream steps but declares no inputs`,
      );
    }
  }

  const stepById = new Map(plan.steps.map((step) => [step.id, step]));
  const seenAcrossGroups = new Set<string>();
  for (const group of plan.parallelGroups) {
    const seenInGroup = new Set<string>();
    for (const id of group) {
      if (!ids.has(id)) {
        errors.push(`parallelGroups references unknown step id "${id}"`);
      }
      if (seenInGroup.has(id)) {
        errors.push(`parallelGroups contains duplicate step id "${id}"`);
      }
      seenInGroup.add(id);
      if (seenAcrossGroups.has(id)) {
        errors.push(`parallelGroups contains step id "${id}" in multiple groups`);
      }
      seenAcrossGroups.add(id);
    }

    const validGroupIds = [...seenInGroup].filter((id) => ids.has(id));
    for (let i = 0; i < validGroupIds.length; i += 1) {
      for (let j = i + 1; j < validGroupIds.length; j += 1) {
        const left = validGroupIds[i]!;
        const right = validGroupIds[j]!;
        if (
          dependsTransitively(stepById, left, right) ||
          dependsTransitively(stepById, right, left)
        ) {
          errors.push(
            `parallelGroups groups dependent steps "${left}" and "${right}"`,
          );
        }
      }
    }
  }

  for (const step of plan.steps) {
    if (step.dependencies.length === 0 || step.inputs.length === 0) continue;
    const upstreamOutputs = new Set<string>();
    const inputNames = new Set(step.inputs.map((input) => input.name));
    for (const dep of step.dependencies) {
      const upstream = stepById.get(dep);
      if (!upstream) continue;
      const depOutputs = upstream.outputs.map((output) => output.name);
      for (const outputName of depOutputs) upstreamOutputs.add(outputName);
      if (!depOutputs.some((outputName) => inputNames.has(outputName))) {
        errors.push(
          `step "${step.id}" does not consume any output from dependency "${dep}"`,
        );
      }
    }
    if (
      upstreamOutputs.size > 0 &&
      !step.inputs.some((input) => upstreamOutputs.has(input.name))
    ) {
      errors.push(
        `step "${step.id}" inputs do not match outputs from dependencies`,
      );
    }
  }

  // Cycle detection (Kahn's algorithm).
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const step of plan.steps) {
    indeg.set(step.id, 0);
    adj.set(step.id, []);
  }
  for (const step of plan.steps) {
    for (const dep of step.dependencies) {
      if (!indeg.has(dep)) continue;
      adj.get(dep)!.push(step.id);
      indeg.set(step.id, (indeg.get(step.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, d] of indeg.entries()) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    visited += 1;
    for (const next of adj.get(cur) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (visited !== plan.steps.length) {
    errors.push("plan contains a dependency cycle");
  }
  return errors;
}

function dependsTransitively(
  stepById: Map<string, ExecutionPlan["steps"][number]>,
  stepId: string,
  targetId: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(stepId)) return false;
  seen.add(stepId);
  const step = stepById.get(stepId);
  if (!step) return false;
  if (step.dependencies.includes(targetId)) return true;
  return step.dependencies.some((dep) =>
    dependsTransitively(stepById, dep, targetId, seen),
  );
}

function validateStepIoNames(
  step: ExecutionPlan["steps"][number],
  errors: string[],
): void {
  const inputNames = new Set<string>();
  for (const input of step.inputs) {
    if (!isPortId(input.name)) {
      errors.push(
        `step "${step.id}" input "${input.name}" is not a valid lower_snake_case port id`,
      );
    }
    if (inputNames.has(input.name)) {
      errors.push(`step "${step.id}" declares duplicate input "${input.name}"`);
    }
    inputNames.add(input.name);
  }

  const outputNames = new Set<string>();
  for (const output of step.outputs) {
    if (!isPortId(output.name)) {
      errors.push(
        `step "${step.id}" output "${output.name}" is not a valid lower_snake_case port id`,
      );
    }
    if (outputNames.has(output.name)) {
      errors.push(`step "${step.id}" declares duplicate output "${output.name}"`);
    }
    outputNames.add(output.name);
  }
}

function isPortId(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

function normalizeRequirements(
  requirements: ExecutionPlan["requirements"],
  plan?: Pick<ExecutionPlan, "summary" | "steps">,
): SkillRequirements {
  const normalized = skillRequirementsSchema.parse(requirements ?? {});
  if (!plan) return normalized;

  if (normalized.goals.length === 0 && plan.summary.trim()) {
    normalized.goals = [plan.summary.trim()];
  }
  if (normalized.inputContract.length === 0) {
    normalized.inputContract = deriveInputContract(plan);
  }
  if (normalized.outputContract.length === 0) {
    normalized.outputContract = deriveOutputContract(plan);
  }
  if (normalized.acceptanceCriteria.length === 0) {
    normalized.acceptanceCriteria = [
      "The generated flow validates successfully and produces the declared output contract.",
    ];
  }
  if (!normalized.contextHandoff.trim()) {
    normalized.contextHandoff =
      "Root steps consume the runtime __runInput__; downstream steps consume upstream outputs and preserve cumulative context when a context object is present.";
  }
  return normalized;
}

function deriveInputContract(
  plan: Pick<ExecutionPlan, "steps">,
): SkillRequirements["inputContract"] {
  const rootInputs = plan.steps
    .filter((step) => step.dependencies.length === 0)
    .flatMap((step) => step.inputs);
  const inputs =
    rootInputs.length > 0
      ? rootInputs
      : [
          {
            name: "input",
            description: "Runtime input passed to the generated flow.",
            dataType: "object" as const,
          },
        ];
  return dedupeIoByName(inputs);
}

function deriveOutputContract(
  plan: Pick<ExecutionPlan, "steps">,
): SkillRequirements["outputContract"] {
  const dependedOn = new Set<string>();
  for (const step of plan.steps) {
    for (const dep of step.dependencies) dependedOn.add(dep);
  }
  return dedupeIoByName(
    plan.steps
      .filter((step) => !dependedOn.has(step.id))
      .flatMap((step) => step.outputs),
  );
}

function dedupeIoByName<T extends { name: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
}

export const __testing = {
  buildSystemPrompt,
  normalizeRequirements,
  validatePlanIntegrity,
};
