/**
 * `reduce_items` — small deterministic array aggregation node.
 *
 * Supports common count / sum / average / min / max / first / last / join modes
 * without evaluating arbitrary JavaScript. `path` may point at a field inside
 * each item.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

const reduceItemsConfig = z
  .object({
    mode: z
      .enum(["count", "sum", "average", "min", "max", "first", "last", "join"])
      .default("count"),
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
        { label: "Average", value: "average" },
        { label: "Min", value: "min" },
        { label: "Max", value: "max" },
        { label: "First", value: "first" },
        { label: "Last", value: "last" },
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
    {
      id: "numericCount",
      direction: "output",
      kind: "data",
      label: "Numeric count",
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
    const numbers = values.flatMap((value) => {
      const number = numberOrUndefined(value);
      return number === undefined ? [] : [number];
    });
    const result = reduceValues({
      mode,
      values,
      numbers,
      separator: String(config.separator ?? ","),
      sourceCount: source.length,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        result,
        count: source.length,
        numericCount: numbers.length,
      },
    };
  },
});

function valueAtPath(item: unknown, path: string): unknown {
  return path.length > 0 ? readPath(item, path) : item;
}

function reduceValues(options: {
  mode: string;
  values: unknown[];
  numbers: number[];
  separator: string;
  sourceCount: number;
}): unknown {
  const { mode, values, numbers, separator, sourceCount } = options;
  if (mode === "sum") return numbers.reduce<number>((total, value) => total + value, 0);
  if (mode === "average") {
    return numbers.length > 0
      ? numbers.reduce<number>((total, value) => total + value, 0) / numbers.length
      : null;
  }
  if (mode === "min") return numbers.length > 0 ? Math.min(...numbers) : null;
  if (mode === "max") return numbers.length > 0 ? Math.max(...numbers) : null;
  if (mode === "first") return values.length > 0 ? values[0] : null;
  if (mode === "last") return values.length > 0 ? values[values.length - 1] : null;
  if (mode === "join") return values.map((value) => valueToString(value)).join(separator);
  return sourceCount;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function valueToString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
