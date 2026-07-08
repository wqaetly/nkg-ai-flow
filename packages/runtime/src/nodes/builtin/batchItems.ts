/**
 * `batch_items` - fixed-size array batching.
 *
 * Turns a flat item list into an array of chunks for API batching,
 * file processing, or downstream foreach/parallel fan-out.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

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
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const size = readPositiveInteger(config.size, 10);
    const includePartial = config.includePartial !== false;
    const batches: unknown[][] = [];

    for (let index = 0; index < source.length; index += size) {
      const batch = source.slice(index, index + size);
      if (batch.length === size || includePartial) {
        batches.push(batch);
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
        count: batches.length,
        itemCount: source.length,
        hasPartial,
      },
    };
  },
});

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
