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

type ReduceItemsMode = "count" | "sum" | "average" | "min" | "max" | "first" | "last" | "join";

interface NumericEntry {
  index: number;
  value: number;
}

interface ReduceResult {
  result: unknown;
  resultIndex: number | null;
}

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
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "separator", direction: "input", kind: "data", label: "Separator", schema: { type: "string" } },
    {
      id: "result",
      direction: "output",
      kind: "data",
      label: "Result",
    },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "separator", direction: "output", kind: "data", label: "Separator", schema: { type: "string" } },
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
    {
      id: "numericIndexes",
      direction: "output",
      kind: "data",
      label: "Numeric indexes",
      schema: { type: "array" },
    },
    {
      id: "resultIndex",
      direction: "output",
      kind: "data",
      label: "Result index",
      schema: { type: ["number", "null"] },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config }) {
    const source: unknown[] = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const mode = readMode(input.mode ?? config.mode);
    const path = String(input.path ?? config.path ?? "");
    const separator = String(input.separator ?? config.separator ?? ",");
    const values = source.map((item) => valueAtPath(item, path));
    const numericEntries = values.flatMap<NumericEntry>((value, index) => {
      const number = numberOrUndefined(value);
      return number === undefined ? [] : [{ index, value: number }];
    });
    const reduced = reduceValues({
      mode,
      values,
      numericEntries,
      separator,
      sourceCount: source.length,
    });
    const numericIndexes = numericEntries.map((entry) => entry.index);

    return {
      kind: "success",
      outputs: {
        out: null,
        result: reduced.result,
        resultIndex: reduced.resultIndex,
        mode,
        path,
        separator,
        count: source.length,
        numericCount: numericEntries.length,
        numericIndexes,
        summary: {
          status: "reduced",
          mode,
          path,
          separator,
          result: reduced.result,
          resultIndex: reduced.resultIndex,
          count: source.length,
          numericCount: numericEntries.length,
          numericIndexes,
        },
      },
    };
  },
});

function readMode(value: unknown): ReduceItemsMode {
  return value === "sum" ||
    value === "average" ||
    value === "min" ||
    value === "max" ||
    value === "first" ||
    value === "last" ||
    value === "join"
    ? value
    : "count";
}

function valueAtPath(item: unknown, path: string): unknown {
  return path.length > 0 ? readPath(item, path) : item;
}

function reduceValues(options: {
  mode: string;
  values: unknown[];
  numericEntries: NumericEntry[];
  separator: string;
  sourceCount: number;
}): ReduceResult {
  const { mode, values, numericEntries, separator, sourceCount } = options;
  const numbers = numericEntries.map((entry) => entry.value);
  if (mode === "sum") {
    return {
      result: numbers.reduce<number>((total, value) => total + value, 0),
      resultIndex: null,
    };
  }
  if (mode === "average") {
    return {
      result: numbers.length > 0
        ? numbers.reduce<number>((total, value) => total + value, 0) / numbers.length
        : null,
      resultIndex: null,
    };
  }
  if (mode === "min") {
    return numericEntries.reduce<ReduceResult>(
      (best, entry) =>
        best.result === null || entry.value < Number(best.result)
          ? { result: entry.value, resultIndex: entry.index }
          : best,
      { result: null, resultIndex: null },
    );
  }
  if (mode === "max") {
    return numericEntries.reduce<ReduceResult>(
      (best, entry) =>
        best.result === null || entry.value > Number(best.result)
          ? { result: entry.value, resultIndex: entry.index }
          : best,
      { result: null, resultIndex: null },
    );
  }
  if (mode === "first") {
    return {
      result: values.length > 0 ? values[0] : null,
      resultIndex: values.length > 0 ? 0 : null,
    };
  }
  if (mode === "last") {
    return {
      result: values.length > 0 ? values[values.length - 1] : null,
      resultIndex: values.length > 0 ? values.length - 1 : null,
    };
  }
  if (mode === "join") {
    return {
      result: values.map((value) => valueToString(value)).join(separator),
      resultIndex: null,
    };
  }
  return { result: sourceCount, resultIndex: null };
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
