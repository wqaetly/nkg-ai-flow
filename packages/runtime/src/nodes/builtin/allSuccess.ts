/**
 * `all_success` - explicit all-join success gate.
 *
 * `join` waits for every branch. This node classifies the joined results
 * and continues only when every arrived result is successful.
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

const allSuccessConfig = z
  .object({
    mode: z
      .enum(["truthy", "ok", "status"])
      .default("truthy")
      .describe("How each branch result is classified."),
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

export const allSuccessNode = defineNode({
  type: "all_success",
  typeVersion: "1.0.0",
  title: "All Success",
  description: "Continues only when every branch result is successful.",
  kind: "pseudo",
  config: allSuccessConfig,
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
    statusPath: {
      label: "Status Path",
      control: "input",
      order: 2,
      placeholder: "status",
    },
    successValues: {
      label: "Success Values",
      control: "input",
      order: 3,
      placeholder: "ok,success,succeeded",
    },
    errorPath: {
      label: "Error Path",
      control: "input",
      order: 4,
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
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "values", direction: "output", kind: "data", label: "Values" },
    { id: "successes", direction: "output", kind: "data", label: "Successes" },
    { id: "failures", direction: "output", kind: "data", label: "Failures" },
    { id: "firstFailure", direction: "output", kind: "data", label: "First failure" },
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
    const status =
      results.length === 0
        ? "empty"
        : failures.length === 0
          ? "all_success"
          : "failed";
    const summary = {
      status,
      successCount: successes.length,
      failureCount: failures.length,
      total: results.length,
    };

    ctx.log.debug("all_success classified branch results", summary);

    return {
      kind: "success",
      outputs: {
        [status]: null,
        values: results,
        successes,
        failures,
        firstFailure: failures[0] ?? null,
        evaluations,
        summary,
        successCount: successes.length,
        failureCount: failures.length,
        total: results.length,
        status,
      },
    };
  },
});

function normalizeResults(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
    return value[0];
  }
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
  if (isPresent(error)) return evaluation(index, result, false, "error_present");

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
