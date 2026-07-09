/**
 * `unique_items` - deterministic array de-duplication.
 *
 * Useful for cleaning search results, entity lists, queue candidates, and
 * other repeated collection payloads before downstream work fans out.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type KeepMode = "first" | "last";

interface UniqueEntry {
  item: unknown;
  key: string;
  keyValue: unknown;
  index: number;
}

const uniqueItemsConfig = z
  .object({
    path: z.string().default("").describe("Optional dotted path used as the unique key."),
    keep: z
      .enum(["first", "last"])
      .default("first")
      .describe("Whether the first or last item for each key is kept."),
    caseSensitive: z
      .boolean()
      .default(true)
      .describe("Whether string keys are case-sensitive."),
  })
  .passthrough();

export const uniqueItemsNode = defineNode({
  type: "unique_items",
  typeVersion: "1.0.0",
  title: "Unique Items",
  description: "Removes duplicate array items by value or by a field path.",
  config: uniqueItemsConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "id",
      order: 1,
    },
    keep: {
      label: "Keep",
      control: "select",
      enumOptions: [
        { label: "First", value: "first" },
        { label: "Last", value: "last" },
      ],
      order: 2,
    },
    caseSensitive: {
      label: "Case Sensitive",
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
    { id: "keep", direction: "input", kind: "data", label: "Keep", schema: { type: "string" } },
    {
      id: "caseSensitive",
      direction: "input",
      kind: "data",
      label: "Case sensitive",
      schema: { type: "boolean" },
    },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Unique items",
      schema: { type: "array" },
    },
    {
      id: "duplicates",
      direction: "output",
      kind: "data",
      label: "Duplicate items",
      schema: { type: "array" },
    },
    {
      id: "indexes",
      direction: "output",
      kind: "data",
      label: "Kept indexes",
      schema: { type: "array" },
    },
    {
      id: "duplicateIndexes",
      direction: "output",
      kind: "data",
      label: "Duplicate indexes",
      schema: { type: "array" },
    },
    {
      id: "keys",
      direction: "output",
      kind: "data",
      label: "Unique keys",
      schema: { type: "array" },
    },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "keep", direction: "output", kind: "data", label: "Keep", schema: { type: "string" } },
    {
      id: "caseSensitive",
      direction: "output",
      kind: "data",
      label: "Case sensitive",
      schema: { type: "boolean" },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Unique count",
      schema: { type: "number" },
    },
    {
      id: "duplicateCount",
      direction: "output",
      kind: "data",
      label: "Duplicate count",
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
    const keep = readKeep(input.keep ?? config.keep);
    const caseSensitive = readBoolean(input.caseSensitive) ?? readBoolean(config.caseSensitive) ?? true;
    const { entries, duplicates } = dedupe(source, { path, keep, caseSensitive });
    const items = entries.map((entry) => entry.item);
    const keys = entries.map((entry) => entry.keyValue);
    const indexes = entries.map((entry) => entry.index);
    const duplicateItems = duplicates.map((entry) => entry.item);
    const duplicateIndexes = duplicates.map((entry) => entry.index);
    const summary = {
      path,
      keep,
      caseSensitive,
      sourceCount: source.length,
      count: items.length,
      duplicateCount: duplicates.length,
      indexes,
      duplicateIndexes,
      keys,
    };

    ctx.log.debug("unique_items deduplicated items", {
      count: items.length,
      duplicateCount: duplicates.length,
      sourceCount: source.length,
      path,
      keep,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items,
        duplicates: duplicateItems,
        indexes,
        duplicateIndexes,
        keys,
        path,
        keep,
        caseSensitive,
        count: items.length,
        duplicateCount: duplicates.length,
        summary,
      },
    };
  },
});

function readKeep(value: unknown): KeepMode {
  return value === "last" ? "last" : "first";
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function dedupe(
  source: unknown[],
  options: {
    path: string;
    keep: KeepMode;
    caseSensitive: boolean;
  },
): { entries: UniqueEntry[]; duplicates: UniqueEntry[] } {
  const byKey = new Map<string, UniqueEntry>();
  const duplicates: UniqueEntry[] = [];

  source.forEach((item, index) => {
    const keyValue = valueAtPath(item, options.path);
    const key = normalizeKey(keyValue, options.caseSensitive);
    const previous = byKey.get(key);
    if (previous) {
      if (options.keep === "last") {
        duplicates.push(previous);
        byKey.set(key, { item, key, keyValue, index });
      } else {
        duplicates.push({ item, key, keyValue, index });
      }
    } else {
      byKey.set(key, { item, key, keyValue, index });
    }
  });

  return {
    entries: [...byKey.values()].sort((left, right) => left.index - right.index),
    duplicates,
  };
}

function valueAtPath(item: unknown, path: string): unknown {
  const trimmed = path.trim();
  return trimmed.length > 0 ? readPath(item, trimmed) : item;
}

function normalizeKey(value: unknown, caseSensitive: boolean): string {
  if (typeof value === "string") {
    return `string:${caseSensitive ? value : value.toLowerCase()}`;
  }
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${key}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
