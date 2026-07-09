/**
 * `feature_flag` - persisted feature gate and rollout router.
 *
 * The node keeps release control explicit in the graph. Authors can store a
 * flag configuration, evaluate a stable rollout key, or clear the flag state
 * without coupling deployment policy to application code.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type FeatureFlagMode = "evaluate" | "set" | "clear";
type FeatureFlagBranch = "enabled" | "disabled" | "updated" | "cleared" | "missing";

interface FeatureFlagState {
  name: string;
  enabled: boolean;
  rolloutPercent: number;
  description: string;
  evaluations: number;
  lastKey: string;
  lastBucket: number | null;
  updatedAt: number;
}

const featureFlagConfig = z
  .object({
    name: z.string().default("").describe("Feature flag state variable name."),
    mode: z
      .enum(["evaluate", "set", "clear"])
      .default("evaluate")
      .describe("Feature flag operation mode."),
    enabled: z.boolean().default(true).describe("Whether the flag is globally enabled."),
    rolloutPercent: z
      .number()
      .min(0)
      .max(100)
      .default(100)
      .describe("Stable rollout percentage from 0 to 100."),
    key: z.string().default("").describe("Static rollout key when no key input is connected."),
    description: z.string().default("").describe("Optional feature flag description."),
  })
  .passthrough();

export const featureFlagNode = defineNode({
  type: "feature_flag",
  typeVersion: "1.0.0",
  title: "Feature Flag",
  description: "Evaluates, stores, or clears a persisted feature rollout flag.",
  kind: "pseudo",
  config: featureFlagConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "CHECKOUT_V2",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 2,
      enumOptions: [
        { label: "Evaluate", value: "evaluate" },
        { label: "Set", value: "set" },
        { label: "Clear", value: "clear" },
      ],
    },
    enabled: { label: "Enabled", control: "switch", order: 3 },
    rolloutPercent: { label: "Rollout Percent", control: "number", order: 4 },
    key: { label: "Key", control: "input", order: 5 },
    description: { label: "Description", control: "input", order: 6 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "key", direction: "input", kind: "data", label: "Key" },
    { id: "enabled", direction: "input", kind: "data", label: "Enabled", schema: { type: "boolean" } },
    {
      id: "rolloutPercent",
      direction: "input",
      kind: "data",
      label: "Rollout percent",
      schema: { type: "number" },
    },
    { id: "description", direction: "input", kind: "data", label: "Description", schema: { type: "string" } },
    { id: "enabled", direction: "output", kind: "control", label: "Enabled" },
    { id: "disabled", direction: "output", kind: "control", label: "Disabled" },
    { id: "updated", direction: "output", kind: "control", label: "Updated" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "key", direction: "output", kind: "data", label: "Key", schema: { type: "string" } },
    {
      id: "enabledValue",
      direction: "output",
      kind: "data",
      label: "Enabled value",
      schema: { type: "boolean" },
    },
    {
      id: "bucket",
      direction: "output",
      kind: "data",
      label: "Bucket",
      schema: { type: "number" },
    },
    {
      id: "rolloutPercent",
      direction: "output",
      kind: "data",
      label: "Rollout percent",
      schema: { type: "number" },
    },
    { id: "description", direction: "output", kind: "data", label: "Description", schema: { type: "string" } },
    {
      id: "evaluations",
      direction: "output",
      kind: "data",
      label: "Evaluations",
      schema: { type: "number" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.feature_flag.missing_name",
        "feature_flag node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.feature_flag.readonly_store",
        "feature_flag requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "evaluate";
    const policy = {
      enabled: readBoolean(input.enabled) ?? readBoolean(config.enabled) ?? true,
      rolloutPercent: readRolloutPercent(input.rolloutPercent ?? config.rolloutPercent),
      description: String(input.description ?? config.description ?? "").trim(),
    };
    const previous = readFeatureFlagState(name, store.get(name), policy, now);
    if (mode === "clear") {
      const existed = store.delete(name);
      return success(existed ? "cleared" : "missing", emptyState(name, policy, now), "", null, mode);
    }
    if (mode === "set") {
      const state = {
        ...previous,
        enabled: policy.enabled,
        rolloutPercent: policy.rolloutPercent,
        description: policy.description,
        updatedAt: now,
      };
      store.set(name, toVariableValue(state), metadata(ctx.flowId));
      return success("updated", state, "", null, mode);
    }

    const key = readKey(input.key ?? input.input ?? input.in ?? config.key ?? ctx.runId);
    const bucket = rolloutBucket(`${name}:${key}`);
    const active = previous.enabled && bucket < previous.rolloutPercent;
    const state: FeatureFlagState = {
      ...previous,
      evaluations: previous.evaluations + 1,
      lastKey: key,
      lastBucket: bucket,
      updatedAt: now,
    };
    store.set(name, toVariableValue(state), metadata(ctx.flowId));
    ctx.log.debug("feature_flag selected branch", {
      name,
      key,
      branch: active ? "enabled" : "disabled",
      bucket,
      rolloutPercent: state.rolloutPercent,
    });
    return success(active ? "enabled" : "disabled", state, key, bucket, mode);
  },
});

function readMode(value: unknown): FeatureFlagMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "evaluate" || normalized === "set" || normalized === "clear" ? normalized : undefined;
}

function success(
  branch: FeatureFlagBranch,
  state: FeatureFlagState,
  key: string,
  bucket: number | null,
  mode: FeatureFlagMode,
) {
  const enabledValue = branch === "enabled" || (branch === "updated" && state.enabled);
  const summary = {
    name: state.name,
    mode,
    branch,
    key,
    enabledValue,
    globalEnabled: state.enabled,
    bucket,
    rolloutPercent: state.rolloutPercent,
    description: state.description,
    evaluations: state.evaluations,
    updatedAt: state.updatedAt,
  };
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      state,
      name: state.name,
      mode,
      key,
      enabledValue,
      bucket,
      rolloutPercent: state.rolloutPercent,
      description: state.description,
      evaluations: state.evaluations,
      summary,
    },
  };
}

function readFeatureFlagState(
  name: string,
  value: unknown,
  config: { enabled?: unknown; rolloutPercent?: unknown; description?: unknown },
  now: number,
): FeatureFlagState {
  const fallback = emptyState(name, config, now);
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return {
    name,
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    rolloutPercent: readRolloutPercent(record.rolloutPercent ?? fallback.rolloutPercent),
    description: typeof record.description === "string" ? record.description : fallback.description,
    evaluations: readNonNegativeInteger(record.evaluations),
    lastKey: typeof record.lastKey === "string" ? record.lastKey : "",
    lastBucket: readBucket(record.lastBucket),
    updatedAt: readTimestamp(record.updatedAt) ?? now,
  };
}

function emptyState(
  name: string,
  config: { enabled?: unknown; rolloutPercent?: unknown; description?: unknown },
  now: number,
): FeatureFlagState {
  return {
    name,
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    rolloutPercent: readRolloutPercent(config.rolloutPercent ?? 100),
    description: typeof config.description === "string" ? config.description.trim() : "",
    evaluations: 0,
    lastKey: "",
    lastBucket: null,
    updatedAt: now,
  };
}

function readKey(value: unknown): string {
  const key = String(value ?? "").trim();
  return key === "" ? "default" : key;
}

function readRolloutPercent(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.max(0, Math.min(100, number));
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function readBucket(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function rolloutBucket(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 10000 / 100;
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function toVariableValue(state: FeatureFlagState): VariableValue {
  return {
    name: state.name,
    enabled: state.enabled,
    rolloutPercent: state.rolloutPercent,
    description: state.description,
    evaluations: state.evaluations,
    lastKey: state.lastKey,
    lastBucket: state.lastBucket,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Feature flag state",
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
