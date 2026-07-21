/**
 * Node-pack entry for the `skill-to-flow` conversion pipeline.
 *
 * Loaded by the Studio sidecar via `apps/skill-to-flow/anf.app.json`:
 *
 *   {
 *     "nodePacks": ["nodes/index.ts"]
 *   }
 *
 * The 5 nodes here form the conversion pipeline itself, NOT the flow
 * that the pipeline emits. The pipeline takes a SKILL.md and produces
 * a `GeneratedFlowPackage` (custom TS nodes + flow JSON + build /
 * runtime scripts) that the user drops into a new `apps/<skill>/`.
 */

import type { DefinedNode } from "@ai-native-flow/node-sdk";
import type { LlmProvider } from "@ai-native-flow/runtime";

import { createSkillParserNode, skillParserNode, type SkillParserDeps } from "./skillParser.js";
import { createSkillPlannerNode, skillPlannerNode } from "./skillPlanner.js";
import { createNodeDesignerNode, nodeDesignerNode } from "./nodeDesigner.js";
import { createCodeSynthesizerNode, codeSynthesizerNode } from "./codeSynthesizer.js";
import { flowValidatorNode } from "./flowValidator.js";

export {
  skillParserNode,
  skillPlannerNode,
  nodeDesignerNode,
  codeSynthesizerNode,
  flowValidatorNode,
  createSkillPlannerNode,
  createNodeDesignerNode,
  createCodeSynthesizerNode,
  createSkillParserNode,
};

/**
 * Default export — a factory the sidecar calls with shared deps.
 * Every node in this pack reads its LLM config from the standard
 * variable / secret stores, so the factory takes no arguments.
 */
export default function createNodes(
  deps: { llmProvider?: LlmProvider } & SkillParserDeps = {},
): DefinedNode[] {
  return [
    createSkillParserNode(deps),
    createSkillPlannerNode(deps.llmProvider),
    createNodeDesignerNode(deps.llmProvider),
    createCodeSynthesizerNode(deps.llmProvider),
    flowValidatorNode,
  ];
}
