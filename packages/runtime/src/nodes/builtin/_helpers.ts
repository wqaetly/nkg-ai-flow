/**
 * Shared port literals and pure helpers used by the built-in nodes.
 *
 * These intentionally live outside any single node file because:
 *
 *   - the same control / error port shapes are used by start, end,
 *     condition (and any future control-flow node),
 *   - `renderTemplate` is needed by both `transform` and `llm`,
 *   - `evaluateCondition` is small enough that pulling it out keeps
 *     `condition.ts` readable while still allowing isolated unit
 *     tests against the helper directly.
 *
 * Helpers here MUST stay pure (no `ctx`, no I/O) so that they can be
 * tested without spinning up the runtime; node-specific orchestration
 * stays in the node files.
 */

import type { PortDefinition } from "@ai-native-flow/flow-ir";

/* -------------------------------------------------------------------------- */
/* Shared port literals (mirror flow-ir's BUILTIN_* definitions)              */
/* -------------------------------------------------------------------------- */

export const controlIn: PortDefinition = {
  id: "in",
  direction: "input",
  kind: "control",
  label: "运行",
};

export const controlOut: PortDefinition = {
  id: "out",
  direction: "output",
  kind: "control",
  label: "下一步",
};

export const errorOut: PortDefinition = {
  id: "error",
  direction: "output",
  kind: "error",
  label: "错误",
};

/* -------------------------------------------------------------------------- */
/* Template rendering (transform + llm)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Substitutes `${path.to.field}` placeholders in `template` with values
 * read from `input`. Missing paths render as the empty string, matching
 * the Phase 1 behaviour expected by the built-in `transform` and `llm`
 * nodes.
 */
export function renderTemplate(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const path = expr.trim().split(".");
    let cursor: unknown = input;
    for (const segment of path) {
      if (
        cursor &&
        typeof cursor === "object" &&
        segment in (cursor as Record<string, unknown>)
      ) {
        cursor = (cursor as Record<string, unknown>)[segment];
      } else {
        return "";
      }
    }
    return cursor === undefined || cursor === null ? "" : String(cursor);
  });
}

/* -------------------------------------------------------------------------- */
/* 条件判断 evaluation (condition node)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Tiny safe condition evaluator. Supports:
 *
 *   - `""`                         -> Boolean(input.input)
 *   - `field`                      -> Boolean(readPath(input, "field"))
 *   - `!field`                     -> !Boolean(readPath(input, "field"))
 *   - `field == "literal"`         -> equality against a literal
 *   - `field != 3`                 -> inequality against a numeric literal
 *   - `field >= 10 && enabled`     -> boolean composition
 *   - `contains(tags, "ready")`     -> small allowlisted helpers
 *
 * Anything outside this grammar returns `undefined` / `false`. It is not
 * arbitrary JavaScript; keep it deterministic and side-effect free.
 */
export function evaluateCondition(
  expression: string,
  input: Record<string, unknown>,
): boolean {
  if (expression === "") return Boolean(input.input);
  return Boolean(evaluateExpression(expression, input));
}

export function evaluateExpression(
  expression: string,
  input: Record<string, unknown>,
): unknown {
  const body = expression.trim();
  if (body === "") return input.input ?? input.in ?? null;

  const orParts = splitTopLevel(body, "||");
  if (orParts.length > 1) {
    return orParts.some((part) => Boolean(evaluateExpression(part, input)));
  }

  const andParts = splitTopLevel(body, "&&");
  if (andParts.length > 1) {
    return andParts.every((part) => Boolean(evaluateExpression(part, input)));
  }

  if (body.startsWith("!") && !body.startsWith("!=")) {
    return !Boolean(evaluateExpression(body.slice(1), input));
  }

  const wrapped = unwrapParens(body);
  if (wrapped !== body) return evaluateExpression(wrapped, input);

  const comparison = findTopLevelComparison(body);
  if (comparison) {
    const left = evaluateOperand(comparison.left, input);
    const right = evaluateOperand(comparison.right, input);
    return compareValues(left, right, comparison.op);
  }

  return evaluateOperand(body, input);
}

/**
 * Reads a dotted path out of an arbitrary value, returning `undefined`
 * if any segment is missing or non-object.
 */
export function readPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const segment of parsePathSegments(path)) {
    if (
      cursor &&
      typeof cursor === "object" &&
      segment in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function evaluateOperand(expression: string, input: Record<string, unknown>): unknown {
  const body = expression.trim();
  if (body === "") return undefined;
  if (body.startsWith("(") && body.endsWith(")")) {
    return evaluateExpression(body, input);
  }
  if (
    (body.startsWith("\"") && body.endsWith("\"")) ||
    (body.startsWith("'") && body.endsWith("'"))
  ) {
    return body.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  if (/^-?\d+(\.\d+)?$/.test(body)) return Number(body);
  if (body === "true") return true;
  if (body === "false") return false;
  if (body === "null") return null;
  if (body === "undefined") return undefined;

  const call = body.match(/^([A-Za-z_]\w*)\((.*)\)$/);
  if (call) {
    const [, name, rawArgs] = call;
    const args = splitArguments(rawArgs ?? "").map((arg) => evaluateExpression(arg, input));
    return evaluateFunction(name ?? "", args);
  }

  return readPath(input, body);
}

function evaluateFunction(name: string, args: unknown[]): unknown {
  const [value, expected] = args;
  if (name === "contains") {
    if (Array.isArray(value)) return value.some((item) => valuesEqual(item, expected));
    if (typeof value === "string") return value.includes(String(expected ?? ""));
    return false;
  }
  if (name === "startsWith") {
    return typeof value === "string" && value.startsWith(String(expected ?? ""));
  }
  if (name === "endsWith") {
    return typeof value === "string" && value.endsWith(String(expected ?? ""));
  }
  if (name === "matches") {
    if (typeof value !== "string" || typeof expected !== "string") return false;
    try {
      return new RegExp(expected).test(value);
    } catch {
      return false;
    }
  }
  return undefined;
}

function compareValues(left: unknown, right: unknown, op: string): boolean {
  if (op === "==" || op === "!=") {
    const equal = valuesEqual(left, right);
    return op === "==" ? equal : !equal;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const a = numeric ? leftNumber : String(left ?? "");
  const b = numeric ? rightNumber : String(right ?? "");
  if (op === ">") return a > b;
  if (op === ">=") return a >= b;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const scalarLeft = left === null || ["string", "number", "boolean"].includes(typeof left);
  const scalarRight = right === null || ["string", "number", "boolean"].includes(typeof right);
  return scalarLeft && scalarRight && String(left) === String(right);
}

function findTopLevelComparison(
  expression: string,
): { left: string; op: string; right: string } | undefined {
  for (const op of [">=", "<=", "==", "!=", ">", "<"]) {
    const index = findTopLevelOperator(expression, op);
    if (index >= 0) {
      return {
        left: expression.slice(0, index).trim(),
        op,
        right: expression.slice(index + op.length).trim(),
      };
    }
  }
  return undefined;
}

function splitTopLevel(expression: string, operator: "||" | "&&"): string[] {
  const parts: string[] = [];
  let start = 0;
  let cursor = 0;
  while (cursor < expression.length) {
    const index = findTopLevelOperator(expression.slice(cursor), operator);
    if (index < 0) break;
    const absolute = cursor + index;
    parts.push(expression.slice(start, absolute).trim());
    cursor = absolute + operator.length;
    start = cursor;
  }
  if (parts.length === 0) return [expression];
  parts.push(expression.slice(start).trim());
  return parts;
}

function splitArguments(args: string): string[] {
  if (args.trim() === "") return [];
  const parts: string[] = [];
  let quote: "\"" | "'" | undefined;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    const prev = args[index - 1];
    if ((char === "\"" || char === "'") && prev !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(args.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts;
}

function findTopLevelOperator(expression: string, operator: string): number {
  let quote: "\"" | "'" | undefined;
  let depth = 0;
  for (let index = 0; index <= expression.length - operator.length; index += 1) {
    const char = expression[index];
    const prev = expression[index - 1];
    if ((char === "\"" || char === "'") && prev !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && expression.slice(index, index + operator.length) === operator) {
      return index;
    }
  }
  return -1;
}

function unwrapParens(expression: string): string {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return expression;
  let quote: "\"" | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    const prev = expression[index - 1];
    if ((char === "\"" || char === "'") && prev !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < expression.length - 1) return expression;
  }
  return expression.slice(1, -1).trim();
}

function parsePathSegments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}
