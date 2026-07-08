/**
 * `empty_gate` - generic empty/non-empty router.
 *
 * Query results, form fields, object payloads, and optional values often need
 * the same explicit branch: continue with data when it exists, or take a
 * fallback path when it is empty. This node keeps that decision visible in the
 * graph instead of burying it in templates or bespoke condition expressions.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type EmptyGateMode = "auto" | "array" | "object" | "string" | "present";
type EmptyGateBranch = "empty" | "non_empty";

interface EmptyGateDecision {
  branch: EmptyGateBranch;
  reason: string;
  count: number;
  keys: string[];
  items: unknown[];
}

const emptyGateConfig = z
  .object({
    mode: z
      .enum(["auto", "array", "object", "string", "present"])
      .default("auto")
      .describe("How the selected value is interpreted before checking emptiness."),
    path: z
      .string()
      .default("")
      .describe("Optional dotted path read from the input value before evaluation."),
    trimStrings: z
      .boolean()
      .default(true)
      .describe("Whether string mode trims whitespace before checking emptiness."),
  })
  .passthrough();

export const emptyGateNode = defineNode({
  type: "empty_gate",
  typeVersion: "1.0.0",
  title: "Empty Gate",
  description: "Routes values to empty or non-empty branches.",
  kind: "pseudo",
  config: emptyGateConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      order: 1,
      enumOptions: [
        { label: "Auto", value: "auto" },
        { label: "Array", value: "array" },
        { label: "Object", value: "object" },
        { label: "String", value: "string" },
        { label: "Present", value: "present" },
      ],
    },
    path: {
      label: "Path",
      control: "input",
      order: 2,
      placeholder: "items",
    },
    trimStrings: {
      label: "Trim Strings",
      control: "switch",
      order: 3,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "trimStrings", direction: "input", kind: "data", label: "Trim strings", schema: { type: "boolean" } },
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "non_empty", direction: "output", kind: "control", label: "Non-empty" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "trimStrings", direction: "output", kind: "data", label: "Trim strings", schema: { type: "boolean" } },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "selected", direction: "output", kind: "data", label: "Selected Value" },
    { id: "items", direction: "output", kind: "data", label: "Items" },
    { id: "keys", direction: "output", kind: "data", label: "Keys" },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "isEmpty", direction: "output", kind: "data", label: "Is Empty", schema: { type: "boolean" } },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const value = input.value ?? input.input ?? input.in ?? null;
    const path = String(input.path ?? config.path ?? "");
    const selected = selectValue(value, path);
    const mode = readMode(input.mode ?? config.mode);
    const trimStrings = readBoolean(input.trimStrings) ?? readBoolean(config.trimStrings) ?? true;
    const decision = decide(selected, {
      mode,
      trimStrings,
    });

    ctx.log.debug("empty_gate selected branch", {
      branch: decision.branch,
      reason: decision.reason,
      count: decision.count,
      mode,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        mode,
        path,
        trimStrings,
        value,
        selected,
        items: decision.items,
        keys: decision.keys,
        count: decision.count,
        isEmpty: decision.branch === "empty",
        reason: decision.reason,
      },
    };
  },
});

function readMode(value: unknown): EmptyGateMode {
  return value === "array" || value === "object" || value === "string" || value === "present"
    ? value
    : "auto";
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function selectValue(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return value;
  const selected = readPath(value, trimmed);
  return selected === undefined ? null : selected;
}

function decide(
  value: unknown,
  options: {
    mode: EmptyGateMode;
    trimStrings: boolean;
  },
): EmptyGateDecision {
  const mode = options.mode === "auto" ? inferMode(value) : options.mode;
  if (mode === "array") return decideArray(value);
  if (mode === "object") return decideObject(value);
  if (mode === "string") return decideString(value, options.trimStrings);
  return decidePresent(value);
}

function inferMode(value: unknown): EmptyGateMode {
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (value && typeof value === "object") return "object";
  return "present";
}

function decideArray(value: unknown): EmptyGateDecision {
  const items = Array.isArray(value) ? value : [];
  return {
    branch: items.length === 0 ? "empty" : "non_empty",
    reason: items.length === 0 ? "array_empty" : "array_non_empty",
    count: items.length,
    keys: [],
    items,
  };
}

function decideObject(value: unknown): EmptyGateDecision {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const keys = Object.keys(record);
  return {
    branch: keys.length === 0 ? "empty" : "non_empty",
    reason: keys.length === 0 ? "object_empty" : "object_non_empty",
    count: keys.length,
    keys,
    items: keys.map((key) => record[key]),
  };
}

function decideString(value: unknown, trimStrings: boolean): EmptyGateDecision {
  const text = value === undefined || value === null ? "" : String(value);
  const normalized = trimStrings ? text.trim() : text;
  return {
    branch: normalized.length === 0 ? "empty" : "non_empty",
    reason: normalized.length === 0 ? "string_empty" : "string_non_empty",
    count: normalized.length,
    keys: [],
    items: normalized === "" ? [] : [normalized],
  };
}

function decidePresent(value: unknown): EmptyGateDecision {
  const present = value !== undefined && value !== null;
  return {
    branch: present ? "non_empty" : "empty",
    reason: present ? "value_present" : "value_missing",
    count: present ? 1 : 0,
    keys: [],
    items: present ? [value] : [],
  };
}
