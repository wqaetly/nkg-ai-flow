/**
 * `metric` - persisted flow/business metric.
 *
 * Audit logs answer "what happened". Metrics answer "how much / how often".
 * This node lets authors explicitly update counters, gauges, and numeric
 * observations from inside the graph without coupling observability to the
 * scheduler internals.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type MetricMode = "increment" | "set" | "observe" | "read" | "reset";
type MetricBranch = "updated" | "read" | "reset" | "missing";

interface MetricState {
  name: string;
  value: number;
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  last: number | null;
  samples: number[];
  createdAt: number;
  updatedAt: number;
}

const metricConfig = z
  .object({
    name: z.string().default("").describe("Metric state variable name."),
    mode: z
      .enum(["increment", "set", "observe", "read", "reset"])
      .default("increment")
      .describe("Metric operation mode."),
    value: z.number().default(1).describe("Static numeric value when no value input is connected."),
    maxSamples: z
      .number()
      .int()
      .min(0)
      .default(100)
      .describe("Maximum recent numeric samples retained in state."),
  })
  .passthrough();

export const metricNode = defineNode({
  type: "metric",
  typeVersion: "1.0.0",
  title: "Metric",
  description: "Updates, reads, or resets a persisted numeric flow metric.",
  kind: "pseudo",
  config: metricConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "ORDER_APPROVED_COUNT",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Increment", value: "increment" },
        { label: "Set", value: "set" },
        { label: "Observe", value: "observe" },
        { label: "Read", value: "read" },
        { label: "Reset", value: "reset" },
      ],
    },
    value: { label: "Value", control: "number", order: 3 },
    maxSamples: { label: "Max Samples", control: "number", order: 4 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "maxSamples", direction: "input", kind: "data", label: "Max samples", schema: { type: "number" } },
    { id: "updated", direction: "output", kind: "control", label: "Updated" },
    { id: "read", direction: "output", kind: "control", label: "Read" },
    { id: "reset", direction: "output", kind: "control", label: "Reset" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "maxSamples", direction: "output", kind: "data", label: "Max samples", schema: { type: "number" } },
    { id: "value", direction: "output", kind: "data", label: "Value", schema: { type: "number" } },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    { id: "sum", direction: "output", kind: "data", label: "Sum", schema: { type: "number" } },
    { id: "min", direction: "output", kind: "data", label: "Min", schema: { type: "number" } },
    { id: "max", direction: "output", kind: "data", label: "Max", schema: { type: "number" } },
    { id: "average", direction: "output", kind: "data", label: "Average", schema: { type: "number" } },
    { id: "last", direction: "output", kind: "data", label: "Last", schema: { type: "number" } },
    { id: "samples", direction: "output", kind: "data", label: "Samples" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error("node.metric.missing_name", "metric node requires config.name or name input", ctx.nodeId);
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error("node.metric.readonly_store", "metric requires a mutable VariableStore", ctx.nodeId);
    }

    const now = Date.now();
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "increment";
    const previous = readMetricState(name, store.get(name), now);
    const maxSamples = readIntegerAtLeast(input.maxSamples, 0) ?? readIntegerAtLeast(config.maxSamples, 0) ?? 100;
    if (mode === "reset") {
      store.delete(name);
      return success("reset", emptyState(name, now), mode, maxSamples);
    }
    if (mode === "read") {
      if (!store.has(name)) return success("missing", emptyState(name, now), mode, maxSamples);
      return success("read", previous, mode, maxSamples);
    }

    const value = readNumber(input.value ?? input.input ?? input.in ?? config.value);
    if (value === undefined) {
      return error("node.metric.unsupported_value", "metric value must be numeric", ctx.nodeId);
    }
    const state = updateMetric(previous, mode, value, maxSamples, now);
    store.set(name, toVariableValue(state), metadata(ctx.flowId));
    ctx.log.debug("metric selected branch", {
      name,
      mode,
      value: state.value,
      count: state.count,
    });
    return success("updated", state, mode, maxSamples);
  },
});

function readMode(value: unknown): MetricMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "increment" ||
    normalized === "set" ||
    normalized === "observe" ||
    normalized === "read" ||
    normalized === "reset"
  ) {
    return normalized;
  }
  return undefined;
}

function updateMetric(
  previous: MetricState,
  mode: Exclude<MetricMode, "read" | "reset">,
  amount: number,
  maxSamples: number,
  now: number,
): MetricState {
  const value = mode === "increment" ? previous.value + amount : amount;
  const count = previous.count + 1;
  const sum = previous.sum + amount;
  const samples = maxSamples === 0
    ? []
    : [...previous.samples, amount].slice(-maxSamples);
  return {
    ...previous,
    value,
    count,
    sum,
    min: previous.min === null ? amount : Math.min(previous.min, amount),
    max: previous.max === null ? amount : Math.max(previous.max, amount),
    last: amount,
    samples,
    updatedAt: now,
  };
}

function success(branch: MetricBranch, state: MetricState, mode: MetricMode, maxSamples: number) {
  const average = state.count > 0 ? state.sum / state.count : 0;
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      state,
      name: state.name,
      mode,
      maxSamples,
      value: state.value,
      count: state.count,
      sum: state.sum,
      min: state.min,
      max: state.max,
      average,
      last: state.last,
      samples: state.samples,
    },
  };
}

function readMetricState(name: string, value: unknown, now: number): MetricState {
  if (!value || typeof value !== "object") return emptyState(name, now);
  const record = value as Record<string, unknown>;
  return {
    name,
    value: readNumber(record.value) ?? 0,
    count: readNonNegativeInteger(record.count),
    sum: readNumber(record.sum) ?? 0,
    min: readNumber(record.min) ?? null,
    max: readNumber(record.max) ?? null,
    last: readNumber(record.last) ?? null,
    samples: Array.isArray(record.samples)
      ? record.samples.map(readNumber).filter((item): item is number => item !== undefined)
      : [],
    createdAt: readTimestamp(record.createdAt) ?? now,
    updatedAt: readTimestamp(record.updatedAt) ?? now,
  };
}

function emptyState(name: string, now: number): MetricState {
  return {
    name,
    value: 0,
    count: 0,
    sum: 0,
    min: null,
    max: null,
    last: null,
    samples: [],
    createdAt: now,
    updatedAt: now,
  };
}

function readNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.trunc(number) : undefined;
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

function toVariableValue(state: MetricState): VariableValue {
  return {
    name: state.name,
    value: state.value,
    count: state.count,
    sum: state.sum,
    min: state.min,
    max: state.max,
    last: state.last,
    samples: state.samples,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Flow metric state",
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
