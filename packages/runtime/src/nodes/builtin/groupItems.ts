/**
 * `group_items` - deterministic array grouping.
 *
 * Groups collection payloads by a field or full item value so downstream flows
 * can summarize, branch, batch, or map over groups explicitly.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

interface GroupEntry {
  key: string;
  value: unknown;
  items: unknown[];
  count: number;
}

type GroupSortBy = "first" | "key" | "count";
type SortDirection = "asc" | "desc";

const groupItemsConfig = z
  .object({
    path: z.string().default("").describe("Optional dotted path used as the group key."),
    missingKey: z
      .string()
      .default("__missing__")
      .describe("Group key used when the selected value is null or missing."),
    caseSensitive: z
      .boolean()
      .default(true)
      .describe("Whether string group keys are case-sensitive."),
    sortBy: z
      .enum(["first", "key", "count"])
      .default("first")
      .describe("How group entries are ordered."),
    sortDirection: z
      .enum(["asc", "desc"])
      .default("asc")
      .describe("Sort direction used when sortBy is key or count."),
  })
  .passthrough();

export const groupItemsNode = defineNode({
  type: "group_items",
  typeVersion: "1.0.0",
  title: "Group Items",
  description: "Groups array items by full value or a field path.",
  config: groupItemsConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "status",
      order: 1,
    },
    missingKey: {
      label: "Missing Key",
      control: "input",
      placeholder: "__missing__",
      order: 2,
    },
    caseSensitive: {
      label: "Case Sensitive",
      control: "switch",
      order: 3,
    },
    sortBy: {
      label: "Sort By",
      control: "select",
      enumOptions: [
        { label: "First Seen", value: "first" },
        { label: "Key", value: "key" },
        { label: "Count", value: "count" },
      ],
      order: 4,
    },
    sortDirection: {
      label: "Sort Direction",
      control: "select",
      enumOptions: [
        { label: "Ascending", value: "asc" },
        { label: "Descending", value: "desc" },
      ],
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
    { id: "missingKey", direction: "input", kind: "data", label: "Missing key", schema: { type: "string" } },
    {
      id: "caseSensitive",
      direction: "input",
      kind: "data",
      label: "Case sensitive",
      schema: { type: "boolean" },
    },
    { id: "sortBy", direction: "input", kind: "data", label: "Sort by", schema: { type: "string" } },
    { id: "sortDirection", direction: "input", kind: "data", label: "Sort direction", schema: { type: "string" } },
    {
      id: "groups",
      direction: "output",
      kind: "data",
      label: "Groups",
      schema: { type: "object" },
    },
    {
      id: "entries",
      direction: "output",
      kind: "data",
      label: "Group entries",
      schema: { type: "array" },
    },
    {
      id: "keys",
      direction: "output",
      kind: "data",
      label: "Group keys",
      schema: { type: "array" },
    },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "missingKey", direction: "output", kind: "data", label: "Missing key", schema: { type: "string" } },
    {
      id: "caseSensitive",
      direction: "output",
      kind: "data",
      label: "Case sensitive",
      schema: { type: "boolean" },
    },
    { id: "sortBy", direction: "output", kind: "data", label: "Sort by", schema: { type: "string" } },
    { id: "sortDirection", direction: "output", kind: "data", label: "Sort direction", schema: { type: "string" } },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Group count",
      schema: { type: "number" },
    },
    {
      id: "total",
      direction: "output",
      kind: "data",
      label: "Total",
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
    const path = String(input.path ?? config.path ?? "");
    const missingKey = String(input.missingKey ?? config.missingKey ?? "__missing__");
    const caseSensitive = readBoolean(input.caseSensitive) ?? readBoolean(config.caseSensitive) ?? true;
    const sortBy = readSortBy(input.sortBy ?? config.sortBy);
    const sortDirection = readSortDirection(input.sortDirection ?? config.sortDirection);
    const entries = groupItems(source, {
      path,
      missingKey,
      caseSensitive,
      sortBy,
      sortDirection,
    });
    const groups = Object.fromEntries(entries.map((entry) => [entry.key, entry.items]));

    ctx.log.debug("group_items grouped items", {
      count: entries.length,
      total: source.length,
      path,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        groups,
        entries,
        keys: entries.map((entry) => entry.key),
        path,
        missingKey,
        caseSensitive,
        sortBy,
        sortDirection,
        count: entries.length,
        total: source.length,
      },
    };
  },
});

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function readSortBy(value: unknown): GroupSortBy {
  return value === "key" || value === "count" ? value : "first";
}

function readSortDirection(value: unknown): SortDirection {
  return value === "desc" ? "desc" : "asc";
}

function groupItems(
  source: unknown[],
  options: {
    path: string;
    missingKey: string;
    caseSensitive: boolean;
    sortBy: GroupSortBy;
    sortDirection: SortDirection;
  },
): GroupEntry[] {
  const groups = new Map<string, GroupEntry>();
  for (const item of source) {
    const value = valueAtPath(item, options.path);
    const key = displayKey(value, options);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      existing.count += 1;
    } else {
      groups.set(key, {
        key,
        value: value === undefined || value === null ? options.missingKey : value,
        items: [item],
        count: 1,
      });
    }
  }
  return sortGroups([...groups.values()], options.sortBy, options.sortDirection);
}

function valueAtPath(item: unknown, path: string): unknown {
  const trimmed = path.trim();
  return trimmed.length > 0 ? readPath(item, trimmed) : item;
}

function displayKey(
  value: unknown,
  options: {
    missingKey: string;
    caseSensitive: boolean;
  },
): string {
  if (value === undefined || value === null) return options.missingKey;
  if (typeof value === "string") return options.caseSensitive ? value : value.toLowerCase();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
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

function sortGroups(
  entries: GroupEntry[],
  sortBy: GroupSortBy,
  direction: SortDirection,
): GroupEntry[] {
  if (sortBy === "first") return entries;
  const multiplier = direction === "desc" ? -1 : 1;
  return [...entries].sort((left, right) => {
    const compared =
      sortBy === "count"
        ? left.count - right.count
        : left.key.localeCompare(right.key, undefined, { numeric: true });
    return compared === 0 ? 0 : compared * multiplier;
  });
}
