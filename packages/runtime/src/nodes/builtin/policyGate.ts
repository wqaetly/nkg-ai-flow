/**
 * `policy_gate` - explicit business policy gate.
 *
 * This node is deliberately stricter than a generic condition: authors list
 * one rule per line, and the node emits a full decision summary while routing
 * to `allowed` or `denied`.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn, readPath } from "./_helpers.js";

type PolicyMode = "all" | "any";
type PolicyOperator = "truthy" | "falsy" | "==" | "!=" | ">" | ">=" | "<" | "<=";

interface PolicyRule {
  text: string;
  path: string;
  operator: PolicyOperator;
  expected?: unknown;
}

interface PolicyRuleResult {
  rule: string;
  path: string;
  operator: PolicyOperator;
  passed: boolean;
  actual: unknown;
  expected?: unknown;
}

const policyGateConfig = z
  .object({
    mode: z.enum(["all", "any"]).default("all").describe("Rule match mode."),
    rules: z
      .string()
      .default("")
      .describe("Line-separated policy rules. Supports path, !path, ==, !=, >, >=, <, <=."),
    reason: z
      .string()
      .default("")
      .describe("Optional denial reason emitted when the policy gate denies."),
  })
  .passthrough();

export const policyGateNode = defineNode({
  type: "policy_gate",
  typeVersion: "1.0.0",
  title: "Policy Gate",
  description: "Routes execution to allowed or denied after evaluating business rules.",
  kind: "pseudo",
  config: policyGateConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      order: 1,
      enumOptions: [
        { label: "All rules", value: "all" },
        { label: "Any rule", value: "any" },
      ],
    },
    rules: {
      label: "Rules",
      control: "textarea",
      order: 2,
      placeholder: 'amount <= 100\ncustomer.tier == "gold"\napproved',
    },
    reason: {
      label: "Reason",
      control: "input",
      order: 3,
      placeholder: "Policy check failed",
    },
  },
  ports: [
    controlIn,
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "rules", direction: "input", kind: "data", label: "Rules", schema: { type: "string" } },
    { id: "reason", direction: "input", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "allowed", direction: "output", kind: "control", label: "Allowed" },
    { id: "denied", direction: "output", kind: "control", label: "Denied" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "rules", direction: "output", kind: "data", label: "Rules", schema: { type: "string" } },
    { id: "ruleCount", direction: "output", kind: "data", label: "Rule Count", schema: { type: "number" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "passed", direction: "output", kind: "data", label: "Passed rules" },
    { id: "failed", direction: "output", kind: "data", label: "Failed rules" },
    { id: "results", direction: "output", kind: "data", label: "Rule results" },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "all";
    const ruleSource = String(input.rules ?? config.rules ?? "");
    const rules = parseRules(ruleSource);
    const invalid = rules.find((rule) => rule instanceof Error);
    if (invalid instanceof Error) {
      return error(
        "node.policy_gate.invalid_rule",
        invalid.message,
        ctx.nodeId,
      );
    }

    const parsedRules = rules as PolicyRule[];
    const payload = input.input ?? input.in ?? input.__runInput__ ?? input;

    if (parsedRules.length === 0) {
      return decision({
        status: "denied",
        reason: "no_rules",
        results: [],
        mode,
        rules: ruleSource,
      });
    }

    const results = parsedRules.map((rule) => evaluateRule(rule, payload));
    const allowed = isAllowed(mode, results);
    const failed = results.filter((result) => !result.passed).map((result) => result.rule);
    const status = allowed ? "allowed" : "denied";
    const reason = allowed
      ? ""
      : String(input.reason ?? config.reason ?? "").trim() || `failed_rules:${failed.join(",")}`;

    ctx.log.debug("policy_gate selected branch", {
      mode,
      status,
      passed: results.length - failed.length,
      failed: failed.length,
    });

    return decision({ status, reason, results, mode, rules: ruleSource });
  },
});

function readMode(value: unknown): PolicyMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "all" || normalized === "any" ? normalized : undefined;
}

function parseRules(source: string): Array<PolicyRule | Error> {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map(parseRule);
}

function parseRule(text: string): PolicyRule | Error {
  const comparison = text.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (comparison) {
    const [, path, operator, rawExpected] = comparison;
    const expected = parseExpectedValue(rawExpected!);
    if (expected instanceof Error) return expected;
    return {
      text,
      path: path!,
      operator: operator as PolicyOperator,
      expected,
    };
  }

  const negated = text.startsWith("!");
  const path = negated ? text.slice(1).trim() : text;
  if (!/^[\w.]+$/.test(path)) {
    return new Error(`Invalid policy rule: ${text}`);
  }
  return {
    text,
    path,
    operator: negated ? "falsy" : "truthy",
  };
}

function parseExpectedValue(source: string): unknown | Error {
  const trimmed = source.trim();
  if (trimmed === "") return new Error("Policy comparison requires a value.");
  const quoted = trimmed.match(/^"(.*)"$/) ?? trimmed.match(/^'(.*)'$/);
  if (quoted) return quoted[1] ?? "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  return trimmed;
}

function evaluateRule(rule: PolicyRule, payload: unknown): PolicyRuleResult {
  const actual = readPath(payload, rule.path);
  let passed = false;

  switch (rule.operator) {
    case "truthy":
      passed = Boolean(actual);
      break;
    case "falsy":
      passed = !actual;
      break;
    case "==":
      passed = actual === rule.expected;
      break;
    case "!=":
      passed = actual !== rule.expected;
      break;
    case ">":
    case ">=":
    case "<":
    case "<=":
      passed = compareNumbers(actual, rule.expected, rule.operator);
      break;
  }

  return {
    rule: rule.text,
    path: rule.path,
    operator: rule.operator,
    passed,
    actual,
    expected: rule.expected,
  };
}

function compareNumbers(
  actual: unknown,
  expected: unknown,
  operator: ">" | ">=" | "<" | "<=",
): boolean {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) {
    return false;
  }
  if (operator === ">") return actualNumber > expectedNumber;
  if (operator === ">=") return actualNumber >= expectedNumber;
  if (operator === "<") return actualNumber < expectedNumber;
  return actualNumber <= expectedNumber;
}

function isAllowed(mode: PolicyMode, results: PolicyRuleResult[]): boolean {
  if (mode === "any") return results.some((result) => result.passed);
  return results.every((result) => result.passed);
}

function decision(args: {
  status: "allowed" | "denied";
  reason: string;
  results: PolicyRuleResult[];
  mode: PolicyMode;
  rules: string;
}) {
  const passed = args.results
    .filter((result) => result.passed)
    .map((result) => result.rule);
  const failed = args.results
    .filter((result) => !result.passed)
    .map((result) => result.rule);
  const summary = {
    status: args.status,
    mode: args.mode,
    rules: args.rules,
    ruleCount: args.results.length,
    passed,
    failed,
    results: args.results,
    reason: args.reason,
  };
  return {
    kind: "success" as const,
    outputs: {
      [args.status]: null,
      mode: args.mode,
      rules: args.rules,
      ruleCount: args.results.length,
      status: args.status,
      passed,
      failed,
      results: args.results,
      reason: args.reason,
      summary,
    },
  };
}

function error(
  code: string,
  message: string,
  nodeId: string,
): {
  kind: "error";
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
} {
  return {
    kind: "error",
    error: createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "node_logic", nodeId },
    }) as unknown as {
      code: string;
      message: string;
      [key: string]: unknown;
    },
  };
}
