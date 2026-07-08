/**
 * `start` pseudo-node — flow entry point.
 *
 * The Execution Engine seeds `runInput` from the 运行Record; we surface
 * it back on the `runInput` data slot so downstream nodes can read it
 * by destructuring the engine-provided input object. The control wire
 * out of `out` carries no payload, only the activation signal.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { controlOut } from "./_helpers.js";

export const startNode = defineNode({
  type: "start",
  typeVersion: "1.0.0",
  title: "开始",
  description: "流程入口伪节点。",
  kind: "pseudo",
  ports: [
    controlOut,
    {
      id: "runInput",
      direction: "output",
      kind: "data",
      label: "Run input",
    },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input as Record<string, unknown>;
    return {
      kind: "success",
      outputs: { out: null, runInput: raw.runInput ?? null },
    };
  },
});
