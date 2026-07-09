/**
 * `stringify_json` - serialize structured flow data into JSON text.
 *
 * Complements `parse_json` by turning validated or transformed objects back
 * into a stable payload for HTTP bodies, logs, file tools, and prompt context.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn, readPath } from "./_helpers.js";

type BigIntMode = "string" | "error";

const stringifyJsonConfig = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Optional dotted path read from the input envelope before stringifying."),
    indent: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(0)
      .describe("Pretty-print indentation spaces; 0 emits compact JSON."),
    sortKeys: z
      .boolean()
      .default(false)
      .describe("Whether object keys are sorted recursively before stringifying."),
    bigintMode: z
      .enum(["string", "error"])
      .default("string")
      .describe("How BigInt values are handled."),
  })
  .passthrough();

export const stringifyJsonNode = defineNode({
  type: "stringify_json",
  typeVersion: "1.0.0",
  title: "Stringify JSON",
  description: "Serializes structured data into JSON text and routes failures.",
  kind: "pseudo",
  config: stringifyJsonConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "payload",
      order: 1,
    },
    indent: {
      label: "Indent",
      control: "number",
      order: 2,
    },
    sortKeys: {
      label: "Sort Keys",
      control: "switch",
      order: 3,
    },
    bigintMode: {
      label: "BigInt Mode",
      control: "select",
      enumOptions: [
        { label: "String", value: "string" },
        { label: "Error", value: "error" },
      ],
      order: 4,
    },
  },
  ports: [
    controlIn,
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "indent", direction: "input", kind: "data", label: "Indent", schema: { type: "number" } },
    { id: "sortKeys", direction: "input", kind: "data", label: "Sort keys", schema: { type: "boolean" } },
    { id: "bigintMode", direction: "input", kind: "data", label: "BigInt mode", schema: { type: "string" } },
    { id: "stringified", direction: "output", kind: "control", label: "Stringified" },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    {
      id: "text",
      direction: "output",
      kind: "data",
      label: "Text",
      schema: { type: "string" },
    },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "indent", direction: "output", kind: "data", label: "Indent", schema: { type: "number" } },
    { id: "sortKeys", direction: "output", kind: "data", label: "Sort keys", schema: { type: "boolean" } },
    { id: "bigintMode", direction: "output", kind: "data", label: "BigInt mode", schema: { type: "string" } },
    {
      id: "status",
      direction: "output",
      kind: "data",
      label: "Status",
      schema: { type: "string" },
    },
    {
      id: "length",
      direction: "output",
      kind: "data",
      label: "Length",
      schema: { type: "number" },
    },
    {
      id: "errorMessage",
      direction: "output",
      kind: "data",
      label: "Error message",
      schema: { type: "string" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const path = String(input.path ?? config.path ?? "").trim();
    const value = readValue(input, path);
    const indent = readIndent(input.indent) ?? readIndent(config.indent) ?? 0;
    const sortKeys = readBoolean(input.sortKeys) ?? readBoolean(config.sortKeys) ?? false;
    const bigintMode = readBigIntMode(input.bigintMode ?? config.bigintMode);
    const metadata = { path, indent, sortKeys, bigintMode };

    try {
      const normalized = sortKeys ? sortJsonKeys(value) : value;
      const text = stringify(normalized, { indent, bigintMode });

      ctx.log.debug("stringify_json stringified value", {
        length: text.length,
        indent,
        sortKeys,
      });

      return success("stringified", value, text, "stringified", "", metadata);
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : "Unable to stringify JSON.";
      ctx.log.debug("stringify_json failed", { errorMessage });
      return success("failed", value, "", "failed", errorMessage, metadata);
    }
  },
});

function readValue(input: Record<string, unknown>, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed !== "") return readPath(input, trimmed);
  return input.value ?? input.input ?? input.in ?? input.__runInput__ ?? null;
}

function readIndent(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(10, Math.trunc(numeric)));
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

function readBigIntMode(value: unknown): BigIntMode {
  return value === "error" ? "error" : "string";
}

function stringify(
  value: unknown,
  options: { indent: number; bigintMode: BigIntMode },
): string {
  const seen = new WeakSet<object>();
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === "bigint") {
        if (options.bigintMode === "error") {
          throw new TypeError("BigInt values cannot be represented as JSON numbers.");
        }
        return item.toString();
      }
      if (item && typeof item === "object") {
        if (seen.has(item)) throw new TypeError("Circular structure cannot be stringified.");
        seen.add(item);
      }
      return item;
    },
    options.indent,
  );
  return text === undefined ? "null" : text;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!isPlainObject(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonKeys(value[key]);
  }
  return sorted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function success(
  branch: "stringified" | "failed",
  value: unknown,
  text: string,
  status: string,
  errorMessage: string,
  metadata: {
    path: string;
    indent: number;
    sortKeys: boolean;
    bigintMode: BigIntMode;
  },
) {
  const summary = {
    branch,
    status,
    path: metadata.path,
    indent: metadata.indent,
    sortKeys: metadata.sortKeys,
    bigintMode: metadata.bigintMode,
    length: text.length,
    valueType: valueType(value),
    errorMessage,
  };
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      text,
      value,
      status,
      path: metadata.path,
      indent: metadata.indent,
      sortKeys: metadata.sortKeys,
      bigintMode: metadata.bigintMode,
      length: text.length,
      errorMessage,
      summary,
    },
  };
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return typeof value;
}
