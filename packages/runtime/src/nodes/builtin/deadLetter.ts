/**
 * `dead_letter` - persisted dead-letter queue for failed work.
 *
 * Error handling stays explicit in the graph: failed branches can enqueue
 * payloads/errors here, and later flows can drain or clear the queue for
 * replay, alerting, or manual remediation.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type DeadLetterMode = "enqueue" | "drain" | "clear";
type DeadLetterBranch = "recorded" | "drained" | "empty" | "cleared";

interface DeadLetterEntry {
  id: string;
  payload: VariableValue | null;
  error: VariableValue | null;
  reason: string;
  recordedAt: number;
}

interface DeadLetterState {
  entries: DeadLetterEntry[];
  updatedAt: number;
}

const deadLetterConfig = z
  .object({
    name: z.string().default("").describe("Dead-letter queue state variable name."),
    mode: z
      .enum(["enqueue", "drain", "clear"])
      .default("enqueue")
      .describe("Dead-letter operation mode."),
    reason: z.string().default("").describe("Optional failure reason."),
    maxItems: z
      .number()
      .int()
      .min(1)
      .default(1000)
      .describe("Maximum retained queue entries."),
  })
  .passthrough();

export const deadLetterNode = defineNode({
  type: "dead_letter",
  typeVersion: "1.0.0",
  title: "Dead Letter",
  description: "Records or drains failed payloads for replay or remediation.",
  kind: "pseudo",
  config: deadLetterConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_DEAD_LETTERS",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Enqueue", value: "enqueue" },
        { label: "Drain", value: "drain" },
        { label: "Clear", value: "clear" },
      ],
    },
    reason: { label: "Reason", control: "input", order: 3 },
    maxItems: { label: "Max Items", control: "number", order: 4 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "payload", direction: "input", kind: "data", label: "Payload" },
    { id: "error", direction: "input", kind: "data", label: "Error" },
    { id: "recorded", direction: "output", kind: "control", label: "Recorded" },
    { id: "drained", direction: "output", kind: "control", label: "Drained" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "entries", direction: "output", kind: "data", label: "Entries" },
    { id: "entry", direction: "output", kind: "data", label: "Entry" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.dead_letter.missing_name",
        "dead_letter node requires config.name",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.dead_letter.readonly_store",
        "dead_letter requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const mode = config.mode ?? "enqueue";
    const previous = readDeadLetterState(store.get(name));
    const maxItems = Math.max(1, Math.trunc(Number(config.maxItems ?? 1000)));
    const decision = applyMode(previous, {
      mode,
      reason: String(config.reason ?? ""),
      payload: input.payload ?? input.input ?? input.in ?? null,
      error: input.error ?? null,
      maxItems,
      now,
    });

    if (decision.persist) {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    } else {
      store.delete(name);
    }

    ctx.log.debug("dead_letter selected branch", {
      name,
      mode,
      branch: decision.branch,
      count: decision.entries.length,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        entries: decision.entries,
        entry: decision.entries[0] ?? null,
        count: decision.entries.length,
        state: decision.state,
      },
    };
  },
});

function applyMode(
  previous: DeadLetterState,
  options: {
    mode: DeadLetterMode;
    reason: string;
    payload: unknown;
    error: unknown;
    maxItems: number;
    now: number;
  },
): {
  branch: DeadLetterBranch;
  entries: DeadLetterEntry[];
  state: DeadLetterState;
  persist: boolean;
} {
  const { mode, reason, payload, error, maxItems, now } = options;
  if (mode === "clear") {
    return { branch: "cleared", entries: [], state: emptyState(now), persist: false };
  }
  if (mode === "drain") {
    if (previous.entries.length === 0) {
      return { branch: "empty", entries: [], state: emptyState(now), persist: false };
    }
    return {
      branch: "drained",
      entries: previous.entries,
      state: emptyState(now),
      persist: false,
    };
  }
  const entry: DeadLetterEntry = {
    id: `${now}-${previous.entries.length + 1}`,
    payload: toJsonValue(payload) ?? null,
    error: toJsonValue(error) ?? null,
    reason: reason.trim(),
    recordedAt: now,
  };
  const entries = [...previous.entries, entry].slice(-maxItems);
  return {
    branch: "recorded",
    entries: [entry],
    state: { entries, updatedAt: now },
    persist: true,
  };
}

function readDeadLetterState(value: unknown): DeadLetterState {
  if (!value || typeof value !== "object") return emptyState(Date.now());
  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.entries)
    ? record.entries.map(readEntry).filter((entry): entry is DeadLetterEntry => entry !== null)
    : [];
  return {
    entries,
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function readEntry(value: unknown): DeadLetterEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    payload: toJsonValue(record.payload) ?? null,
    error: toJsonValue(record.error) ?? null,
    reason: typeof record.reason === "string" ? record.reason : "",
    recordedAt: readTimestamp(record.recordedAt) ?? Date.now(),
  };
}

function emptyState(now: number): DeadLetterState {
  return { entries: [], updatedAt: now };
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function toVariableValue(state: DeadLetterState): VariableValue {
  return {
    entries: state.entries.map((entry) => ({
      id: entry.id,
      payload: entry.payload,
      error: entry.error,
      reason: entry.reason,
      recordedAt: entry.recordedAt,
    })),
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Dead-letter queue state",
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
