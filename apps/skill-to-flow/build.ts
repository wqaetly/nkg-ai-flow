/**
 * Build script for the skill-to-flow conversion pipeline.
 *
 * Topology (rules-flanked LLM core plus agent materialization):
 *
 *   start
 *     ▼ control
 *   skill_parser            (rules)
 *     ▼ data: skill_def
 *   skill_planner           (LLM)
 *     ▼ data: plan
 *   node_designer           (LLM, parallel)
 *     ▼ data: node_specs
 *   code_synthesizer        (LLM, parallel) — also assembles flow JSON
 *     ▼ data: package
 *   flow_validator          (rules; uses @ai-native-flow/flow-validator)
 *     ▼ data: artifact
 *   package_materializer    (agent; writes files + runs verification)
 *     ▼ control
 *   end
 *
 * Run with: tsx build.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineFlow,
  type FlowBuilder,
} from "@ai-native-flow/flow-builder";
import {
  createDefaultRegistry,
  type InMemoryNodeTypeRegistry,
} from "@ai-native-flow/flow-ir";
import { installNode } from "@ai-native-flow/node-sdk";
import {
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
  getBuiltinNodeDefinitions,
} from "@ai-native-flow/runtime";

import { skillParserNode } from "./nodes/skillParser.js";
import { skillPlannerNode } from "./nodes/skillPlanner.js";
import { nodeDesignerNode } from "./nodes/nodeDesigner.js";
import { codeSynthesizerNode } from "./nodes/codeSynthesizer.js";
import { flowValidatorNode } from "./nodes/flowValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export function buildSkillToFlowRegistry(): InMemoryNodeTypeRegistry {
  const registry = createDefaultRegistry();
  for (const def of getBuiltinNodeDefinitions()) {
    if (!registry.has(def.type, def.typeVersion)) registry.register(def);
  }
  for (const node of [
    skillParserNode,
    skillPlannerNode,
    nodeDesignerNode,
    codeSynthesizerNode,
    flowValidatorNode,
  ]) {
    installNode(
      {
        registerType: (def, capabilities) => registry.register(def, capabilities),
        registerRunner: () => undefined,
      },
      node,
    );
  }
  return registry;
}

/* -------------------------------------------------------------------------- */
/* Flow construction                                                          */
/* -------------------------------------------------------------------------- */

export function buildSkillToFlowFlow(): FlowBuilder {
  const registry = buildSkillToFlowRegistry();
  const flow = defineFlow({
    id: "skill_to_flow",
    version: "1.0.0",
    label: "Skill 转 Flow（LLM 驱动）",
    description:
      "将 CodeBuddy SKILL.md 转为可执行 Flow 包：解析 → LLM 规划 → LLM 设计 → LLM 合成 → 真校验 → Agent 物化。",
    inputSchema: { type: "object" },
    registry,
  });

  /* -- Pseudo-nodes ------------------------------------------------------- */

  const start = flow.node("start", {
    id: "node_start",
    label: "Start",
    position: { x: -200, y: 0 },
  });
  const end = flow.node("end", {
    id: "node_end",
    label: "End",
    position: { x: 2750, y: 0 },
  });

  /* -- Pipeline nodes ----------------------------------------------------- */

  const parser = flow.node("skill_parser", {
    id: "skill_parser",
    label: "Skill 解析器（规则）",
    position: { x: 100, y: 0 },
    config: {
      default_name: "unnamed-skill",
      max_body_length: 100_000,
    },
  });

  const planner = flow.node("skill_planner", {
    id: "skill_planner",
    label: "Skill 规划器（LLM）",
    position: { x: 450, y: 0 },
    config: {
      base_url: DEFAULT_LLM_BASE_URL_REF,
      api_key: DEFAULT_LLM_API_KEY_REF,
      model: DEFAULT_LLM_MODEL_REF,
      temperature: DEFAULT_LLM_TEMPERATURE,
      max_tokens: DEFAULT_LLM_MAX_TOKENS,
      min_steps: 3,
      max_steps: 12,
      max_retries: 2,
    },
  });

  const designer = flow.node("node_designer", {
    id: "node_designer",
    label: "节点设计器（LLM·并发）",
    position: { x: 800, y: 0 },
    config: {
      base_url: DEFAULT_LLM_BASE_URL_REF,
      api_key: DEFAULT_LLM_API_KEY_REF,
      model: DEFAULT_LLM_MODEL_REF,
      temperature: DEFAULT_LLM_TEMPERATURE,
      max_tokens: DEFAULT_LLM_MAX_TOKENS,
      max_concurrency: 3,
      max_retries: 2,
    },
  });

  const synthesizer = flow.node("code_synthesizer", {
    id: "code_synthesizer",
    label: "代码合成器（LLM·并发）",
    position: { x: 1150, y: 0 },
    config: {
      base_url: DEFAULT_LLM_BASE_URL_REF,
      api_key: DEFAULT_LLM_API_KEY_REF,
      model: DEFAULT_LLM_MODEL_REF,
      temperature: DEFAULT_LLM_TEMPERATURE,
      max_tokens: DEFAULT_LLM_MAX_TOKENS,
      max_concurrency: 3,
      max_retries: 2,
      package_scope: "@ai-native-flow",
      flow_version: "1.0.0",
    },
  });

  const validator = flow.node("flow_validator", {
    id: "flow_validator",
    label: "Flow 验证器（规则）",
    position: { x: 1500, y: 0 },
    config: {
      strict: false,
      lint_sources: true,
    },
  });

  const outputDir = flow.node("transform", {
    id: "output_dir",
    label: "输出目录解析",
    position: { x: 1500, y: 300 },
    config: {
      template: "${input.output_dir}",
    },
  });

  const materializeTask = flow.node("text_input", {
    id: "materialize_task",
    label: "物化任务说明",
    position: { x: 1850, y: 260 },
    config: {
      value: [
        "Materialize the generated Flow package from context.package.",
        "First inspect context.isValid, context.errors, context.warnings, and context.fileIssues. Treat validation errors, warnings, and fileIssues as repair context, not as text to ignore.",
        "Also inspect context.requirements before writing files. Preserve the original goals, input/output contract, acceptance criteria, constraints, and context handoff policy in the generated package; use them to judge whether verification failures need code repair or model-owned unresolved_errors.",
        "Use context.materializationPlan.files as the ordered write checklist.",
        "Prefer one write_files call with files_ref=\"materializationPlan.files\" and create=true to write the whole package.",
        "If context.fileIssues is non-empty, or context.warnings contains lint.unsafe_file_path, lint.duplicate_file_path, lint.non_posix_file_path, or lint.directory_file_path, do not use files_ref directly; instead call write_files with an explicit files array that chooses safe unique POSIX-style package-relative file paths while preserving each entry's contentsRef.",
        "For surgical repairs after verification, use edit_file with path_ref/new_text_ref refs instead of pasting large source into new_text.",
        "Use create=true and stay under working_dir.",
        "After writing files, run each command in context.materializationPlan.verifyCommands in order when possible, such as `npx tsx build.ts` for graph validation and `npm run typecheck --if-present` for generated TypeScript.",
        "If verification fails, use the command observation plus context.errors/context.warnings to edit files and retry within maxSteps.",
        "Finish with a final summary and only include model-owned repair notes in final context, such as unresolved_errors when semantic errors remain after your edits.",
        "Do not guess or hand-write changed_files, written_files, verification_results, or validator_status; the runtime agent fills those fields from real tool logs and the input FlowArtifact.",
        "Downstream nodes expect the exact runtime-owned field names changed_files, written_files, verification_results, validator_status, and unresolved_errors; never rename verification_results to verification.",
      ].join("\n"),
    },
  });

  const materializer = flow.node("agent", {
    id: "package_materializer",
    label: "包物化 Agent（文件+Bash）",
    position: { x: 2200, y: 0 },
    config: {
      baseUrl: DEFAULT_LLM_BASE_URL_REF,
      apiKey: DEFAULT_LLM_API_KEY_REF,
      model: DEFAULT_LLM_MODEL_REF,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      maxSteps: 30,
      workingDir: "./generated/skill-to-flow-output",
      allowBash: true,
      allowedTools: [
        "list_files",
        "read_file",
        "grep",
        "edit_file",
        "write_files",
        "run_bash",
      ],
      timeoutMs: 30_000,
      maxOutputChars: 40_000,
      systemPrompt:
        "You are a terse build agent. Use tools to write generated files and verify the package. Stay inside working_dir.",
    },
  });

  /* -- Edges -------------------------------------------------------------- */

  // Control: start → parser
  flow.connect(start.out("out"), parser.in("in"));

  // Data: parser → planner (skill_def)
  flow.connect(parser.out("skill_def"), planner.in("skill_def"));

  // Data fan-out: parser → designer (skill_def)
  //               planner → designer (plan)
  flow.connect(parser.out("skill_def"), designer.in("skill_def"));
  flow.connect(planner.out("plan"), designer.in("plan"));

  // Data fan-out: parser → synthesizer (skill_def)
  //               planner → synthesizer (plan)
  //               designer → synthesizer (node_specs)
  flow.connect(parser.out("skill_def"), synthesizer.in("skill_def"));
  flow.connect(planner.out("plan"), synthesizer.in("plan"));
  flow.connect(designer.out("node_specs"), synthesizer.in("node_specs"));

  // Data: synthesizer → validator (package)
  //       designer → validator (node_specs)
  flow.connect(synthesizer.out("package"), validator.in("package"));
  flow.connect(designer.out("node_specs"), validator.in("node_specs"));

  // Data: run input → output_dir transform → materializer.working_dir
  flow.connect(start.out("runInput"), outputDir.in("input"));
  flow.connect(outputDir.out("output"), materializer.in("working_dir"));

  // Data: validator artifact + static task → materializer.
  flow.connect(validator.out("artifact"), materializer.in("context"));
  flow.connect(materializeTask.out("text"), materializer.in("task"));

  // Control: validator → task prompt → materializer → end
  flow.connect(validator.out("out"), materializeTask.in("in"));
  flow.connect(materializeTask.out("out"), materializer.in("in"));
  flow.connect(materializer.out("out"), end.in("in"));

  return flow;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const FLOW_JSON_PATH = path.join(__dirname, "flows", "skill-to-flow.json");

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("build.ts")
) {
  const flow = buildSkillToFlowFlow();
  const json = flow.dump();
  mkdirSync(path.dirname(FLOW_JSON_PATH), { recursive: true });
  writeFileSync(FLOW_JSON_PATH, `${json}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${FLOW_JSON_PATH} (${json.length} bytes)`);
}
