/**
 * `checkpoint` - persisted flow checkpoint.
 *
 * This node makes long-flow recovery explicit. Authors can save a snapshot,
 * load it in a later run, clear it after completion, or touch it to extend
 * TTL / update metadata without hiding replay behaviour in the scheduler.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type CheckpointMode = "save" | "load" | "clear" | "touch";
type CheckpointStatus = "saved" | "loaded" | "expired" | "missing" | "cleared";
type CheckpointBranch = "saved" | "loaded" | "missing" | "cleared" | "expired";

interface CheckpointState {
  name: string;
  status: Exclude<CheckpointStatus, "missing" | "cleared">;
  snapshot: VariableValue | null;
  label: string;
  version: number;
  savedAt: number;
  loadedAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

const checkpointConfig = z
  .object({
    name: z.string().default("").describe("Checkpoint state variable name."),
    mode: z
      .enum(["save", "load", "clear", "touch"])
      .default("save")
      .describe("Checkpoint operation mode."),
    snapshot: z
      .unknown()
      .optional()
      .describe("Static snapshot fallback when no snapshot input is connected."),
    label: z.string().default("").describe("Optional human-readable checkpoint label."),
    ttlMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional time-to-live in milliseconds; 0 disables expiry."),
  })
  .passthrough();

export const checkpointNode = defineNode({
  type: "checkpoint",
  typeVersion: "1.0.0",
  title: "Checkpoint",
  description: "Saves, loads, touches, or clears a persisted flow checkpoint.",
  kind: "pseudo",
  config: checkpointConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_123_CHECKPOINT",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Save", value: "save" },
        { label: "Load", value: "load" },
        { label: "Clear", value: "clear" },
        { label: "Touch", value: "touch" },
      ],
    },
    snapshot: {
      label: "Snapshot",
      control: "textarea",
      order: 3,
      placeholder: "Static snapshot fallback.",
    },
    label: { label: "Label", control: "input", order: 4 },
    ttlMs: { label: "TTL (ms)", control: "number", order: 5 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "snapshot", direction: "input", kind: "data", label: "Snapshot" },
    { id: "saved", direction: "output", kind: "control", label: "Saved" },
    { id: "loaded", direction: "output", kind: "control", label: "Loaded" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "snapshot", direction: "output", kind: "data", label: "Snapshot" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "label", direction: "output", kind: "data", label: "Label", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status" },
    {
      id: "version",
      direction: "output",
      kind: "data",
      label: "Version",
      schema: { type: "number" },
    },
    { id: "savedAt", direction: "output", kind: "data", label: "Saved At", schema: { type: "string" } },
    { id: "loadedAt", direction: "output", kind: "data", label: "Loaded At", schema: { type: "string" } },
    { id: "expiresAt", direction: "output", kind: "data", label: "Expires At", schema: { type: "string" } },
    {
      id: "ttlMs",
      direction: "output",
      kind: "data",
      label: "TTL ms",
      schema: { type: "number" },
    },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
    { id: "stateExists", direction: "output", kind: "data", label: "State Exists", schema: { type: "boolean" } },
    { id: "savedValue", direction: "output", kind: "data", label: "Saved", schema: { type: "boolean" } },
    { id: "loadedValue", direction: "output", kind: "data", label: "Loaded", schema: { type: "boolean" } },
    { id: "missingValue", direction: "output", kind: "data", label: "Missing", schema: { type: "boolean" } },
    { id: "clearedValue", direction: "output", kind: "data", label: "Cleared", schema: { type: "boolean" } },
    { id: "expiredValue", direction: "output", kind: "data", label: "Expired", schema: { type: "boolean" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.checkpoint.missing_name",
        "checkpoint node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.checkpoint.readonly_store",
        "checkpoint requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const ttlMs = Math.max(0, Math.trunc(Number(config.ttlMs ?? 0)));
    const previous = normalizeExpired(readCheckpoint(store.get(name)), now);
    const decision = applyMode(previous, {
      name,
      mode: config.mode ?? "save",
      label: String(config.label ?? ""),
      ttlMs,
      now,
      snapshot: toJsonValue(input.snapshot ?? input.input ?? input.in ?? config.snapshot ?? null),
    });

    if (decision.state === null) {
      store.delete(name);
    } else {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    }

    const remainingMs =
      decision.state?.expiresAt === null || decision.state === null
        ? 0
        : Math.max(0, decision.state.expiresAt - now);
    const state = decision.state;
    const savedAt = state === null ? "" : new Date(state.savedAt).toISOString();
    const loadedAt =
      state?.loadedAt === null || state === null ? "" : new Date(state.loadedAt).toISOString();
    const expiresAt =
      state?.expiresAt === null || state === null ? "" : new Date(state.expiresAt).toISOString();
    const ttlValue =
      state?.expiresAt === null || state === null ? 0 : Math.max(0, state.expiresAt - state.savedAt);

    ctx.log.debug("checkpoint selected branch", {
      name,
      mode: config.mode ?? "save",
      branch: decision.branch,
      version: decision.state?.version ?? 0,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state,
        snapshot: state?.snapshot ?? null,
        name: state?.name ?? name,
        label: state?.label ?? "",
        status: decision.branch,
        version: state?.version ?? 0,
        savedAt,
        loadedAt,
        expiresAt,
        ttlMs: ttlValue,
        remainingMs,
        stateExists: state !== null,
        savedValue: decision.branch === "saved",
        loadedValue: decision.branch === "loaded",
        missingValue: decision.branch === "missing",
        clearedValue: decision.branch === "cleared",
        expiredValue: decision.branch === "expired",
      },
    };
  },
});

function applyMode(
  previous: CheckpointState | null,
  options: {
    name: string;
    mode: CheckpointMode;
    label: string;
    ttlMs: number;
    now: number;
    snapshot: VariableValue | undefined;
  },
): { branch: CheckpointBranch; state: CheckpointState | null } {
  const { name, mode, label, ttlMs, now, snapshot } = options;
  if (mode === "clear") {
    return previous
      ? { branch: "cleared", state: null }
      : { branch: "missing", state: null };
  }
  if (mode === "load") {
    if (previous?.status === "expired") {
      return { branch: "expired", state: previous };
    }
    return previous
      ? { branch: "loaded", state: { ...previous, status: "loaded", loadedAt: now, updatedAt: now } }
      : { branch: "missing", state: null };
  }
  if (mode === "touch") {
    if (previous?.status === "expired") {
      return { branch: "expired", state: previous };
    }
    return previous
      ? {
          branch: "saved",
          state: {
            ...previous,
            status: "saved",
            label: label.trim() || previous.label,
            expiresAt: expiresAt(ttlMs, now, previous.expiresAt),
            updatedAt: now,
          },
        }
      : { branch: "missing", state: null };
  }
  return {
    branch: "saved",
    state: {
      name,
      status: "saved",
      snapshot: snapshot ?? null,
      label: label.trim(),
      version: (previous?.version ?? 0) + 1,
      savedAt: now,
      loadedAt: null,
      expiresAt: expiresAt(ttlMs, now, null),
      updatedAt: now,
    },
  };
}

function expiresAt(
  ttlMs: number,
  now: number,
  previous: number | null,
): number | null {
  if (ttlMs > 0) return now + ttlMs;
  return previous ?? null;
}

function normalizeExpired(
  state: CheckpointState | null,
  now: number,
): CheckpointState | null {
  if (state?.expiresAt !== null && state?.expiresAt !== undefined && now >= state.expiresAt) {
    return { ...state, status: "expired", updatedAt: now };
  }
  return state;
}

function readCheckpoint(value: unknown): CheckpointState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (name === "") return null;
  return {
    name,
    status: record.status === "loaded" ? "loaded" : record.status === "expired" ? "expired" : "saved",
    snapshot: toJsonValue(record.snapshot) ?? null,
    label: typeof record.label === "string" ? record.label : "",
    version: readNonNegativeInteger(record.version),
    savedAt: readTimestamp(record.savedAt) ?? Date.now(),
    loadedAt: readTimestamp(record.loadedAt),
    expiresAt: readTimestamp(record.expiresAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
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

function toVariableValue(state: CheckpointState): VariableValue {
  return {
    name: state.name,
    status: state.status,
    snapshot: state.snapshot,
    label: state.label,
    version: state.version,
    savedAt: state.savedAt,
    loadedAt: state.loadedAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Flow checkpoint state",
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
