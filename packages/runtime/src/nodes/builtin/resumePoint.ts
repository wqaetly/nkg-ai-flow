/**
 * `resume_point` - durable recovery target marker.
 *
 * Checkpoints store snapshots. This node stores the recovery intent around
 * a snapshot: which node should be resumed, why, and how long the resume
 * marker stays valid.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type ResumePointMode = "mark" | "load" | "clear" | "touch";
type ResumePointBranch = "marked" | "ready" | "missing" | "cleared" | "expired";
type ResumePointStatus = "ready" | "expired";

interface ResumePointState {
  name: string;
  status: ResumePointStatus;
  targetNodeId: string;
  snapshot: VariableValue | null;
  reason: string;
  sourceRunId: string;
  version: number;
  markedAt: number;
  loadedAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

const resumePointConfig = z
  .object({
    name: z.string().default("").describe("Resume marker state variable name."),
    mode: z
      .enum(["mark", "load", "clear", "touch"])
      .default("mark")
      .describe("Resume marker operation mode."),
    targetNodeId: z
      .string()
      .default("")
      .describe("Node id that should be used as the recovery target."),
    snapshot: z
      .unknown()
      .optional()
      .describe("Static snapshot fallback when no snapshot input is connected."),
    reason: z.string().default("").describe("Human-readable resume reason."),
    ttlMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional time-to-live in milliseconds; 0 disables expiry."),
  })
  .passthrough();

export const resumePointNode = defineNode({
  type: "resume_point",
  typeVersion: "1.0.0",
  title: "Resume Point",
  description: "Marks, loads, touches, or clears a durable recovery target.",
  kind: "pseudo",
  config: resumePointConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_FAILURE_RESUME",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Mark", value: "mark" },
        { label: "Load", value: "load" },
        { label: "Clear", value: "clear" },
        { label: "Touch", value: "touch" },
      ],
    },
    targetNodeId: {
      label: "Target Node Id",
      control: "input",
      order: 3,
      placeholder: "charge_payment",
    },
    snapshot: {
      label: "Snapshot",
      control: "textarea",
      order: 4,
    },
    reason: {
      label: "Reason",
      control: "input",
      order: 5,
    },
    ttlMs: {
      label: "TTL (ms)",
      control: "number",
      order: 6,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "snapshot", direction: "input", kind: "data", label: "Snapshot" },
    { id: "targetNodeId", direction: "input", kind: "data", label: "Target Node Id", schema: { type: "string" } },
    { id: "reason", direction: "input", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "ttlMs", direction: "input", kind: "data", label: "TTL ms", schema: { type: "number" } },
    { id: "marked", direction: "output", kind: "control", label: "Marked" },
    { id: "ready", direction: "output", kind: "control", label: "Ready" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "snapshot", direction: "output", kind: "data", label: "Snapshot" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "targetNodeId", direction: "output", kind: "data", label: "Target Node Id", schema: { type: "string" } },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "stateStatus", direction: "output", kind: "data", label: "State Status", schema: { type: "string" } },
    { id: "sourceRunId", direction: "output", kind: "data", label: "Source Run Id", schema: { type: "string" } },
    { id: "version", direction: "output", kind: "data", label: "Version", schema: { type: "number" } },
    { id: "markedAt", direction: "output", kind: "data", label: "Marked At", schema: { type: "string" } },
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
    { id: "markedValue", direction: "output", kind: "data", label: "Marked", schema: { type: "boolean" } },
    { id: "readyValue", direction: "output", kind: "data", label: "Ready", schema: { type: "boolean" } },
    { id: "missingValue", direction: "output", kind: "data", label: "Missing", schema: { type: "boolean" } },
    { id: "clearedValue", direction: "output", kind: "data", label: "Cleared", schema: { type: "boolean" } },
    { id: "expiredValue", direction: "output", kind: "data", label: "Expired", schema: { type: "boolean" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.resume_point.missing_name",
        "resume_point node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.resume_point.readonly_store",
        "resume_point requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "mark";
    const ttlMs = readIntegerAtLeast(input.ttlMs, 0) ?? readIntegerAtLeast(config.ttlMs, 0) ?? 0;
    const previous = readResumePoint(store.get(name));
    const decision = applyMode(normalizeExpired(previous, now), {
      name,
      mode,
      targetNodeId: String(input.targetNodeId ?? config.targetNodeId ?? "").trim(),
      snapshot: toJsonValue(input.snapshot ?? input.input ?? input.in ?? config.snapshot ?? null),
      reason: String(input.reason ?? config.reason ?? ""),
      sourceRunId: ctx.runId,
      ttlMs,
      now,
      nodeId: ctx.nodeId,
    });
    if (decision.kind === "error") return decision;

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
    const markedAt = state === null ? "" : new Date(state.markedAt).toISOString();
    const loadedAt =
      state?.loadedAt === null || state === null ? "" : new Date(state.loadedAt).toISOString();
    const expiresAt =
      state?.expiresAt === null || state === null ? "" : new Date(state.expiresAt).toISOString();
    const ttlValue =
      state?.expiresAt === null || state === null ? 0 : Math.max(0, state.expiresAt - state.markedAt);

    ctx.log.debug("resume_point selected branch", {
      name,
      mode,
      branch: decision.branch,
      targetNodeId: decision.state?.targetNodeId ?? "",
      version: decision.state?.version ?? 0,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state,
        snapshot: state?.snapshot ?? null,
        name: state?.name ?? name,
        targetNodeId: state?.targetNodeId ?? "",
        reason: state?.reason ?? "",
        mode,
        status: decision.branch,
        stateStatus: state?.status ?? "",
        sourceRunId: state?.sourceRunId ?? "",
        version: state?.version ?? 0,
        markedAt,
        loadedAt,
        expiresAt,
        ttlMs: ttlValue,
        remainingMs,
        stateExists: state !== null,
        markedValue: decision.branch === "marked",
        readyValue: decision.branch === "ready",
        missingValue: decision.branch === "missing",
        clearedValue: decision.branch === "cleared",
        expiredValue: decision.branch === "expired",
      },
    };
  },
});

function applyMode(
  previous: ResumePointState | null,
  options: {
    name: string;
    mode: ResumePointMode;
    targetNodeId: string;
    snapshot: VariableValue | undefined;
    reason: string;
    sourceRunId: string;
    ttlMs: number;
    now: number;
    nodeId: string;
  },
):
  | { kind: "success"; branch: ResumePointBranch; state: ResumePointState | null }
  | ReturnType<typeof error> {
  const { name, mode, targetNodeId, snapshot, reason, sourceRunId, ttlMs, now, nodeId } = options;
  if (mode === "clear") {
    return previous
      ? { kind: "success", branch: "cleared", state: null }
      : { kind: "success", branch: "missing", state: null };
  }
  if (mode === "load") {
    if (!previous) return { kind: "success", branch: "missing", state: null };
    if (previous.status === "expired") {
      return { kind: "success", branch: "expired", state: previous };
    }
    return {
      kind: "success",
      branch: "ready",
      state: { ...previous, status: "ready", loadedAt: now, updatedAt: now },
    };
  }
  if (mode === "touch") {
    if (!previous) return { kind: "success", branch: "missing", state: null };
    if (previous.status === "expired") {
      return { kind: "success", branch: "expired", state: previous };
    }
    return {
      kind: "success",
      branch: "marked",
      state: {
        ...previous,
        reason: reason.trim() || previous.reason,
        expiresAt: expiresAt(ttlMs, now, previous.expiresAt),
        updatedAt: now,
      },
    };
  }
  if (targetNodeId === "") {
    return error(
      "node.resume_point.missing_target",
      "resume_point mark mode requires config.targetNodeId or targetNodeId input",
      nodeId,
    );
  }
  if (snapshot === undefined) {
    return error(
      "node.resume_point.unsupported_snapshot",
      "resume_point snapshot must be JSON-compatible",
      nodeId,
    );
  }
  return {
    kind: "success",
    branch: "marked",
    state: {
      name,
      status: "ready",
      targetNodeId,
      snapshot,
      reason: reason.trim(),
      sourceRunId,
      version: (previous?.version ?? 0) + 1,
      markedAt: now,
      loadedAt: null,
      expiresAt: expiresAt(ttlMs, now, null),
      updatedAt: now,
    },
  };
}

function normalizeExpired(
  state: ResumePointState | null,
  now: number,
): ResumePointState | null {
  if (!state) return null;
  if (state.expiresAt !== null && now >= state.expiresAt) {
    return {
      ...state,
      status: "expired",
      updatedAt: now,
    };
  }
  return state;
}

function expiresAt(
  ttlMs: number,
  now: number,
  previous: number | null,
): number | null {
  if (ttlMs > 0) return now + ttlMs;
  return previous ?? null;
}

function readResumePoint(value: unknown): ResumePointState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const targetNodeId =
    typeof record.targetNodeId === "string" ? record.targetNodeId : "";
  const snapshot = toJsonValue(record.snapshot);
  if (name === "" || targetNodeId === "" || snapshot === undefined) return null;
  return {
    name,
    status: record.status === "expired" ? "expired" : "ready",
    targetNodeId,
    snapshot,
    reason: typeof record.reason === "string" ? record.reason : "",
    sourceRunId: typeof record.sourceRunId === "string" ? record.sourceRunId : "",
    version: readNonNegativeInteger(record.version),
    markedAt: readTimestamp(record.markedAt) ?? Date.now(),
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

function readMode(value: unknown): ResumePointMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "mark" ||
    normalized === "load" ||
    normalized === "clear" ||
    normalized === "touch"
    ? normalized
    : undefined;
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

function toVariableValue(state: ResumePointState): VariableValue {
  return {
    name: state.name,
    status: state.status,
    targetNodeId: state.targetNodeId,
    snapshot: state.snapshot,
    reason: state.reason,
    sourceRunId: state.sourceRunId,
    version: state.version,
    markedAt: state.markedAt,
    loadedAt: state.loadedAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Flow resume point state",
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
