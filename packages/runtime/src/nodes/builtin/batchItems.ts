/**
 * `batch_items` - fixed-size array batching.
 *
 * Turns a flat item list into an array of chunks for API batching,
 * file processing, or downstream foreach/parallel fan-out.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

interface BatchRange {
  index: number;
  start: number;
  end: number;
  count: number;
  partial: boolean;
}

const batchItemsConfig = z
  .object({
    size: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe("Number of source items per batch."),
    includePartial: z
      .boolean()
      .default(true)
      .describe("When false, drops the final batch if it is smaller than size."),
  })
  .passthrough();

export const batchItemsNode = defineNode({
  type: "batch_items",
  typeVersion: "1.0.0",
  title: "Batch Items",
  description: "Splits an array into fixed-size batches.",
  config: batchItemsConfig,
  fieldMeta: {
    size: {
      label: "Size",
      control: "number",
      order: 1,
    },
    includePartial: {
      label: "Include Partial",
      control: "switch",
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
    {
      id: "size",
      direction: "input",
      kind: "data",
      label: "Size",
      schema: { type: "number" },
    },
    {
      id: "includePartial",
      direction: "input",
      kind: "data",
      label: "Include partial",
      schema: { type: "boolean" },
    },
    {
      id: "batches",
      direction: "output",
      kind: "data",
      label: "Batches",
      schema: { type: "array" },
    },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Batches",
      schema: { type: "array" },
    },
    {
      id: "size",
      direction: "output",
      kind: "data",
      label: "Size",
      schema: { type: "number" },
    },
    {
      id: "includePartial",
      direction: "output",
      kind: "data",
      label: "Include partial",
      schema: { type: "boolean" },
    },
    {
      id: "ranges",
      direction: "output",
      kind: "data",
      label: "Ranges",
      schema: { type: "array" },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Batch count",
      schema: { type: "number" },
    },
    {
      id: "itemCount",
      direction: "output",
      kind: "data",
      label: "Item count",
      schema: { type: "number" },
    },
    {
      id: "hasPartial",
      direction: "output",
      kind: "data",
      label: "Has partial",
      schema: { type: "boolean" },
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
    const size = readPositiveInteger(input.size, 0) ?? readPositiveInteger(config.size, 10) ?? 10;
    const includePartial = readBoolean(input.includePartial) ?? readBoolean(config.includePartial) ?? true;
    const batches: unknown[][] = [];
    const ranges: BatchRange[] = [];

    for (let start = 0; start < source.length; start += size) {
      const batch = source.slice(start, start + size);
      if (batch.length === size || includePartial) {
        batches.push(batch);
        ranges.push({
          index: ranges.length,
          start,
          end: start + batch.length,
          count: batch.length,
          partial: batch.length < size,
        });
      }
    }

    const hasPartial = source.length > 0 && source.length % size !== 0;

    ctx.log.debug("batch_items split items", {
      size,
      includePartial,
      itemCount: source.length,
      batchCount: batches.length,
      hasPartial,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        batches,
        items: batches,
        size,
        includePartial,
        ranges,
        count: batches.length,
        itemCount: source.length,
        hasPartial,
        summary: {
          status: "batched",
          size,
          includePartial,
          count: batches.length,
          itemCount: source.length,
          hasPartial,
          droppedPartial: hasPartial && !includePartial,
          ranges,
        },
      },
    };
  },
});

function readPositiveInteger(value: unknown, fallback: number): number | undefined {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback > 0 ? fallback : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}
