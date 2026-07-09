/**
 * `fallback` - explicit primary/fallback router.
 *
 * It turns "use the primary value when usable, otherwise continue with a
 * fallback value" into a visible control-flow decision instead of hiding that
 * recovery logic in templates or ad-hoc condition nodes.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type FallbackMode = "present" | "truthy" | "ok" | "status";
type FallbackStatus = "primary" | "fallback";

const fallbackConfig = z
  .object({
    mode: z
      .enum(["present", "truthy", "ok", "status"])
      .default("present")
      .describe("How the primary value is judged usable."),
    valuePath: z
      .string()
      .default("")
      .describe("Optional dotted path extracted from the primary value."),
    fallbackValue: z
      .unknown()
      .optional()
      .describe("Static fallback value used when no fallback input is connected."),
    errorPath: z
      .string()
      .default("error")
      .describe("Optional dotted path; a present value forces the fallback branch."),
    statusPath: z
      .string()
      .default("status")
      .describe("Dotted path used by status mode."),
    successValues: z
      .string()
      .default("ok,success,succeeded,ready,valid,enabled")
      .describe("Comma-separated status values treated as primary success."),
  })
  .passthrough();

export const fallbackNode = defineNode({
  type: "fallback",
  typeVersion: "1.0.0",
  title: "Fallback",
  description: "Routes to a primary or fallback branch based on value usability.",
  kind: "pseudo",
  config: fallbackConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      order: 1,
      enumOptions: [
        { label: "Present", value: "present" },
        { label: "Truthy", value: "truthy" },
        { label: "OK flag", value: "ok" },
        { label: "Status", value: "status" },
      ],
    },
    valuePath: {
      label: "Value Path",
      control: "input",
      order: 2,
      placeholder: "data.result",
    },
    fallbackValue: {
      label: "Fallback Value",
      control: "textarea",
      order: 3,
      placeholder: "Static fallback value.",
    },
    errorPath: {
      label: "Error Path",
      control: "input",
      order: 4,
      placeholder: "error",
    },
    statusPath: {
      label: "Status Path",
      control: "input",
      order: 5,
      placeholder: "status",
    },
    successValues: {
      label: "Success Values",
      control: "input",
      order: 6,
      placeholder: "ok,success,succeeded",
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "value", direction: "input", kind: "data", label: "Primary Value" },
    { id: "fallback", direction: "input", kind: "data", label: "Fallback Value" },
    { id: "error", direction: "input", kind: "data", label: "Error" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "valuePath", direction: "input", kind: "data", label: "Value Path", schema: { type: "string" } },
    { id: "errorPath", direction: "input", kind: "data", label: "Error Path", schema: { type: "string" } },
    { id: "statusPath", direction: "input", kind: "data", label: "Status Path", schema: { type: "string" } },
    { id: "successValues", direction: "input", kind: "data", label: "Success Values", schema: { type: "string" } },
    { id: "primary", direction: "output", kind: "control", label: "Primary" },
    { id: "fallback", direction: "output", kind: "control", label: "Fallback" },
    { id: "value", direction: "output", kind: "data", label: "Selected Value" },
    { id: "primaryValue", direction: "output", kind: "data", label: "Primary Value" },
    { id: "fallbackValue", direction: "output", kind: "data", label: "Fallback Value" },
    { id: "original", direction: "output", kind: "data", label: "Original Value" },
    { id: "error", direction: "output", kind: "data", label: "Error" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "valuePath", direction: "output", kind: "data", label: "Value Path", schema: { type: "string" } },
    { id: "errorPath", direction: "output", kind: "data", label: "Error Path", schema: { type: "string" } },
    { id: "statusPath", direction: "output", kind: "data", label: "Status Path", schema: { type: "string" } },
    { id: "successValues", direction: "output", kind: "data", label: "Success Values", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
    {
      id: "usedFallback",
      direction: "output",
      kind: "data",
      label: "Used Fallback",
      schema: { type: "boolean" },
    },
    {
      id: "primaryUsable",
      direction: "output",
      kind: "data",
      label: "Primary Usable",
      schema: { type: "boolean" },
    },
    {
      id: "fallbackProvided",
      direction: "output",
      kind: "data",
      label: "Fallback Provided",
      schema: { type: "boolean" },
    },
    {
      id: "selectedSource",
      direction: "output",
      kind: "data",
      label: "Selected Source",
      schema: { type: "string" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const original = input.value ?? input.input ?? input.in ?? null;
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "present";
    const valuePath = String(input.valuePath ?? config.valuePath ?? "");
    const errorPath = String(input.errorPath ?? config.errorPath ?? "");
    const statusPath = String(input.statusPath ?? config.statusPath ?? "status");
    const successValues = String(input.successValues ?? config.successValues ?? "");
    const primaryValue = selectValue(original, valuePath);
    const fallbackProvided = input.fallback !== undefined || config.fallbackValue !== undefined;
    const fallbackValue =
      input.fallback !== undefined ? input.fallback : config.fallbackValue ?? null;
    const explicitError = input.error ?? readOptionalPath(original, errorPath);
    const decision = decide(primaryValue, original, explicitError, {
      mode,
      statusPath,
      successValues: parseSuccessValues(successValues),
    });
    const selectedValue = decision.status === "primary" ? primaryValue : fallbackValue;
    const usedFallback = decision.status === "fallback";
    const primaryUsable = decision.status === "primary";
    const selectedSource = decision.status;
    const summary = {
      status: decision.status,
      reason: decision.reason,
      usedFallback,
      primaryUsable,
      fallbackProvided,
      selectedSource,
      hasError: explicitError !== undefined && explicitError !== null,
      mode,
      valuePath,
      errorPath,
      statusPath,
      successValues,
    };

    ctx.log.debug("fallback selected branch", summary);

    return {
      kind: "success",
      outputs: {
        [decision.status]: null,
        value: selectedValue,
        primaryValue,
        fallbackValue,
        original,
        error: explicitError ?? null,
        mode,
        valuePath,
        errorPath,
        statusPath,
        successValues,
        status: decision.status,
        reason: decision.reason,
        usedFallback,
        primaryUsable,
        fallbackProvided,
        selectedSource,
        summary,
      },
    };
  },
});

function readMode(value: unknown): FallbackMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "present" ||
    normalized === "truthy" ||
    normalized === "ok" ||
    normalized === "status"
    ? normalized
    : undefined;
}

function selectValue(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return value;
  const selected = readPath(value, trimmed);
  return selected === undefined ? null : selected;
}

function readOptionalPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  return readPath(value, trimmed);
}

function parseSuccessValues(value: unknown): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function decide(
  value: unknown,
  original: unknown,
  error: unknown,
  config: {
    mode: FallbackMode;
    statusPath: string;
    successValues: ReadonlySet<string>;
  },
): { status: FallbackStatus; reason: string } {
  if (isPresentError(error)) {
    return { status: "fallback", reason: "error_present" };
  }

  if (config.mode === "present") {
    const present = value !== undefined && value !== null;
    return present
      ? { status: "primary", reason: "value_present" }
      : { status: "fallback", reason: "value_missing" };
  }

  if (config.mode === "truthy") {
    return value
      ? { status: "primary", reason: "truthy" }
      : { status: "fallback", reason: "falsy" };
  }

  if (config.mode === "ok") {
    const ok =
      readOptionalPath(original, "ok") ??
      readOptionalPath(original, "success") ??
      readOptionalPath(original, "succeeded");
    return ok === true
      ? { status: "primary", reason: "ok_flag" }
      : { status: "fallback", reason: "ok_flag_missing" };
  }

  const status = readOptionalPath(original, config.statusPath);
  if (!isPresentStatus(status)) {
    return { status: "fallback", reason: "status_missing" };
  }
  return config.successValues.has(String(status).toLowerCase())
    ? { status: "primary", reason: "status_match" }
    : { status: "fallback", reason: "status_mismatch" };
}

function isPresentError(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function isPresentStatus(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
