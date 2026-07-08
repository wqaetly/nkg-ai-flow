/**
 * `rate_limit` - stateful sliding-window gate.
 *
 * The node persists compact counters in the runtime VariableStore so API
 * calls, tool invocations, or batch branches can make explicit "go / wait"
 * decisions without hiding scheduler behaviour.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

interface RateLimitState {
  windowStart: number;
  windowMs: number;
  limit: number;
  timestamps: number[];
  updatedAt: number;
}

const rateLimitConfig = z
  .object({
    name: z.string().default("").describe("Rate limit state variable name."),
    limit: z
      .number()
      .int()
      .min(1)
      .default(60)
      .describe("Maximum allowed hits within the window."),
    windowMs: z
      .number()
      .int()
      .min(1)
      .default(60000)
      .describe("Sliding window size in milliseconds."),
    cost: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("How many hits this run consumes when allowed."),
  })
  .passthrough();

export const rateLimitNode = defineNode({
  type: "rate_limit",
  typeVersion: "1.0.0",
  title: "Rate Limit",
  description: "Routes execution based on a persisted sliding-window quota.",
  kind: "pseudo",
  config: rateLimitConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "OPENAI_API_LIMIT",
    },
    limit: { label: "Limit", control: "number", order: 2 },
    windowMs: { label: "Window (ms)", control: "number", order: 3 },
    cost: { label: "Cost", control: "number", order: 4 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "allowed", direction: "output", kind: "control", label: "Allowed" },
    { id: "limited", direction: "output", kind: "control", label: "Limited" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    {
      id: "remaining",
      direction: "output",
      kind: "data",
      label: "Remaining",
      schema: { type: "number" },
    },
    {
      id: "used",
      direction: "output",
      kind: "data",
      label: "Used",
      schema: { type: "number" },
    },
    {
      id: "retryAfterMs",
      direction: "output",
      kind: "data",
      label: "Retry after ms",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.rate_limit.missing_name",
        "rate_limit node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.rate_limit.readonly_store",
        "rate_limit requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const limit = Math.max(1, Math.trunc(Number(config.limit ?? 60)));
    const windowMs = Math.max(1, Math.trunc(Number(config.windowMs ?? 60000)));
    const cost = Math.max(1, Math.trunc(Number(config.cost ?? 1)));
    const previous = readRateLimitState(store.get(name), { limit, windowMs, now });
    const active = previous.timestamps.filter((timestamp) => now - timestamp < windowMs);
    const usedBefore = active.length;
    const allowed = usedBefore + cost <= limit;
    const timestamps = allowed ? appendHits(active, cost, now) : active;
    const used = timestamps.length;
    const remaining = Math.max(0, limit - used);
    const retryAfterMs = allowed
      ? 0
      : Math.max(0, windowMs - (now - (active[0] ?? now)));
    const state: RateLimitState = {
      windowStart: timestamps[0] ?? now,
      windowMs,
      limit,
      timestamps,
      updatedAt: now,
    };

    store.set(name, toVariableValue(state), metadata(ctx.flowId));
    const branch = allowed ? "allowed" : "limited";
    ctx.log.debug("rate_limit selected branch", {
      name,
      branch,
      limit,
      used,
      remaining,
      retryAfterMs,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        state,
        name,
        remaining,
        used,
        retryAfterMs,
      },
    };
  },
});

function readRateLimitState(
  value: unknown,
  fallback: { limit: number; windowMs: number; now: number },
): RateLimitState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const timestamps = Array.isArray(record.timestamps)
      ? record.timestamps.filter(isFiniteNumber)
      : [];
    return {
      windowStart: readTimestamp(record.windowStart) ?? timestamps[0] ?? fallback.now,
      windowMs: readPositiveInteger(record.windowMs) ?? fallback.windowMs,
      limit: readPositiveInteger(record.limit) ?? fallback.limit,
      timestamps,
      updatedAt: readTimestamp(record.updatedAt) ?? fallback.now,
    };
  }
  return {
    windowStart: fallback.now,
    windowMs: fallback.windowMs,
    limit: fallback.limit,
    timestamps: [],
    updatedAt: fallback.now,
  };
}

function appendHits(timestamps: number[], cost: number, now: number): number[] {
  const next = [...timestamps];
  for (let index = 0; index < cost; index++) next.push(now);
  return next;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

function toVariableValue(state: RateLimitState): VariableValue {
  return {
    windowStart: state.windowStart,
    windowMs: state.windowMs,
    limit: state.limit,
    timestamps: state.timestamps,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Rate limit sliding-window state",
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
