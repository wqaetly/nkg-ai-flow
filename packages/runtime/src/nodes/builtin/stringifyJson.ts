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
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const value = readValue(input, String(config.path ?? ""));
    const indent = Math.max(0, Math.min(10, Math.trunc(Number(config.indent ?? 0))));
    const sortKeys = config.sortKeys === true;
    const bigintMode = readBigIntMode(config.bigintMode);

    try {
      const normalized = sortKeys ? sortJsonKeys(value) : value;
      const text = stringify(normalized, { indent, bigintMode });

      ctx.log.debug("stringify_json stringified value", {
        length: text.length,
        indent,
        sortKeys,
      });

      return success("stringified", value, text, "stringified");
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : "Unable to stringify JSON.";
      ctx.log.debug("stringify_json failed", { errorMessage });
      return success("failed", value, "", "failed", errorMessage);
    }
  },
});

function readValue(input: Record<string, unknown>, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed !== "") return readPath(input, trimmed);
  return input.value ?? input.input ?? input.in ?? input.__runInput__ ?? null;
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
  errorMessage = "",
) {
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      text,
      value,
      status,
      length: text.length,
      errorMessage,
    },
  };
}
