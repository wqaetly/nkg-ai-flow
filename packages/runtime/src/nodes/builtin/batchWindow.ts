/**
 * `batch_window` - persisted batch accumulation gate.
 *
 * The node buffers items in the runtime VariableStore and routes to `ready`
 * once enough items are accumulated or the oldest batch item exceeds maxAgeMs.
 * It does not sleep; authors decide whether a waiting branch retries later.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type BatchWindowMode = "add" | "flush" | "clear";
type BatchWindowBranch = "ready" | "waiting" | "empty" | "cleared";

interface BatchWindowState {
  items: VariableValue[];
  createdAt: number;
  updatedAt: number;
  flushCount: number;
}

const batchWindowConfig = z
  .object({
    name: z.string().default("").describe("Batch window state variable name."),
    maxItems: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe("Number of items required before routing to ready."),
    maxAgeMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Maximum batch age before routing to ready; 0 disables age flush."),
    mode: z
      .enum(["add", "flush", "clear"])
      .default("add")
      .describe("Batch window operation mode."),
  })
  .passthrough();

export const batchWindowNode = defineNode({
  type: "batch_window",
  typeVersion: "1.0.0",
  title: "Batch Window",
  description: "Buffers items and flushes when count or age thresholds are met.",
  kind: "pseudo",
  config: batchWindowConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "EMAIL_BATCH",
    },
    maxItems: { label: "Max Items", control: "number", order: 2 },
    maxAgeMs: { label: "Max Age (ms)", control: "number", order: 3 },
    mode: {
      label: "Mode",
      control: "select",
      order: 4,
      enumOptions: [
        { label: "Add", value: "add" },
        { label: "Flush", value: "flush" },
        { label: "Clear", value: "clear" },
      ],
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "maxItems", direction: "input", kind: "data", label: "Max Items", schema: { type: "number" } },
    { id: "maxAgeMs", direction: "input", kind: "data", label: "Max Age ms", schema: { type: "number" } },
    { id: "item", direction: "input", kind: "data", label: "Item" },
    { id: "ready", direction: "output", kind: "control", label: "Ready" },
    { id: "waiting", direction: "output", kind: "control", label: "Waiting" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "items", direction: "output", kind: "data", label: "Items" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "maxItems", direction: "output", kind: "data", label: "Max Items", schema: { type: "number" } },
    { id: "maxAgeMs", direction: "output", kind: "data", label: "Max Age ms", schema: { type: "number" } },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    {
      id: "remaining",
      direction: "output",
      kind: "data",
      label: "Remaining",
      schema: { type: "number" },
    },
    {
      id: "ageMs",
      direction: "output",
      kind: "data",
      label: "Age ms",
      schema: { type: "number" },
    },
    {
      id: "flushCount",
      direction: "output",
      kind: "data",
      label: "Flush count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.batch_window.missing_name",
        "batch_window node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.batch_window.readonly_store",
        "batch_window requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const maxItems = readPositiveInteger(input.maxItems) ?? readPositiveInteger(config.maxItems) ?? 10;
    const maxAgeMs = readIntegerAtLeast(input.maxAgeMs, 0) ?? readIntegerAtLeast(config.maxAgeMs, 0) ?? 0;
    const previous = readBatchWindowState(store.get(name), now);
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "add";
    const decision =
      mode === "clear"
        ? clearWindow(previous, now)
        : mode === "flush"
          ? flushWindow(previous, now)
          : addItem(previous, input, { maxItems, maxAgeMs, now });

    if (decision.persist) {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    } else {
      store.delete(name);
    }

    const count = decision.state.items.length;
    const ageMs = count > 0 ? Math.max(0, now - decision.state.createdAt) : 0;
    const remaining = Math.max(0, maxItems - count);
    ctx.log.debug("batch_window selected branch", {
      name,
      mode,
      branch: decision.branch,
      count,
      maxItems,
      ageMs,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        items: decision.items,
        state: decision.state,
        name,
        mode,
        maxItems,
        maxAgeMs,
        count,
        remaining,
        ageMs,
        flushCount: decision.state.flushCount,
      },
    };
  },
});

function addItem(
  previous: BatchWindowState,
  input: Record<string, unknown>,
  options: { maxItems: number; maxAgeMs: number; now: number },
): { branch: BatchWindowBranch; state: BatchWindowState; items: VariableValue[]; persist: boolean } {
  const raw = input.item ?? input.input ?? input.in ?? null;
  const item = toJsonValue(raw);
  const items = item === undefined ? previous.items : [...previous.items, item];
  const createdAt = previous.items.length > 0 ? previous.createdAt : options.now;
  const state: BatchWindowState = {
    items,
    createdAt,
    updatedAt: options.now,
    flushCount: previous.flushCount,
  };
  const readyByCount = items.length >= options.maxItems;
  const readyByAge =
    options.maxAgeMs > 0 &&
    items.length > 0 &&
    options.now - createdAt >= options.maxAgeMs;
  if (readyByCount || readyByAge) return flushed(state, options.now);
  return { branch: "waiting", state, items, persist: true };
}

function flushWindow(
  previous: BatchWindowState,
  now: number,
): { branch: BatchWindowBranch; state: BatchWindowState; items: VariableValue[]; persist: boolean } {
  if (previous.items.length === 0) {
    return { branch: "empty", state: emptyState(now, previous.flushCount), items: [], persist: false };
  }
  return flushed(previous, now);
}

function clearWindow(
  previous: BatchWindowState,
  now: number,
): { branch: BatchWindowBranch; state: BatchWindowState; items: VariableValue[]; persist: boolean } {
  return {
    branch: "cleared",
    state: emptyState(now, previous.flushCount),
    items: previous.items,
    persist: false,
  };
}

function flushed(
  state: BatchWindowState,
  now: number,
): { branch: BatchWindowBranch; state: BatchWindowState; items: VariableValue[]; persist: boolean } {
  return {
    branch: "ready",
    state: emptyState(now, state.flushCount + 1),
    items: state.items,
    persist: false,
  };
}

function emptyState(now: number, flushCount: number): BatchWindowState {
  return {
    items: [],
    createdAt: now,
    updatedAt: now,
    flushCount,
  };
}

function readBatchWindowState(value: unknown, now: number): BatchWindowState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      items: Array.isArray(record.items)
        ? record.items.map(toJsonValue).filter((item): item is VariableValue => item !== undefined)
        : [],
      createdAt: readTimestamp(record.createdAt) ?? now,
      updatedAt: readTimestamp(record.updatedAt) ?? now,
      flushCount: readNonNegativeInteger(record.flushCount),
    };
  }
  return emptyState(now, 0);
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function readMode(value: unknown): BatchWindowMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "add" || normalized === "flush" || normalized === "clear"
    ? normalized
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer > 0 ? integer : undefined;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer >= minimum ? integer : undefined;
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

function toVariableValue(state: BatchWindowState): VariableValue {
  return {
    items: state.items,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    flushCount: state.flushCount,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Batch window state",
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
