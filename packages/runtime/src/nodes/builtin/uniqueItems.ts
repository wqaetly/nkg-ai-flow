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
      id: "keys",
      direction: "output",
      kind: "data",
      label: "Unique keys",
      schema: { type: "array" },
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
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const path = String(config.path ?? "");
    const keep = readKeep(config.keep);
    const caseSensitive = config.caseSensitive !== false;
    const { entries, duplicates } = dedupe(source, { path, keep, caseSensitive });
    const items = entries.map((entry) => entry.item);
    const keys = entries.map((entry) => entry.keyValue);

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
        duplicates,
        keys,
        count: items.length,
        duplicateCount: duplicates.length,
      },
    };
  },
});

function readKeep(value: unknown): KeepMode {
  return value === "last" ? "last" : "first";
}

function dedupe(
  source: unknown[],
  options: {
    path: string;
    keep: KeepMode;
    caseSensitive: boolean;
  },
): { entries: UniqueEntry[]; duplicates: unknown[] } {
  const byKey = new Map<string, UniqueEntry>();
  const duplicates: unknown[] = [];

  source.forEach((item, index) => {
    const keyValue = valueAtPath(item, options.path);
    const key = normalizeKey(keyValue, options.caseSensitive);
    const previous = byKey.get(key);
    if (previous) {
      if (options.keep === "last") {
        duplicates.push(previous.item);
        byKey.set(key, { item, key, keyValue, index });
      } else {
        duplicates.push(item);
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
