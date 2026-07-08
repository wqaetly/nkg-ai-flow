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
    const requestedStart = readNonNegativeInteger(config.start);
    const requestedEnd = readNonNegativeInteger(config.end);
    const requestedCount = readNonNegativeInteger(config.count);
    const fromEnd = config.fromEnd === true;
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
        hasMore: end < total,
      },
    };
  },
});

function readNonNegativeInteger(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
