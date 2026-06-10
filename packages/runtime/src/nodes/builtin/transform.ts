/**
 * `transform` — pure data transformation.
 *
 * Phase 1 supports three config shapes:
 *
 *   - `{ template: "...${input.field}..." }`   string template
 *   - `{ expression: "`...${input.field}...`" }` back-ticked template literal
 *                                              (so `defineFlow` examples can
 *                                              author plain JS template
 *                                              strings without leaving JSON)
 *   - `{ value: <any> }`                       static replacement value
 *
 * A real expression evaluator (jsonata, jmespath, JS sandbox) lands in
 * Phase 3 alongside the sandboxed Node Logic Provider.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { renderTemplate } from "./_helpers.js";

const transformConfig = z
  .object({
    template: z
      .string()
      .optional()
      .describe("String template; use `${input.field}` placeholders."),
    expression: z
      .string()
      .optional()
      .describe("Back-ticked template literal alternative."),
    value: z
      .unknown()
      .optional()
      .describe("Static replacement value (any JSON)."),
  })
  .passthrough();

export const transformNode = defineNode({
  type: "transform",
  typeVersion: "1.0.0",
  title: "Transform",
  description: "Pure data transformation.",
  config: transformConfig,
  fieldMeta: {
    template: { label: "Template", control: "textarea", order: 1 },
    expression: { label: "Expression", control: "input", order: 2 },
    value: { label: "Static Value", control: "json", order: 3 },
  },
  ports: [
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "output", direction: "output", kind: "data", label: "Output" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const { template, expression, value } = config;
    let output: unknown;
    if (typeof template === "string") {
      output = renderTemplate(template, raw);
    } else if (typeof expression === "string") {
      // Strip an outer pair of backticks if the author wrote a JS
      // template literal in JSON (`"\`Hello, ${input.name}\`"`).
      const stripped =
        expression.startsWith("`") && expression.endsWith("`")
          ? expression.slice(1, -1)
          : expression;
      output = renderTemplate(stripped, raw);
    } else if (value !== undefined) {
      output = value;
    } else {
      output = raw.input ?? raw.in ?? null;
    }
    ctx.log.debug("transform produced output", {
      hasTemplate:
        typeof template === "string" || typeof expression === "string",
    });
    return {
      kind: "success",
      outputs: { out: null, output },
    };
  },
});
