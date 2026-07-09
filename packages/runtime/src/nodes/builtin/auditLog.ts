/**
 * `audit_log` - persisted business audit trail.
 *
 * Runtime node events are diagnostic. This node records domain-level facts
 * directly in the graph: approvals, external decisions, policy checks, replay
 * actions, or any other event an author wants to query later.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type AuditLogMode = "append" | "read" | "clear";
type AuditLogBranch = "appended" | "read" | "empty" | "cleared";

interface AuditLogEntry {
  id: string;
  sequence: number;
  type: string;
  actor: string;
  message: string;
  payload: VariableValue | null;
  recordedAt: number;
  runId: string;
  nodeId: string;
}

interface AuditLogState {
  entries: AuditLogEntry[];
  sequence: number;
  updatedAt: number;
}

const auditLogConfig = z
  .object({
    name: z.string().default("").describe("Audit log state variable name."),
    mode: z
      .enum(["append", "read", "clear"])
      .default("append")
      .describe("Audit log operation mode."),
    type: z.string().default("event").describe("Business event type."),
    actor: z.string().default("").describe("Actor that caused the event."),
    message: z.string().default("").describe("Human-readable event message."),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .default(1000)
      .describe("Maximum retained audit entries."),
    limit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe("Maximum entries returned by read mode."),
  })
  .passthrough();

export const auditLogNode = defineNode({
  type: "audit_log",
  typeVersion: "1.0.0",
  title: "Audit Log",
  description: "Appends, reads, or clears a persisted business audit trail.",
  kind: "pseudo",
  config: auditLogConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_AUDIT_LOG",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Append", value: "append" },
        { label: "Read", value: "read" },
        { label: "Clear", value: "clear" },
      ],
    },
    type: { label: "Type", control: "input", order: 3 },
    actor: { label: "Actor", control: "input", order: 4 },
    message: { label: "Message", control: "input", order: 5 },
    maxEntries: { label: "Max Entries", control: "number", order: 6 },
    limit: { label: "Limit", control: "number", order: 7 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "type", direction: "input", kind: "data", label: "Type", schema: { type: "string" } },
    { id: "actor", direction: "input", kind: "data", label: "Actor", schema: { type: "string" } },
    { id: "message", direction: "input", kind: "data", label: "Message", schema: { type: "string" } },
    { id: "maxEntries", direction: "input", kind: "data", label: "Max entries", schema: { type: "number" } },
    { id: "limit", direction: "input", kind: "data", label: "Limit", schema: { type: "number" } },
    { id: "payload", direction: "input", kind: "data", label: "Payload" },
    { id: "appended", direction: "output", kind: "control", label: "Appended" },
    { id: "read", direction: "output", kind: "control", label: "Read" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "entries", direction: "output", kind: "data", label: "Entries" },
    { id: "entry", direction: "output", kind: "data", label: "Entry" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "type", direction: "output", kind: "data", label: "Type", schema: { type: "string" } },
    { id: "actor", direction: "output", kind: "data", label: "Actor", schema: { type: "string" } },
    { id: "message", direction: "output", kind: "data", label: "Message", schema: { type: "string" } },
    { id: "maxEntries", direction: "output", kind: "data", label: "Max entries", schema: { type: "number" } },
    { id: "limit", direction: "output", kind: "data", label: "Limit", schema: { type: "number" } },
    { id: "state", direction: "output", kind: "data", label: "State" },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
    {
      id: "sequence",
      direction: "output",
      kind: "data",
      label: "Sequence",
      schema: { type: "number" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.audit_log.missing_name",
        "audit_log node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.audit_log.readonly_store",
        "audit_log requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const previous = readAuditLogState(store.get(name), now);
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "append";
    const maxEntries = readPositiveInteger(input.maxEntries) ?? readPositiveInteger(config.maxEntries) ?? 1000;
    const limit = readPositiveInteger(input.limit) ?? readPositiveInteger(config.limit) ?? 100;
    const eventType = String(input.type ?? config.type ?? "event").trim() || "event";
    const actor = String(input.actor ?? config.actor ?? "").trim();
    const message = String(input.message ?? config.message ?? "").trim();
    const decision = applyMode(previous, {
      mode,
      maxEntries,
      limit,
      now,
      eventType,
      actor,
      message,
      payload: input.payload ?? input.input ?? input.in ?? null,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
    });

    if (decision.persist) {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    } else {
      store.delete(name);
    }

    const summary = {
      name,
      mode,
      branch: decision.branch,
      count: decision.entries.length,
      retainedCount: decision.state.entries.length,
      sequence: decision.state.sequence,
      maxEntries,
      limit,
      type: eventType,
      actor,
      message,
      entrySequence: decision.entries[0]?.sequence ?? null,
      persisted: decision.persist,
      updatedAt: decision.state.updatedAt,
    };
    ctx.log.debug("audit_log selected branch", summary);

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        entries: decision.entries,
        entry: decision.entries[0] ?? null,
        name,
        mode,
        type: eventType,
        actor,
        message,
        maxEntries,
        limit,
        state: decision.state,
        count: decision.entries.length,
        sequence: decision.state.sequence,
        summary,
      },
    };
  },
});

function applyMode(
  previous: AuditLogState,
  options: {
    mode: AuditLogMode;
    maxEntries: number;
    limit: number;
    now: number;
    eventType: string;
    actor: string;
    message: string;
    payload: unknown;
    runId: string;
    nodeId: string;
  },
): {
  branch: AuditLogBranch;
  entries: AuditLogEntry[];
  state: AuditLogState;
  persist: boolean;
} {
  const { mode, maxEntries, limit, now } = options;
  if (mode === "clear") {
    return {
      branch: "cleared",
      entries: previous.entries,
      state: emptyState(now, previous.sequence),
      persist: false,
    };
  }
  if (mode === "read") {
    if (previous.entries.length === 0) {
      return {
        branch: "empty",
        entries: [],
        state: emptyState(now, previous.sequence),
        persist: false,
      };
    }
    return {
      branch: "read",
      entries: previous.entries.slice(-limit),
      state: { ...previous, updatedAt: now },
      persist: true,
    };
  }

  const sequence = previous.sequence + 1;
  const entry: AuditLogEntry = {
    id: `${now}-${sequence}`,
    sequence,
    type: options.eventType,
    actor: options.actor,
    message: options.message,
    payload: toJsonValue(options.payload) ?? null,
    recordedAt: now,
    runId: options.runId,
    nodeId: options.nodeId,
  };
  return {
    branch: "appended",
    entries: [entry],
    state: {
      entries: [...previous.entries, entry].slice(-maxEntries),
      sequence,
      updatedAt: now,
    },
    persist: true,
  };
}

function readMode(value: unknown): AuditLogMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "append" || normalized === "read" || normalized === "clear" ? normalized : undefined;
}

function readAuditLogState(value: unknown, now: number): AuditLogState {
  if (!value || typeof value !== "object") return emptyState(now, 0);
  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.entries)
    ? record.entries.map(readEntry).filter((entry): entry is AuditLogEntry => entry !== null)
    : [];
  return {
    entries,
    sequence: Math.max(readNonNegativeInteger(record.sequence), maxSequence(entries)),
    updatedAt: readTimestamp(record.updatedAt) ?? now,
  };
}

function readEntry(value: unknown): AuditLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const sequence = readNonNegativeInteger(record.sequence);
  if (id === "" || sequence === 0) return null;
  return {
    id,
    sequence,
    type: typeof record.type === "string" ? record.type : "event",
    actor: typeof record.actor === "string" ? record.actor : "",
    message: typeof record.message === "string" ? record.message : "",
    payload: toJsonValue(record.payload) ?? null,
    recordedAt: readTimestamp(record.recordedAt) ?? Date.now(),
    runId: typeof record.runId === "string" ? record.runId : "",
    nodeId: typeof record.nodeId === "string" ? record.nodeId : "",
  };
}

function emptyState(now: number, sequence: number): AuditLogState {
  return { entries: [], sequence, updatedAt: now };
}

function maxSequence(entries: readonly AuditLogEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : undefined;
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

function toVariableValue(state: AuditLogState): VariableValue {
  return {
    entries: state.entries.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      type: entry.type,
      actor: entry.actor,
      message: entry.message,
      payload: entry.payload,
      recordedAt: entry.recordedAt,
      runId: entry.runId,
      nodeId: entry.nodeId,
    })),
    sequence: state.sequence,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Business audit log state",
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
