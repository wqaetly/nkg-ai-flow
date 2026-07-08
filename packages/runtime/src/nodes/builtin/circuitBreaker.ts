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
  failureCount: number;
  openedAt: number | null;
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
    mode: {
      label: "Mode",
      control: "select",
      order: 4,
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
    { id: "closed", direction: "output", kind: "control", label: "Closed" },
    { id: "open", direction: "output", kind: "control", label: "Open" },
    {
      id: "half_open",
      direction: "output",
      kind: "control",
      label: "Half-open",
    },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "status", direction: "output", kind: "data", label: "Status" },
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
    { id: "isOpen", direction: "output", kind: "data", label: "Is Open", schema: { type: "boolean" } },
    { id: "isHalfOpen", direction: "output", kind: "data", label: "Is Half Open", schema: { type: "boolean" } },
    { id: "isClosed", direction: "output", kind: "data", label: "Is Closed", schema: { type: "boolean" } },
    { id: "canPass", direction: "output", kind: "data", label: "Can Pass", schema: { type: "boolean" } },
    { id: "openedAt", direction: "output", kind: "data", label: "Opened At", schema: { type: "string" } },
    { id: "updatedAt", direction: "output", kind: "data", label: "Updated At", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ config, ctx }) {
    const name = String(config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.circuit_breaker.missing_name",
        "circuit_breaker node requires config.name",
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
    const failureThreshold = Math.max(
      1,
      Math.trunc(Number(config.failureThreshold ?? 3)),
    );
    const resetTimeoutMs = Math.max(
      0,
      Math.trunc(Number(config.resetTimeoutMs ?? 30000)),
    );
    const mode = config.mode ?? "check";
    const previous = readCircuitState(store.get(name));
    const next = applyMode(previous, {
      mode,
      failureThreshold,
      resetTimeoutMs,
      now,
    });
    const remainingMs =
      next.status === "open" && next.openedAt !== null
        ? Math.max(0, resetTimeoutMs - (now - next.openedAt))
        : 0;
    const openedAt = next.openedAt === null ? "" : new Date(next.openedAt).toISOString();
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

    ctx.log.debug("circuit_breaker selected branch", {
      name,
      mode,
      branch,
      failureCount: next.failureCount,
      failureThreshold,
      remainingMs,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        state: next,
        status: next.status,
        failureCount: next.failureCount,
        remainingMs,
        failureThreshold,
        remainingFailures,
        resetTimeoutMs,
        isOpen,
        isHalfOpen,
        isClosed,
        canPass,
        openedAt,
        updatedAt,
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
    now: number;
  },
): CircuitState {
  const { mode, failureThreshold, resetTimeoutMs, now } = options;
  if (mode === "reset" || mode === "record_success") return closed(now);
  if (mode === "record_failure") {
    const failureCount = previous.failureCount + 1;
    if (failureCount >= failureThreshold) {
      return {
        status: "open",
        failureCount,
        openedAt: now,
        updatedAt: now,
      };
    }
    return {
      status: "closed",
      failureCount,
      openedAt: null,
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

function closed(now: number): CircuitState {
  return {
    status: "closed",
    failureCount: 0,
    openedAt: null,
    updatedAt: now,
  };
}

function readCircuitState(value: unknown): CircuitState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const status = readStatus(record.status);
    return {
      status,
      failureCount: readNonNegativeInteger(record.failureCount),
      openedAt:
        typeof record.openedAt === "number" && Number.isFinite(record.openedAt)
          ? record.openedAt
          : null,
      updatedAt:
        typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : Date.now(),
    };
  }
  return closed(Date.now());
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
    failureCount: state.failureCount,
    openedAt: state.openedAt,
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
