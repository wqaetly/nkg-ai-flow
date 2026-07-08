/**
 * `mutex` - stateful mutual-exclusion gate.
 *
 * This node lets a flow serialize work for a named resource (file, order,
 * external account, batch partition) by persisting a lock record in the
 * runtime VariableStore. It is intentionally explicit: authors choose the
 * acquired / locked / released branches instead of the scheduler hiding waits.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type MutexMode = "acquire" | "release" | "refresh" | "force_release";

interface MutexState {
  locked: boolean;
  owner: string | null;
  acquiredAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

const mutexConfig = z
  .object({
    name: z.string().default("").describe("Mutex state variable name."),
    owner: z
      .string()
      .default("")
      .describe("Optional owner token. Empty defaults to flowId:runId."),
    ttlMs: z
      .number()
      .int()
      .min(0)
      .default(300000)
      .describe("Lock time-to-live in milliseconds; 0 disables expiry."),
    mode: z
      .enum(["acquire", "release", "refresh", "force_release"])
      .default("acquire")
      .describe("Mutex operation mode."),
  })
  .passthrough();

export const mutexNode = defineNode({
  type: "mutex",
  typeVersion: "1.0.0",
  title: "Mutex",
  description: "Acquires, refreshes, or releases a persisted resource lock.",
  kind: "pseudo",
  config: mutexConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_123_LOCK",
    },
    owner: {
      label: "Owner",
      control: "input",
      order: 2,
      placeholder: "Optional owner token.",
    },
    ttlMs: { label: "TTL (ms)", control: "number", order: 3 },
    mode: {
      label: "Mode",
      control: "select",
      order: 4,
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
    { id: "locked", direction: "output", kind: "control", label: "Locked" },
    { id: "released", direction: "output", kind: "control", label: "Released" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "owner", direction: "output", kind: "data", label: "Owner" },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
    {
      id: "expiresAt",
      direction: "output",
      kind: "data",
      label: "Expires at",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.mutex.missing_name",
        "mutex node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.mutex.readonly_store",
        "mutex requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const ttlMs = Math.max(0, Math.trunc(Number(config.ttlMs ?? 300000)));
    const mode = config.mode ?? "acquire";
    const owner = readOwner(input.owner, config.owner, `${ctx.flowId}:${ctx.runId}`);
    const previous = normalizeExpired(readMutexState(store.get(name), now), now);
    const decision = applyMode(previous, { mode, owner, ttlMs, now });
    const remainingMs = remaining(decision.state, now);

    store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    ctx.log.debug("mutex selected branch", {
      name,
      mode,
      owner,
      branch: decision.branch,
      remainingMs,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state: decision.state,
        name,
        owner: decision.state.owner,
        remainingMs,
        expiresAt: decision.state.expiresAt,
      },
    };
  },
});

function applyMode(
  previous: MutexState,
  options: { mode: MutexMode; owner: string; ttlMs: number; now: number },
): { branch: "acquired" | "locked" | "released"; state: MutexState } {
  const { mode, owner, ttlMs, now } = options;
  if (mode === "force_release") {
    return { branch: "released", state: unlocked(now) };
  }
  if (mode === "release") {
    if (!previous.locked || previous.owner === owner) {
      return { branch: "released", state: unlocked(now) };
    }
    return { branch: "locked", state: touch(previous, now) };
  }
  if (mode === "refresh") {
    if (previous.locked && previous.owner === owner) {
      return { branch: "acquired", state: locked(owner, ttlMs, now, previous.acquiredAt ?? now) };
    }
    if (!previous.locked) {
      return { branch: "acquired", state: locked(owner, ttlMs, now, now) };
    }
    return { branch: "locked", state: touch(previous, now) };
  }
  if (!previous.locked || previous.owner === owner) {
    return { branch: "acquired", state: locked(owner, ttlMs, now, previous.acquiredAt ?? now) };
  }
  return { branch: "locked", state: touch(previous, now) };
}

function locked(
  owner: string,
  ttlMs: number,
  now: number,
  acquiredAt: number,
): MutexState {
  return {
    locked: true,
    owner,
    acquiredAt,
    expiresAt: ttlMs > 0 ? now + ttlMs : null,
    updatedAt: now,
  };
}

function unlocked(now: number): MutexState {
  return {
    locked: false,
    owner: null,
    acquiredAt: null,
    expiresAt: null,
    updatedAt: now,
  };
}

function touch(state: MutexState, now: number): MutexState {
  return { ...state, updatedAt: now };
}

function normalizeExpired(state: MutexState, now: number): MutexState {
  if (state.locked && state.expiresAt !== null && now >= state.expiresAt) {
    return unlocked(now);
  }
  return state;
}

function remaining(state: MutexState, now: number): number {
  if (!state.locked || state.expiresAt === null) return 0;
  return Math.max(0, state.expiresAt - now);
}

function readMutexState(value: unknown, now: number): MutexState {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const lockedValue = record.locked === true;
    return {
      locked: lockedValue,
      owner: typeof record.owner === "string" ? record.owner : null,
      acquiredAt: readTimestamp(record.acquiredAt),
      expiresAt: readTimestamp(record.expiresAt),
      updatedAt: readTimestamp(record.updatedAt) ?? now,
    };
  }
  return unlocked(now);
}

function readOwner(inputOwner: unknown, configOwner: unknown, fallback: string): string {
  const fromInput = typeof inputOwner === "string" ? inputOwner.trim() : "";
  if (fromInput !== "") return fromInput;
  const fromConfig = typeof configOwner === "string" ? configOwner.trim() : "";
  return fromConfig !== "" ? fromConfig : fallback;
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

function toVariableValue(state: MutexState): VariableValue {
  return {
    locked: state.locked,
    owner: state.owner,
    acquiredAt: state.acquiredAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Mutex lock state",
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
