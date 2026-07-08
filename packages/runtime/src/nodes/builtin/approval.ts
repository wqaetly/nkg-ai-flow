/**
 * `approval` - human approval checkpoint.
 *
 * This node models a business-level human-in-the-loop task on top of the
 * runtime VariableStore. The graph remains explicit: one run can request an
 * approval, another can resolve it, and later runs can check the result.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type ApprovalMode = "request" | "check" | "resolve" | "cancel" | "clear";
type ApprovalDecision = "approved" | "rejected";
type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";
type ApprovalBranch =
  | "requested"
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "cleared"
  | "missing";

interface ApprovalState {
  name: string;
  status: ApprovalStatus;
  title: string;
  assignee: string;
  payload: VariableValue | null;
  decision: ApprovalDecision | null;
  comment: string;
  requestedAt: number;
  resolvedAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
}

const approvalConfig = z
  .object({
    name: z.string().default("").describe("Approval state variable name."),
    mode: z
      .enum(["request", "check", "resolve", "cancel", "clear"])
      .default("request")
      .describe("Approval operation mode."),
    title: z.string().default("").describe("Human-readable approval title."),
    assignee: z.string().default("").describe("Expected approver or group."),
    decision: z
      .enum(["approved", "rejected"])
      .default("approved")
      .describe("Decision used by resolve mode when no decision input is connected."),
    comment: z.string().default("").describe("Optional decision comment."),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Optional approval timeout in milliseconds; 0 disables expiry."),
  })
  .passthrough();

export const approvalNode = defineNode({
  type: "approval",
  typeVersion: "1.0.0",
  title: "Approval",
  description: "Requests, checks, resolves, cancels, or clears a human approval.",
  kind: "pseudo",
  config: approvalConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_APPROVAL",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Request", value: "request" },
        { label: "Check", value: "check" },
        { label: "Resolve", value: "resolve" },
        { label: "Cancel", value: "cancel" },
        { label: "Clear", value: "clear" },
      ],
    },
    title: { label: "Title", control: "input", order: 3 },
    assignee: { label: "Assignee", control: "input", order: 4 },
    decision: {
      label: "Decision",
      control: "select",
      order: 5,
      enumOptions: [
        { label: "Approved", value: "approved" },
        { label: "Rejected", value: "rejected" },
      ],
    },
    comment: { label: "Comment", control: "input", order: 6 },
    timeoutMs: { label: "Timeout (ms)", control: "number", order: 7 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "title", direction: "input", kind: "data", label: "Title", schema: { type: "string" } },
    { id: "assignee", direction: "input", kind: "data", label: "Assignee", schema: { type: "string" } },
    { id: "payload", direction: "input", kind: "data", label: "Payload" },
    { id: "decision", direction: "input", kind: "data", label: "Decision" },
    { id: "comment", direction: "input", kind: "data", label: "Comment" },
    {
      id: "timeoutMs",
      direction: "input",
      kind: "data",
      label: "Timeout ms",
      schema: { type: "number" },
    },
    { id: "requested", direction: "output", kind: "control", label: "Requested" },
    { id: "pending", direction: "output", kind: "control", label: "Pending" },
    { id: "approved", direction: "output", kind: "control", label: "Approved" },
    { id: "rejected", direction: "output", kind: "control", label: "Rejected" },
    { id: "cancelled", direction: "output", kind: "control", label: "Cancelled" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "branch", direction: "output", kind: "data", label: "Branch", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "title", direction: "output", kind: "data", label: "Title", schema: { type: "string" } },
    { id: "assignee", direction: "output", kind: "data", label: "Assignee", schema: { type: "string" } },
    { id: "payload", direction: "output", kind: "data", label: "Payload" },
    { id: "decision", direction: "output", kind: "data", label: "Decision" },
    { id: "comment", direction: "output", kind: "data", label: "Comment", schema: { type: "string" } },
    { id: "requestedAt", direction: "output", kind: "data", label: "Requested At", schema: { type: "string" } },
    { id: "resolvedAt", direction: "output", kind: "data", label: "Resolved At", schema: { type: "string" } },
    { id: "expiresAt", direction: "output", kind: "data", label: "Expires At", schema: { type: "string" } },
    {
      id: "timeoutMs",
      direction: "output",
      kind: "data",
      label: "Timeout ms",
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
    { id: "requestedValue", direction: "output", kind: "data", label: "Requested", schema: { type: "boolean" } },
    { id: "pendingValue", direction: "output", kind: "data", label: "Pending", schema: { type: "boolean" } },
    { id: "approvedValue", direction: "output", kind: "data", label: "Approved", schema: { type: "boolean" } },
    { id: "rejectedValue", direction: "output", kind: "data", label: "Rejected", schema: { type: "boolean" } },
    { id: "cancelledValue", direction: "output", kind: "data", label: "Cancelled", schema: { type: "boolean" } },
    { id: "expiredValue", direction: "output", kind: "data", label: "Expired", schema: { type: "boolean" } },
    { id: "clearedValue", direction: "output", kind: "data", label: "Cleared", schema: { type: "boolean" } },
    { id: "missingValue", direction: "output", kind: "data", label: "Missing", schema: { type: "boolean" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error("node.approval.missing_name", "approval node requires config.name or name input", ctx.nodeId);
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error("node.approval.readonly_store", "approval requires a mutable VariableStore", ctx.nodeId);
    }

    const now = Date.now();
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "request";
    const previous = normalizeExpired(readApprovalState(store.get(name)), now);
    const decision = applyMode(previous, {
      name,
      mode,
      title: String(input.title ?? config.title ?? ""),
      assignee: String(input.assignee ?? config.assignee ?? ""),
      payload: toJsonValue(input.payload ?? input.input ?? input.in ?? null),
      decision: readDecision(input.decision) ?? config.decision ?? "approved",
      comment: readComment(input.comment ?? config.comment),
      timeoutMs: readIntegerAtLeast(input.timeoutMs, 0) ?? readIntegerAtLeast(config.timeoutMs, 0) ?? 0,
      now,
    });

    if (decision.state === null) {
      store.delete(name);
    } else {
      store.set(name, toVariableValue(decision.state), metadata(ctx.flowId));
    }

    const state = decision.state;
    const remainingMs =
      state?.expiresAt === null || state === null ? 0 : Math.max(0, state.expiresAt - now);
    const requestedAt =
      state === null ? "" : new Date(state.requestedAt).toISOString();
    const resolvedAt =
      state?.resolvedAt === null || state === null
        ? ""
        : new Date(state.resolvedAt).toISOString();
    const expiresAt =
      state?.expiresAt === null || state === null
        ? ""
        : new Date(state.expiresAt).toISOString();
    const timeoutMs =
      state?.expiresAt === null || state === null
        ? 0
        : Math.max(0, state.expiresAt - state.requestedAt);
    const status = state?.status ?? "missing";
    ctx.log.debug("approval selected branch", {
      name,
      mode,
      branch: decision.branch,
      status,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state,
        name: state?.name ?? name,
        mode,
        branch: decision.branch,
        status,
        title: state?.title ?? "",
        assignee: state?.assignee ?? "",
        payload: state?.payload ?? null,
        decision: state?.decision ?? null,
        comment: state?.comment ?? "",
        requestedAt,
        resolvedAt,
        expiresAt,
        timeoutMs,
        remainingMs,
        stateExists: state !== null,
        requestedValue: decision.branch === "requested",
        pendingValue: status === "pending",
        approvedValue: status === "approved",
        rejectedValue: status === "rejected",
        cancelledValue: status === "cancelled",
        expiredValue: status === "expired",
        clearedValue: decision.branch === "cleared",
        missingValue: decision.branch === "missing",
      },
    };
  },
});

function applyMode(
  previous: ApprovalState | null,
  options: {
    name: string;
    mode: ApprovalMode;
    title: string;
    assignee: string;
    payload: VariableValue | undefined;
    decision: ApprovalDecision;
    comment: string;
    timeoutMs: number;
    now: number;
  },
): { branch: ApprovalBranch; state: ApprovalState | null } {
  const { name, mode, title, assignee, payload, decision, comment, timeoutMs, now } = options;
  if (mode === "clear") {
    return previous ? { branch: "cleared", state: null } : { branch: "missing", state: null };
  }
  if (mode === "request") {
    return {
      branch: "requested",
      state: {
        name,
        status: "pending",
        title: title.trim(),
        assignee: assignee.trim(),
        payload: payload ?? null,
        decision: null,
        comment: "",
        requestedAt: now,
        resolvedAt: null,
        expiresAt: timeoutMs > 0 ? now + timeoutMs : null,
        updatedAt: now,
      },
    };
  }
  if (!previous) {
    return { branch: "missing", state: null };
  }
  if (mode === "cancel") {
    return {
      branch: "cancelled",
      state: {
        ...previous,
        status: "cancelled",
        comment,
        resolvedAt: now,
        updatedAt: now,
      },
    };
  }
  if (mode === "resolve") {
    if (previous.status === "expired") return { branch: "expired", state: previous };
    return {
      branch: decision,
      state: {
        ...previous,
        status: decision,
        decision,
        comment,
        resolvedAt: now,
        updatedAt: now,
      },
    };
  }
  return { branch: previous.status, state: { ...previous, updatedAt: now } };
}

function normalizeExpired(state: ApprovalState | null, now: number): ApprovalState | null {
  if (state?.status === "pending" && state.expiresAt !== null && now >= state.expiresAt) {
    return {
      ...state,
      status: "expired",
      resolvedAt: now,
      updatedAt: now,
    };
  }
  return state;
}

function readApprovalState(value: unknown): ApprovalState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (name === "") return null;
  return {
    name,
    status: readStatus(record.status),
    title: typeof record.title === "string" ? record.title : "",
    assignee: typeof record.assignee === "string" ? record.assignee : "",
    payload: toJsonValue(record.payload) ?? null,
    decision: readDecision(record.decision) ?? null,
    comment: typeof record.comment === "string" ? record.comment : "",
    requestedAt: readTimestamp(record.requestedAt) ?? Date.now(),
    resolvedAt: readTimestamp(record.resolvedAt),
    expiresAt: readTimestamp(record.expiresAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function readStatus(value: unknown): ApprovalStatus {
  return value === "approved" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "pending"
    ? value
    : "pending";
}

function readDecision(value: unknown): ApprovalDecision | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "approved" || normalized === "approve") return "approved";
  if (normalized === "rejected" || normalized === "reject") return "rejected";
  return undefined;
}

function readMode(value: unknown): ApprovalMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "request" ||
    normalized === "check" ||
    normalized === "resolve" ||
    normalized === "cancel" ||
    normalized === "clear"
  ) {
    return normalized;
  }
  return undefined;
}

function readComment(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer >= minimum ? integer : undefined;
}

function readTimestamp(value: unknown): number | null {
  if (value === null) return null;
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

function toVariableValue(state: ApprovalState): VariableValue {
  return {
    name: state.name,
    status: state.status,
    title: state.title,
    assignee: state.assignee,
    payload: state.payload,
    decision: state.decision,
    comment: state.comment,
    requestedAt: state.requestedAt,
    resolvedAt: state.resolvedAt,
    expiresAt: state.expiresAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Human approval state",
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
