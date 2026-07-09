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

type RollbackBranch = "rollback" | "empty" | "succeeded" | "partial" | "failed" | "incomplete";

interface RollbackAction {
  id: string;
  action: string;
  payload: VariableValue;
  registeredAt: number | null;
  registeredFlowId: string;
  registeredFlowVersion: string;
  registeredRunId: string;
  registeredNodeId: string;
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
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "successPath", direction: "input", kind: "data", label: "Success Path", schema: { type: "string" } },
    { id: "successValues", direction: "input", kind: "data", label: "Success Values" },
    { id: "errorPath", direction: "input", kind: "data", label: "Error Path", schema: { type: "string" } },
    { id: "missingResult", direction: "input", kind: "data", label: "Missing Result", schema: { type: "string" } },
    { id: "rollback", direction: "output", kind: "control", label: "Rollback" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "succeeded", direction: "output", kind: "control", label: "Succeeded" },
    { id: "partial", direction: "output", kind: "control", label: "Partial" },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "incomplete", direction: "output", kind: "control", label: "Incomplete" },
    { id: "actions", direction: "output", kind: "data", label: "Actions" },
    { id: "results", direction: "output", kind: "data", label: "Results" },
    { id: "failures", direction: "output", kind: "data", label: "Failures" },
    { id: "pending", direction: "output", kind: "data", label: "Pending" },
    { id: "registeredFlowIds", direction: "output", kind: "data", label: "Registered Flow Ids" },
    { id: "registeredFlowVersions", direction: "output", kind: "data", label: "Registered Flow Versions" },
    { id: "registeredRunIds", direction: "output", kind: "data", label: "Registered Run Ids" },
    { id: "registeredNodeIds", direction: "output", kind: "data", label: "Registered Node Ids" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "successPath", direction: "output", kind: "data", label: "Success Path", schema: { type: "string" } },
    { id: "successValues", direction: "output", kind: "data", label: "Success Values" },
    { id: "errorPath", direction: "output", kind: "data", label: "Error Path", schema: { type: "string" } },
    { id: "missingResult", direction: "output", kind: "data", label: "Missing Result", schema: { type: "string" } },
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
    { id: "successRate", direction: "output", kind: "data", label: "Success Rate", schema: { type: "number" } },
    { id: "failureRate", direction: "output", kind: "data", label: "Failure Rate", schema: { type: "number" } },
    { id: "pendingRate", direction: "output", kind: "data", label: "Pending Rate", schema: { type: "number" } },
    { id: "hasFailures", direction: "output", kind: "data", label: "Has Failures", schema: { type: "boolean" } },
    { id: "hasPending", direction: "output", kind: "data", label: "Has Pending", schema: { type: "boolean" } },
    { id: "rollbackValue", direction: "output", kind: "data", label: "Rollback", schema: { type: "boolean" } },
    { id: "emptyValue", direction: "output", kind: "data", label: "Empty", schema: { type: "boolean" } },
    { id: "succeededValue", direction: "output", kind: "data", label: "Succeeded", schema: { type: "boolean" } },
    { id: "partialValue", direction: "output", kind: "data", label: "Partial", schema: { type: "boolean" } },
    { id: "failedValue", direction: "output", kind: "data", label: "Failed", schema: { type: "boolean" } },
    { id: "incompleteValue", direction: "output", kind: "data", label: "Incomplete", schema: { type: "boolean" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "plan";
    const successValues = normalizeSuccessValues(input.successValues ?? config.successValues);
    const diagnostics = {
      mode,
      successPath: String(input.successPath ?? config.successPath ?? "status"),
      successValues,
      errorPath: String(input.errorPath ?? config.errorPath ?? "error"),
      missingResult: readMissingResult(input.missingResult) ?? readMissingResult(config.missingResult) ?? "pending",
    };
    const actions = readActions(input.actions ?? input.input);
    if (actions.length === 0) {
      ctx.log.debug("rollback selected branch", { mode, branch: "empty" });
      return success("empty", {
        ...diagnostics,
        ...actionSourceDiagnostics([]),
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

    if (mode === "plan") {
      ctx.log.debug("rollback selected branch", {
        mode: "plan",
        branch: "rollback",
        count: actions.length,
      });
      return success("rollback", {
        ...diagnostics,
        ...actionSourceDiagnostics(actions),
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
      successPath: diagnostics.successPath,
      successValues,
      errorPath: diagnostics.errorPath,
      missingResult: diagnostics.missingResult,
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
      ...diagnostics,
      ...actionSourceDiagnostics(actions),
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
  if (counts.failureCount === 0 && counts.pendingCount > 0) return "incomplete";
  if (counts.successCount > 0) return "partial";
  return "failed";
}

function readMode(value: unknown): "plan" | "summarize" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "plan" || normalized === "summarize" ? normalized : undefined;
}

function readMissingResult(value: unknown): "pending" | "failed" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "pending" || normalized === "failed" ? normalized : undefined;
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
    registeredFlowId: typeof record.registeredFlowId === "string" ? record.registeredFlowId : "",
    registeredFlowVersion:
      typeof record.registeredFlowVersion === "string" ? record.registeredFlowVersion : "",
    registeredRunId: typeof record.registeredRunId === "string" ? record.registeredRunId : "",
    registeredNodeId: typeof record.registeredNodeId === "string" ? record.registeredNodeId : "",
  };
}

function actionSourceDiagnostics(actions: RollbackAction[]): {
  registeredFlowIds: string[];
  registeredFlowVersions: string[];
  registeredRunIds: string[];
  registeredNodeIds: string[];
} {
  return {
    registeredFlowIds: actions.map((action) => action.registeredFlowId),
    registeredFlowVersions: actions.map((action) => action.registeredFlowVersion),
    registeredRunIds: actions.map((action) => action.registeredRunId),
    registeredNodeIds: actions.map((action) => action.registeredNodeId),
  };
}

function normalizeSuccessValues(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : String(value ?? "").split(",");
  const values = rawValues
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? values : ["succeeded", "success", "ok", "rolled_back", "done"];
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
  const count = readCount(outputs.count);
  const successCount = readCount(outputs.successCount);
  const failureCount = readCount(outputs.failureCount);
  const pendingCount = readCount(outputs.pendingCount);
  const successRate = count > 0 ? successCount / count : 0;
  const failureRate = count > 0 ? failureCount / count : 0;
  const pendingRate = count > 0 ? pendingCount / count : 0;
  const flags = {
    hasFailures: failureCount > 0,
    hasPending: pendingCount > 0,
    rollbackValue: branch === "rollback",
    emptyValue: branch === "empty",
    succeededValue: branch === "succeeded",
    partialValue: branch === "partial",
    failedValue: branch === "failed",
    incompleteValue: branch === "incomplete",
  };
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      ...outputs,
      successRate,
      failureRate,
      pendingRate,
      ...flags,
      summary: rollbackSummary(branch, outputs, {
        count,
        successCount,
        failureCount,
        pendingCount,
        successRate,
        failureRate,
        pendingRate,
        ...flags,
      }),
    },
  };
}

function rollbackSummary(
  branch: RollbackBranch,
  outputs: Record<string, unknown>,
  metrics: {
    count: number;
    successCount: number;
    failureCount: number;
    pendingCount: number;
    successRate: number;
    failureRate: number;
    pendingRate: number;
    hasFailures: boolean;
    hasPending: boolean;
    rollbackValue: boolean;
    emptyValue: boolean;
    succeededValue: boolean;
    partialValue: boolean;
    failedValue: boolean;
    incompleteValue: boolean;
  },
): Record<string, unknown> {
  return {
    status: String(outputs.status ?? branch),
    mode: String(outputs.mode ?? ""),
    successPath: String(outputs.successPath ?? ""),
    successValues: outputs.successValues,
    errorPath: String(outputs.errorPath ?? ""),
    missingResult: String(outputs.missingResult ?? ""),
    registeredFlowIds: outputs.registeredFlowIds,
    registeredFlowVersions: outputs.registeredFlowVersions,
    registeredRunIds: outputs.registeredRunIds,
    registeredNodeIds: outputs.registeredNodeIds,
    actions: outputs.actions,
    results: outputs.results,
    failures: outputs.failures,
    pending: outputs.pending,
    ...metrics,
  };
}

function readCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
