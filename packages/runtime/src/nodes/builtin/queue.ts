/**
 * `queue` - persisted FIFO work queue.
 *
 * The node gives ordinary flows a small durable buffer without making the
 * scheduler responsible for hidden work leasing. Authors can explicitly push
 * items, pop work for a downstream branch, peek for inspection, or clear the
 * queue.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type QueueMode = "push" | "pop" | "peek" | "clear";
type QueueBranch = "pushed" | "popped" | "peeked" | "empty" | "cleared";

interface QueueState {
  items: VariableValue[];
  updatedAt: number;
  pushedCount: number;
  poppedCount: number;
}

const queueConfig = z
  .object({
    name: z.string().default("").describe("Queue state variable name."),
    mode: z
      .enum(["push", "pop", "peek", "clear"])
      .default("push")
      .describe("Queue operation mode."),
    maxItems: z
      .number()
      .int()
      .min(1)
      .default(1000)
      .describe("Maximum retained queue items."),
    count: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Number of items to pop or peek."),
  })
  .passthrough();

export const queueNode = defineNode({
  type: "queue",
  typeVersion: "1.0.0",
  title: "Queue",
  description: "Persists FIFO work items and routes push, pop, peek, or clear results.",
  kind: "pseudo",
  config: queueConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_WORK_QUEUE",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Push", value: "push" },
        { label: "Pop", value: "pop" },
        { label: "Peek", value: "peek" },
        { label: "Clear", value: "clear" },
      ],
    },
    maxItems: { label: "Max Items", control: "number", order: 3 },
    count: { label: "Count", control: "number", order: 4 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "maxItems", direction: "input", kind: "data", label: "Max Items", schema: { type: "number" } },
    { id: "count", direction: "input", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "item", direction: "input", kind: "data", label: "Item" },
    { id: "pushed", direction: "output", kind: "control", label: "Pushed" },
    { id: "popped", direction: "output", kind: "control", label: "Popped" },
    { id: "peeked", direction: "output", kind: "control", label: "Peeked" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "items", direction: "output", kind: "data", label: "Items" },
    { id: "item", direction: "output", kind: "data", label: "Item" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    {
      id: "maxItems",
      direction: "output",
      kind: "data",
      label: "Max Items",
      schema: { type: "number" },
    },
    {
      id: "requestedCount",
      direction: "output",
      kind: "data",
      label: "Requested Count",
      schema: { type: "number" },
    },
    { id: "state", direction: "output", kind: "data", label: "State" },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
    {
      id: "queueSize",
      direction: "output",
      kind: "data",
      label: "Queue size",
      schema: { type: "number" },
    },
    {
      id: "remaining",
      direction: "output",
      kind: "data",
      label: "Remaining",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error("node.queue.missing_name", "queue node requires config.name or name input", ctx.nodeId);
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error("node.queue.readonly_store", "queue requires a mutable VariableStore", ctx.nodeId);
    }

    const now = Date.now();
    const previous = readQueueState(store.get(name), now);
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "push";
    const maxItems = readPositiveInteger(input.maxItems) ?? readPositiveInteger(config.maxItems) ?? 1000;
    const count = readPositiveInteger(input.count) ?? readPositiveInteger(config.count) ?? 1;
    const decision = applyMode(previous, {
      mode,
      item: input.item ?? input.input ?? input.in ?? null,
      maxItems,
      count,
      now,
      nodeId: ctx.nodeId,
    });

    if (decision.kind === "error") return decision;

    if (decision.persist) {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    } else {
      store.delete(name);
    }

    const queueSize = decision.state.items.length;
    ctx.log.debug("queue selected branch", {
      name,
      mode,
      branch: decision.branch,
      count: decision.items.length,
      queueSize,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        items: decision.items,
        item: decision.items[0] ?? null,
        name,
        mode,
        maxItems,
        requestedCount: count,
        state: decision.state,
        count: decision.items.length,
        queueSize,
        remaining: Math.max(0, maxItems - queueSize),
      },
    };
  },
});

function applyMode(
  previous: QueueState,
  options: {
    mode: QueueMode;
    item: unknown;
    maxItems: number;
    count: number;
    now: number;
    nodeId: string;
  },
):
  | {
      kind: "success";
      branch: QueueBranch;
      items: VariableValue[];
      state: QueueState;
      persist: boolean;
    }
  | ReturnType<typeof error> {
  const { mode, item, maxItems, count, now, nodeId } = options;
  if (mode === "clear") {
    return {
      kind: "success",
      branch: "cleared",
      items: previous.items,
      state: emptyState(now, previous),
      persist: false,
    };
  }
  if (mode === "pop") {
    if (previous.items.length === 0) {
      return {
        kind: "success",
        branch: "empty",
        items: [],
        state: emptyState(now, previous),
        persist: false,
      };
    }
    const items = previous.items.slice(0, count);
    const remaining = previous.items.slice(items.length);
    const state: QueueState = {
      items: remaining,
      updatedAt: now,
      pushedCount: previous.pushedCount,
      poppedCount: previous.poppedCount + items.length,
    };
    return {
      kind: "success",
      branch: "popped",
      items,
      state,
      persist: remaining.length > 0,
    };
  }
  if (mode === "peek") {
    if (previous.items.length === 0) {
      return {
        kind: "success",
        branch: "empty",
        items: [],
        state: emptyState(now, previous),
        persist: false,
      };
    }
    return {
      kind: "success",
      branch: "peeked",
      items: previous.items.slice(0, count),
      state: { ...previous, updatedAt: now },
      persist: true,
    };
  }

  const value = toJsonValue(item);
  if (value === undefined) {
    return error("node.queue.unsupported_item", "queue item must be JSON-compatible", nodeId);
  }
  const items = [...previous.items, value].slice(-maxItems);
  return {
    kind: "success",
    branch: "pushed",
    items: [value],
    state: {
      items,
      updatedAt: now,
      pushedCount: previous.pushedCount + 1,
      poppedCount: previous.poppedCount,
    },
    persist: true,
  };
}

function readQueueState(value: unknown, now: number): QueueState {
  if (!value || typeof value !== "object") return emptyState(now);
  const record = value as Record<string, unknown>;
  return {
    items: Array.isArray(record.items)
      ? record.items.map(toJsonValue).filter((item): item is VariableValue => item !== undefined)
      : [],
    updatedAt: readTimestamp(record.updatedAt) ?? now,
    pushedCount: readNonNegativeInteger(record.pushedCount),
    poppedCount: readNonNegativeInteger(record.poppedCount),
  };
}

function emptyState(now: number, previous?: QueueState): QueueState {
  return {
    items: [],
    updatedAt: now,
    pushedCount: previous?.pushedCount ?? 0,
    poppedCount: previous?.poppedCount ?? 0,
  };
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function readMode(value: unknown): QueueMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "push" ||
    normalized === "pop" ||
    normalized === "peek" ||
    normalized === "clear"
    ? normalized
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer > 0 ? integer : undefined;
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

function toVariableValue(state: QueueState): VariableValue {
  return {
    items: state.items,
    updatedAt: state.updatedAt,
    pushedCount: state.pushedCount,
    poppedCount: state.poppedCount,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Queue state",
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
