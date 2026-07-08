/**
 * `semaphore` - stateful counting concurrency gate.
 *
 * Compared with `mutex`, this node allows up to `capacity` concurrent owners
 * for a named resource. It is useful for pool limits such as "at most 3 file
 * processors" or "at most 5 API workers" while keeping routing explicit.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type SemaphoreMode = "acquire" | "release" | "refresh" | "force_release";

interface SemaphoreHolder {
  owner: string;
  acquiredAt: number;
  expiresAt: number | null;
  updatedAt: number;
}

interface SemaphoreState {
  capacity: number;
  holders: SemaphoreHolder[];
  updatedAt: number;
}

const semaphoreConfig = z
  .object({
    name: z.string().default("").describe("Semaphore state variable name."),
    owner: z
      .string()
      .default("")
      .describe("Optional owner token. Empty defaults to flowId:runId."),
    capacity: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Maximum concurrent owners."),
    ttlMs: z
      .number()
      .int()
      .min(0)
      .default(300000)
      .describe("Permit time-to-live in milliseconds; 0 disables expiry."),
    mode: z
      .enum(["acquire", "release", "refresh", "force_release"])
      .default("acquire")
      .describe("Semaphore operation mode."),
  })
  .passthrough();

export const semaphoreNode = defineNode({
  type: "semaphore",
  typeVersion: "1.0.0",
  title: "Semaphore",
  description: "Acquires or releases a persisted counting concurrency permit.",
  kind: "pseudo",
  config: semaphoreConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "FILE_WORKER_POOL",
    },
    owner: {
      label: "Owner",
      control: "input",
      order: 2,
      placeholder: "Optional owner token.",
    },
    capacity: { label: "Capacity", control: "number", order: 3 },
    ttlMs: { label: "TTL (ms)", control: "number", order: 4 },
    mode: {
      label: "Mode",
      control: "select",
      order: 5,
      enumOptions: [
        { label: "Acquire", value: "acquire" },
        { label: "Release", value: "release" },
        { label: "Refresh", value: "refresh" },
        { label: "Force release", value: "force_release" },
      ],
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "owner", direction: "input", kind: "data", label: "Owner" },
    { id: "acquired", direction: "output", kind: "control", label: "Acquired" },
    { id: "saturated", direction: "output", kind: "control", label: "Saturated" },
    { id: "released", direction: "output", kind: "control", label: "Released" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "owner", direction: "output", kind: "data", label: "Owner" },
    {
      id: "available",
      direction: "output",
      kind: "data",
      label: "Available",
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
      id: "capacity",
      direction: "output",
      kind: "data",
      label: "Capacity",
      schema: { type: "number" },
    },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.semaphore.missing_name",
        "semaphore node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.semaphore.readonly_store",
        "semaphore requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const owner = readOwner(input.owner, config.owner, `${ctx.flowId}:${ctx.runId}`);
    const capacity = Math.max(1, Math.trunc(Number(config.capacity ?? 1)));
    const ttlMs = Math.max(0, Math.trunc(Number(config.ttlMs ?? 300000)));
    const mode = config.mode ?? "acquire";
    const previous = normalizeState(readSemaphoreState(store.get(name)), capacity, now);
    const decision = applyMode(previous, { mode, owner, capacity, ttlMs, now });
    const used = decision.state.holders.length;
    const available = Math.max(0, capacity - used);
    const remainingMs = ownerRemainingMs(decision.state, owner, now);

    store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    ctx.log.debug("semaphore selected branch", {
      name,
      mode,
      owner,
      branch: decision.branch,
      capacity,
      used,
      available,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state: decision.state,
        name,
        owner,
        available,
        used,
        capacity,
        remainingMs,
      },
    };
  },
});

function applyMode(
  previous: SemaphoreState,
  options: {
    mode: SemaphoreMode;
    owner: string;
    capacity: number;
    ttlMs: number;
    now: number;
  },
): { branch: "acquired" | "saturated" | "released"; state: SemaphoreState } {
  const { mode, owner, capacity, ttlMs, now } = options;
  if (mode === "force_release") {
    return {
      branch: "released",
      state: { capacity, holders: [], updatedAt: now },
    };
  }
  if (mode === "release") {
    return {
      branch: "released",
      state: {
        capacity,
        holders: previous.holders.filter((holder) => holder.owner !== owner),
        updatedAt: now,
      },
    };
  }
  const existing = previous.holders.find((holder) => holder.owner === owner);
  if (mode === "refresh") {
    if (existing) {
      return {
        branch: "acquired",
        state: upsertHolder(previous, owner, ttlMs, now, existing.acquiredAt),
      };
    }
    return { branch: "saturated", state: { ...previous, capacity, updatedAt: now } };
  }
  if (existing) {
    return {
      branch: "acquired",
      state: upsertHolder(previous, owner, ttlMs, now, existing.acquiredAt),
    };
  }
  if (previous.holders.length >= capacity) {
    return { branch: "saturated", state: { ...previous, capacity, updatedAt: now } };
  }
  return {
    branch: "acquired",
    state: upsertHolder(previous, owner, ttlMs, now, now),
  };
}

function upsertHolder(
  previous: SemaphoreState,
  owner: string,
  ttlMs: number,
  now: number,
  acquiredAt: number,
): SemaphoreState {
  const next: SemaphoreHolder = {
    owner,
    acquiredAt,
    expiresAt: ttlMs > 0 ? now + ttlMs : null,
    updatedAt: now,
  };
  return {
    capacity: previous.capacity,
    holders: [
      ...previous.holders.filter((holder) => holder.owner !== owner),
      next,
    ],
    updatedAt: now,
  };
}

function normalizeState(
  state: SemaphoreState,
  capacity: number,
  now: number,
): SemaphoreState {
  return {
    capacity,
    holders: state.holders.filter(
      (holder) => holder.expiresAt === null || now < holder.expiresAt,
    ),
    updatedAt: now,
  };
}

function readSemaphoreState(value: unknown): SemaphoreState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const holders = Array.isArray(record.holders)
      ? record.holders.map(readHolder).filter((holder): holder is SemaphoreHolder => holder !== null)
      : [];
    return {
      capacity: readPositiveInteger(record.capacity) ?? 1,
      holders,
      updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
    };
  }
  return { capacity: 1, holders: [], updatedAt: Date.now() };
}

function readHolder(value: unknown): SemaphoreHolder | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const owner = typeof record.owner === "string" ? record.owner : "";
  if (owner === "") return null;
  return {
    owner,
    acquiredAt: readTimestamp(record.acquiredAt) ?? Date.now(),
    expiresAt: readTimestamp(record.expiresAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function ownerRemainingMs(
  state: SemaphoreState,
  owner: string,
  now: number,
): number {
  const holder = state.holders.find((candidate) => candidate.owner === owner);
  if (!holder || holder.expiresAt === null) return 0;
  return Math.max(0, holder.expiresAt - now);
}

function readOwner(inputOwner: unknown, configOwner: unknown, fallback: string): string {
  const fromInput = typeof inputOwner === "string" ? inputOwner.trim() : "";
  if (fromInput !== "") return fromInput;
  const fromConfig = typeof configOwner === "string" ? configOwner.trim() : "";
  return fromConfig !== "" ? fromConfig : fallback;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
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

function toVariableValue(state: SemaphoreState): VariableValue {
  return {
    capacity: state.capacity,
    holders: state.holders.map((holder) => ({
      owner: holder.owner,
      acquiredAt: holder.acquiredAt,
      expiresAt: holder.expiresAt,
      updatedAt: holder.updatedAt,
    })),
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Semaphore concurrency state",
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
