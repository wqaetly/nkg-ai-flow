/**
 * `slice_items` - array slicing / pagination.
 *
 * Complements filter/map/sort/reduce with deterministic windowing for
 * pagination, top-N extraction after sorting, and batch preparation.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const sliceItemsConfig = z
  .object({
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Zero-based start index, or offset from the end when fromEnd is enabled."),
    end: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional exclusive end index; 0 means no explicit end."),
    count: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional number of items to emit; overrides end when greater than 0."),
    fromEnd: z
      .boolean()
      .default(false)
      .describe("When true, start is treated as an offset from the end."),
  })
  .passthrough();

export const sliceItemsNode = defineNode({
  type: "slice_items",
  typeVersion: "1.0.0",
  title: "Slice Items",
  description: "Slices an array by start/end/count for pagination or windowing.",
  config: sliceItemsConfig,
  fieldMeta: {
    start: {
      label: "Start",
      control: "number",
      order: 1,
    },
    end: {
      label: "End",
      control: "number",
      order: 2,
    },
    count: {
      label: "Count",
      control: "number",
      order: 3,
    },
    fromEnd: {
      label: "From End",
      control: "switch",
      order: 4,
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
    { id: "start", direction: "input", kind: "data", label: "Start", schema: { type: "number" } },
    { id: "end", direction: "input", kind: "data", label: "End", schema: { type: "number" } },
    { id: "count", direction: "input", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "fromEnd", direction: "input", kind: "data", label: "From end", schema: { type: "boolean" } },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Sliced items",
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
      id: "total",
      direction: "output",
      kind: "data",
      label: "Total",
      schema: { type: "number" },
    },
    {
      id: "start",
      direction: "output",
      kind: "data",
      label: "Start",
      schema: { type: "number" },
    },
    {
      id: "end",
      direction: "output",
      kind: "data",
      label: "End",
      schema: { type: "number" },
    },
    {
      id: "fromEnd",
      direction: "output",
      kind: "data",
      label: "From end",
      schema: { type: "boolean" },
    },
    {
      id: "hasMore",
      direction: "output",
      kind: "data",
      label: "Has more",
      schema: { type: "boolean" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const total = source.length;
    const requestedStart = readConfigInteger(input, "start", config.start);
    const requestedEnd = readConfigInteger(input, "end", config.end);
    const requestedCount = readConfigInteger(input, "count", config.count);
    const fromEnd = readBoolean(input.fromEnd) ?? readBoolean(config.fromEnd) ?? false;
    const start = fromEnd
      ? clamp(total - requestedStart - (requestedCount > 0 ? requestedCount : 0), 0, total)
      : clamp(requestedStart, 0, total);
    const end = requestedCount > 0
      ? clamp(start + requestedCount, start, total)
      : requestedEnd > 0
        ? clamp(requestedEnd, start, total)
        : total;
    const items = source.slice(start, end);

    ctx.log.debug("slice_items sliced items", {
      start,
      end,
      count: items.length,
      total,
      fromEnd,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        count: items.length,
        total,
        start,
        end,
        fromEnd,
        hasMore: end < total,
      },
    };
  },
});

function readConfigInteger(
  input: Record<string, unknown>,
  key: "start" | "end" | "count",
  fallback: unknown,
): number {
  if (Object.prototype.hasOwnProperty.call(input, key)) return readNonNegativeInteger(input[key]) ?? 0;
  return readNonNegativeInteger(fallback) ?? 0;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Math.trunc(Number(value ?? 0));
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 0 ? parsed : 0;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
