/**
 * Validation result types shared by every validator entry point.
 *
 * The Builder, the Validator and the Studio all consume these. Errors are
 * structured `RuntimeError` objects (see `flow-ir/errors`), warnings keep the
 * same shape but are advisory only.
 */

import type { RuntimeError } from "@ai-native-flow/flow-ir";

export interface ValidationResult {
  ok: boolean;
  errors: RuntimeError[];
  warnings: RuntimeError[];
}

export function emptyResult(): ValidationResult {
  return { ok: true, errors: [], warnings: [] };
}

export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const merged = emptyResult();
  for (const r of results) {
    merged.errors.push(...r.errors);
    merged.warnings.push(...r.warnings);
  }
  merged.ok = merged.errors.length === 0;
  return merged;
}
