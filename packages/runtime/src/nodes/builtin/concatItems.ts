/**
 * `concat_items` - concatenate multiple item arrays.
 *
 * Useful after parallel branches, search fan-out, or multiple upstream tools
 * each produce arrays that should continue as one ordered item stream.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

interface SourceRange {
  sourceIndex: number;
  start: number;
  end: number;
  count: number;
  included: boolean;
}

interface ConcatResult {
  items: unknown[];
  sourceIndexes: number[];
  sourceOffsets: number[];
  sourceRanges: SourceRange[];
}

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
      id: "includeScalars",
      direction: "input",
      kind: "data",
      label: "Include scalars",
      schema: { type: "boolean" },
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
      id: "sourceIndexes",
      direction: "output",
      kind: "data",
      label: "Source indexes",
      schema: { type: "array" },
    },
    {
      id: "sourceOffsets",
      direction: "output",
      kind: "data",
      label: "Source offsets",
      schema: { type: "array" },
    },
    {
      id: "sourceRanges",
      direction: "output",
      kind: "data",
      label: "Source ranges",
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
    {
      id: "includeScalars",
      direction: "output",
      kind: "data",
      label: "Include scalars",
      schema: { type: "boolean" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const sources = normalizeSources(input.items ?? input.input);
    const includeScalars =
      readBoolean(input.includeScalars) ?? readBoolean(config.includeScalars) ?? true;
    const result = concatSources(sources, includeScalars);
    const includedSourceCount = result.sourceRanges.filter((range) => range.included).length;
    const summary = {
      count: result.items.length,
      sourceCount: sources.length,
      includedSourceCount,
      skippedSourceCount: sources.length - includedSourceCount,
      includeScalars,
      sourceRanges: result.sourceRanges,
    };

    ctx.log.debug("concat_items concatenated sources", summary);

    return {
      kind: "success",
      outputs: {
        out: null,
        items: result.items,
        sources,
        sourceIndexes: result.sourceIndexes,
        sourceOffsets: result.sourceOffsets,
        sourceRanges: result.sourceRanges,
        count: result.items.length,
        sourceCount: sources.length,
        includeScalars,
        summary,
      },
    };
  },
});

function normalizeSources(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function concatSources(sources: unknown[], includeScalars: boolean): ConcatResult {
  const items: unknown[] = [];
  const sourceIndexes: number[] = [];
  const sourceOffsets: number[] = [];
  const sourceRanges: SourceRange[] = [];

  sources.forEach((source, sourceIndex) => {
    const start = items.length;
    if (Array.isArray(source)) {
      source.forEach((item, sourceOffset) => {
        items.push(item);
        sourceIndexes.push(sourceIndex);
        sourceOffsets.push(sourceOffset);
      });
    } else if (includeScalars && source !== undefined) {
      items.push(source);
      sourceIndexes.push(sourceIndex);
      sourceOffsets.push(0);
    }
    sourceRanges.push({
      sourceIndex,
      start,
      end: items.length,
      count: items.length - start,
      included: items.length > start,
    });
  });

  return { items, sourceIndexes, sourceOffsets, sourceRanges };
}
