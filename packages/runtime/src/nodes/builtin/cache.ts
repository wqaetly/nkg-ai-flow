/**
 * `cache` - persisted namespaced value cache.
 *
 * This node keeps caching explicit in the graph: authors decide when to read,
 * store, invalidate, or clear cached values instead of hiding memoization in a
 * scheduler or transport layer.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type CacheMode = "get" | "set" | "delete" | "clear";
type CacheBranch = "hit" | "miss" | "stored" | "deleted" | "cleared" | "expired";

interface CacheEntry {
  value: VariableValue;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  hits: number;
}

const cacheConfig = z
  .object({
    namespace: z.string().default("default").describe("Cache namespace."),
    key: z.string().default("").describe("Cache key."),
    mode: z
      .enum(["get", "set", "delete", "clear"])
      .default("get")
      .describe("Cache operation mode."),
    ttlMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Time to live in milliseconds; 0 never expires."),
    value: z.unknown().optional().describe("Static value used by set mode."),
  })
  .passthrough();

export const cacheNode = defineNode({
  type: "cache",
  typeVersion: "1.0.0",
  title: "Cache",
  description: "Reads, writes, invalidates, or clears namespaced cached values.",
  kind: "pseudo",
  config: cacheConfig,
  fieldMeta: {
    namespace: {
      label: "Namespace",
      control: "input",
      order: 1,
      placeholder: "http",
    },
    key: {
      label: "Key",
      control: "input",
      order: 2,
      placeholder: "GET:/orders/1",
    },
    mode: {
      label: "Mode",
      control: "select",
      order: 3,
      enumOptions: [
        { label: "Get", value: "get" },
        { label: "Set", value: "set" },
        { label: "Delete", value: "delete" },
        { label: "Clear", value: "clear" },
      ],
    },
    ttlMs: { label: "TTL (ms)", control: "number", order: 4 },
    value: {
      label: "Value",
      control: "textarea",
      order: 5,
      placeholder: "Static fallback value for set mode.",
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "namespace", direction: "input", kind: "data", label: "Namespace", schema: { type: "string" } },
    { id: "key", direction: "input", kind: "data", label: "Key" },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "ttlMs", direction: "input", kind: "data", label: "TTL ms", schema: { type: "number" } },
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "hit", direction: "output", kind: "control", label: "Hit" },
    { id: "miss", direction: "output", kind: "control", label: "Miss" },
    { id: "stored", direction: "output", kind: "control", label: "Stored" },
    { id: "deleted", direction: "output", kind: "control", label: "Deleted" },
    { id: "cleared", direction: "output", kind: "control", label: "Cleared" },
    { id: "expired", direction: "output", kind: "control", label: "Expired" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "entry", direction: "output", kind: "data", label: "Entry" },
    { id: "key", direction: "output", kind: "data", label: "Key", schema: { type: "string" } },
    {
      id: "namespace",
      direction: "output",
      kind: "data",
      label: "Namespace",
      schema: { type: "string" },
    },
    {
      id: "storeKey",
      direction: "output",
      kind: "data",
      label: "Store Key",
      schema: { type: "string" },
    },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    {
      id: "ttlMs",
      direction: "output",
      kind: "data",
      label: "TTL ms",
      schema: { type: "number" },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
    {
      id: "expiresAt",
      direction: "output",
      kind: "data",
      label: "Expires at",
      schema: { type: "number" },
    },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error("node.cache.readonly_store", "cache requires a mutable VariableStore", ctx.nodeId);
    }

    const namespace = readNamespace(input.namespace ?? config.namespace);
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "get";
    const ttlMs = readIntegerAtLeast(input.ttlMs, 0) ?? readIntegerAtLeast(config.ttlMs, 0) ?? 0;
    const now = Date.now();
    if (mode === "clear") {
      const prefix = cachePrefix(namespace);
      const keys = store
        .list()
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(prefix));
      for (const key of keys) store.delete(key);
      return success("cleared", {
        namespace,
        key: "",
        storeKey: prefix,
        mode,
        ttlMs,
        value: null,
        entry: null,
        count: keys.length,
        expiresAt: null,
        remainingMs: 0,
      });
    }

    const key = readKey(input.key ?? config.key);
    if (key === "") {
      return error("node.cache.missing_key", "cache node requires a key", ctx.nodeId);
    }

    const storeKey = cacheStoreKey(namespace, key);
    if (mode === "delete") {
      const existed = store.delete(storeKey);
      return success(existed ? "deleted" : "miss", {
        namespace,
        key,
        storeKey,
        mode,
        ttlMs,
        value: null,
        entry: null,
        count: existed ? 1 : 0,
        expiresAt: null,
        remainingMs: 0,
      });
    }

    if (mode === "set") {
      const raw = input.value ?? config.value ?? input.input ?? input.in ?? null;
      const value = toJsonValue(raw);
      if (value === undefined) {
        return error("node.cache.unsupported_value", "cache value must be JSON-compatible", ctx.nodeId);
      }
      const previous = readCacheEntry(store.get(storeKey));
      const entry: CacheEntry = {
        value,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        expiresAt: ttlMs > 0 ? now + ttlMs : null,
        hits: previous?.hits ?? 0,
      };
      store.set(storeKey, toVariableValue(entry), metadata(ctx.flowId, namespace, key));
      return success("stored", {
        namespace,
        key,
        storeKey,
        mode,
        ttlMs,
        value,
        entry,
        count: 1,
        expiresAt: entry.expiresAt,
        remainingMs: remainingMs(entry, now),
      });
    }

    const entry = readCacheEntry(store.get(storeKey));
    if (!entry) {
      return success("miss", {
        namespace,
        key,
        storeKey,
        mode,
        ttlMs,
        value: null,
        entry: null,
        count: 0,
        expiresAt: null,
        remainingMs: 0,
      });
    }
    if (entry.expiresAt !== null && now >= entry.expiresAt) {
      store.delete(storeKey);
      return success("expired", {
        namespace,
        key,
        storeKey,
        mode,
        ttlMs,
        value: entry.value,
        entry,
        count: 0,
        expiresAt: entry.expiresAt,
        remainingMs: 0,
      });
    }
    const hit: CacheEntry = { ...entry, updatedAt: now, hits: entry.hits + 1 };
    store.set(storeKey, toVariableValue(hit), metadata(ctx.flowId, namespace, key));
    return success("hit", {
      namespace,
      key,
      storeKey,
      mode,
      ttlMs,
      value: hit.value,
      entry: hit,
      count: 1,
      expiresAt: hit.expiresAt,
      remainingMs: remainingMs(hit, now),
    });
  },
});

function success(
  branch: CacheBranch,
  values: {
    namespace: string;
    key: string;
    storeKey: string;
    mode: CacheMode;
    ttlMs: number;
    value: VariableValue | null;
    entry: CacheEntry | null;
    count: number;
    expiresAt: number | null;
    remainingMs: number;
  },
) {
  const summary = {
    namespace: values.namespace,
    key: values.key,
    storeKey: values.storeKey,
    mode: values.mode,
    branch,
    ttlMs: values.ttlMs,
    count: values.count,
    hasValue: values.value !== null,
    hasEntry: values.entry !== null,
    hits: values.entry?.hits ?? 0,
    expiresAt: values.expiresAt,
    remainingMs: values.remainingMs,
  };
  return {
    kind: "success" as const,
    outputs: {
      [branch]: null,
      value: values.value,
      entry: values.entry,
      key: values.key,
      namespace: values.namespace,
      storeKey: values.storeKey,
      mode: values.mode,
      ttlMs: values.ttlMs,
      count: values.count,
      expiresAt: values.expiresAt,
      remainingMs: values.remainingMs,
      summary,
    },
  };
}

function readNamespace(value: unknown): string {
  const namespace = String(value ?? "default").trim();
  return namespace === "" ? "default" : namespace;
}

function readKey(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function readMode(value: unknown): CacheMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "get" ||
    normalized === "set" ||
    normalized === "delete" ||
    normalized === "clear"
    ? normalized
    : undefined;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer >= minimum ? integer : undefined;
}

function cachePrefix(namespace: string): string {
  return `CACHE:${namespace}:`;
}

function cacheStoreKey(namespace: string, key: string): string {
  return `${cachePrefix(namespace)}${key}`;
}

function readCacheEntry(value: unknown): CacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const cached = toJsonValue(record.value);
  if (cached === undefined) return null;
  return {
    value: cached,
    createdAt: readTimestamp(record.createdAt) ?? Date.now(),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
    expiresAt: readTimestamp(record.expiresAt),
    hits: readNonNegativeInteger(record.hits),
  };
}

function remainingMs(entry: CacheEntry, now: number): number {
  return entry.expiresAt === null ? 0 : Math.max(0, entry.expiresAt - now);
}

function readTimestamp(value: unknown): number | null {
  if (value === null) return null;
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
    typeof (value as { delete?: unknown }).delete === "function" &&
    typeof (value as { list?: unknown }).list === "function"
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

function toVariableValue(entry: CacheEntry): VariableValue {
  return {
    value: entry.value,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    hits: entry.hits,
  };
}

function metadata(flowId: string, namespace: string, key: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: `Cache entry ${namespace}:${key}`,
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
