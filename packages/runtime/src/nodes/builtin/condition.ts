/**
 * `condition` — boolean router.
 *
 * Evaluates `config.expression` against `input` via the small safe
 * expression grammar in `_helpers.evaluateCondition`: comparisons,
 * boolean composition, presence checks, and allowlisted helper calls.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn, evaluateCondition } from "./_helpers.js";

const conditionConfig = z
  .object({
    expression: z
      .string()
      .default("")
      .describe(
        "Boolean expression evaluated against input (`==`, `!=`, `>`, `>=`, `&&`, `||`, `!`, helpers).",
      ),
  })
  .passthrough();

export const conditionNode = defineNode({
  type: "condition",
  typeVersion: "1.0.0",
  title: "条件判断",
  description: "按布尔条件路由到是/否分支。",
  kind: "pseudo",
  config: conditionConfig,
  fieldMeta: {
    expression: {
      label: "表达式",
      control: "input",
      placeholder: "input.text == 'ok'",
    },
  },
  ports: [
    controlIn,
    { id: "input", direction: "input", kind: "data", label: "输入" },
    { id: "expression", direction: "input", kind: "data", label: "表达式", schema: { type: "string" } },
    { id: "true", direction: "output", kind: "control", label: "是" },
    { id: "false", direction: "output", kind: "control", label: "否" },
    { id: "input", direction: "output", kind: "data", label: "输入" },
    { id: "expression", direction: "output", kind: "data", label: "表达式", schema: { type: "string" } },
    { id: "result", direction: "output", kind: "data", label: "结果", schema: { type: "boolean" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const expression = String(raw.expression ?? config.expression ?? "");
    const truthy = evaluateCondition(expression, raw);
    const status = truthy ? "true" : "false";
    const value = raw.input ?? null;
    const summary = { expression, result: truthy, status, selectedBranch: status, input: value };
    ctx.log.debug("condition evaluated", summary);
    return {
      kind: "success",
      outputs: truthy
        ? { true: null, input: value, expression, result: truthy, status, summary }
        : { false: null, input: value, expression, result: truthy, status, summary },
    };
  },
});
