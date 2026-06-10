/**
 * Reference resolution.
 *
 * Inside a Flow JSON config, references resolve through the VariableStore:
 *
 *   { "$var":    "MODEL_DEFAULT" }      -> replaced with the variable value
 *   { "$secret": "LLM_API_KEY"   }      -> legacy alias for `$var`
 *
 * `resolveRefs(value, ctx)` walks an arbitrary JSON-like structure and
 * replaces every reference it finds, leaving non-reference values
 * untouched. This lets nodes consume their config the same way they would
 * if the values had been hard-coded:
 *
 *   const cfg = resolveRefs(node.config, ctx);
 *   const model = cfg.model;          // string
 *   const apiKey = cfg.apiKey;       // string
 *
 * Resolution is "all-or-nothing" per call: if any required variable /
 * legacy secret alias is missing, a structured `RuntimeError` is thrown. Use
 * `tryResolveRefs` to allow undefined fallbacks.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
} from "@ai-native-flow/flow-ir";
import { variableNotFound } from "./errors.js";
import {
  isSecretRef,
  isVariableRef,
  type VariableStore,
  type VariableValue,
} from "./types.js";

export interface ResolveContext {
  variables: VariableStore;
  /** Deprecated compatibility field. `$secret` now resolves via variables. */
  secrets?: VariableStore;
}

export interface ResolveOptions {
  /**
   * When true, missing references resolve to `undefined` instead of
   * throwing. Intended for diagnostic / preview tooling, not production
   * runs.
   */
  allowMissing?: boolean;
}

/**
 * Recursively resolve `$var` / `$secret` references in `value`. Returns a
 * fresh structure; the input is never mutated.
 */
export function resolveRefs(
  value: unknown,
  ctx: ResolveContext,
  options: ResolveOptions = {},
): unknown {
  if (isVariableRef(value)) {
    const v = ctx.variables.get(value.$var);
    if (v === undefined) {
      if (options.allowMissing) return undefined;
      throw new RuntimeErrorException(variableNotFound(value.$var));
    }
    return v;
  }
  if (isSecretRef(value)) {
    const v = ctx.variables.get(value.$secret);
    if (v === undefined) {
      if (options.allowMissing) return undefined;
      throw new RuntimeErrorException(variableNotFound(value.$secret));
    }
    return v;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, ctx, options));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveRefs(v, ctx, options);
    }
    return out;
  }
  return value;
}

/**
 * Collect every reference encountered inside a value, without resolving
 * them. Used by the Validator to ensure every reference in a Flow JSON
 * has a matching entry in the active stores BEFORE the run starts.
 */
export interface CollectedRefs {
  variables: string[];
  /** Deprecated compatibility bucket; `$secret` aliases are reported as variables. */
  secrets: string[];
}

export function collectRefs(value: unknown, into?: CollectedRefs): CollectedRefs {
  const acc = into ?? { variables: [], secrets: [] };
  walk(value, acc);
  return acc;
}

function walk(value: unknown, acc: CollectedRefs): void {
  if (isVariableRef(value)) {
    if (!acc.variables.includes(value.$var)) acc.variables.push(value.$var);
    return;
  }
  if (isSecretRef(value)) {
    if (!acc.variables.includes(value.$secret)) acc.variables.push(value.$secret);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, acc);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      walk(v, acc);
    }
  }
}

/**
 * Strongly-typed convenience for nodes that resolve a single value: returns
 * the value directly (string / number / boolean / object) and asserts the
 * expected type.
 */
export function resolveValue(
  value: unknown,
  ctx: ResolveContext,
): VariableValue {
  const resolved = resolveRefs(value, ctx);
  return resolved as VariableValue;
}

/** Throw a structured "missing references" error for the validator path. */
export function throwMissingRefs(missing: CollectedRefs, flowId: string): never {
  throw new RuntimeErrorException(
    createRuntimeError({
      code: "variable.missing_refs",
      kind: "validation",
      category: "user_input",
      message: `flow ${flowId} references undefined variables`,
      source: { module: "validator", flowId },
      context: { missing },
    }),
  );
}
