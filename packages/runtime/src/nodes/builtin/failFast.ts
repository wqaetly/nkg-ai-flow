/**
 * `fail_fast` - first failure detector.
 *
 * Intended for parallel branches: wire branch error outputs into this
 * node and it can route as soon as the first failure arrives, without
 * waiting for sibling error edges that may never fire.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

interface ErrorEvaluation {
  index: number;
  error: unknown;
  present: boolean;
  failed: boolean;
  code: string;
  message: string;
  reason: string;
}

const failFastConfig = z
  .object({
    codePath: z.string().default("code").describe("Dotted path used to read an error code."),
    messagePath: z.string().default("message").describe("Dotted path used to read an error message."),
    ignoredCodes: z.string().default("").describe("Comma-separated error codes that should not fail fast."),
    failureCodes: z
      .string()
      .default("")
      .describe("Optional comma-separated allowlist of error codes that should fail fast."),
  })
  .passthrough();

export const failFastNode = defineNode({
  type: "fail_fast",
  typeVersion: "1.0.0",
  title: "Fail Fast",
  description: "Routes when the first branch failure arrives.",
  kind: "pseudo",
  config: failFastConfig,
  fieldMeta: {
    codePath: {
      label: "Code Path",
      control: "input",
      order: 1,
      placeholder: "code",
    },
    messagePath: {
      label: "Message Path",
      control: "input",
      order: 2,
      placeholder: "message",
    },
    ignoredCodes: {
      label: "Ignored Codes",
      control: "input",
      order: 3,
      placeholder: "ERR_RETRYABLE,ERR_CANCELLED",
    },
    failureCodes: {
      label: "Failure Codes",
      control: "input",
      order: 4,
      placeholder: "ERR_FATAL,ERR_TIMEOUT",
    },
  },
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
    {
      id: "codePath",
      direction: "input",
      kind: "data",
      label: "Code Path",
      schema: { type: "string" },
    },
    {
      id: "messagePath",
      direction: "input",
      kind: "data",
      label: "Message Path",
      schema: { type: "string" },
    },
    {
      id: "ignoredCodes",
      direction: "input",
      kind: "data",
      label: "Ignored Codes",
      schema: { type: "string" },
    },
    {
      id: "failureCodes",
      direction: "input",
      kind: "data",
      label: "Failure Codes",
      schema: { type: "string" },
    },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "clear", direction: "output", kind: "control", label: "Clear" },
    { id: "error", direction: "output", kind: "data", label: "First error" },
    { id: "errors", direction: "output", kind: "data", label: "Errors" },
    { id: "ignoredErrors", direction: "output", kind: "data", label: "Ignored Errors" },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "ignoredCount", direction: "output", kind: "data", label: "Ignored Count", schema: { type: "number" } },
    { id: "hasFailure", direction: "output", kind: "data", label: "Has Failure", schema: { type: "boolean" } },
    { id: "failedIndex", direction: "output", kind: "data", label: "Failed Index", schema: { type: "number" } },
    { id: "failedIndexes", direction: "output", kind: "data", label: "Failed Indexes", schema: { type: "array" } },
    { id: "ignoredIndexes", direction: "output", kind: "data", label: "Ignored Indexes", schema: { type: "array" } },
    { id: "errorCode", direction: "output", kind: "data", label: "Error Code", schema: { type: "string" } },
    { id: "errorMessage", direction: "output", kind: "data", label: "Error Message", schema: { type: "string" } },
    { id: "codePath", direction: "output", kind: "data", label: "Code Path", schema: { type: "string" } },
    { id: "messagePath", direction: "output", kind: "data", label: "Message Path", schema: { type: "string" } },
    { id: "ignoredCodes", direction: "output", kind: "data", label: "Ignored Codes" },
    { id: "failureCodes", direction: "output", kind: "data", label: "Failure Codes" },
    { id: "evaluations", direction: "output", kind: "data", label: "Evaluations" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const rawErrors = normalizeErrors(input.errors);
    const codePath = String(input.codePath ?? config.codePath ?? "code");
    const messagePath = String(input.messagePath ?? config.messagePath ?? "message");
    const ignoredCodes = parseCodeList(input.ignoredCodes ?? config.ignoredCodes);
    const failureCodes = parseCodeList(input.failureCodes ?? config.failureCodes);
    const evaluations = rawErrors.map((error, index) =>
      evaluateError(error, index, {
        codePath,
        messagePath,
        ignoredCodes,
        failureCodes,
      }),
    );
    const failures = evaluations.filter((evaluation) => evaluation.failed);
    const ignored = evaluations.filter((evaluation) => evaluation.present && !evaluation.failed);
    const failedIndex = failures[0]?.index ?? -1;
    const hasFailure = failedIndex >= 0;
    const errors = failures.map((evaluation) => evaluation.error);
    const ignoredErrors = ignored.map((evaluation) => evaluation.error);
    const error = failures[0]?.error ?? null;
    const errorCode = failures[0]?.code ?? "";
    const errorMessage = failures[0]?.message ?? "";
    const failedIndexes = failures.map((evaluation) => evaluation.index);
    const ignoredIndexes = ignored.map((evaluation) => evaluation.index);
    const status = hasFailure ? "failed" : "clear";

    ctx.log.debug("fail_fast evaluated errors", {
      status,
      failedIndex,
      count: errors.length,
      ignoredCount: ignoredErrors.length,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        error,
        errors,
        ignoredErrors,
        count: errors.length,
        ignoredCount: ignoredErrors.length,
        hasFailure,
        failedIndex,
        failedIndexes,
        ignoredIndexes,
        errorCode,
        errorMessage,
        codePath,
        messagePath,
        ignoredCodes: [...ignoredCodes],
        failureCodes: [...failureCodes],
        evaluations,
        status,
      },
    };
  },
});

function normalizeErrors(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
    return value[0];
  }
  return Array.isArray(value) ? value : [value];
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function evaluateError(
  error: unknown,
  index: number,
  policy: {
    codePath: string;
    messagePath: string;
    ignoredCodes: ReadonlySet<string>;
    failureCodes: ReadonlySet<string>;
  },
): ErrorEvaluation {
  const present = isPresent(error);
  const { errorCode: code, errorMessage: message } = describeError(error, policy.codePath, policy.messagePath);
  if (!present) return { index, error, present, failed: false, code, message, reason: "empty" };
  if (policy.ignoredCodes.has(code)) return { index, error, present, failed: false, code, message, reason: "ignored_code" };
  if (policy.failureCodes.size > 0 && !policy.failureCodes.has(code)) {
    return { index, error, present, failed: false, code, message, reason: "non_failure_code" };
  }
  return { index, error, present, failed: true, code, message, reason: "failure" };
}

function describeError(error: unknown, codePath: string, messagePath: string): { errorCode: string; errorMessage: string } {
  if (!isPresent(error)) return { errorCode: "", errorMessage: "" };
  if (typeof error === "string") return { errorCode: "", errorMessage: error };
  if (error instanceof Error) return { errorCode: "", errorMessage: error.message };
  if (typeof error === "object") {
    const code = readOptionalPath(error, codePath);
    const message = readOptionalPath(error, messagePath);
    return {
      errorCode: typeof code === "string" ? code : "",
      errorMessage: typeof message === "string" ? message : "",
    };
  }
  return { errorCode: "", errorMessage: String(error) };
}

function parseCodeList(value: unknown): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function readOptionalPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  return readPath(value, trimmed);
}
