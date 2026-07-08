/**
 * `signal_resume` - write an external signal into a wait checkpoint.
 *
 * This is the graph-native counterpart to an out-of-band webhook or human
 * callback updating the runtime state used by `wait_signal`.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type ResumeStatus = "resumed" | "ignored" | "missing" | "expired";

interface WaitSignalState {
  status: "waiting" | "received" | "expired";
  signal: VariableValue | null;
  expected: string;
  requestedAt: number;
  expiresAt: number | null;
  updatedAt: number;
}

const signalResumeConfig = z
  .object({
    name: z.string().default("").describe("Wait state variable name."),
    signal: z
      .unknown()
      .optional()
      .describe("Static signal fallback when no signal input is connected."),
    expected: z.string().default("").describe("Optional expected signal override."),
    createIfMissing: z
      .boolean()
      .default(false)
      .describe("When true, creates a received wait state if none exists."),
  })
  .passthrough();

export const signalResumeNode = defineNode({
  type: "signal_resume",
  typeVersion: "1.0.0",
  title: "Signal Resume",
  description: "Writes an external signal into a wait_signal checkpoint.",
  kind: "pseudo",
  config: signalResumeConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_APPROVAL",
    },
    signal: {
      label: "Signal",
      control: "textarea",
      order: 2,
      placeholder: "approved",
    },
    expected: {
      label: "Expected",
      control: "input",
      order: 3,
    },
    createIfMissing: {
      label: "Create If Missing",
      control: "switch",
      order: 4,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "signal", direction: "input", kind: "data", label: "Signal" },
    { id: "resumed", direction: "output", kind: "control", label: "Resumed" },
    { id: "ignored", direction: "output", kind: "control", label: "Ignored" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "signal", direction: "output", kind: "data", label: "Signal" },
    { id: "expected", direction: "output", kind: "data", label: "Expected", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.signal_resume.missing_name",
        "signal_resume node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.signal_resume.readonly_store",
        "signal_resume requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const rawSignal = input.signal ?? config.signal ?? null;
    const signal = toJsonValue(rawSignal);
    if (signal === undefined) {
      return error(
        "node.signal_resume.unsupported_signal",
        "signal_resume signal must be JSON-compatible",
        ctx.nodeId,
      );
    }

    const previous = readWaitSignalState(store.get(name));
    const expectedOverride = String(config.expected ?? "").trim();
    const expected = expectedOverride || previous?.expected || String(signal);
    const decision = applySignal(previous, {
      signal,
      expected,
      now,
      createIfMissing: config.createIfMissing === true,
    });

    if (decision.state) {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    }

    ctx.log.debug("signal_resume selected branch", {
      name,
      status: decision.status,
      expected,
    });

    return {
      kind: "success",
      outputs: {
        [decision.status]: null,
        state: decision.state,
        status: decision.status,
        signal,
        expected,
      },
    };
  },
});

function applySignal(
  previous: WaitSignalState | null,
  options: {
    signal: VariableValue | null;
    expected: string;
    now: number;
    createIfMissing: boolean;
  },
): { status: ResumeStatus; state: WaitSignalState | null } {
  const { signal, expected, now, createIfMissing } = options;
  if (!previous) {
    if (!createIfMissing) return { status: "missing", state: null };
    const state: WaitSignalState = {
      status: String(signal) === expected ? "received" : "waiting",
      signal,
      expected,
      requestedAt: now,
      expiresAt: null,
      updatedAt: now,
    };
    return { status: state.status === "received" ? "resumed" : "ignored", state };
  }
  if (previous.expiresAt !== null && now >= previous.expiresAt) {
    return {
      status: "expired",
      state: {
        ...previous,
        status: "expired",
        signal,
        updatedAt: now,
      },
    };
  }
  if (String(signal) !== expected) {
    return {
      status: "ignored",
      state: {
        ...previous,
        signal,
        updatedAt: now,
      },
    };
  }
  return {
    status: "resumed",
    state: {
      ...previous,
      status: "received",
      signal,
      expected,
      updatedAt: now,
    },
  };
}

function readWaitSignalState(value: unknown): WaitSignalState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const expected = typeof record.expected === "string" ? record.expected : "";
  if (expected === "") return null;
  return {
    status: record.status === "received" || record.status === "expired"
      ? record.status
      : "waiting",
    signal: toJsonValue(record.signal) ?? null,
    expected,
    requestedAt: readTimestamp(record.requestedAt) ?? Date.now(),
    expiresAt: readTimestamp(record.expiresAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
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
    description: "External wait signal resume state",
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
