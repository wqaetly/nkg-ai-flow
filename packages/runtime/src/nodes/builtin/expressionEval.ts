/**
 * `expression_eval` - safe expression projection.
 *
 * Evaluates the shared built-in expression grammar against incoming data
 * and emits both the raw result and a boolean view for downstream gates.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { evaluateExpression } from "./_helpers.js";

const expressionEvalConfig = z
  .object({
    expression: z
      .string()
      .default("input")
      .describe("Expression evaluated against input data."),
  })
  .passthrough();

export const expressionEvalNode = defineNode({
  type: "expression_eval",
  typeVersion: "1.0.0",
  title: "Expression Eval",
  description: "Evaluates a safe expression against incoming data.",
  config: expressionEvalConfig,
  fieldMeta: {
    expression: {
      label: "Expression",
      control: "input",
      placeholder: "input.amount >= 10 && input.status == 'ready'",
      order: 1,
    },
  },
  ports: [
    {
      id: "input",
      direction: "input",
      kind: "data",
      label: "Input",
    },
    {
      id: "result",
      direction: "output",
      kind: "data",
      label: "Result",
    },
    {
      id: "truthy",
      direction: "output",
      kind: "data",
      label: "Truthy",
      schema: { type: "boolean" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const expression = String(config.expression ?? "input");
    const result = evaluateExpression(expression, input as Record<string, unknown>);
    const truthy = Boolean(result);

    ctx.log.debug("expression_eval evaluated expression", {
      expression,
      truthy,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        result,
        truthy,
      },
    };
  },
});
