/**
 * `flatten_items` - deterministic array flattening.
 *
 * Useful after grouping, batching, or collecting nested search results when
 * downstream flow nodes expect a single flat item stream.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

interface FlattenEntry {
  value: unknown;
  sourceIndex: number;
  sourcePath: string;
}

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
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "depth", direction: "input", kind: "data", label: "Depth", schema: { type: "number" } },
    { id: "includeNulls", direction: "input", kind: "data", label: "Include nulls", schema: { type: "boolean" } },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Flattened items",
      schema: { type: "array" },
    },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "depth", direction: "output", kind: "data", label: "Depth", schema: { type: "number" } },
    { id: "includeNulls", direction: "output", kind: "data", label: "Include nulls", schema: { type: "boolean" } },
    {
      id: "sourceIndexes",
      direction: "output",
      kind: "data",
      label: "Source indexes",
      schema: { type: "array" },
    },
    {
      id: "sourcePaths",
      direction: "output",
      kind: "data",
      label: "Source paths",
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
    const depth = readPositiveInteger(input.depth) ?? readPositiveInteger(config.depth) ?? 1;
    const includeNulls = readBoolean(input.includeNulls) ?? readBoolean(config.includeNulls) ?? true;
    const entries = flattenSelected(source, path, depth).filter(
      (entry) => includeNulls || (entry.value !== null && entry.value !== undefined),
    );
    const items = entries.map((entry) => entry.value);
    const sourceIndexes = entries.map((entry) => entry.sourceIndex);
    const sourcePaths = entries.map((entry) => entry.sourcePath);
    const summary = {
      path,
      depth,
      includeNulls,
      count: items.length,
      inputCount: source.length,
      sourceIndexes,
      sourcePaths,
    };

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
        path,
        depth,
        includeNulls,
        sourceIndexes,
        sourcePaths,
        count: items.length,
        inputCount: source.length,
        summary,
      },
    };
  },
});

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function flattenSelected(source: unknown[], path: string, depth: number): FlattenEntry[] {
  const trimmedPath = path.trim();
  return source.flatMap((item, index) => {
    const value = trimmedPath === "" ? item : readPath(item, trimmedPath);
    const basePath = trimmedPath === "" ? String(index) : `${index}.${trimmedPath}`;
    return flattenEntries(value, depth, index, basePath);
  });
}

function flattenEntries(value: unknown, depth: number, sourceIndex: number, sourcePath: string): FlattenEntry[] {
  if (Array.isArray(value) && depth > 0) {
    return value.flatMap((child, index) =>
      flattenEntries(child, depth - 1, sourceIndex, `${sourcePath}.${index}`),
    );
  }
  return [{ value, sourceIndex, sourcePath }];
}
