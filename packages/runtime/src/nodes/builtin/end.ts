/**
 * `end` pseudo-node — flow exit point.
 *
 * Collects whatever flowed into its `in` control port and re-exposes
 * it under the special `result` field. The Execution Engine watches
 * for `result` on terminal nodes and writes it into the RunRecord as
 * the flow's final output.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

export const endNode = defineNode({
  type: "end",
  typeVersion: "1.0.0",
  title: "End",
  description: "Flow exit pseudo-node; aggregates final output.",
  kind: "pseudo",
  ports: [controlIn],
  validateInput: false,
  run({ input }) {
    const raw = input as Record<string, unknown>;
    return {
      kind: "success",
      outputs: { result: raw.in ?? null },
    };
  },
});
