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

import { skillParserNode } from "./skillParser.js";
import { skillPlannerNode } from "./skillPlanner.js";
import { nodeDesignerNode } from "./nodeDesigner.js";
import { codeSynthesizerNode } from "./codeSynthesizer.js";
import { flowValidatorNode } from "./flowValidator.js";

export {
  skillParserNode,
  skillPlannerNode,
  nodeDesignerNode,
  codeSynthesizerNode,
  flowValidatorNode,
};

/**
 * Default export — a factory the sidecar calls with shared deps.
 * Every node in this pack reads its LLM config from the standard
 * variable / secret stores, so the factory takes no arguments.
 */
export default function createNodes(
  _deps: Record<string, unknown> = {},
): DefinedNode[] {
  return [
    skillParserNode,
    skillPlannerNode,
    nodeDesignerNode,
    codeSynthesizerNode,
    flowValidatorNode,
  ];
}
