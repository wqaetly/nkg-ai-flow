/**
 * `end` pseudo-node — flow exit point.
 *
 * Collects whatever flowed into its `in` control port and re-exposes
 * it under the special `result` field. The Execution Engine watches
 * for `result` on terminal nodes and writes it into the 运行Record as
 * the flow's final output.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

export const endNode = defineNode({
  type: "end",
  typeVersion: "1.0.0",
  title: "结束",
  description: "流程出口伪节点；汇总最终输出。",
  kind: "pseudo",
  ports: [
    controlIn,
    { id: "result", direction: "output", kind: "data", label: "Result" },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input as Record<string, unknown>;
    const result = raw.in ?? null;
    const summary = {
      resultType: valueType(result),
      isNull: result === null,
    };
    return {
      kind: "success",
      outputs: { result, summary },
    };
  },
});

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
