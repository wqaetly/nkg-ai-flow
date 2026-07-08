/**
 * `map_items` — array mapping data-flow node.
 *
 * Applies a string template to every item with `{ item, index, input }`
 * in scope. This keeps the node deterministic and safe while covering
 * common formatting / projection workflows.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { renderTemplate } from "./_helpers.js";

const mapItemsConfig = z
  .object({
    template: z
      .string()
      .default("${item}")
      .describe("Template rendered once per item. Example: ${index}:${item.name}."),
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
  },
  ports: [
    {
      id: "items",
      direction: "input",
      kind: "data",
      label: "Items",
      schema: { type: "array" },
    },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Mapped items",
      schema: { type: "array" },
    },
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
    const template = String(config.template ?? "${item}");
    const items = source.map((item, index) =>
      renderTemplate(template, { item, index, input: item }),
    );

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        count: items.length,
      },
    };
  },
});
