/**
 * `fail_fast` - first failure detector.
 *
 * Intended for parallel branches: wire branch error outputs into this
 * node and it can route as soon as the first failure arrives, without
 * waiting for sibling error edges that may never fire.
 */

import { defineNode } from "@ai-native-flow/node-sdk";

export const failFastNode = defineNode({
  type: "fail_fast",
  typeVersion: "1.0.0",
  title: "Fail Fast",
  description: "Routes when the first branch failure arrives.",
  kind: "pseudo",
  ports: [
    {
      id: "in",
      direction: "input",
      kind: "control",
      label: "Inputs",
      multiple: true,
    },
    {
      id: "errors",
      direction: "input",
      kind: "data",
      label: "Errors",
      multiple: true,
    },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "clear", direction: "output", kind: "control", label: "Clear" },
    { id: "error", direction: "output", kind: "data", label: "First error" },
    { id: "errors", direction: "output", kind: "data", label: "Errors" },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "hasFailure", direction: "output", kind: "data", label: "Has Failure", schema: { type: "boolean" } },
    { id: "failedIndex", direction: "output", kind: "data", label: "Failed Index", schema: { type: "number" } },
    { id: "errorCode", direction: "output", kind: "data", label: "Error Code", schema: { type: "string" } },
    { id: "errorMessage", direction: "output", kind: "data", label: "Error Message", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, ctx }) {
    const rawErrors = normalizeErrors(input.errors);
    const failedIndex = rawErrors.findIndex(isPresent);
    const hasFailure = failedIndex >= 0;
    const errors = rawErrors.filter(isPresent);
    const error = hasFailure ? rawErrors[failedIndex] : null;
    const { errorCode, errorMessage } = describeError(error);
    const status = hasFailure ? "failed" : "clear";

    ctx.log.debug("fail_fast evaluated errors", {
      status,
      failedIndex,
      count: errors.length,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        error,
        errors,
        count: errors.length,
        hasFailure,
        failedIndex,
        errorCode,
        errorMessage,
        status,
      },
    };
  },
});

function normalizeErrors(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function describeError(error: unknown): { errorCode: string; errorMessage: string } {
  if (!isPresent(error)) return { errorCode: "", errorMessage: "" };
  if (typeof error === "string") return { errorCode: "", errorMessage: error };
  if (error instanceof Error) return { errorCode: "", errorMessage: error.message };
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      errorCode: typeof record.code === "string" ? record.code : "",
      errorMessage: typeof record.message === "string" ? record.message : "",
    };
  }
  return { errorCode: "", errorMessage: String(error) };
}
