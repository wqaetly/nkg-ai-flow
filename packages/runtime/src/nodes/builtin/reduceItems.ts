/**
 * `reduce_items` — small deterministic array aggregation node.
 *
 * Supports the common count / sum / join modes without evaluating
 * arbitrary JavaScript. `path` may point at a field inside each item.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

const reduceItemsConfig = z
  .object({
    mode: z.enum(["count", "sum", "join"]).default("count"),
    path: z.string().default("").describe("Optional dotted path read from each item."),
    separator: z.string().default(",").describe("Separator used by join mode."),
  })
  .passthrough();

export const reduceItemsNode = defineNode({
  type: "reduce_items",
  typeVersion: "1.0.0",
  title: "Reduce Items",
  description: "Aggregates an array with count, sum, or join.",
  config: reduceItemsConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      enumOptions: [
        { label: "Count", value: "count" },
        { label: "Sum", value: "sum" },
        { label: "Join", value: "join" },
      ],
      order: 1,
    },
    path: {
      label: "Path",
      control: "input",
      placeholder: "amount",
      order: 2,
    },
    separator: {
      label: "Separator",
      control: "input",
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
      id: "result",
      direction: "output",
      kind: "data",
      label: "Result",
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
    const source: unknown[] = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const path = String(config.path ?? "");
    const values = source.map((item) => valueAtPath(item, path));
    const mode = config.mode ?? "count";
    const result =
      mode === "sum"
        ? values.reduce<number>((total, value) => total + numberOrZero(value), 0)
        : mode === "join"
          ? values.map((value) => valueToString(value)).join(String(config.separator ?? ","))
          : source.length;

    return {
      kind: "success",
      outputs: {
        out: null,
        result,
        count: source.length,
      },
    };
  },
});

function valueAtPath(item: unknown, path: string): unknown {
  return path.length > 0 ? readPath(item, path) : item;
}

function numberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function valueToString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
