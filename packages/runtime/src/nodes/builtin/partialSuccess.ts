/**
 * `partial_success` - classify multi-branch outcomes.
 *
 * Complements join/quorum/race by making partial success an explicit
 * branch decision: all branches succeeded, some succeeded, or too few
 * succeeded to continue.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type SuccessMode = "truthy" | "ok" | "status";

interface Evaluation {
  index: number;
  passed: boolean;
  reason: string;
  result: unknown;
}

const partialSuccessConfig = z
  .object({
    mode: z
      .enum(["truthy", "ok", "status"])
      .default("truthy")
      .describe("How each branch result is classified."),
    minSuccess: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Minimum successful result count required to avoid failed."),
    statusPath: z
      .string()
      .default("status")
      .describe("Dotted path used by status mode."),
    successValues: z
      .string()
      .default("ok,success,succeeded,ready,valid,enabled")
      .describe("Comma-separated status values treated as success."),
    errorPath: z
      .string()
      .default("error")
      .describe("Optional dotted path; a present value marks the result failed."),
  })
  .passthrough();

export const partialSuccessNode = defineNode({
  type: "partial_success",
  typeVersion: "1.0.0",
  title: "Partial Success",
  description: "Classifies multi-branch results as all success, partial, or failed.",
  kind: "pseudo",
  config: partialSuccessConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      order: 1,
      enumOptions: [
        { label: "Truthy", value: "truthy" },
        { label: "OK flag", value: "ok" },
        { label: "Status", value: "status" },
      ],
    },
    minSuccess: {
      label: "Minimum Success",
      control: "number",
      order: 2,
    },
    statusPath: {
      label: "Status Path",
      control: "input",
      order: 3,
      placeholder: "status",
    },
    successValues: {
      label: "Success Values",
      control: "input",
      order: 4,
      placeholder: "ok,success,succeeded",
    },
    errorPath: {
      label: "Error Path",
      control: "input",
      order: 5,
      placeholder: "error",
    },
  },
  ports: [
    {
      id: "results",
      direction: "input",
      kind: "data",
      label: "Results",
      multiple: true,
    },
    { id: "all_success", direction: "output", kind: "control", label: "All success" },
    { id: "partial", direction: "output", kind: "control", label: "Partial" },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "successes", direction: "output", kind: "data", label: "Successes" },
    { id: "failures", direction: "output", kind: "data", label: "Failures" },
    { id: "evaluations", direction: "output", kind: "data", label: "Evaluations" },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
    { id: "successCount", direction: "output", kind: "data", label: "Success count", schema: { type: "number" } },
    { id: "failureCount", direction: "output", kind: "data", label: "Failure count", schema: { type: "number" } },
    { id: "total", direction: "output", kind: "data", label: "Total", schema: { type: "number" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const results = normalizeResults(input.results);
    const mode = readMode(config.mode);
    const successValues = parseSuccessValues(config.successValues);
    const evaluations = results.map((result, index) =>
      evaluateResult(result, index, {
        mode,
        statusPath: String(config.statusPath ?? "status"),
        successValues,
        errorPath: String(config.errorPath ?? "error"),
      }),
    );
    const successes = evaluations
      .filter((evaluation) => evaluation.passed)
      .map((evaluation) => evaluation.result);
    const failures = evaluations
      .filter((evaluation) => !evaluation.passed)
      .map((evaluation) => evaluation.result);
    const minSuccess = Math.max(1, Math.trunc(Number(config.minSuccess ?? 1)));
    const successCount = successes.length;
    const failureCount = failures.length;
    const total = results.length;
    const status =
      total > 0 && failureCount === 0
        ? "all_success"
        : successCount >= minSuccess
          ? "partial"
          : "failed";
    const summary = {
      status,
      successCount,
      failureCount,
      total,
      minSuccess,
    };

    ctx.log.debug("partial_success classified branch results", summary);

    return {
      kind: "success",
      outputs: {
        [status]: null,
        successes,
        failures,
        evaluations,
        summary,
        successCount,
        failureCount,
        total,
        status,
      },
    };
  },
});

function normalizeResults(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readMode(value: unknown): SuccessMode {
  return value === "ok" || value === "status" ? value : "truthy";
}

function parseSuccessValues(value: unknown): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function evaluateResult(
  result: unknown,
  index: number,
  config: {
    mode: SuccessMode;
    statusPath: string;
    successValues: ReadonlySet<string>;
    errorPath: string;
  },
): Evaluation {
  if (result === null || result === undefined) {
    return evaluation(index, result, false, "empty_result");
  }

  const error = readOptionalPath(result, config.errorPath);
  if (isPresent(error)) {
    return evaluation(index, result, false, "error_present");
  }

  if (config.mode === "ok") {
    const ok =
      readOptionalPath(result, "ok") ??
      readOptionalPath(result, "success") ??
      readOptionalPath(result, "succeeded");
    return evaluation(index, result, ok === true, ok === true ? "ok_flag" : "ok_flag_missing");
  }

  const status = readOptionalPath(result, config.statusPath);
  if (config.mode === "status" || isPresent(status)) {
    const passed = config.successValues.has(String(status).toLowerCase());
    return evaluation(index, result, passed, passed ? "status_match" : "status_mismatch");
  }

  const passed = Boolean(result);
  return evaluation(index, result, passed, passed ? "truthy" : "falsy");
}

function evaluation(
  index: number,
  result: unknown,
  passed: boolean,
  reason: string,
): Evaluation {
  return { index, passed, reason, result };
}

function readOptionalPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  return readPath(value, trimmed);
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}
