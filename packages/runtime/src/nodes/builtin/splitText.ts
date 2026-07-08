/**
 * `split_text` - turn text into an item array.
 *
 * This is the text-to-collection bridge for logs, CSV-ish rows, pasted lists,
 * tool output, and prompt input that should continue through map/filter/reduce.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

type SplitMode = "lines" | "separator" | "whitespace" | "regex";

const splitTextConfig = z
  .object({
    mode: z
      .enum(["lines", "separator", "whitespace", "regex"])
      .default("lines")
      .describe("How the text is split into items."),
    separator: z
      .string()
      .default("\n")
      .describe("Separator string or regex pattern, depending on mode."),
    limit: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional maximum number of items to emit; 0 keeps all items."),
    trimItems: z
      .boolean()
      .default(true)
      .describe("Whether leading and trailing whitespace is removed from each item."),
    dropEmpty: z.boolean().default(true).describe("Whether empty items are removed."),
  })
  .passthrough();

export const splitTextNode = defineNode({
  type: "split_text",
  typeVersion: "1.0.0",
  title: "Split Text",
  description: "Splits a text value into an item array.",
  config: splitTextConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      enumOptions: [
        { label: "Lines", value: "lines" },
        { label: "Separator", value: "separator" },
        { label: "Whitespace", value: "whitespace" },
        { label: "Regex", value: "regex" },
      ],
      order: 1,
    },
    separator: {
      label: "Separator",
      control: "input",
      placeholder: "\\n",
      order: 2,
    },
    limit: {
      label: "Limit",
      control: "number",
      order: 3,
    },
    trimItems: {
      label: "Trim Items",
      control: "switch",
      order: 4,
    },
    dropEmpty: {
      label: "Drop Empty",
      control: "switch",
      order: 5,
    },
  },
  ports: [
    {
      id: "text",
      direction: "input",
      kind: "data",
      label: "Text",
      schema: { type: "string" },
    },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "separator", direction: "input", kind: "data", label: "Separator", schema: { type: "string" } },
    { id: "limit", direction: "input", kind: "data", label: "Limit", schema: { type: "number" } },
    { id: "trimItems", direction: "input", kind: "data", label: "Trim items", schema: { type: "boolean" } },
    { id: "dropEmpty", direction: "input", kind: "data", label: "Drop empty", schema: { type: "boolean" } },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Split items",
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
      id: "text",
      direction: "output",
      kind: "data",
      label: "Text",
      schema: { type: "string" },
    },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "separator", direction: "output", kind: "data", label: "Separator", schema: { type: "string" } },
    { id: "limit", direction: "output", kind: "data", label: "Limit", schema: { type: "number" } },
    { id: "trimItems", direction: "output", kind: "data", label: "Trim items", schema: { type: "boolean" } },
    { id: "dropEmpty", direction: "output", kind: "data", label: "Drop empty", schema: { type: "boolean" } },
    {
      id: "reason",
      direction: "output",
      kind: "data",
      label: "Reason",
      schema: { type: "string" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const text = readText(input);
    const mode = readMode(input.mode ?? config.mode);
    const separator = decodeSeparator(String(input.separator ?? config.separator ?? "\n"));
    const limit = readNonNegativeInteger(input.limit) ?? readNonNegativeInteger(config.limit) ?? 0;
    const trimItems = readBoolean(input.trimItems) ?? readBoolean(config.trimItems) ?? true;
    const dropEmpty = readBoolean(input.dropEmpty) ?? readBoolean(config.dropEmpty) ?? true;

    const split = splitRawText(text, mode, separator);
    const normalized = split.items
      .map((item) => (trimItems ? item.trim() : item))
      .filter((item) => !dropEmpty || item !== "");
    const items = limit > 0 ? normalized.slice(0, limit) : normalized;

    ctx.log.debug("split_text split text", {
      count: items.length,
      mode,
      reason: split.reason,
      limit,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        text,
        items,
        count: items.length,
        mode,
        separator,
        limit,
        trimItems,
        dropEmpty,
        reason: split.reason,
      },
    };
  },
});

function readText(input: Record<string, unknown>): string {
  const value = input.text ?? input.input ?? input.in ?? "";
  if (value === null || value === undefined) return "";
  return String(value);
}

function readMode(value: unknown): SplitMode {
  return value === "separator" || value === "whitespace" || value === "regex"
    ? value
    : "lines";
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.trunc(numeric));
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

function splitRawText(
  text: string,
  mode: SplitMode,
  separator: string,
): { items: string[]; reason: string } {
  if (mode === "lines") {
    return { items: text.split(/\r?\n/), reason: "split_lines" };
  }
  if (mode === "whitespace") {
    return { items: text.split(/\s+/), reason: "split_whitespace" };
  }
  if (mode === "regex") {
    try {
      return { items: text.split(new RegExp(separator)), reason: "split_regex" };
    } catch {
      return {
        items: text.split(separator),
        reason: "invalid_regex_fallback_separator",
      };
    }
  }
  return { items: text.split(separator), reason: "split_separator" };
}

function decodeSeparator(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}
