/**
 * `circuit_breaker` - stateful circuit gate.
 *
 * The node stores a compact JSON state object in the runtime VariableStore:
 * `{ status, failureCount, openedAt, updatedAt }`. It can be placed before
 * a risky branch as a gate, or after an error path to record a failure.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type CircuitStatus = "closed" | "open" | "half_open";

interface CircuitState {
  status: CircuitStatus;
  circuitFlowId: string;
  circuitRunId: string;
  circuitNodeId: string;
  failureCount: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number;
}

const circuitBreakerConfig = z
  .object({
    name: z.string().default("").describe("Circuit state variable name."),
    failureThreshold: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("Failures required before the circuit opens."),
    resetTimeoutMs: z
      .number()
      .int()
      .min(0)
      .default(30000)
      .describe("How long an open circuit stays open before half-open."),
    failureWindowMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Rolling window for counting failures; 0 disables expiry."),
    mode: z
      .enum(["check", "record_failure", "record_success", "reset"])
      .default("check")
      .describe("Circuit operation mode."),
  })
  .passthrough();

export const circuitBreakerNode = defineNode({
  type: "circuit_breaker",
  typeVersion: "1.0.0",
  title: "Circuit Breaker",
  description: "Routes execution based on a persisted circuit state.",
  kind: "pseudo",
  config: circuitBreakerConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "PAYMENT_API_CIRCUIT",
    },
    failureThreshold: {
      label: "Failure Threshold",
      control: "number",
      order: 2,
    },
    resetTimeoutMs: {
      label: "Reset Timeout (ms)",
      control: "number",
      order: 3,
    },
    failureWindowMs: {
      label: "Failure Window (ms)",
      control: "number",
      order: 4,
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 5,
      enumOptions: [
        { label: "Check", value: "check" },
        { label: "Record failure", value: "record_failure" },
        { label: "Record success", value: "record_success" },
        { label: "Reset", value: "reset" },
      ],
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    {
      id: "failureThreshold",
      direction: "input",
      kind: "data",
      label: "Failure Threshold",
      schema: { type: "number" },
    },
    {
      id: "resetTimeoutMs",
      direction: "input",
      kind: "data",
      label: "Reset Timeout ms",
      schema: { type: "number" },
    },
    {
      id: "failureWindowMs",
      direction: "input",
      kind: "data",
      label: "Failure Window ms",
      schema: { type: "number" },
    },
    { id: "closed", direction: "output", kind: "control", label: "Closed" },
    { id: "open", direction: "output", kind: "control", label: "Open" },
    {
      id: "half_open",
      direction: "output",
      kind: "control",
      label: "Half-open",
    },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status" },
    { id: "previousStatus", direction: "output", kind: "data", label: "Previous Status" },
    { id: "statusChanged", direction: "output", kind: "data", label: "Status Changed", schema: { type: "boolean" } },
    { id: "transitionReason", direction: "output", kind: "data", label: "Transition Reason", schema: { type: "string" } },
    { id: "circuitFlowId", direction: "output", kind: "data", label: "Circuit Flow Id", schema: { type: "string" } },
    { id: "circuitRunId", direction: "output", kind: "data", label: "Circuit Run Id", schema: { type: "string" } },
    { id: "circuitNodeId", direction: "output", kind: "data", label: "Circuit Node Id", schema: { type: "string" } },
    {
      id: "failureCount",
      direction: "output",
      kind: "data",
      label: "Failure Count",
      schema: { type: "number" },
    },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
    {
      id: "failureThreshold",
      direction: "output",
      kind: "data",
      label: "Failure Threshold",
      schema: { type: "number" },
    },
    {
      id: "remainingFailures",
      direction: "output",
      kind: "data",
      label: "Remaining Failures",
      schema: { type: "number" },
    },
    {
      id: "resetTimeoutMs",
      direction: "output",
      kind: "data",
      label: "Reset Timeout ms",
      schema: { type: "number" },
    },
    {
      id: "failureWindowMs",
      direction: "output",
      kind: "data",
      label: "Failure Window ms",
      schema: { type: "number" },
    },
    { id: "isOpen", direction: "output", kind: "data", label: "Is Open", schema: { type: "boolean" } },
    { id: "isHalfOpen", direction: "output", kind: "data", label: "Is Half Open", schema: { type: "boolean" } },
    { id: "isClosed", direction: "output", kind: "data", label: "Is Closed", schema: { type: "boolean" } },
    { id: "canPass", direction: "output", kind: "data", label: "Can Pass", schema: { type: "boolean" } },
    { id: "openedAt", direction: "output", kind: "data", label: "Opened At", schema: { type: "string" } },
    { id: "lastFailureAt", direction: "output", kind: "data", label: "Last Failure At", schema: { type: "string" } },
    { id: "updatedAt", direction: "output", kind: "data", label: "Updated At", schema: { type: "string" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.circuit_breaker.missing_name",
        "circuit_breaker node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.circuit_breaker.readonly_store",
        "circuit_breaker requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const failureThreshold =
      readIntegerAtLeast(input.failureThreshold, 1) ??
      readIntegerAtLeast(config.failureThreshold, 1) ??
      3;
    const resetTimeoutMs =
      readIntegerAtLeast(input.resetTimeoutMs, 0) ??
      readIntegerAtLeast(config.resetTimeoutMs, 0) ??
      30000;
    const failureWindowMs =
      readIntegerAtLeast(input.failureWindowMs, 0) ??
      readIntegerAtLeast(config.failureWindowMs, 0) ??
      0;
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "check";
    const locator = { circuitFlowId: ctx.flowId, circuitRunId: ctx.runId, circuitNodeId: ctx.nodeId };
    const previous = readCircuitState(store.get(name), locator);
    const next = applyMode(previous, {
      mode,
      failureThreshold,
      resetTimeoutMs,
      failureWindowMs,
      locator,
      now,
    });
    const remainingMs =
      next.status === "open" && next.openedAt !== null
        ? Math.max(0, resetTimeoutMs - (now - next.openedAt))
        : 0;
    const openedAt = next.openedAt === null ? "" : new Date(next.openedAt).toISOString();
    const lastFailureAt = next.lastFailureAt === null ? "" : new Date(next.lastFailureAt).toISOString();
    const updatedAt = new Date(next.updatedAt).toISOString();

    store.set(name, toVariableValue(next), metadata(ctx.flowId));
    const branch =
      next.status === "open"
        ? "open"
        : next.status === "half_open"
          ? "half_open"
          : "closed";
    const isOpen = next.status === "open";
    const isHalfOpen = next.status === "half_open";
    const isClosed = next.status === "closed";
    const canPass = isClosed || isHalfOpen;
    const remainingFailures = Math.max(0, failureThreshold - next.failureCount);
    const previousStatus = previous.status;
    const statusChanged = previousStatus !== next.status;
    const transitionReason = circuitTransitionReason({
      mode,
      previous,
      next,
      statusChanged,
    });

    ctx.log.debug("circuit_breaker selected branch", {
      name,
      mode,
      branch,
      previousStatus,
      statusChanged,
      transitionReason,
      failureCount: next.failureCount,
      failureThreshold,
      failureWindowMs,
      remainingMs,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        state: next,
        name,
        mode,
        status: next.status,
        previousStatus,
        statusChanged,
        transitionReason,
        circuitFlowId: next.circuitFlowId,
        circuitRunId: next.circuitRunId,
        circuitNodeId: next.circuitNodeId,
        failureCount: next.failureCount,
        remainingMs,
        failureThreshold,
        remainingFailures,
        resetTimeoutMs,
        failureWindowMs,
        isOpen,
        isHalfOpen,
        isClosed,
        canPass,
        openedAt,
        lastFailureAt,
        updatedAt,
        summary: {
          status: next.status,
          previousStatus,
          statusChanged,
          transitionReason,
          mode,
          name,
          failureCount: next.failureCount,
          failureThreshold,
          remainingFailures,
          remainingMs,
          resetTimeoutMs,
          failureWindowMs,
          isOpen,
          isHalfOpen,
          isClosed,
          canPass,
          circuitFlowId: next.circuitFlowId,
          circuitRunId: next.circuitRunId,
          circuitNodeId: next.circuitNodeId,
        },
      },
    };
  },
});

function applyMode(
  previous: CircuitState,
  options: {
    mode: "check" | "record_failure" | "record_success" | "reset";
    failureThreshold: number;
    resetTimeoutMs: number;
    failureWindowMs: number;
    locator: { circuitFlowId: string; circuitRunId: string; circuitNodeId: string };
    now: number;
  },
): CircuitState {
  const { mode, failureThreshold, resetTimeoutMs, failureWindowMs, locator, now } = options;
  if (mode === "reset" || mode === "record_success") return closed(now, locator);
  if (mode === "record_failure") {
    const previousFailureCount =
      failureWindowMs > 0 &&
      previous.lastFailureAt !== null &&
      now - previous.lastFailureAt > failureWindowMs
        ? 0
        : previous.failureCount;
    const failureCount = previousFailureCount + 1;
    if (failureCount >= failureThreshold) {
      return {
        status: "open",
        circuitFlowId: locator.circuitFlowId,
        circuitRunId: locator.circuitRunId,
        circuitNodeId: locator.circuitNodeId,
        failureCount,
        openedAt: now,
        lastFailureAt: now,
        updatedAt: now,
      };
    }
    return {
      status: "closed",
      circuitFlowId: locator.circuitFlowId,
      circuitRunId: locator.circuitRunId,
      circuitNodeId: locator.circuitNodeId,
      failureCount,
      openedAt: null,
      lastFailureAt: now,
      updatedAt: now,
    };
  }
  if (
    previous.status === "open" &&
    previous.openedAt !== null &&
    now - previous.openedAt >= resetTimeoutMs
  ) {
    return {
      ...previous,
      status: "half_open",
      updatedAt: now,
    };
  }
  return { ...previous, updatedAt: now };
}

function closed(
  now: number,
  locator: { circuitFlowId: string; circuitRunId: string; circuitNodeId: string },
): CircuitState {
  return {
    status: "closed",
    circuitFlowId: locator.circuitFlowId,
    circuitRunId: locator.circuitRunId,
    circuitNodeId: locator.circuitNodeId,
    failureCount: 0,
    openedAt: null,
    lastFailureAt: null,
    updatedAt: now,
  };
}

function circuitTransitionReason(input: {
  mode: "check" | "record_failure" | "record_success" | "reset";
  previous: CircuitState;
  next: CircuitState;
  statusChanged: boolean;
}): string {
  if (input.mode === "reset") return "reset";
  if (input.mode === "record_success") return "success_recorded";
  if (input.mode === "record_failure" && input.next.status === "open") {
    return input.previous.status === "half_open"
      ? "half_open_probe_failed"
      : "failure_threshold_reached";
  }
  if (input.mode === "record_failure") return "failure_recorded";
  if (input.mode === "check" && input.statusChanged && input.next.status === "half_open") {
    return "reset_timeout_elapsed";
  }
  if (input.mode === "check" && input.next.status === "open") return "circuit_open";
  if (input.mode === "check" && input.next.status === "half_open") return "half_open_probe";
  return "circuit_closed";
}

function readCircuitState(
  value: unknown,
  locator: { circuitFlowId: string; circuitRunId: string; circuitNodeId: string },
): CircuitState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const status = readStatus(record.status);
    return {
      status,
      circuitFlowId: readString(record.circuitFlowId) ?? locator.circuitFlowId,
      circuitRunId: readString(record.circuitRunId) ?? locator.circuitRunId,
      circuitNodeId: readString(record.circuitNodeId) ?? locator.circuitNodeId,
      failureCount: readNonNegativeInteger(record.failureCount),
      openedAt:
        typeof record.openedAt === "number" && Number.isFinite(record.openedAt)
          ? record.openedAt
          : null,
      lastFailureAt:
        typeof record.lastFailureAt === "number" && Number.isFinite(record.lastFailureAt)
          ? record.lastFailureAt
          : null,
      updatedAt:
        typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : Date.now(),
    };
  }
  return closed(Date.now(), locator);
}

function readStatus(value: unknown): CircuitStatus {
  return value === "open" || value === "half_open" || value === "closed"
    ? value
    : "closed";
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.trunc(number) : undefined;
}

function readMode(value: unknown):
  | "check"
  | "record_failure"
  | "record_success"
  | "reset"
  | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim();
  return mode === "check" ||
    mode === "record_failure" ||
    mode === "record_success" ||
    mode === "reset"
    ? mode
    : undefined;
}

function asMutableVariableStore(value: unknown): MutableVariableStore | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { set?: unknown }).set === "function"
  ) {
    return value as MutableVariableStore;
  }
  return undefined;
}

function toVariableValue(state: CircuitState): VariableValue {
  return {
    status: state.status,
    circuitFlowId: state.circuitFlowId,
    circuitRunId: state.circuitRunId,
    circuitNodeId: state.circuitNodeId,
    failureCount: state.failureCount,
    openedAt: state.openedAt,
    lastFailureAt: state.lastFailureAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Circuit breaker state",
  };
}

function error(
  code: string,
  message: string,
  nodeId: string,
): {
  kind: "error";
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
} {
  return {
    kind: "error",
    error: createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "node_logic", nodeId },
    }) as unknown as {
      code: string;
      message: string;
      [key: string]: unknown;
    },
  };
}
