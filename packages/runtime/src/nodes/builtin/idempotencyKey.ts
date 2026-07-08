/**
 * `idempotency_key` - persisted idempotency gate for side effects.
 *
 * The node lets workflow authors explicitly de-duplicate business actions:
 * start a key before a side effect, record completion afterwards, and replay
 * the previous result when the same key appears again.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type IdempotencyMode = "start" | "complete" | "fail" | "reset";
type IdempotencyStatus = "started" | "completed" | "failed";
type IdempotencyBranch = "started" | "replayed" | "completed" | "failed" | "reset";

interface IdempotencyState {
  key: string;
  status: IdempotencyStatus;
  owner: string;
  value: VariableValue | null;
  error: VariableValue | null;
  startedAt: number;
  completedAt: number | null;
  failedAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

const idempotencyConfig = z
  .object({
    namespace: z
      .string()
      .default("default")
      .describe("State namespace used to isolate idempotency keys."),
    key: z.string().default("").describe("Idempotency key fallback."),
    mode: z
      .enum(["start", "complete", "fail", "reset"])
      .default("start")
      .describe("Idempotency operation mode."),
    ttlMs: z
      .number()
      .int()
      .min(0)
      .default(86400000)
      .describe("Time-to-live in milliseconds; 0 disables expiry."),
  })
  .passthrough();

export const idempotencyKeyNode = defineNode({
  type: "idempotency_key",
  typeVersion: "1.0.0",
  title: "Idempotency Key",
  description: "Deduplicates side-effecting flow work by a persisted key.",
  kind: "pseudo",
  config: idempotencyConfig,
  fieldMeta: {
    namespace: {
      label: "Namespace",
      control: "input",
      order: 1,
      placeholder: "payments",
    },
    key: {
      label: "Key",
      control: "input",
      order: 2,
      placeholder: "order-123",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 3,
      enumOptions: [
        { label: "Start", value: "start" },
        { label: "Complete", value: "complete" },
        { label: "Fail", value: "fail" },
        { label: "Reset", value: "reset" },
      ],
    },
    ttlMs: { label: "TTL (ms)", control: "number", order: 4 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "namespace", direction: "input", kind: "data", label: "Namespace", schema: { type: "string" } },
    { id: "key", direction: "input", kind: "data", label: "Key" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "ttlMs", direction: "input", kind: "data", label: "TTL ms", schema: { type: "number" } },
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "error", direction: "input", kind: "data", label: "Error" },
    { id: "started", direction: "output", kind: "control", label: "Started" },
    { id: "replayed", direction: "output", kind: "control", label: "Replayed" },
    { id: "completed", direction: "output", kind: "control", label: "Completed" },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    { id: "reset", direction: "output", kind: "control", label: "Reset" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "status", direction: "output", kind: "data", label: "Status" },
    { id: "namespace", direction: "output", kind: "data", label: "Namespace", schema: { type: "string" } },
    { id: "key", direction: "output", kind: "data", label: "Key" },
    { id: "stateKey", direction: "output", kind: "data", label: "State Key", schema: { type: "string" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    {
      id: "ttlMs",
      direction: "output",
      kind: "data",
      label: "TTL ms",
      schema: { type: "number" },
    },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "error", direction: "output", kind: "data", label: "Error" },
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
    const key = readKey(input.key, config.key);
    if (key === "") {
      return error(
        "node.idempotency_key.missing_key",
        "idempotency_key node requires a key input or config.key",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.idempotency_key.readonly_store",
        "idempotency_key requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const namespace = sanitizeSegment(String(input.namespace ?? config.namespace ?? "default"));
    const stateName = `IDEMPOTENCY:${namespace}:${sanitizeSegment(key)}`;
    const now = Date.now();
    const ttlMs = readIntegerAtLeast(input.ttlMs, 0) ?? readIntegerAtLeast(config.ttlMs, 0) ?? 86400000;
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "start";
    const owner = `${ctx.flowId}:${ctx.runId}`;
    const previous = normalizeExpired(readState(store.get(stateName)), now);
    const decision = applyMode(previous, {
      key,
      mode,
      owner,
      ttlMs,
      now,
      value: toJsonValue(input.value ?? input.input ?? input.in ?? null),
      error: toJsonValue(input.error ?? null),
    });

    if (decision.state === null) {
      store.delete(stateName);
    } else {
      store.set(stateName, toVariableValue(decision.state), metadata(ctx.flowId, namespace));
    }
    const state = decision.state;
    const remainingMs = state?.expiresAt === null || state === null
      ? 0
      : Math.max(0, state.expiresAt - now);

    ctx.log.debug("idempotency_key selected branch", {
      namespace,
      key,
      mode,
      branch: decision.branch,
      status: state?.status ?? "reset",
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state,
        status: state?.status ?? "reset",
        namespace,
        key,
        stateKey: stateName,
        mode,
        ttlMs,
        value: state?.value ?? null,
        error: state?.error ?? null,
        remainingMs,
      },
    };
  },
});

function applyMode(
  previous: IdempotencyState | null,
  options: {
    key: string;
    mode: IdempotencyMode;
    owner: string;
    ttlMs: number;
    now: number;
    value: VariableValue | undefined;
    error: VariableValue | undefined;
  },
): { branch: IdempotencyBranch; state: IdempotencyState | null } {
  const { key, mode, owner, ttlMs, now, value, error } = options;
  if (mode === "reset") return { branch: "reset", state: null };
  if (mode === "complete") {
    const state = {
      ...(previous ?? baseState(key, owner, ttlMs, now)),
      status: "completed" as const,
      value: value ?? previous?.value ?? null,
      error: null,
      completedAt: now,
      failedAt: null,
      expiresAt: expiresAt(ttlMs, now),
      updatedAt: now,
    };
    return { branch: "completed", state };
  }
  if (mode === "fail") {
    const state = {
      ...(previous ?? baseState(key, owner, ttlMs, now)),
      status: "failed" as const,
      error: error ?? previous?.error ?? null,
      failedAt: now,
      expiresAt: expiresAt(ttlMs, now),
      updatedAt: now,
    };
    return { branch: "failed", state };
  }
  if (previous?.status === "completed") {
    return { branch: "replayed", state: { ...previous, updatedAt: now } };
  }
  if (previous?.status === "failed") {
    return { branch: "failed", state: { ...previous, updatedAt: now } };
  }
  if (previous?.status === "started") {
    return { branch: "replayed", state: { ...previous, updatedAt: now } };
  }
  return { branch: "started", state: baseState(key, owner, ttlMs, now) };
}

function baseState(
  key: string,
  owner: string,
  ttlMs: number,
  now: number,
): IdempotencyState {
  return {
    key,
    status: "started",
    owner,
    value: null,
    error: null,
    startedAt: now,
    completedAt: null,
    failedAt: null,
    expiresAt: expiresAt(ttlMs, now),
    updatedAt: now,
  };
}

function expiresAt(ttlMs: number, now: number): number | null {
  return ttlMs > 0 ? now + ttlMs : null;
}

function normalizeExpired(
  state: IdempotencyState | null,
  now: number,
): IdempotencyState | null {
  if (state?.expiresAt !== null && state?.expiresAt !== undefined && now >= state.expiresAt) {
    return null;
  }
  return state;
}

function readState(value: unknown): IdempotencyState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key : "";
  if (key === "") return null;
  const status = readStatus(record.status);
  return {
    key,
    status,
    owner: typeof record.owner === "string" ? record.owner : "",
    value: toJsonValue(record.value) ?? null,
    error: toJsonValue(record.error) ?? null,
    startedAt: readTimestamp(record.startedAt) ?? Date.now(),
    completedAt: readTimestamp(record.completedAt),
    failedAt: readTimestamp(record.failedAt),
    expiresAt: readTimestamp(record.expiresAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function readStatus(value: unknown): IdempotencyStatus {
  return value === "completed" || value === "failed" || value === "started"
    ? value
    : "started";
}

function readKey(inputKey: unknown, configKey: unknown): string {
  const fromInput = inputKey === undefined || inputKey === null ? "" : String(inputKey).trim();
  if (fromInput !== "") return fromInput;
  return typeof configKey === "string" ? configKey.trim() : "";
}

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "default" : trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function readMode(value: unknown): IdempotencyMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "start" ||
    normalized === "complete" ||
    normalized === "fail" ||
    normalized === "reset"
    ? normalized
    : undefined;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer >= minimum ? integer : undefined;
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function toVariableValue(state: IdempotencyState): VariableValue {
  return {
    key: state.key,
    status: state.status,
    owner: state.owner,
    value: state.value,
    error: state.error,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    failedAt: state.failedAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string, namespace: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: `Idempotency key state (${namespace})`,
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
