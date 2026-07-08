/**
 * `wait_timer` - durable timer wait checkpoint.
 *
 * Unlike `delay`, this node does not block the current run for a long sleep.
 * It stores a target due time in runtime variables and routes to `waiting`
 * until a later invocation observes that the timer is due.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type WaitTimerStatus = "waiting" | "due" | "expired";

interface WaitTimerState {
  status: WaitTimerStatus;
  requestedAt: number;
  dueAt: number;
  timeoutAt: number | null;
  updatedAt: number;
}

const waitTimerConfig = z
  .object({
    name: z.string().default("").describe("Timer state variable name."),
    dueAt: z
      .string()
      .default("")
      .describe("Absolute due time as ISO string or epoch milliseconds."),
    durationMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Relative wait duration in milliseconds when dueAt is empty."),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional expiry window after dueAt; 0 disables expiry."),
    reset: z
      .boolean()
      .default(false)
      .describe("When true, recomputes the timer even if state already exists."),
  })
  .passthrough();

export const waitTimerNode = defineNode({
  type: "wait_timer",
  typeVersion: "1.0.0",
  title: "Wait Timer",
  description: "Creates or checks a durable timer wait checkpoint.",
  kind: "pseudo",
  config: waitTimerConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_RETRY_TIMER",
    },
    dueAt: {
      label: "Due At",
      control: "input",
      order: 2,
      placeholder: "2026-07-08T12:00:00.000Z",
    },
    durationMs: {
      label: "Duration (ms)",
      control: "number",
      order: 3,
    },
    timeoutMs: {
      label: "Timeout (ms)",
      control: "number",
      order: 4,
    },
    reset: {
      label: "Reset",
      control: "switch",
      order: 5,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "dueAt", direction: "input", kind: "data", label: "Due At" },
    {
      id: "durationMs",
      direction: "input",
      kind: "data",
      label: "Duration ms",
      schema: { type: "number" },
    },
    { id: "due", direction: "output", kind: "control", label: "Due" },
    { id: "waiting", direction: "output", kind: "control", label: "Waiting" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "requestedAt", direction: "output", kind: "data", label: "Requested At", schema: { type: "string" } },
    { id: "dueAt", direction: "output", kind: "data", label: "Due At", schema: { type: "string" } },
    { id: "timeoutAt", direction: "output", kind: "data", label: "Timeout At", schema: { type: "string" } },
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
    {
      id: "overdueByMs",
      direction: "output",
      kind: "data",
      label: "Overdue by ms",
      schema: { type: "number" },
    },
    { id: "dueValue", direction: "output", kind: "data", label: "Due", schema: { type: "boolean" } },
    { id: "waitingValue", direction: "output", kind: "data", label: "Waiting", schema: { type: "boolean" } },
    { id: "expiredValue", direction: "output", kind: "data", label: "Expired", schema: { type: "boolean" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.wait_timer.missing_name",
        "wait_timer node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.wait_timer.readonly_store",
        "wait_timer requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const previous = config.reset === true ? null : readWaitTimerState(store.get(name));
    const created = previous ?? createWaitTimerState(input, config, now);
    if (!created) {
      return error(
        "node.wait_timer.invalid_due_time",
        "wait_timer requires a valid dueAt or durationMs",
        ctx.nodeId,
      );
    }

    const next = evaluateState(created, now);
    const remainingMs = Math.max(0, next.dueAt - now);
    const overdueByMs = Math.max(0, now - next.dueAt);
    const requestedAtIso = new Date(next.requestedAt).toISOString();
    const dueAtIso = new Date(next.dueAt).toISOString();
    const timeoutAtIso =
      next.timeoutAt === null ? "" : new Date(next.timeoutAt).toISOString();
    const timeoutMs =
      next.timeoutAt === null ? 0 : Math.max(0, next.timeoutAt - next.dueAt);

    store.set(name, toVariableValue(next), metadata(ctx.flowId));
    ctx.log.debug("wait_timer selected branch", {
      name,
      branch: next.status,
      dueAt: dueAtIso,
      remainingMs,
      overdueByMs,
    });

    return {
      kind: "success",
      outputs: {
        [next.status]: null,
        state: next,
        name,
        status: next.status,
        requestedAt: requestedAtIso,
        dueAt: dueAtIso,
        timeoutAt: timeoutAtIso,
        timeoutMs,
        remainingMs,
        overdueByMs,
        dueValue: next.status === "due",
        waitingValue: next.status === "waiting",
        expiredValue: next.status === "expired",
      },
    };
  },
});

function createWaitTimerState(
  input: Record<string, unknown>,
  config: {
    dueAt?: unknown;
    durationMs?: unknown;
    timeoutMs?: unknown;
  },
  now: number,
): WaitTimerState | null {
  const dueAt = readDueTime(input.dueAt) ?? readDueTime(config.dueAt);
  const durationMs = readDuration(input.durationMs) ?? readDuration(config.durationMs) ?? 0;
  const computedDueAt = dueAt ?? now + durationMs;
  if (!Number.isFinite(computedDueAt)) return null;

  const timeoutMs = readDuration(config.timeoutMs) ?? 0;
  return {
    status: "waiting",
    requestedAt: now,
    dueAt: computedDueAt,
    timeoutAt: timeoutMs > 0 ? computedDueAt + timeoutMs : null,
    updatedAt: now,
  };
}

function evaluateState(state: WaitTimerState, now: number): WaitTimerState {
  if (state.timeoutAt !== null && now > state.timeoutAt) {
    return {
      ...state,
      status: "expired",
      updatedAt: now,
    };
  }
  if (now >= state.dueAt) {
    return {
      ...state,
      status: "due",
      updatedAt: now,
    };
  }
  return {
    ...state,
    status: "waiting",
    updatedAt: now,
  };
}

function readWaitTimerState(value: unknown): WaitTimerState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const requestedAt = readTimestamp(record.requestedAt);
  const dueAt = readTimestamp(record.dueAt);
  const updatedAt = readTimestamp(record.updatedAt);
  if (requestedAt === null || dueAt === null || updatedAt === null) return null;
  return {
    status: readStatus(record.status),
    requestedAt,
    dueAt,
    timeoutAt: readTimestamp(record.timeoutAt),
    updatedAt,
  };
}

function readStatus(value: unknown): WaitTimerStatus {
  return value === "due" || value === "expired" || value === "waiting"
    ? value
    : "waiting";
}

function readDueTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function readDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function toVariableValue(state: WaitTimerState): VariableValue {
  return {
    status: state.status,
    requestedAt: state.requestedAt,
    dueAt: state.dueAt,
    timeoutAt: state.timeoutAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Durable timer wait state",
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
