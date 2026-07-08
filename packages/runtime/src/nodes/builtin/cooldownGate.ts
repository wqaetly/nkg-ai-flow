/**
 * `cooldown_gate` - stateful suppression window.
 *
 * It lets flows explicitly say "allow this branch once, then suppress repeats
 * for N milliseconds" without hiding that behaviour in scheduler code.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type CooldownMode = "consume" | "check" | "reset";

interface CooldownState {
  lastAllowedAt: number;
  readyAt: number;
  durationMs: number;
  allowedCount: number;
  suppressedCount: number;
  updatedAt: number;
}

const cooldownGateConfig = z
  .object({
    name: z.string().default("").describe("Cooldown state variable name."),
    durationMs: z
      .number()
      .int()
      .min(1)
      .default(60000)
      .describe("Cooldown window in milliseconds."),
    mode: z
      .enum(["consume", "check", "reset"])
      .default("consume")
      .describe("consume starts a cooldown, check only inspects, reset clears state."),
  })
  .passthrough();

export const cooldownGateNode = defineNode({
  type: "cooldown_gate",
  typeVersion: "1.0.0",
  title: "Cooldown Gate",
  description: "Allows a branch once, then suppresses repeats until the cooldown expires.",
  kind: "pseudo",
  config: cooldownGateConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ALERT_NOTIFICATION_COOLDOWN",
    },
    durationMs: {
      label: "Duration (ms)",
      control: "number",
      order: 2,
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 3,
      enumOptions: [
        { label: "Consume", value: "consume" },
        { label: "Check", value: "check" },
        { label: "Reset", value: "reset" },
      ],
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "now", direction: "input", kind: "data", label: "Now" },
    { id: "ready", direction: "output", kind: "control", label: "Ready" },
    { id: "cooling", direction: "output", kind: "control", label: "Cooling" },
    { id: "reset", direction: "output", kind: "control", label: "Reset" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "remainingMs", direction: "output", kind: "data", label: "Remaining ms", schema: { type: "number" } },
    { id: "readyAt", direction: "output", kind: "data", label: "Ready at", schema: { type: "number" } },
    { id: "lastAllowedAt", direction: "output", kind: "data", label: "Last allowed at", schema: { type: "number" } },
    { id: "allowedCount", direction: "output", kind: "data", label: "Allowed count", schema: { type: "number" } },
    { id: "suppressedCount", direction: "output", kind: "data", label: "Suppressed count", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.cooldown_gate.missing_name",
        "cooldown_gate requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.cooldown_gate.readonly_store",
        "cooldown_gate requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const mode = readMode(config.mode);
    const durationMs = Math.max(1, Math.trunc(Number(config.durationMs ?? 60000)));
    const now = readTimestamp(input.now) ?? Date.now();
    const previous = readCooldownState(store.get(name), durationMs);

    if (mode === "reset") {
      store.delete(name);
      return success("reset", null, {
        status: "reset",
        remainingMs: 0,
        readyAt: now,
        lastAllowedAt: 0,
        allowedCount: previous?.allowedCount ?? 0,
        suppressedCount: previous?.suppressedCount ?? 0,
      }, name);
    }

    const cooling = previous ? now < previous.readyAt : false;
    const ready = !cooling;
    const status = ready ? "ready" : "cooling";
    const remainingMs = previous ? Math.max(0, previous.readyAt - now) : 0;
    const next = buildNextState({
      previous,
      ready,
      mode,
      now,
      durationMs,
    });

    store.set(name, stateToVariableValue(next), metadata(ctx.flowId));
    ctx.log.debug("cooldown_gate selected branch", {
      name,
      mode,
      status,
      remainingMs,
    });

    return success(ready ? "ready" : "cooling", next, {
      status,
      remainingMs: ready ? 0 : remainingMs,
      readyAt: next.readyAt,
      lastAllowedAt: next.lastAllowedAt,
      allowedCount: next.allowedCount,
      suppressedCount: next.suppressedCount,
    }, name);
  },
});

function buildNextState(args: {
  previous: CooldownState | undefined;
  ready: boolean;
  mode: CooldownMode;
  now: number;
  durationMs: number;
}): CooldownState {
  const { previous, ready, mode, now, durationMs } = args;
  const shouldConsume = mode === "consume" && ready;
  const shouldSuppress = mode === "consume" && !ready;
  return {
    lastAllowedAt: shouldConsume ? now : (previous?.lastAllowedAt ?? 0),
    readyAt: shouldConsume ? now + durationMs : (previous?.readyAt ?? now),
    durationMs,
    allowedCount: (previous?.allowedCount ?? 0) + (shouldConsume ? 1 : 0),
    suppressedCount: (previous?.suppressedCount ?? 0) + (shouldSuppress ? 1 : 0),
    updatedAt: now,
  };
}

function success(
  branch: "ready" | "cooling" | "reset",
  state: CooldownState | null,
  data: {
    status: string;
    remainingMs: number;
    readyAt: number;
    lastAllowedAt: number;
    allowedCount: number;
    suppressedCount: number;
  },
  name: string,
) {
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      state,
      name,
      status: data.status,
      remainingMs: data.remainingMs,
      readyAt: data.readyAt,
      lastAllowedAt: data.lastAllowedAt,
      allowedCount: data.allowedCount,
      suppressedCount: data.suppressedCount,
    },
  };
}

function readMode(value: unknown): CooldownMode {
  return value === "check" || value === "reset" ? value : "consume";
}

function readCooldownState(
  value: unknown,
  durationMs: number,
): CooldownState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const readyAt = readTimestamp(record.readyAt);
  if (readyAt === undefined) return undefined;
  return {
    lastAllowedAt: readTimestamp(record.lastAllowedAt) ?? 0,
    readyAt,
    durationMs: readPositiveInteger(record.durationMs) ?? durationMs,
    allowedCount: readNonNegativeInteger(record.allowedCount) ?? 0,
    suppressedCount: readNonNegativeInteger(record.suppressedCount) ?? 0,
    updatedAt: readTimestamp(record.updatedAt) ?? 0,
  };
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}

function asMutableVariableStore(value: unknown): MutableVariableStore | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { set?: unknown }).set === "function" &&
    typeof (value as { delete?: unknown }).delete === "function"
  ) {
    return value as MutableVariableStore;
  }
  return undefined;
}

function stateToVariableValue(state: CooldownState): VariableValue {
  return {
    lastAllowedAt: state.lastAllowedAt,
    readyAt: state.readyAt,
    durationMs: state.durationMs,
    allowedCount: state.allowedCount,
    suppressedCount: state.suppressedCount,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Cooldown gate state",
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
