/**
 * `concat_items` - concatenate multiple item arrays.
 *
 * Useful after parallel branches, search fan-out, or multiple upstream tools
 * each produce arrays that should continue as one ordered item stream.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const concatItemsConfig = z
  .object({
    includeScalars: z
      .boolean()
      .default(true)
      .describe("Whether non-array inputs are appended as single items."),
  })
  .passthrough();

export const concatItemsNode = defineNode({
  type: "concat_items",
  typeVersion: "1.0.0",
  title: "Concat Items",
  description: "Concatenates arrays from one or more upstream sources.",
  config: concatItemsConfig,
  fieldMeta: {
    includeScalars: {
      label: "Include Scalars",
      control: "switch",
      order: 1,
    },
  },
  ports: [
    {
      id: "items",
      direction: "input",
      kind: "data",
      label: "Items",
      multiple: true,
      schema: { type: "array" },
    },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Concatenated items",
      schema: { type: "array" },
    },
    {
      id: "sources",
      direction: "output",
      kind: "data",
      label: "Sources",
      schema: { type: "array" },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
    {
      id: "sourceCount",
      direction: "output",
      kind: "data",
      label: "Source count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const sources = normalizeSources(input.items ?? input.input);
    const includeScalars = config.includeScalars !== false;
    const items = concatSources(sources, includeScalars);

    ctx.log.debug("concat_items concatenated sources", {
      count: items.length,
      sourceCount: sources.length,
      includeScalars,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        sources,
        count: items.length,
        sourceCount: sources.length,
      },
    };
  },
});

function normalizeSources(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function concatSources(sources: unknown[], includeScalars: boolean): unknown[] {
  const items: unknown[] = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      items.push(...source);
    } else if (includeScalars && source !== undefined) {
      items.push(source);
    }
  }
  return items;
}
