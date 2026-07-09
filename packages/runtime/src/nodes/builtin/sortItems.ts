/**
 * `sort_items` - deterministic array sorting.
 *
 * Complements filter/map/reduce with stable ordering for ranked results,
 * priority queues, top-N selections, and report preparation.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type SortDirection = "asc" | "desc";
type SortValueType = "auto" | "string" | "number" | "date";
type NullPlacement = "first" | "last";

interface SortEntry {
  item: unknown;
  key: unknown;
  index: number;
}

const sortItemsConfig = z
  .object({
    path: z.string().default("").describe("Optional dotted path read from each item."),
    direction: z.enum(["asc", "desc"]).default("asc").describe("Sort direction."),
    type: z
      .enum(["auto", "string", "number", "date"])
      .default("auto")
      .describe("How sort keys are compared."),
    nulls: z
      .enum(["first", "last"])
      .default("last")
      .describe("Where null, undefined, and missing keys are placed."),
    limit: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional max number of sorted items to emit; 0 keeps all items."),
  })
  .passthrough();

export const sortItemsNode = defineNode({
  type: "sort_items",
  typeVersion: "1.0.0",
  title: "Sort Items",
  description: "Sorts an array by an optional item field path.",
  config: sortItemsConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "priority",
      order: 1,
    },
    direction: {
      label: "Direction",
      control: "select",
      enumOptions: [
        { label: "Ascending", value: "asc" },
        { label: "Descending", value: "desc" },
      ],
      order: 2,
    },
    type: {
      label: "Type",
      control: "select",
      enumOptions: [
        { label: "Auto", value: "auto" },
        { label: "String", value: "string" },
        { label: "Number", value: "number" },
        { label: "Date", value: "date" },
      ],
      order: 3,
    },
    nulls: {
      label: "Nulls",
      control: "select",
      enumOptions: [
        { label: "First", value: "first" },
        { label: "Last", value: "last" },
      ],
      order: 4,
    },
    limit: {
      label: "Limit",
      control: "number",
      order: 5,
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
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "direction", direction: "input", kind: "data", label: "Direction", schema: { type: "string" } },
    { id: "type", direction: "input", kind: "data", label: "Type", schema: { type: "string" } },
    { id: "nulls", direction: "input", kind: "data", label: "Nulls", schema: { type: "string" } },
    { id: "limit", direction: "input", kind: "data", label: "Limit", schema: { type: "number" } },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Sorted items",
      schema: { type: "array" },
    },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "direction", direction: "output", kind: "data", label: "Direction", schema: { type: "string" } },
    { id: "type", direction: "output", kind: "data", label: "Type", schema: { type: "string" } },
    { id: "nulls", direction: "output", kind: "data", label: "Nulls", schema: { type: "string" } },
    { id: "limit", direction: "output", kind: "data", label: "Limit", schema: { type: "number" } },
    {
      id: "keys",
      direction: "output",
      kind: "data",
      label: "Sort keys",
      schema: { type: "array" },
    },
    {
      id: "indexes",
      direction: "output",
      kind: "data",
      label: "Source indexes",
      schema: { type: "array" },
    },
    {
      id: "first",
      direction: "output",
      kind: "data",
      label: "First item",
    },
    {
      id: "last",
      direction: "output",
      kind: "data",
      label: "Last item",
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
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const path = String(input.path ?? config.path ?? "");
    const direction = readDirection(input.direction ?? config.direction);
    const type = readType(input.type ?? config.type);
    const nulls = readNulls(input.nulls ?? config.nulls);
    const limit = readNonNegativeInteger(input.limit) ?? readNonNegativeInteger(config.limit) ?? 0;
    const sortedEntries = source
      .map((item, index): SortEntry => ({ item, key: valueAtPath(item, path), index }))
      .sort((left, right) => {
        const missingCompared = compareMissing(left.key, right.key, nulls);
        if (missingCompared !== null) return missingCompared;
        const compared = compareKeys(left.key, right.key, { type, nulls });
        if (compared !== 0) return direction === "asc" ? compared : -compared;
        return left.index - right.index;
      });
    const limited = limit > 0 ? sortedEntries.slice(0, limit) : sortedEntries;
    const items = limited.map((entry) => entry.item);
    const keys = limited.map((entry) => entry.key);
    const indexes = limited.map((entry) => entry.index);

    ctx.log.debug("sort_items sorted items", {
      count: items.length,
      sourceCount: source.length,
      path,
      direction,
      type,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        path,
        direction,
        type,
        nulls,
        limit,
        keys,
        indexes,
        first: items[0] ?? null,
        last: items.at(-1) ?? null,
        count: items.length,
        sourceCount: source.length,
        summary: {
          status: "sorted",
          path,
          direction,
          type,
          nulls,
          limit,
          limited: limit > 0 && limited.length < sortedEntries.length,
          keys,
          indexes,
          first: items[0] ?? null,
          last: items.at(-1) ?? null,
          count: items.length,
          sourceCount: source.length,
        },
      },
    };
  },
});

function readDirection(value: unknown): SortDirection {
  return value === "desc" ? "desc" : "asc";
}

function readType(value: unknown): SortValueType {
  return value === "string" || value === "number" || value === "date" ? value : "auto";
}

function readNulls(value: unknown): NullPlacement {
  return value === "first" ? "first" : "last";
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function valueAtPath(item: unknown, path: string): unknown {
  return path.length > 0 ? readPath(item, path) : item;
}

function compareKeys(
  left: unknown,
  right: unknown,
  options: {
    type: SortValueType;
    nulls: NullPlacement;
  },
): number {
  const leftMissing = left === undefined || left === null;
  const rightMissing = right === undefined || right === null;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    const missingFirst = options.nulls === "first" ? -1 : 1;
    return leftMissing ? missingFirst : -missingFirst;
  }

  if (options.type === "number") return compareNumbers(left, right);
  if (options.type === "date") return compareDates(left, right);
  if (options.type === "string") return compareStrings(left, right);
  return compareAuto(left, right);
}

function compareMissing(
  left: unknown,
  right: unknown,
  nulls: NullPlacement,
): number | null {
  const leftMissing = left === undefined || left === null;
  const rightMissing = right === undefined || right === null;
  if (!leftMissing && !rightMissing) return null;
  if (leftMissing && rightMissing) return 0;
  const missingFirst = nulls === "first" ? -1 : 1;
  return leftMissing ? missingFirst : -missingFirst;
}

function compareAuto(left: unknown, right: unknown): number {
  const leftNumber = readNumber(left);
  const rightNumber = readNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return compareNumericValues(leftNumber, rightNumber);
  }
  return compareStrings(left, right);
}

function compareNumbers(left: unknown, right: unknown): number {
  const leftNumber = readNumber(left);
  const rightNumber = readNumber(right);
  if (leftNumber === null || rightNumber === null) {
    if (leftNumber === null && rightNumber === null) return compareStrings(left, right);
    return leftNumber === null ? 1 : -1;
  }
  return compareNumericValues(leftNumber, rightNumber);
}

function compareDates(left: unknown, right: unknown): number {
  const leftTime = readTime(left);
  const rightTime = readTime(right);
  if (leftTime === null || rightTime === null) {
    if (leftTime === null && rightTime === null) return compareStrings(left, right);
    return leftTime === null ? 1 : -1;
  }
  return compareNumericValues(leftTime, rightTime);
}

function compareNumericValues(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareStrings(left: unknown, right: unknown): number {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readTime(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
