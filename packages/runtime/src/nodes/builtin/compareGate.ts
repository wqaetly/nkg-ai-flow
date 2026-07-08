/**
 * `compare_gate` - typed comparison router.
 *
 * This is the explicit counterpart to tiny string conditions: it compares two
 * values with a configured operator, then routes the graph to matched or
 * unmatched while exposing the compared values and reason for downstream logs.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type CompareOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "in";

interface CompareResult {
  matched: boolean;
  reason: string;
}

const compareGateConfig = z
  .object({
    operator: z
      .enum([
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "starts_with",
        "ends_with",
        "matches",
        "in",
      ])
      .default("eq")
      .describe("Comparison operator."),
    leftPath: z
      .string()
      .default("")
      .describe("Optional dotted path read from the left input value."),
    rightPath: z
      .string()
      .default("")
      .describe("Optional dotted path read from the right input value."),
    rightValue: z
      .unknown()
      .optional()
      .describe("Static right value used when no right input is connected."),
    caseSensitive: z
      .boolean()
      .default(true)
      .describe("Whether string comparisons are case-sensitive."),
  })
  .passthrough();

export const compareGateNode = defineNode({
  type: "compare_gate",
  typeVersion: "1.0.0",
  title: "Compare Gate",
  description: "Routes based on a comparison between two values.",
  kind: "pseudo",
  config: compareGateConfig,
  fieldMeta: {
    operator: {
      label: "Operator",
      control: "select",
      order: 1,
      enumOptions: [
        { label: "Equals", value: "eq" },
        { label: "Not equals", value: "ne" },
        { label: "Greater than", value: "gt" },
        { label: "Greater or equal", value: "gte" },
        { label: "Less than", value: "lt" },
        { label: "Less or equal", value: "lte" },
        { label: "Contains", value: "contains" },
        { label: "Starts with", value: "starts_with" },
        { label: "Ends with", value: "ends_with" },
        { label: "Matches regex", value: "matches" },
        { label: "In", value: "in" },
      ],
    },
    leftPath: {
      label: "Left Path",
      control: "input",
      order: 2,
      placeholder: "order.total",
    },
    rightPath: {
      label: "Right Path",
      control: "input",
      order: 3,
      placeholder: "threshold",
    },
    rightValue: {
      label: "Right Value",
      control: "textarea",
      order: 4,
      placeholder: "Static comparison value.",
    },
    caseSensitive: {
      label: "Case Sensitive",
      control: "switch",
      order: 5,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "left", direction: "input", kind: "data", label: "Left" },
    { id: "right", direction: "input", kind: "data", label: "Right" },
    { id: "matched", direction: "output", kind: "control", label: "Matched" },
    { id: "unmatched", direction: "output", kind: "control", label: "Unmatched" },
    { id: "left", direction: "output", kind: "data", label: "Left" },
    { id: "right", direction: "output", kind: "data", label: "Right" },
    { id: "operator", direction: "output", kind: "data", label: "Operator", schema: { type: "string" } },
    { id: "result", direction: "output", kind: "data", label: "Result", schema: { type: "boolean" } },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const operator = readOperator(config.operator);
    const leftRoot = input.left ?? input.value ?? input.input ?? input.in ?? null;
    const rightRoot = input.right !== undefined ? input.right : config.rightValue ?? null;
    const left = selectValue(leftRoot, String(config.leftPath ?? ""));
    const right = selectValue(rightRoot, String(config.rightPath ?? ""));
    const result = compare(left, right, {
      operator,
      caseSensitive: config.caseSensitive !== false,
    });
    const branch = result.matched ? "matched" : "unmatched";

    ctx.log.debug("compare_gate selected branch", {
      branch,
      operator,
      reason: result.reason,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        left,
        right,
        operator,
        result: result.matched,
        reason: result.reason,
      },
    };
  },
});

function readOperator(value: unknown): CompareOperator {
  return value === "ne" ||
    value === "gt" ||
    value === "gte" ||
    value === "lt" ||
    value === "lte" ||
    value === "contains" ||
    value === "starts_with" ||
    value === "ends_with" ||
    value === "matches" ||
    value === "in"
    ? value
    : "eq";
}

function selectValue(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return value;
  const selected = readPath(value, trimmed);
  return selected === undefined ? null : selected;
}

function compare(
  left: unknown,
  right: unknown,
  options: {
    operator: CompareOperator;
    caseSensitive: boolean;
  },
): CompareResult {
  switch (options.operator) {
    case "eq":
      return result(compareScalar(left, right, options.caseSensitive), "eq");
    case "ne":
      return result(!compareScalar(left, right, options.caseSensitive), "ne");
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareOrdered(left, right, options.operator);
    case "contains":
      return compareContains(left, right, options.caseSensitive);
    case "starts_with":
      return compareText(left, right, options.caseSensitive, "starts_with");
    case "ends_with":
      return compareText(left, right, options.caseSensitive, "ends_with");
    case "matches":
      return compareRegex(left, right, options.caseSensitive);
    case "in":
      return compareIn(left, right, options.caseSensitive);
  }
}

function compareScalar(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  if (typeof left === "string" && typeof right === "string" && !caseSensitive) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function compareOrdered(
  left: unknown,
  right: unknown,
  operator: Extract<CompareOperator, "gt" | "gte" | "lt" | "lte">,
): CompareResult {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    return { matched: false, reason: "not_comparable" };
  }
  if (operator === "gt") return result(leftNumber > rightNumber, "gt");
  if (operator === "gte") return result(leftNumber >= rightNumber, "gte");
  if (operator === "lt") return result(leftNumber < rightNumber, "lt");
  return result(leftNumber <= rightNumber, "lte");
}

function compareContains(left: unknown, right: unknown, caseSensitive: boolean): CompareResult {
  if (Array.isArray(left)) {
    return result(left.some((item) => compareScalar(item, right, caseSensitive)), "contains");
  }
  const leftText = normalizeText(left, caseSensitive);
  const rightText = normalizeText(right, caseSensitive);
  return result(leftText.includes(rightText), "contains");
}

function compareText(
  left: unknown,
  right: unknown,
  caseSensitive: boolean,
  operator: Extract<CompareOperator, "starts_with" | "ends_with">,
): CompareResult {
  const leftText = normalizeText(left, caseSensitive);
  const rightText = normalizeText(right, caseSensitive);
  return result(
    operator === "starts_with" ? leftText.startsWith(rightText) : leftText.endsWith(rightText),
    operator,
  );
}

function compareRegex(left: unknown, right: unknown, caseSensitive: boolean): CompareResult {
  try {
    const regex = new RegExp(String(right ?? ""), caseSensitive ? "" : "i");
    return result(regex.test(String(left ?? "")), "matches");
  } catch {
    return { matched: false, reason: "invalid_pattern" };
  }
}

function compareIn(left: unknown, right: unknown, caseSensitive: boolean): CompareResult {
  const values = Array.isArray(right)
    ? right
    : String(right ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  return result(values.some((item) => compareScalar(left, item, caseSensitive)), "in");
}

function normalizeText(value: unknown, caseSensitive: boolean): string {
  const text = String(value ?? "");
  return caseSensitive ? text : text.toLowerCase();
}

function result(matched: boolean, operator: string): CompareResult {
  return { matched, reason: matched ? `${operator}_matched` : `${operator}_unmatched` };
}
