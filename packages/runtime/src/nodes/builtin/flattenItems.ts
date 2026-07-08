/**
 * `flatten_items` - deterministic array flattening.
 *
 * Useful after grouping, batching, or collecting nested search results when
 * downstream flow nodes expect a single flat item stream.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

const flattenItemsConfig = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Optional dotted path read from each top-level item before flattening."),
    depth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Maximum flatten depth."),
    includeNulls: z
      .boolean()
      .default(true)
      .describe("Whether null and undefined values are kept in the output."),
  })
  .passthrough();

export const flattenItemsNode = defineNode({
  type: "flatten_items",
  typeVersion: "1.0.0",
  title: "Flatten Items",
  description: "Flattens nested arrays into a single item array.",
  config: flattenItemsConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "items",
      order: 1,
    },
    depth: {
      label: "Depth",
      control: "number",
      order: 2,
    },
    includeNulls: {
      label: "Include Nulls",
      control: "switch",
      order: 3,
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
      label: "Flattened items",
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
      id: "inputCount",
      direction: "output",
      kind: "data",
      label: "Input count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const path = String(config.path ?? "");
    const depth = Math.max(1, Math.trunc(Number(config.depth ?? 1)));
    const includeNulls = config.includeNulls !== false;
    const selected = path.trim() === "" ? source : source.map((item) => readPath(item, path));
    const items = flatten(selected, depth).filter(
      (item) => includeNulls || (item !== null && item !== undefined),
    );

    ctx.log.debug("flatten_items flattened items", {
      count: items.length,
      inputCount: source.length,
      depth,
      path,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        count: items.length,
        inputCount: source.length,
      },
    };
  },
});

function flatten(values: unknown[], depth: number): unknown[] {
  const output: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value) && depth > 0) {
      output.push(...flatten(value, depth - 1));
    } else {
      output.push(value);
    }
  }
  return output;
}
