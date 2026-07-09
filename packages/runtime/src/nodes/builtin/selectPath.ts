/**
 * `select_path` - project a nested value out of structured flow data.
 *
 * It makes field extraction explicit on the canvas, instead of hiding path
 * reads inside templates or downstream nodes.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

const selectPathConfig = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Dotted/bracket path to read, e.g. order.items[0].sku."),
    defaultValue: z
      .unknown()
      .optional()
      .describe("Value emitted when the path is missing."),
  })
  .passthrough();

export const selectPathNode = defineNode({
  type: "select_path",
  typeVersion: "1.0.0",
  title: "Select Path",
  description: "Extracts a nested value from structured input and routes missing paths.",
  kind: "pseudo",
  config: selectPathConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "order.items[0].sku",
      order: 1,
    },
    defaultValue: {
      label: "Default Value",
      control: "textarea",
      order: 2,
    },
  },
  ports: [
    controlIn,
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "defaultValue", direction: "input", kind: "data", label: "Default value" },
    { id: "found", direction: "output", kind: "control", label: "Found" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "value", direction: "output", kind: "data", label: "Selected value" },
    { id: "source", direction: "output", kind: "data", label: "Source value" },
    {
      id: "exists",
      direction: "output",
      kind: "data",
      label: "Exists",
      schema: { type: "boolean" },
    },
    {
      id: "path",
      direction: "output",
      kind: "data",
      label: "Path",
      schema: { type: "string" },
    },
    { id: "defaultValue", direction: "output", kind: "data", label: "Default value" },
    {
      id: "type",
      direction: "output",
      kind: "data",
      label: "Type",
      schema: { type: "string" },
    },
    {
      id: "reason",
      direction: "output",
      kind: "data",
      label: "Reason",
      schema: { type: "string" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = readSource(input);
    const path = String(input.path ?? config.path ?? "").trim();
    const selected = selectValue(source, path);
    const hasInputDefault = Object.prototype.hasOwnProperty.call(input, "defaultValue");
    const hasConfigDefault = Object.prototype.hasOwnProperty.call(config, "defaultValue");
    const hasDefault = hasInputDefault || hasConfigDefault;
    const defaultValue = hasInputDefault ? input.defaultValue : config.defaultValue;
    const exists = selected.exists;
    const value = exists ? selected.value : hasDefault ? defaultValue : null;
    const branch = exists ? "found" : "missing";
    const reason = exists
      ? path === ""
        ? "selected_source"
        : "selected_path"
      : hasDefault
        ? "missing_default"
        : "missing_null";
    const type = valueType(value);
    const summary = {
      branch,
      path,
      exists,
      hasDefault,
      type,
      reason,
    };

    ctx.log.debug("select_path selected value", {
      path,
      exists,
      type,
      reason,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        value,
        source,
        exists,
        path,
        defaultValue: hasDefault ? defaultValue : null,
        type,
        reason,
        summary,
      },
    };
  },
});

function readSource(input: Record<string, unknown>): unknown {
  return input.value ?? input.input ?? input.in ?? input.__runInput__ ?? null;
}

function selectValue(source: unknown, path: string): { exists: boolean; value: unknown } {
  if (path === "") return { exists: true, value: source };
  const segments = parsePath(path);
  if (segments.length === 0) return { exists: false, value: undefined };

  let cursor = source;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return { exists: false, value: undefined };
    if (Array.isArray(cursor)) {
      const index = readArrayIndex(segment);
      if (index === undefined || index < 0 || index >= cursor.length) {
        return { exists: false, value: undefined };
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor === "object" && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment];
      continue;
    }
    return { exists: false, value: undefined };
  }
  return { exists: true, value: cursor };
}

function parsePath(path: string): string[] {
  const segments: string[] = [];
  const pattern = /([^[.\]]+)|\[(\d+|(["'])(.*?)\3)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    const bare = match[1];
    const bracket = match[2];
    const quoted = match[4];
    segments.push(quoted ?? bracket ?? bare ?? "");
  }
  return segments.filter((segment) => segment !== "");
}

function readArrayIndex(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
