/**
 * Shape-level validation: a Flow JSON object is structurally valid against
 * the Zod schemas defined in `flow-ir`.
 *
 * This layer **does not** check graph semantics (port directions, missing
 * nodes, etc.). Those checks live in `validateGraph.ts`. Splitting them keeps
 * error codes precise so AI agents can self-repair specific mistakes.
 */

import {
  FlowGraphSchema,
  SUPPORTED_FLOW_GRAPH_SCHEMA_VERSIONS,
  createRuntimeError,
  type FlowGraph,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import { emptyResult, type ValidationResult } from "./result.js";

/**
 * Validate the structural shape of a candidate Flow JSON.
 *
 * On success, returns the parsed `FlowGraph`. On failure, the `result`
 * object holds one or more `validator.schema_invalid` errors and `flow` is
 * `undefined`. Callers (Builder.dump, builder-runner) should bail out on
 * `!ok`.
 */
export function validateSchema(input: unknown): {
  result: ValidationResult;
  flow?: FlowGraph;
} {
  const result = emptyResult();

  // Pre-check schemaVersion separately so we can return the documented
  // `validator.schema_version_unsupported` code instead of a generic
  // `validator.schema_invalid`. The error model spec mentions this code
  // explicitly and Phase 1+ runtimes will branch on it.
  if (input && typeof input === "object") {
    const sv = (input as { schemaVersion?: unknown }).schemaVersion;
    if (typeof sv === "string" && !isSupportedSchemaVersion(sv)) {
      result.errors.push(unsupportedSchemaVersion(sv));
      result.ok = false;
      return { result };
    }
  }

  const parsed = FlowGraphSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      result.errors.push(zodIssueToError(issue));
    }
    result.ok = false;
    return { result };
  }

  return { result, flow: parsed.data as FlowGraph };
}

function isSupportedSchemaVersion(sv: string): boolean {
  return (SUPPORTED_FLOW_GRAPH_SCHEMA_VERSIONS as readonly string[]).includes(sv);
}

function unsupportedSchemaVersion(sv: string): RuntimeError {
  return createRuntimeError({
    code: "validator.schema_version_unsupported",
    kind: "validation",
    category: "user_input",
    message: `unsupported schemaVersion: ${sv}`,
    source: { module: "validator" },
    context: { schemaVersion: sv, supported: [...SUPPORTED_FLOW_GRAPH_SCHEMA_VERSIONS] },
  });
}

interface ZodIssueLike {
  path: (string | number)[];
  message: string;
  code: string;
}

function zodIssueToError(issue: ZodIssueLike): RuntimeError {
  const path = issue.path.join(".");
  return createRuntimeError({
    code: "validator.schema_invalid",
    kind: "validation",
    category: "user_input",
    message: path
      ? `schema invalid at "${path}": ${issue.message}`
      : `schema invalid: ${issue.message}`,
    source: { module: "validator" },
    context: { path, zodCode: issue.code },
  });
}
