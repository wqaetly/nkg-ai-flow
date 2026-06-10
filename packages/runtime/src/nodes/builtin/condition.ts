/**
 * `condition` — boolean router.
 *
 * Phase 1 evaluates `config.expression` against `input` via the tiny
 * safe evaluator in `_helpers.evaluateCondition`: equality, presence,
 * and boolean negation, no arbitrary JS. Anything more advanced waits
 * for the Phase 3 Sandbox.
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
        "Boolean expression evaluated against input (`==`, `!=`, `!`, presence).",
      ),
  })
  .passthrough();

export const conditionNode = defineNode({
  type: "condition",
  typeVersion: "1.0.0",
  title: "Condition",
  description: "Boolean condition routing to true / false branches.",
  kind: "pseudo",
  config: conditionConfig,
  fieldMeta: {
    expression: {
      label: "Expression",
      control: "input",
      placeholder: "input.text == 'ok'",
    },
  },
  ports: [
    controlIn,
    { id: "true", direction: "output", kind: "control", label: "True" },
    { id: "false", direction: "output", kind: "control", label: "False" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const expression = config.expression ?? "";
    const truthy = evaluateCondition(expression, raw);
    ctx.log.debug("condition evaluated", { expression, truthy });
    return {
      kind: "success",
      outputs: truthy ? { true: null } : { false: null },
    };
  },
});
