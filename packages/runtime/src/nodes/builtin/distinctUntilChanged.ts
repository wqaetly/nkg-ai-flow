/**
 * `distinct_until_changed` - persisted change gate.
 *
 * It records the last observed value for a named stream and only routes to
 * `changed` when the selected value differs from the previous observation.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";
import { controlIn, readPath } from "./_helpers.js";

type CompareMode = "json" | "string";

interface DistinctState {
  value: VariableValue;
  fingerprint: string;
  updatedAt: number;
  seenAt: number;
  evaluations: number;
  changes: number;
}

const distinctUntilChangedConfig = z
  .object({
    name: z.string().default("").describe("State key used to remember the last value."),
    path: z
      .string()
      .default("")
      .describe("Optional dotted path selected from the input payload before comparison."),
    mode: z.enum(["json", "string"]).default("json").describe("Comparison mode."),
    emitInitial: z
      .boolean()
      .default(true)
      .describe("Whether the first observed value should route to changed."),
    value: z
      .unknown()
      .optional()
      .describe("Static fallback value when no value input is connected."),
  })
  .passthrough();

export const distinctUntilChangedNode = defineNode({
  type: "distinct_until_changed",
  typeVersion: "1.0.0",
  title: "Distinct Until Changed",
  description: "Routes only newly changed values to the changed branch.",
  kind: "pseudo",
  config: distinctUntilChangedConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "INVENTORY_STATUS",
    },
    path: {
      label: "Path",
      control: "input",
      order: 2,
      placeholder: "status",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 3,
      enumOptions: [
        { label: "JSON", value: "json" },
        { label: "String", value: "string" },
      ],
    },
    emitInitial: {
      label: "Emit Initial",
      control: "switch",
      order: 4,
    },
    value: {
      label: "Static Value",
      control: "textarea",
      order: 5,
    },
  },
  ports: [
    controlIn,
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "changed", direction: "output", kind: "control", label: "Changed" },
    { id: "unchanged", direction: "output", kind: "control", label: "Unchanged" },
    { id: "name", direction: "output", kind: "data", label: "Name" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "previous", direction: "output", kind: "data", label: "Previous" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "changedValue", direction: "output", kind: "data", label: "Changed value", schema: { type: "boolean" } },
    { id: "fingerprint", direction: "output", kind: "data", label: "Fingerprint", schema: { type: "string" } },
    { id: "evaluations", direction: "output", kind: "data", label: "Evaluations", schema: { type: "number" } },
    { id: "changes", direction: "output", kind: "data", label: "Changes", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.distinct_until_changed.missing_name",
        "distinct_until_changed requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.distinct_until_changed.readonly_store",
        "distinct_until_changed requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const payload = input.value ?? config.value ?? input.input ?? input.in ?? input.__runInput__ ?? null;
    const selected = selectValue(payload, String(config.path ?? ""));
    const value = toVariableValue(selected);
    if (value === undefined) {
      return error(
        "node.distinct_until_changed.unsupported_value",
        "distinct_until_changed value must be JSON-compatible",
        ctx.nodeId,
        { valueType: typeof selected },
      );
    }

    const mode = config.mode === "string" ? "string" : "json";
    const fingerprint = fingerprintValue(value, mode);
    const previous = readState(store.get(name));
    const firstObservation = !previous;
    const valueChanged = !previous || previous.fingerprint !== fingerprint;
    const routeChanged = firstObservation
      ? Boolean(config.emitInitial ?? true)
      : valueChanged;
    const status = routeChanged ? "changed" : "unchanged";
    const now = Date.now();
    const next: DistinctState = {
      value,
      fingerprint,
      updatedAt: valueChanged ? now : (previous?.updatedAt ?? now),
      seenAt: now,
      evaluations: (previous?.evaluations ?? 0) + 1,
      changes: (previous?.changes ?? 0) + (valueChanged ? 1 : 0),
    };

    const metadata: VariableMetadata = {
      source: "runtime",
      scope: { flowId: ctx.flowId },
      description: "distinct_until_changed state",
    };
    store.set(name, stateToVariableValue(next), metadata);

    ctx.log.debug("distinct_until_changed evaluated value", {
      name,
      status,
      mode,
      firstObservation,
      valueChanged,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        name,
        value,
        previous: previous?.value ?? null,
        status,
        changedValue: valueChanged,
        fingerprint,
        evaluations: next.evaluations,
        changes: next.changes,
      },
    };
  },
});

function selectValue(payload: unknown, path: string): unknown {
  const trimmed = path.trim();
  return trimmed === "" ? payload : readPath(payload, trimmed);
}

function fingerprintValue(value: VariableValue, mode: CompareMode): string {
  if (mode === "string") return String(value);
  return stableStringify(value);
}

function stableStringify(value: VariableValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function readState(value: unknown): DistinctState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const storedValue = toVariableValue(state.value);
  if (storedValue === undefined || typeof state.fingerprint !== "string") {
    return undefined;
  }
  return {
    value: storedValue,
    fingerprint: state.fingerprint,
    updatedAt: readNumber(state.updatedAt),
    seenAt: readNumber(state.seenAt),
    evaluations: readNumber(state.evaluations),
    changes: readNumber(state.changes),
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stateToVariableValue(state: DistinctState): VariableValue {
  return {
    value: state.value,
    fingerprint: state.fingerprint,
    updatedAt: state.updatedAt,
    seenAt: state.seenAt,
    evaluations: state.evaluations,
    changes: state.changes,
  };
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

function toVariableValue(value: unknown): VariableValue | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(toVariableValue);
    return items.some((item) => item === undefined)
      ? undefined
      : (items as VariableValue[]);
  }
  if (value && typeof value === "object") {
    const out: Record<string, VariableValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toVariableValue(item);
      if (converted === undefined) return undefined;
      out[key] = converted;
    }
    return out;
  }
  return undefined;
}

function error(
  code: string,
  message: string,
  nodeId: string,
  context?: Record<string, unknown>,
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
      context,
    }) as unknown as {
      code: string;
      message: string;
      [key: string]: unknown;
    },
  };
}
