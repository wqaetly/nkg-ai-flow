/**
 * `merge_object` - merge structured object payloads into one object.
 *
 * Useful after parallel data collection, default/config overlays, tool result
 * enrichment, and before HTTP/stringify steps that need a single payload.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

type MergeMode = "shallow" | "deep";
type NullMode = "keep" | "skip";
type NonObjectMode = "skip" | "wrap";

const mergeObjectConfig = z
  .object({
    mode: z
      .enum(["shallow", "deep"])
      .default("deep")
      .describe("Whether nested plain objects are merged recursively."),
    nullMode: z
      .enum(["keep", "skip"])
      .default("keep")
      .describe("Whether null and undefined property values override previous values."),
    nonObjectMode: z
      .enum(["skip", "wrap"])
      .default("skip")
      .describe("How non-object sources are handled."),
    scalarKey: z
      .string()
      .default("value")
      .describe("Key used when nonObjectMode is wrap."),
  })
  .passthrough();

export const mergeObjectNode = defineNode({
  type: "merge_object",
  typeVersion: "1.0.0",
  title: "Merge Object",
  description: "Merges multiple object sources into one structured payload.",
  config: mergeObjectConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      enumOptions: [
        { label: "Shallow", value: "shallow" },
        { label: "Deep", value: "deep" },
      ],
      order: 1,
    },
    nullMode: {
      label: "Null Mode",
      control: "select",
      enumOptions: [
        { label: "Keep", value: "keep" },
        { label: "Skip", value: "skip" },
      ],
      order: 2,
    },
    nonObjectMode: {
      label: "Non-object Mode",
      control: "select",
      enumOptions: [
        { label: "Skip", value: "skip" },
        { label: "Wrap", value: "wrap" },
      ],
      order: 3,
    },
    scalarKey: {
      label: "Scalar Key",
      control: "input",
      placeholder: "value",
      order: 4,
    },
  },
  ports: [
    {
      id: "objects",
      direction: "input",
      kind: "data",
      label: "Objects",
      multiple: true,
      schema: { type: "object" },
    },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "nullMode", direction: "input", kind: "data", label: "Null mode", schema: { type: "string" } },
    { id: "nonObjectMode", direction: "input", kind: "data", label: "Non-object mode", schema: { type: "string" } },
    { id: "scalarKey", direction: "input", kind: "data", label: "Scalar key", schema: { type: "string" } },
    {
      id: "value",
      direction: "output",
      kind: "data",
      label: "Merged object",
      schema: { type: "object" },
    },
    {
      id: "sources",
      direction: "output",
      kind: "data",
      label: "Sources",
      schema: { type: "array" },
    },
    {
      id: "skipped",
      direction: "output",
      kind: "data",
      label: "Skipped sources",
      schema: { type: "array" },
    },
    {
      id: "keys",
      direction: "output",
      kind: "data",
      label: "Keys",
      schema: { type: "array" },
    },
    {
      id: "sourceCount",
      direction: "output",
      kind: "data",
      label: "Source count",
      schema: { type: "number" },
    },
    {
      id: "skippedCount",
      direction: "output",
      kind: "data",
      label: "Skipped count",
      schema: { type: "number" },
    },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "nullMode", direction: "output", kind: "data", label: "Null mode", schema: { type: "string" } },
    { id: "nonObjectMode", direction: "output", kind: "data", label: "Non-object mode", schema: { type: "string" } },
    { id: "scalarKey", direction: "output", kind: "data", label: "Scalar key", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const rawSources = readSources(input);
    const options = {
      mode: readMode(input.mode ?? config.mode),
      nullMode: readNullMode(input.nullMode ?? config.nullMode),
      nonObjectMode: readNonObjectMode(input.nonObjectMode ?? config.nonObjectMode),
      scalarKey: String(input.scalarKey ?? config.scalarKey ?? "value") || "value",
    };
    const normalized = normalizeSources(rawSources, options);
    const value = mergeSources(normalized.sources, options);
    const keys = Object.keys(value);

    ctx.log.debug("merge_object merged sources", {
      sourceCount: normalized.sources.length,
      skippedCount: normalized.skipped.length,
      keyCount: keys.length,
      mode: options.mode,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        value,
        sources: normalized.sources,
        skipped: normalized.skipped,
        keys,
        sourceCount: normalized.sources.length,
        skippedCount: normalized.skipped.length,
        mode: options.mode,
        nullMode: options.nullMode,
        nonObjectMode: options.nonObjectMode,
        scalarKey: options.scalarKey,
      },
    };
  },
});

function readSources(input: Record<string, unknown>): unknown[] {
  if (input.objects !== undefined) return asList(input.objects);
  if (input.input !== undefined) return asList(input.input);
  if (input.in !== undefined) return asList(input.in);
  return [];
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function normalizeSources(
  values: unknown[],
  options: { nonObjectMode: NonObjectMode; scalarKey: string },
): { sources: Array<Record<string, unknown>>; skipped: unknown[] } {
  const sources: Array<Record<string, unknown>> = [];
  const skipped: unknown[] = [];
  for (const value of values) {
    if (isPlainObject(value)) {
      sources.push(value);
    } else if (options.nonObjectMode === "wrap" && value !== undefined) {
      sources.push({ [options.scalarKey]: value });
    } else {
      skipped.push(value);
    }
  }
  return { sources, skipped };
}

function mergeSources(
  sources: Array<Record<string, unknown>>,
  options: { mode: MergeMode; nullMode: NullMode },
): Record<string, unknown> {
  let target: Record<string, unknown> = {};
  for (const source of sources) {
    target =
      options.mode === "deep"
        ? deepMerge(target, source, options.nullMode)
        : shallowMerge(target, source, options.nullMode);
  }
  return target;
}

function shallowMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  nullMode: NullMode,
): Record<string, unknown> {
  const output = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (nullMode === "skip" && (value === null || value === undefined)) continue;
    output[key] = value;
  }
  return output;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  nullMode: NullMode,
): Record<string, unknown> {
  const output = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (nullMode === "skip" && (value === null || value === undefined)) continue;
    const previous = output[key];
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous, value, nullMode)
        : value;
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readMode(value: unknown): MergeMode {
  return value === "shallow" ? "shallow" : "deep";
}

function readNullMode(value: unknown): NullMode {
  return value === "skip" ? "skip" : "keep";
}

function readNonObjectMode(value: unknown): NonObjectMode {
  return value === "wrap" ? "wrap" : "skip";
}
