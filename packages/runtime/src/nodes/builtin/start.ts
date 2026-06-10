/**
 * `start` pseudo-node — flow entry point.
 *
 * The Execution Engine seeds `runInput` from the RunRecord; we surface
 * it back on the `runInput` data slot so downstream nodes can read it
 * by destructuring the engine-provided input object. The control wire
 * out of `out` carries no payload, only the activation signal.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { controlOut } from "./_helpers.js";

export const startNode = defineNode({
  type: "start",
  typeVersion: "1.0.0",
  title: "Start",
  description: "Flow entry pseudo-node.",
  kind: "pseudo",
  ports: [controlOut],
  validateInput: false,
  run({ input }) {
    const raw = input as Record<string, unknown>;
    return {
      kind: "success",
      outputs: { out: null, runInput: raw.runInput ?? null },
    };
  },
});
