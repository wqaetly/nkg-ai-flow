/**
 * `wait_signal` - external wait checkpoint.
 *
 * The runtime does not suspend a running DAG. This node stores a wait
 * request and routes the current run to `waiting` until an external actor
 * writes the expected signal into the same state entry. A later run can
 * re-check the checkpoint and continue through `received`.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type WaitStatus = "waiting" | "received" | "expired";

interface WaitSignalState {
  status: WaitStatus;
  signal: VariableValue | null;
  expected: string;
  requestedAt: number;
  expiresAt: number | null;
  updatedAt: number;
}

const waitSignalConfig = z
  .object({
    name: z.string().default("").describe("Wait state variable name."),
    expected: z.string().default("approved").describe("Expected signal value."),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional timeout in milliseconds; 0 disables expiry."),
  })
  .passthrough();

export const waitSignalNode = defineNode({
  type: "wait_signal",
  typeVersion: "1.0.0",
  title: "Wait Signal",
  description: "Creates or checks an external wait checkpoint.",
  kind: "pseudo",
  config: waitSignalConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_APPROVAL",
    },
    expected: {
      label: "Expected",
      control: "input",
      order: 2,
    },
    timeoutMs: {
      label: "Timeout (ms)",
      control: "number",
      order: 3,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "signal", direction: "input", kind: "data", label: "Signal" },
    { id: "expected", direction: "input", kind: "data", label: "Expected", schema: { type: "string" } },
    { id: "received", direction: "output", kind: "control", label: "Received" },
    { id: "waiting", direction: "output", kind: "control", label: "Waiting" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status" },
    { id: "signal", direction: "output", kind: "data", label: "Signal" },
    { id: "expected", direction: "output", kind: "data", label: "Expected", schema: { type: "string" } },
    { id: "requestedAt", direction: "output", kind: "data", label: "Requested At", schema: { type: "string" } },
    { id: "expiresAt", direction: "output", kind: "data", label: "Expires At", schema: { type: "string" } },
    {
      id: "timeoutMs",
      direction: "output",
      kind: "data",
      label: "Timeout ms",
      schema: { type: "number" },
    },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
    { id: "receivedValue", direction: "output", kind: "data", label: "Received", schema: { type: "boolean" } },
    { id: "waitingValue", direction: "output", kind: "data", label: "Waiting", schema: { type: "boolean" } },
    { id: "expiredValue", direction: "output", kind: "data", label: "Expired", schema: { type: "boolean" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.wait_signal.missing_name",
        "wait_signal node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.wait_signal.readonly_store",
        "wait_signal requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const expected = String(input.expected ?? config.expected ?? "approved");
    const timeoutMs = Math.max(0, Math.trunc(Number(config.timeoutMs ?? 0)));
    const previous = readWaitSignalState(store.get(name), expected, timeoutMs, now);
    const signal = input.signal ?? previous.signal;
    const next = evaluateState(previous, signal, expected, now);
    const remainingMs =
      next.expiresAt === null ? 0 : Math.max(0, next.expiresAt - now);
    const requestedAtIso = new Date(next.requestedAt).toISOString();
    const expiresAtIso =
      next.expiresAt === null ? "" : new Date(next.expiresAt).toISOString();
    const effectiveTimeoutMs =
      next.expiresAt === null ? 0 : Math.max(0, next.expiresAt - next.requestedAt);
    const branch = next.status;

    store.set(name, toVariableValue(next), metadata(ctx.flowId));
    ctx.log.debug("wait_signal selected branch", {
      name,
      expected,
      branch,
      remainingMs,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        state: next,
        name,
        status: next.status,
        signal: next.signal,
        expected: next.expected,
        requestedAt: requestedAtIso,
        expiresAt: expiresAtIso,
        timeoutMs: effectiveTimeoutMs,
        remainingMs,
        receivedValue: next.status === "received",
        waitingValue: next.status === "waiting",
        expiredValue: next.status === "expired",
      },
    };
  },
});

function evaluateState(
  previous: WaitSignalState,
  signal: unknown,
  expected: string,
  now: number,
): WaitSignalState {
  const converted = toJsonValue(signal);
  if (previous.status === "expired") {
    return {
      ...previous,
      status: "expired",
      updatedAt: now,
    };
  }
  if (previous.status === "received") {
    return {
      ...previous,
      status: "received",
      updatedAt: now,
    };
  }
  if (converted !== undefined && String(converted) === expected) {
    return {
      ...previous,
      status: "received",
      signal: converted,
      expected,
      updatedAt: now,
    };
  }
  if (previous.expiresAt !== null && now >= previous.expiresAt) {
    return {
      ...previous,
      status: "expired",
      signal: converted ?? previous.signal,
      updatedAt: now,
    };
  }
  return {
    ...previous,
    status: "waiting",
    signal: converted ?? previous.signal,
    expected,
    updatedAt: now,
  };
}

function readWaitSignalState(
  value: unknown,
  expected: string,
  timeoutMs: number,
  now: number,
): WaitSignalState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const requestedAt = readTimestamp(record.requestedAt) ?? now;
    const configuredExpiresAt =
      timeoutMs > 0 ? requestedAt + timeoutMs : null;
    return {
      status: readStatus(record.status),
      signal: toJsonValue(record.signal) ?? null,
      expected:
        typeof record.expected === "string" && record.expected.length > 0
          ? record.expected
          : expected,
      requestedAt,
      expiresAt: readTimestamp(record.expiresAt) ?? configuredExpiresAt,
      updatedAt: readTimestamp(record.updatedAt) ?? now,
    };
  }
  return {
    status: "waiting",
    signal: null,
    expected,
    requestedAt: now,
    expiresAt: timeoutMs > 0 ? now + timeoutMs : null,
    updatedAt: now,
  };
}

function readStatus(value: unknown): WaitStatus {
  return value === "received" || value === "expired" || value === "waiting"
    ? value
    : "waiting";
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function toVariableValue(state: WaitSignalState): VariableValue {
  return {
    status: state.status,
    signal: state.signal,
    expected: state.expected,
    requestedAt: state.requestedAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "External wait signal state",
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
