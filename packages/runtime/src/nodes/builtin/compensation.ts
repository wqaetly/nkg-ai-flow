/**
 * `compensation` - register and drain compensating actions.
 *
 * A Saga-style flow can call `register` after each successful forward
 * action. If a later step fails, call `drain` to emit the actions in
 * reverse order for downstream rollback execution.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

interface CompensationAction {
  id: string;
  action: string;
  payload: VariableValue;
  registeredAt: number;
  registeredFlowId: string;
  registeredFlowVersion: string;
  registeredRunId: string;
  registeredNodeId: string;
}

interface CompensationState {
  actions: CompensationAction[];
  updatedAt: number;
}

const compensationConfig = z
  .object({
    name: z.string().default("").describe("Compensation stack state name."),
    mode: z
      .enum(["register", "drain", "clear"])
      .default("register")
      .describe("Compensation operation mode."),
    action: z.string().default("").describe("Compensation action name."),
    payload: z
      .unknown()
      .optional()
      .describe("Static payload used when no payload input is connected."),
  })
  .passthrough();

export const compensationNode = defineNode({
  type: "compensation",
  typeVersion: "1.0.0",
  title: "Compensation",
  description: "Registers or drains compensating actions for rollback flows.",
  config: compensationConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_SAGA_COMPENSATIONS",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Register", value: "register" },
        { label: "Drain", value: "drain" },
        { label: "Clear", value: "clear" },
      ],
    },
    action: {
      label: "Action",
      control: "input",
      order: 3,
      placeholder: "refund_payment",
    },
    payload: {
      label: "Payload",
      control: "textarea",
      order: 4,
    },
  },
  ports: [
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "action", direction: "input", kind: "data", label: "Action", schema: { type: "string" } },
    { id: "payload", direction: "input", kind: "data", label: "Payload" },
    { id: "actions", direction: "output", kind: "data", label: "Actions" },
    { id: "action", direction: "output", kind: "data", label: "Action" },
    { id: "actionName", direction: "output", kind: "data", label: "Action Name", schema: { type: "string" } },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
    {
      id: "stackCount",
      direction: "output",
      kind: "data",
      label: "Stack Count",
      schema: { type: "number" },
    },
    { id: "updatedAt", direction: "output", kind: "data", label: "Updated At", schema: { type: "string" } },
    { id: "registeredFlowId", direction: "output", kind: "data", label: "Registered Flow Id", schema: { type: "string" } },
    { id: "registeredFlowVersion", direction: "output", kind: "data", label: "Registered Flow Version", schema: { type: "string" } },
    { id: "registeredRunId", direction: "output", kind: "data", label: "Registered Run Id", schema: { type: "string" } },
    { id: "registeredNodeId", direction: "output", kind: "data", label: "Registered Node Id", schema: { type: "string" } },
    { id: "registeredValue", direction: "output", kind: "data", label: "Registered", schema: { type: "boolean" } },
    { id: "drainedValue", direction: "output", kind: "data", label: "Drained", schema: { type: "boolean" } },
    { id: "clearedValue", direction: "output", kind: "data", label: "Cleared", schema: { type: "boolean" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
    { id: "state", direction: "output", kind: "data", label: "State" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.compensation.missing_name",
        "compensation node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.compensation.readonly_store",
        "compensation requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "register";
    const previous = readCompensationState(store.get(name));
    const result = applyMode(previous, {
      mode,
      action: String(input.action ?? config.action ?? "").trim(),
      payload: input.payload ?? config.payload ?? input.input ?? null,
      now,
      flowId: ctx.flowId,
      flowVersion: ctx.flowVersion,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
    });
    if (result.kind === "error") return result;

    store.set(name, toVariableValue(result.state), metadata(ctx.flowId));
    const status =
      mode === "register" ? "registered" : mode === "drain" ? "drained" : "cleared";
    ctx.log.debug("compensation updated stack", {
      name,
      mode,
      count: result.state.actions.length,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        actions: result.actions,
        action: result.actions[0] ?? null,
        actionName: result.actions[0]?.action ?? "",
        name,
        mode,
        status,
        count: result.actions.length,
        stackCount: result.state.actions.length,
        updatedAt: new Date(result.state.updatedAt).toISOString(),
        registeredFlowId: result.actions[0]?.registeredFlowId ?? "",
        registeredFlowVersion: result.actions[0]?.registeredFlowVersion ?? "",
        registeredRunId: result.actions[0]?.registeredRunId ?? "",
        registeredNodeId: result.actions[0]?.registeredNodeId ?? "",
        registeredValue: status === "registered",
        drainedValue: status === "drained",
        clearedValue: status === "cleared",
        summary: compensationSummary({
          name,
          mode,
          status,
          actions: result.actions,
          state: result.state,
        }),
        state: result.state,
      },
    };
  },
});

function compensationSummary(args: {
  name: string;
  mode: "register" | "drain" | "clear";
  status: "registered" | "drained" | "cleared";
  actions: CompensationAction[];
  state: CompensationState;
}): Record<string, unknown> {
  const first = args.actions[0];
  return {
    name: args.name,
    mode: args.mode,
    status: args.status,
    count: args.actions.length,
    stackCount: args.state.actions.length,
    updatedAt: new Date(args.state.updatedAt).toISOString(),
    actionName: first?.action ?? "",
    registeredFlowId: first?.registeredFlowId ?? "",
    registeredFlowVersion: first?.registeredFlowVersion ?? "",
    registeredRunId: first?.registeredRunId ?? "",
    registeredNodeId: first?.registeredNodeId ?? "",
    actions: args.actions,
    registeredValue: args.status === "registered",
    drainedValue: args.status === "drained",
    clearedValue: args.status === "cleared",
  };
}

function applyMode(
  previous: CompensationState,
  options: {
    mode: "register" | "drain" | "clear";
    action: string;
    payload: unknown;
    now: number;
    flowId: string;
    flowVersion: string;
    runId: string;
    nodeId: string;
  },
):
  | { kind: "success"; state: CompensationState; actions: CompensationAction[] }
  | ReturnType<typeof error> {
  const { mode, action, payload, now, flowId, flowVersion, runId, nodeId } = options;
  if (mode === "clear") {
    return { kind: "success", state: emptyState(now), actions: [] };
  }
  if (mode === "drain") {
    return {
      kind: "success",
      state: emptyState(now),
      actions: [...previous.actions].reverse(),
    };
  }
  if (action === "") {
    return error(
      "node.compensation.missing_action",
      "compensation register mode requires config.action",
      nodeId,
    );
  }
  const converted = toJsonValue(payload);
  if (converted === undefined) {
    return error(
      "node.compensation.unsupported_payload",
      "compensation payload must be JSON-compatible",
      nodeId,
    );
  }
  const nextAction: CompensationAction = {
    id: `${now}-${previous.actions.length + 1}`,
    action,
    payload: converted,
    registeredAt: now,
    registeredFlowId: flowId,
    registeredFlowVersion: flowVersion,
    registeredRunId: runId,
    registeredNodeId: nodeId,
  };
  const state = {
    actions: [...previous.actions, nextAction],
    updatedAt: now,
  };
  return { kind: "success", state, actions: [nextAction] };
}

function readMode(value: unknown): "register" | "drain" | "clear" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "register" || normalized === "drain" || normalized === "clear") {
    return normalized;
  }
  return undefined;
}

function readCompensationState(value: unknown): CompensationState {
  if (!value || typeof value !== "object") return emptyState(Date.now());
  const record = value as Record<string, unknown>;
  const actions = Array.isArray(record.actions)
    ? record.actions.map(readAction).filter((action) => action !== undefined)
    : [];
  return {
    actions,
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : Date.now(),
  };
}

function readAction(value: unknown): CompensationAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const payload = toJsonValue(record.payload);
  if (
    typeof record.id !== "string" ||
    typeof record.action !== "string" ||
    typeof record.registeredAt !== "number" ||
    !Number.isFinite(record.registeredAt) ||
    payload === undefined
  ) {
    return undefined;
  }
  return {
    id: record.id,
    action: record.action,
    payload,
    registeredAt: record.registeredAt,
    registeredFlowId: typeof record.registeredFlowId === "string" ? record.registeredFlowId : "",
    registeredFlowVersion:
      typeof record.registeredFlowVersion === "string" ? record.registeredFlowVersion : "",
    registeredRunId: typeof record.registeredRunId === "string" ? record.registeredRunId : "",
    registeredNodeId: typeof record.registeredNodeId === "string" ? record.registeredNodeId : "",
  };
}

function emptyState(now: number): CompensationState {
  return { actions: [], updatedAt: now };
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

function toVariableValue(state: CompensationState): VariableValue {
  return {
    actions: state.actions.map((action) => ({
      id: action.id,
      action: action.action,
      payload: action.payload,
      registeredAt: action.registeredAt,
      registeredFlowId: action.registeredFlowId,
      registeredFlowVersion: action.registeredFlowVersion,
      registeredRunId: action.registeredRunId,
      registeredNodeId: action.registeredNodeId,
    })),
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Compensation stack state",
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
