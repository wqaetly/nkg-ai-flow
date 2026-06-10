/**
 * Shared runtime factory for the skill-to-flow conversion pipeline.
 *
 * Wires the default Runtime with the 5 pipeline nodes installed and
 * registers the `skill_to_flow` flow as the active version.
 *
 * The pipeline reads its LLM endpoint from VariableStore entries:
 * `LLM_BASE_URL`, `LLM_DEFAULT_MODEL`, and
 * `LLM_API_KEY`. Callers pass stores into this factory or install
 * process-wide defaults before launch. This app does not auto-load,
 * synthesize, or fallback-fill missing LLM configuration.
 *
 * Any OpenAI-compatible endpoint works (OpenAI, DeepSeek, vLLM,
 * private reverse-proxies, etc.).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntime, type Runtime } from "@ai-native-flow/runtime";
import type {
  SecretStore,
  VariableStore,
} from "@ai-native-flow/variable-store";
import type { FlowGraph } from "@ai-native-flow/flow-ir";

import { skillParserNode } from "./nodes/skillParser.js";
import { skillPlannerNode } from "./nodes/skillPlanner.js";
import { nodeDesignerNode } from "./nodes/nodeDesigner.js";
import { codeSynthesizerNode } from "./nodes/codeSynthesizer.js";
import { flowValidatorNode } from "./nodes/flowValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FLOW_ID = "skill_to_flow";
export const FLOW_VERSION = "1.0.0";
export const FLOW_JSON_PATH = path.join(
  __dirname,
  "flows",
  "skill-to-flow.json",
);

export interface CreateSkillToFlowRuntimeOptions {
  /** Skip auto-loading and registering the bundled Flow JSON. */
  skipFlowRegistration?: boolean;
  /** Explicit variable store containing entries such as `LLM_BASE_URL`. */
  variables?: VariableStore;
  /** @deprecated Use `variables`; treated as the same store. */
  secrets?: SecretStore;
}

/**
 * Build a Runtime + register the bundled flow + promote it to active.
 */
export async function createSkillToFlowRuntime(
  options: CreateSkillToFlowRuntimeOptions = {},
): Promise<Runtime> {
  const runtime = createRuntime({
    variables: options.variables,
    secrets: options.secrets,
    nodes: [
      skillParserNode,
      skillPlannerNode,
      nodeDesignerNode,
      codeSynthesizerNode,
      flowValidatorNode,
    ],
  });

  if (!options.skipFlowRegistration) {
    const json = readFileSync(FLOW_JSON_PATH, "utf8");
    const graph: FlowGraph = JSON.parse(json);
    await runtime.registry.register({ graph, json });
    await runtime.registry.promote(graph.id, graph.version);
  }

  return runtime;
}

/* CLI bin shim */
export { createSkillToFlowRuntime as createRuntime };

