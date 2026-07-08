/**
 * `map_items` — array mapping data-flow node.
 *
 * Applies a string template or safe expression to every item with
 * `{ item, index, input, items, count }` in scope. This keeps the node
 * deterministic and safe while covering common projection workflows.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { evaluateExpression, renderTemplate } from "./_helpers.js";

const mapItemsConfig = z
  .object({
    template: z
      .string()
      .default("${item}")
      .describe("Template rendered once per item. Example: ${index}:${item.name}."),
    expression: z
      .string()
      .optional()
      .describe("Safe expression evaluated once per item; overrides template when provided."),
  })
  .passthrough();

export const mapItemsNode = defineNode({
  type: "map_items",
  typeVersion: "1.0.0",
  title: "Map Items",
  description: "Maps an array by rendering a template for each item.",
  config: mapItemsConfig,
  fieldMeta: {
    template: {
      label: "Template",
      control: "textarea",
      placeholder: "${index}:${item.name}",
      order: 1,
    },
    expression: {
      label: "Expression",
      control: "input",
      placeholder: "upper(item.name)",
      order: 2,
    },
  },
  ports: [
    {
      id: "items",
      direction: "input",
      kind: "data",
      label: "Items",
      schema: { type: "array" },
    },
    { id: "template", direction: "input", kind: "data", label: "Template", schema: { type: "string" } },
    { id: "expression", direction: "input", kind: "data", label: "Expression", schema: { type: "string" } },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Mapped items",
      schema: { type: "array" },
    },
    { id: "template", direction: "output", kind: "data", label: "Template", schema: { type: "string" } },
    { id: "expression", direction: "output", kind: "data", label: "Expression", schema: { type: "string" } },
    { id: "usedExpression", direction: "output", kind: "data", label: "Used expression", schema: { type: "boolean" } },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const template = String(input.template ?? config.template ?? "${item}");
    const expression = typeof (input.expression ?? config.expression) === "string"
      ? String(input.expression ?? config.expression).trim()
      : "";
    const usedExpression = expression.length > 0;
    const items = source.map((item, index) => {
      const scope = {
        item,
        index,
        input: item,
        items: source,
        count: source.length,
      };
      return usedExpression
        ? evaluateExpression(expression, scope)
        : renderTemplate(template, scope);
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        template,
        expression,
        usedExpression,
        count: items.length,
      },
    };
  },
});
