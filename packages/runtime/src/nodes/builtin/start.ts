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
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input as Record<string, unknown>;
    const runInput = raw.runInput ?? null;
    const summary = {
      inputType: valueType(runInput),
      isNull: runInput === null,
      keyCount: keyCount(runInput),
    };
    return {
      kind: "success",
      outputs: { out: null, runInput, summary },
    };
  },
});

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function keyCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value).length;
}
