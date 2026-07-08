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
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, ctx }) {
    const errors = normalizeErrors(input.errors).filter(isPresent);
    const error = errors[0] ?? null;
    const status = error ? "failed" : "clear";

    ctx.log.debug("fail_fast evaluated errors", {
      status,
      count: errors.length,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        error,
        errors,
        count: errors.length,
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
