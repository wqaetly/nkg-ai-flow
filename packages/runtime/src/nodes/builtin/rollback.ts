/**
 * `rollback` - route and summarize Saga rollback actions.
 *
 * `compensation` owns the durable stack. This node turns drained actions
 * into an explicit rollback branch and can later summarize per-action
 * rollback results into succeeded / partial / failed outcomes.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import type { VariableValue } from "@ai-native-flow/variable-store";
import { readPath } from "./_helpers.js";

type RollbackBranch = "rollback" | "empty" | "succeeded" | "partial" | "failed";

interface RollbackAction {
  id: string;
  action: string;
  payload: VariableValue;
  registeredAt: number | null;
}

interface RollbackEvaluation {
  action: RollbackAction;
  result: VariableValue | null;
  status: "succeeded" | "failed" | "pending";
  error: VariableValue | null;
}

const rollbackConfig = z
  .object({
    mode: z
      .enum(["plan", "summarize"])
      .default("plan")
      .describe("Whether to route rollback actions or summarize rollback results."),
    successPath: z
      .string()
      .default("status")
      .describe("Path read from each result to determine success."),
    successValues: z
      .array(z.string())
      .default(["succeeded", "success", "ok", "rolled_back", "done"])
      .describe("Result values treated as successful rollback."),
    errorPath: z
      .string()
      .default("error")
      .describe("Path read from each result to capture failure details."),
    missingResult: z
      .enum(["pending", "failed"])
      .default("pending")
      .describe("How summarize mode handles actions without a result."),
  })
  .passthrough();

export const rollbackNode = defineNode({
  type: "rollback",
  typeVersion: "1.0.0",
  title: "Rollback",
  description: "Routes drained compensation actions and summarizes rollback results.",
  kind: "pseudo",
  config: rollbackConfig,
  fieldMeta: {
    mode: {
      label: "Mode",
      control: "select",
      order: 1,
      enumOptions: [
        { label: "Plan", value: "plan" },
        { label: "Summarize", value: "summarize" },
      ],
    },
    successPath: {
      label: "Success Path",
      control: "input",
      order: 2,
    },
    successValues: {
      label: "Success Values",
      control: "textarea",
      order: 3,
    },
    errorPath: {
      label: "Error Path",
      control: "input",
      order: 4,
    },
    missingResult: {
      label: "Missing Result",
      control: "select",
      order: 5,
      enumOptions: [
        { label: "Pending", value: "pending" },
        { label: "Failed", value: "failed" },
      ],
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "actions", direction: "input", kind: "data", label: "Actions" },
    { id: "results", direction: "input", kind: "data", label: "Results" },
    { id: "rollback", direction: "output", kind: "control", label: "Rollback" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "succeeded", direction: "output", kind: "control", label: "Succeeded" },
    { id: "partial", direction: "output", kind: "control", label: "Partial" },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "actions", direction: "output", kind: "data", label: "Actions" },
    { id: "results", direction: "output", kind: "data", label: "Results" },
    { id: "failures", direction: "output", kind: "data", label: "Failures" },
    { id: "pending", direction: "output", kind: "data", label: "Pending" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    {
      id: "successCount",
      direction: "output",
      kind: "data",
      label: "Success count",
      schema: { type: "number" },
    },
    {
      id: "failureCount",
      direction: "output",
      kind: "data",
      label: "Failure count",
      schema: { type: "number" },
    },
    {
      id: "pendingCount",
      direction: "output",
      kind: "data",
      label: "Pending count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const actions = readActions(input.actions ?? input.input);
    if (actions.length === 0) {
      ctx.log.debug("rollback selected branch", { mode: config.mode, branch: "empty" });
      return success("empty", {
        actions: [],
        results: [],
        failures: [],
        pending: [],
        status: "empty",
        count: 0,
        successCount: 0,
        failureCount: 0,
        pendingCount: 0,
      });
    }

    if ((config.mode ?? "plan") === "plan") {
      ctx.log.debug("rollback selected branch", {
        mode: "plan",
        branch: "rollback",
        count: actions.length,
      });
      return success("rollback", {
        actions,
        results: [],
        failures: [],
        pending: actions,
        status: "rollback",
        count: actions.length,
        successCount: 0,
        failureCount: 0,
        pendingCount: actions.length,
      });
    }

    const evaluations = summarize(actions, input.results, {
      successPath: String(config.successPath ?? "status"),
      successValues: normalizeSuccessValues(config.successValues),
      errorPath: String(config.errorPath ?? "error"),
      missingResult: config.missingResult ?? "pending",
    });
    const failures = evaluations.filter((item) => item.status === "failed");
    const pending = evaluations.filter((item) => item.status === "pending");
    const successCount = evaluations.length - failures.length - pending.length;
    const branch = chooseSummaryBranch({
      total: actions.length,
      successCount,
      failureCount: failures.length,
      pendingCount: pending.length,
    });

    ctx.log.debug("rollback selected branch", {
      mode: "summarize",
      branch,
      count: actions.length,
      successCount,
      failureCount: failures.length,
      pendingCount: pending.length,
    });

    return success(branch, {
      actions,
      results: evaluations,
      failures,
      pending,
      status: branch,
      count: actions.length,
      successCount,
      failureCount: failures.length,
      pendingCount: pending.length,
    });
  },
});

function summarize(
  actions: RollbackAction[],
  rawResults: unknown,
  options: {
    successPath: string;
    successValues: string[];
    errorPath: string;
    missingResult: "pending" | "failed";
  },
): RollbackEvaluation[] {
  const results = Array.isArray(rawResults) ? rawResults : [];
  return actions.map((action, index) => {
    const result = toJsonValue(results[index]);
    if (result === undefined) {
      return {
        action,
        result: null,
        status: options.missingResult,
        error: options.missingResult === "failed" ? "missing_result" : null,
      };
    }
    const statusValue = readPath(result, options.successPath);
    const okValue = readPath(result, "ok");
    const errorValue = toJsonValue(readPath(result, options.errorPath)) ?? null;
    const success =
      okValue === true ||
      options.successValues.includes(String(statusValue ?? "").toLowerCase());
    return {
      action,
      result,
      status: success ? "succeeded" : "failed",
      error: success ? null : errorValue ?? "rollback_failed",
    };
  });
}

function chooseSummaryBranch(counts: {
  total: number;
  successCount: number;
  failureCount: number;
  pendingCount: number;
}): RollbackBranch {
  if (counts.failureCount === 0 && counts.pendingCount === 0) return "succeeded";
  if (counts.successCount > 0) return "partial";
  return "failed";
}

function readActions(value: unknown): RollbackAction[] {
  if (!Array.isArray(value)) return [];
  return value.map(readAction).filter((action) => action !== undefined);
}

function readAction(value: unknown): RollbackAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const payload = toJsonValue(record.payload);
  if (typeof record.action !== "string" || record.action.trim() === "" || payload === undefined) {
    return undefined;
  }
  return {
    id: typeof record.id === "string" ? record.id : record.action,
    action: record.action,
    payload,
    registeredAt:
      typeof record.registeredAt === "number" && Number.isFinite(record.registeredAt)
        ? record.registeredAt
        : null,
  };
}

function normalizeSuccessValues(value: unknown): string[] {
  if (!Array.isArray(value)) return ["succeeded", "success", "ok", "rolled_back", "done"];
  return value.map((item) => String(item).toLowerCase());
}

function toJsonValue(value: unknown): VariableValue | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(toJsonValue);
    return items.some((item) => item === undefined)
      ? undefined
      : (items as VariableValue[]);
  }
  if (value && typeof value === "object") {
    const out: Record<string, VariableValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item);
      if (converted === undefined) return undefined;
      out[key] = converted;
    }
    return out;
  }
  return undefined;
}

function success(branch: RollbackBranch, outputs: Record<string, unknown>) {
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      ...outputs,
    },
  };
}
