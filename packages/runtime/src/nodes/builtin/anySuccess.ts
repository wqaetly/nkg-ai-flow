/**
 * `any_success` - explicit any-join success selector.
 *
 * Race continues on first arrival. This node evaluates arrived branch
 * results and continues when any result is considered successful.
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

const anySuccessConfig = z
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

export const anySuccessNode = defineNode({
  type: "any_success",
  typeVersion: "1.0.0",
  title: "Any Success",
  description: "Continues when any branch result is successful.",
  kind: "pseudo",
  config: anySuccessConfig,
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
    {
      id: "mode",
      direction: "input",
      kind: "data",
      label: "Mode",
      schema: { type: "string" },
    },
    {
      id: "statusPath",
      direction: "input",
      kind: "data",
      label: "Status Path",
      schema: { type: "string" },
    },
    {
      id: "successValues",
      direction: "input",
      kind: "data",
      label: "Success Values",
      schema: { type: "string" },
    },
    {
      id: "errorPath",
      direction: "input",
      kind: "data",
      label: "Error Path",
      schema: { type: "string" },
    },
    { id: "any_success", direction: "output", kind: "control", label: "Any success" },
    { id: "no_success", direction: "output", kind: "control", label: "No success" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "value", direction: "output", kind: "data", label: "First success" },
    { id: "successes", direction: "output", kind: "data", label: "Successes" },
    { id: "failures", direction: "output", kind: "data", label: "Failures" },
    { id: "firstSuccess", direction: "output", kind: "data", label: "First success" },
    { id: "firstFailure", direction: "output", kind: "data", label: "First failure" },
    { id: "evaluations", direction: "output", kind: "data", label: "Evaluations" },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
    { id: "successCount", direction: "output", kind: "data", label: "Success count", schema: { type: "number" } },
    { id: "failureCount", direction: "output", kind: "data", label: "Failure count", schema: { type: "number" } },
    { id: "total", direction: "output", kind: "data", label: "Total", schema: { type: "number" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "statusPath", direction: "output", kind: "data", label: "Status Path", schema: { type: "string" } },
    { id: "successValues", direction: "output", kind: "data", label: "Success Values" },
    { id: "errorPath", direction: "output", kind: "data", label: "Error Path", schema: { type: "string" } },
    { id: "hasSuccess", direction: "output", kind: "data", label: "Has Success", schema: { type: "boolean" } },
    { id: "hasFailure", direction: "output", kind: "data", label: "Has Failure", schema: { type: "boolean" } },
    { id: "successRate", direction: "output", kind: "data", label: "Success Rate", schema: { type: "number" } },
    { id: "failureRate", direction: "output", kind: "data", label: "Failure Rate", schema: { type: "number" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const results = normalizeResults(input.results);
    const mode = readMode(input.mode ?? config.mode);
    const statusPath = String(input.statusPath ?? config.statusPath ?? "status");
    const successValues = parseSuccessValues(input.successValues ?? config.successValues);
    const successValueList = [...successValues];
    const errorPath = String(input.errorPath ?? config.errorPath ?? "error");
    const evaluations = results.map((result, index) =>
      evaluateResult(result, index, {
        mode,
        statusPath,
        successValues,
        errorPath,
      }),
    );
    const successes = evaluations
      .filter((evaluation) => evaluation.passed)
      .map((evaluation) => evaluation.result);
    const failures = evaluations
      .filter((evaluation) => !evaluation.passed)
      .map((evaluation) => evaluation.result);
    const successCount = successes.length;
    const failureCount = failures.length;
    const total = results.length;
    const hasSuccess = successCount > 0;
    const hasFailure = failureCount > 0;
    const successRate = total === 0 ? 0 : successCount / total;
    const failureRate = total === 0 ? 0 : failureCount / total;
    const status =
      total === 0
        ? "empty"
        : hasSuccess
          ? "any_success"
          : "no_success";
    const summary = {
      status,
      successCount,
      failureCount,
      total,
      mode,
      statusPath,
      successValues: successValueList,
      errorPath,
      hasSuccess,
      hasFailure,
      successRate,
      failureRate,
    };

    ctx.log.debug("any_success classified branch results", summary);

    return {
      kind: "success",
      outputs: {
        [status]: null,
        value: successes[0] ?? null,
        successes,
        failures,
        firstSuccess: successes[0] ?? null,
        firstFailure: failures[0] ?? null,
        evaluations,
        summary,
        successCount,
        failureCount,
        total,
        mode,
        statusPath,
        successValues: successValueList,
        errorPath,
        hasSuccess,
        hasFailure,
        successRate,
        failureRate,
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
