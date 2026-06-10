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
 *   - `""`                     -> Boolean(input.input)
 *   - `field`                  -> Boolean(readPath(input, "field"))
 *   - `!field`                 -> !Boolean(readPath(input, "field"))
 *   - `field == "literal"`     -> equality against a string literal
 *   - `field != "literal"`     -> inequality against a string literal
 *
 * Anything outside this grammar evaluates to `false`. A real expression
 * evaluator lands in Phase 3 alongside the sandboxed Node Logic
 * Provider.
 */
export function evaluateCondition(
  expression: string,
  input: Record<string, unknown>,
): boolean {
  if (expression === "") return Boolean(input.input);
  const negated = expression.startsWith("!");
  const body = negated ? expression.slice(1).trim() : expression.trim();
  const eqMatch = body.match(/^([\w.]+)\s*(==|!=)\s*"(.*)"$/);
  if (eqMatch) {
    const [, path, op, literal] = eqMatch;
    const actual = readPath(input, path!);
    const equal = actual === literal;
    return op === "==" ? equal : !equal;
  }
  const truthy = Boolean(readPath(input, body));
  return negated ? !truthy : truthy;
}

/**
 * Reads a dotted path out of an arbitrary value, returning `undefined`
 * if any segment is missing or non-object.
 */
export function readPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const segment of path.split(".")) {
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
