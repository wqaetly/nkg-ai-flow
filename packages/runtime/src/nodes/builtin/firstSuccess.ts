/**
 * `first_success` - ordered fallback selector.
 *
 * Given several candidate results, it chooses the first usable one and routes
 * to `found`; when every candidate fails the author-visible rule, it routes to
 * `missing`.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type FirstSuccessMode = "truthy" | "ok" | "status";

interface CandidateEvaluation {
  index: number;
  passed: boolean;
  reason: string;
  candidate: unknown;
}

const firstSuccessConfig = z
  .object({
    mode: z
      .enum(["truthy", "ok", "status"])
      .default("truthy")
      .describe("How candidate success is detected."),
    valuePath: z
      .string()
      .default("")
      .describe("Optional dotted path extracted from the selected candidate."),
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
      .describe("Optional dotted path; a present value marks the candidate failed."),
  })
  .passthrough();

export const firstSuccessNode = defineNode({
  type: "first_success",
  typeVersion: "1.0.0",
  title: "First Success",
  description: "Selects the first successful candidate from ordered fallback results.",
  kind: "pseudo",
  config: firstSuccessConfig,
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
    valuePath: {
      label: "Value Path",
      control: "input",
      order: 2,
      placeholder: "result.text",
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
      id: "candidates",
      direction: "input",
      kind: "data",
      label: "Candidates",
      multiple: true,
    },
    { id: "found", direction: "output", kind: "control", label: "Found" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "candidate", direction: "output", kind: "data", label: "Candidate" },
    { id: "candidates", direction: "output", kind: "data", label: "Candidates" },
    { id: "evaluations", direction: "output", kind: "data", label: "Evaluations" },
    { id: "index", direction: "output", kind: "data", label: "Index", schema: { type: "number" } },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const candidates = normalizeCandidates(input.candidates);
    const mode = readMode(config.mode);
    const successValues = parseSuccessValues(config.successValues);
    const evaluations = candidates.map((candidate, index) =>
      evaluateCandidate(candidate, index, {
        mode,
        statusPath: String(config.statusPath ?? "status"),
        successValues,
        errorPath: String(config.errorPath ?? "error"),
      }),
    );
    const selected = evaluations.find((evaluation) => evaluation.passed);
    const status = selected ? "found" : "missing";
    const reason = selected?.reason ?? "no_successful_candidate";
    const value =
      selected === undefined
        ? null
        : selectValue(selected.candidate, String(config.valuePath ?? ""));

    ctx.log.debug("first_success evaluated candidates", {
      status,
      count: candidates.length,
      index: selected?.index ?? -1,
      mode,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        value,
        candidate: selected?.candidate ?? null,
        candidates,
        evaluations,
        index: selected?.index ?? -1,
        count: candidates.length,
        status,
        reason,
      },
    };
  },
});

function normalizeCandidates(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readMode(value: unknown): FirstSuccessMode {
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

function evaluateCandidate(
  candidate: unknown,
  index: number,
  config: {
    mode: FirstSuccessMode;
    statusPath: string;
    successValues: ReadonlySet<string>;
    errorPath: string;
  },
): CandidateEvaluation {
  if (candidate === null || candidate === undefined) {
    return evaluation(index, candidate, false, "empty_candidate");
  }

  const error = readOptionalPath(candidate, config.errorPath);
  if (isPresent(error)) {
    return evaluation(index, candidate, false, "error_present");
  }

  if (config.mode === "ok") {
    const ok =
      readOptionalPath(candidate, "ok") ??
      readOptionalPath(candidate, "success") ??
      readOptionalPath(candidate, "succeeded");
    return evaluation(
      index,
      candidate,
      ok === true,
      ok === true ? "ok_flag" : "ok_flag_missing",
    );
  }

  const status = readOptionalPath(candidate, config.statusPath);
  if (config.mode === "status" || isPresent(status)) {
    const passed = config.successValues.has(String(status).toLowerCase());
    return evaluation(
      index,
      candidate,
      passed,
      passed ? "status_match" : "status_mismatch",
    );
  }

  const passed = Boolean(candidate);
  return evaluation(index, candidate, passed, passed ? "truthy" : "falsy");
}

function evaluation(
  index: number,
  candidate: unknown,
  passed: boolean,
  reason: string,
): CandidateEvaluation {
  return { index, passed, reason, candidate };
}

function readOptionalPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  return readPath(value, trimmed);
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function selectValue(candidate: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return candidate;
  const selected = readPath(candidate, trimmed);
  return selected === undefined ? null : selected;
}
