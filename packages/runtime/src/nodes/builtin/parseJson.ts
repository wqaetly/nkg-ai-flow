/**
 * `parse_json` - parse JSON text into structured flow data.
 *
 * This bridges text-producing nodes (LLM, HTTP, text input, tools) into
 * structured branches that can continue through schema guards and routers.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn, readPath } from "./_helpers.js";

const parseJsonConfig = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Optional dotted path read from the input envelope before parsing."),
    trim: z.boolean().default(true).describe("Whether text is trimmed before parsing."),
    unwrapCodeFence: z
      .boolean()
      .default(true)
      .describe("Whether markdown fenced JSON blocks are unwrapped before parsing."),
    acceptNonString: z
      .boolean()
      .default(true)
      .describe("Whether already structured non-string inputs are passed through as parsed."),
  })
  .passthrough();

export const parseJsonNode = defineNode({
  type: "parse_json",
  typeVersion: "1.0.0",
  title: "Parse JSON",
  description: "Parses JSON text into structured data and routes invalid input.",
  kind: "pseudo",
  config: parseJsonConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "body",
      order: 1,
    },
    trim: {
      label: "Trim",
      control: "switch",
      order: 2,
    },
    unwrapCodeFence: {
      label: "Unwrap Code Fence",
      control: "switch",
      order: 3,
    },
    acceptNonString: {
      label: "Accept Non-string",
      control: "switch",
      order: 4,
    },
  },
  ports: [
    controlIn,
    {
      id: "text",
      direction: "input",
      kind: "data",
      label: "Text",
    },
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "trim", direction: "input", kind: "data", label: "Trim", schema: { type: "boolean" } },
    {
      id: "unwrapCodeFence",
      direction: "input",
      kind: "data",
      label: "Unwrap code fence",
      schema: { type: "boolean" },
    },
    {
      id: "acceptNonString",
      direction: "input",
      kind: "data",
      label: "Accept non-string",
      schema: { type: "boolean" },
    },
    { id: "parsed", direction: "output", kind: "control", label: "Parsed" },
    { id: "invalid", direction: "output", kind: "control", label: "Invalid" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "raw", direction: "output", kind: "data", label: "Raw" },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "trim", direction: "output", kind: "data", label: "Trim", schema: { type: "boolean" } },
    {
      id: "unwrapCodeFence",
      direction: "output",
      kind: "data",
      label: "Unwrap code fence",
      schema: { type: "boolean" },
    },
    {
      id: "acceptNonString",
      direction: "output",
      kind: "data",
      label: "Accept non-string",
      schema: { type: "boolean" },
    },
    {
      id: "status",
      direction: "output",
      kind: "data",
      label: "Status",
      schema: { type: "string" },
    },
    {
      id: "type",
      direction: "output",
      kind: "data",
      label: "Type",
      schema: { type: "string" },
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
    const path = String(input.path ?? config.path ?? "").trim();
    const trim = readBoolean(input.trim) ?? readBoolean(config.trim) ?? true;
    const unwrapCodeFence = readBoolean(input.unwrapCodeFence) ?? readBoolean(config.unwrapCodeFence) ?? true;
    const acceptNonString = readBoolean(input.acceptNonString) ?? readBoolean(config.acceptNonString) ?? true;
    const raw = readRawValue(input, path);
    const metadata = { path, trim, unwrapCodeFence, acceptNonString };

    if (typeof raw !== "string") {
      if (acceptNonString) {
        const value = raw ?? null;
        return success("parsed", value, raw, "already_structured", "", metadata);
      }
      return success("invalid", null, raw, "input_is_not_string", "Input is not a string.", metadata);
    }

    const normalized = normalizeText(raw, {
      trim,
      unwrapCodeFence,
    });

    try {
      const value = JSON.parse(normalized.text) as unknown;
      ctx.log.debug("parse_json parsed text", {
        type: jsonType(value),
        reason: normalized.reason,
      });
      return success("parsed", value, raw, normalized.reason, "", metadata);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Invalid JSON.";
      ctx.log.debug("parse_json rejected text", { errorMessage: message });
      return success("invalid", null, raw, "invalid_json", message, metadata);
    }
  },
});

function readRawValue(input: Record<string, unknown>, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed !== "") return readPath(input, trimmed);
  return input.text ?? input.input ?? input.in ?? input.__runInput__ ?? "";
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

function normalizeText(
  value: string,
  options: { trim: boolean; unwrapCodeFence: boolean },
): { text: string; reason: string } {
  let text = options.trim ? value.trim() : value;
  let reason = options.trim ? "trimmed" : "raw";
  if (options.unwrapCodeFence) {
    const unwrapped = unwrapCodeFence(text);
    if (unwrapped !== text) {
      text = options.trim ? unwrapped.trim() : unwrapped;
      reason = "unwrapped_code_fence";
    }
  }
  return { text, reason };
}

function unwrapCodeFence(value: string): string {
  const match = value.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```$/);
  return match?.[1] ?? value;
}

function success(
  branch: "parsed" | "invalid",
  value: unknown,
  raw: unknown,
  status: string,
  errorMessage: string,
  metadata: {
    path: string;
    trim: boolean;
    unwrapCodeFence: boolean;
    acceptNonString: boolean;
  },
) {
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      value,
      raw,
      path: metadata.path,
      trim: metadata.trim,
      unwrapCodeFence: metadata.unwrapCodeFence,
      acceptNonString: metadata.acceptNonString,
      status,
      type: jsonType(value),
      errorMessage,
    },
  };
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
