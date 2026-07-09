/**
 * `retry_state` - persisted retry attempt policy.
 *
 * `retry_policy` is stateless. This node stores attempt counters and the
 * next retry time so retry decisions can survive separate workflow runs.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

type RetryStateMode = "record_failure" | "record_success" | "check" | "reset";
type RetryStateBranch = "retry" | "waiting" | "exhausted" | "unsafe" | "reset" | "idle";
type RetryStatus = "retry" | "waiting" | "exhausted" | "unsafe";

interface PersistedRetryState {
  status: RetryStatus;
  retryFlowId: string;
  retryRunId: string;
  retryNodeId: string;
  attempt: number;
  maxAttempts: number;
  retryable: boolean | null;
  idempotent: boolean | null;
  requiresIdempotency: boolean;
  blockedByIdempotency: boolean;
  lastError: VariableValue | null;
  nextRetryAt: number | null;
  exhaustedAt: number | null;
  updatedAt: number;
}

const retryStateConfig = z
  .object({
    name: z.string().default("").describe("Retry state variable name."),
    key: z.string().default("").describe("Optional key suffix for per-item retry state."),
    mode: z
      .enum(["record_failure", "record_success", "check", "reset"])
      .default("record_failure")
      .describe("Retry state operation mode."),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("Maximum total attempts before routing to exhausted."),
    baseDelayMs: z
      .number()
      .int()
      .min(0)
      .default(1000)
      .describe("Initial backoff delay in milliseconds."),
    multiplier: z
      .number()
      .min(1)
      .default(2)
      .describe("Exponential backoff multiplier."),
    maxDelayMs: z
      .number()
      .int()
      .min(0)
      .default(30000)
      .describe("Maximum backoff delay in milliseconds."),
    jitterPercent: z
      .number()
      .min(0)
      .max(100)
      .default(0)
      .describe("Deterministic jitter percentage applied to retry delay."),
    retryableOnly: z
      .boolean()
      .default(true)
      .describe("Only retry errors whose retryable flag is true."),
    retryableCodes: z
      .string()
      .default("")
      .describe("Comma-separated exact or wildcard error codes allowed to retry."),
    retryAfterMsPath: z
      .string()
      .default("retryAfterMs")
      .describe("Dotted path to a retry-after delay in milliseconds."),
    retryAfterAtPath: z
      .string()
      .default("retryAfterAt")
      .describe("Dotted path to an absolute retry-after timestamp."),
    requireIdempotency: z
      .boolean()
      .default(false)
      .describe("When true, persist non-idempotent or unknown operations as unsafe instead of retrying."),
  })
  .passthrough();

export const retryStateNode = defineNode({
  type: "retry_state",
  typeVersion: "1.0.0",
  title: "Retry State",
  description: "Persists retry attempts and routes by backoff state.",
  kind: "pseudo",
  config: retryStateConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "PAYMENT_RETRY",
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
        { label: "Record Failure", value: "record_failure" },
        { label: "Record Success", value: "record_success" },
        { label: "Check", value: "check" },
        { label: "Reset", value: "reset" },
      ],
    },
    maxAttempts: { label: "Max Attempts", control: "number", order: 4 },
    baseDelayMs: { label: "Base Delay (ms)", control: "number", order: 5 },
    multiplier: { label: "Multiplier", control: "number", order: 6 },
    maxDelayMs: { label: "Max Delay (ms)", control: "number", order: 7 },
    jitterPercent: { label: "Jitter Percent", control: "number", order: 8 },
    retryableOnly: { label: "Retryable Only", control: "switch", order: 9 },
    retryableCodes: { label: "Retryable Codes", control: "input", order: 10 },
    retryAfterMsPath: {
      label: "Retry After Ms Path",
      control: "input",
      order: 11,
      placeholder: "retryAfterMs",
    },
    retryAfterAtPath: {
      label: "Retry After At Path",
      control: "input",
      order: 12,
      placeholder: "retryAfterAt",
    },
    requireIdempotency: { label: "Require Idempotency", control: "switch", order: 13 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "name", direction: "input", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "error", direction: "input", kind: "data", label: "Error" },
    { id: "idempotent", direction: "input", kind: "data", label: "Idempotent", schema: { type: "boolean" } },
    { id: "key", direction: "input", kind: "data", label: "Key", schema: { type: "string" } },
    { id: "mode", direction: "input", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "maxAttempts", direction: "input", kind: "data", label: "Max Attempts", schema: { type: "number" } },
    { id: "baseDelayMs", direction: "input", kind: "data", label: "Base Delay ms", schema: { type: "number" } },
    { id: "multiplier", direction: "input", kind: "data", label: "Multiplier", schema: { type: "number" } },
    { id: "maxDelayMs", direction: "input", kind: "data", label: "Max Delay ms", schema: { type: "number" } },
    { id: "jitterPercent", direction: "input", kind: "data", label: "Jitter Percent", schema: { type: "number" } },
    { id: "retryableOnly", direction: "input", kind: "data", label: "Retryable Only", schema: { type: "boolean" } },
    { id: "retryableCodes", direction: "input", kind: "data", label: "Retryable Codes", schema: { type: "string" } },
    { id: "retryAfterMsPath", direction: "input", kind: "data", label: "Retry After Ms Path", schema: { type: "string" } },
    { id: "retryAfterAtPath", direction: "input", kind: "data", label: "Retry After At Path", schema: { type: "string" } },
    { id: "requireIdempotency", direction: "input", kind: "data", label: "Require Idempotency", schema: { type: "boolean" } },
    { id: "retry", direction: "output", kind: "control", label: "Retry" },
    { id: "waiting", direction: "output", kind: "control", label: "Waiting" },
    { id: "exhausted", direction: "output", kind: "control", label: "Exhausted" },
    { id: "unsafe", direction: "output", kind: "control", label: "Unsafe" },
    { id: "reset", direction: "output", kind: "control", label: "Reset" },
    { id: "idle", direction: "output", kind: "control", label: "Idle" },
    { id: "state", direction: "output", kind: "data", label: "State" },
    { id: "name", direction: "output", kind: "data", label: "Name", schema: { type: "string" } },
    { id: "error", direction: "output", kind: "data", label: "Error" },
    { id: "mode", direction: "output", kind: "data", label: "Mode", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "retryFlowId", direction: "output", kind: "data", label: "Retry Flow Id", schema: { type: "string" } },
    { id: "retryRunId", direction: "output", kind: "data", label: "Retry Run Id", schema: { type: "string" } },
    { id: "retryNodeId", direction: "output", kind: "data", label: "Retry Node Id", schema: { type: "string" } },
    { id: "attempt", direction: "output", kind: "data", label: "Attempt", schema: { type: "number" } },
    { id: "nextAttempt", direction: "output", kind: "data", label: "Next Attempt", schema: { type: "number" } },
    { id: "delayMs", direction: "output", kind: "data", label: "Delay ms", schema: { type: "number" } },
    { id: "retryAfterMs", direction: "output", kind: "data", label: "Retry after ms", schema: { type: "number" } },
    { id: "nextRetryAt", direction: "output", kind: "data", label: "Next Retry At", schema: { type: "string" } },
    { id: "retryable", direction: "output", kind: "data", label: "Retryable", schema: { type: "boolean" } },
    { id: "idempotent", direction: "output", kind: "data", label: "Idempotent", schema: { type: "boolean" } },
    { id: "requiresIdempotency", direction: "output", kind: "data", label: "Requires Idempotency", schema: { type: "boolean" } },
    { id: "blockedByIdempotency", direction: "output", kind: "data", label: "Blocked By Idempotency", schema: { type: "boolean" } },
    { id: "stateStatus", direction: "output", kind: "data", label: "State Status", schema: { type: "string" } },
    { id: "maxAttempts", direction: "output", kind: "data", label: "Max Attempts", schema: { type: "number" } },
    { id: "baseDelayMs", direction: "output", kind: "data", label: "Base Delay ms", schema: { type: "number" } },
    { id: "multiplier", direction: "output", kind: "data", label: "Multiplier", schema: { type: "number" } },
    { id: "maxDelayMs", direction: "output", kind: "data", label: "Max Delay ms", schema: { type: "number" } },
    { id: "jitterPercent", direction: "output", kind: "data", label: "Jitter Percent", schema: { type: "number" } },
    { id: "retryableOnly", direction: "output", kind: "data", label: "Retryable Only", schema: { type: "boolean" } },
    { id: "retryableCodes", direction: "output", kind: "data", label: "Retryable Codes", schema: { type: "string" } },
    { id: "retryAfterMsPath", direction: "output", kind: "data", label: "Retry After Ms Path", schema: { type: "string" } },
    { id: "retryAfterAtPath", direction: "output", kind: "data", label: "Retry After At Path", schema: { type: "string" } },
    { id: "remainingAttempts", direction: "output", kind: "data", label: "Remaining Attempts", schema: { type: "number" } },
    { id: "exhaustedValue", direction: "output", kind: "data", label: "Exhausted", schema: { type: "boolean" } },
    { id: "unsafeValue", direction: "output", kind: "data", label: "Unsafe", schema: { type: "boolean" } },
    { id: "stateKey", direction: "output", kind: "data", label: "State Key", schema: { type: "string" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    const stateKey = buildStateKey(name, input.key ?? config.key);
    if (stateKey === "") {
      return error(
        "node.retry_state.missing_name",
        "retry_state node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.retry_state.readonly_store",
        "retry_state requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const now = Date.now();
    const locator = { retryFlowId: ctx.flowId, retryRunId: ctx.runId, retryNodeId: ctx.nodeId };
    const previous = readRetryState(store.get(stateKey), locator);
    const mode = readMode(input.mode) ?? readMode(config.mode) ?? "record_failure";
    const requireIdempotency =
      readBoolean(input.requireIdempotency) ?? (config.requireIdempotency === true);
    const retryableOnly =
      readBoolean(input.retryableOnly) ?? (config.retryableOnly !== false);
    const policyMaxAttempts =
      readPositiveInteger(input.maxAttempts, undefined) ??
      readPositiveInteger(config.maxAttempts, 3);
    const policyBaseDelayMs =
      readNonNegativeInteger(input.baseDelayMs, undefined) ??
      readNonNegativeInteger(config.baseDelayMs, 1000);
    const policyMultiplier =
      readNumberAtLeast(input.multiplier, 1) ?? readNumberAtLeast(config.multiplier, 1) ?? 2;
    const policyMaxDelayMs =
      readNonNegativeInteger(input.maxDelayMs, undefined) ??
      readNonNegativeInteger(config.maxDelayMs, 30000);
    const policyJitterPercent =
      clampPercent(input.jitterPercent) ?? clampPercent(config.jitterPercent) ?? 0;
    const retryableCodes = String(input.retryableCodes ?? config.retryableCodes ?? "");
    const retryAfterMsPath = String(input.retryAfterMsPath ?? config.retryAfterMsPath ?? "retryAfterMs");
    const retryAfterAtPath = String(input.retryAfterAtPath ?? config.retryAfterAtPath ?? "retryAfterAt");
    const decision = applyMode(previous, {
      mode,
      error: input.error ?? null,
      idempotent: input.idempotent,
      requireIdempotency,
      retryableOnly,
      maxAttempts: policyMaxAttempts,
      baseDelayMs: policyBaseDelayMs,
      multiplier: policyMultiplier,
      maxDelayMs: policyMaxDelayMs,
      jitterPercent: policyJitterPercent,
      retryableCodes,
      retryAfterMsPath,
      retryAfterAtPath,
      stateKey,
      locator,
      now,
      nodeId: ctx.nodeId,
    });
    if (decision.kind === "error") return decision;

    if (decision.state === null) {
      store.delete(stateKey);
    } else {
      store.set(stateKey, toVariableValue(decision.state), metadata(ctx.flowId));
    }

    const retryAfterMs =
      decision.state?.nextRetryAt === null || decision.state === null
        ? 0
        : Math.max(0, decision.state.nextRetryAt - now);
    const nextRetryAt =
      decision.state?.nextRetryAt === null || decision.state === null
        ? ""
        : new Date(decision.state.nextRetryAt).toISOString();
    const attempt = decision.state?.attempt ?? 0;
    const maxAttempts = decision.state?.maxAttempts ?? policyMaxAttempts;
    const remainingAttempts = Math.max(0, maxAttempts - attempt);
    const stateStatus = decision.state?.status ?? decision.branch;
    const exhaustedValue =
      decision.branch === "exhausted" || decision.state?.status === "exhausted";
    const unsafeValue =
      decision.branch === "unsafe" || decision.state?.status === "unsafe";

    ctx.log.debug("retry_state selected branch", {
      stateKey,
      mode,
      branch: decision.branch,
      attempt,
      retryAfterMs,
    });

    return {
      kind: "success",
      outputs: {
        [decision.branch]: null,
        state: decision.state,
        name,
        error: decision.state?.lastError ?? null,
        mode,
        status: decision.branch,
        retryFlowId: decision.state?.retryFlowId ?? "",
        retryRunId: decision.state?.retryRunId ?? "",
        retryNodeId: decision.state?.retryNodeId ?? "",
        attempt,
        nextAttempt: decision.branch === "retry" ? attempt + 1 : attempt,
        delayMs: decision.delayMs,
        retryAfterMs,
        nextRetryAt,
        retryable: decision.state?.retryable ?? null,
        idempotent: decision.state?.idempotent ?? null,
        requiresIdempotency: decision.state?.requiresIdempotency ?? requireIdempotency,
        blockedByIdempotency: decision.state?.blockedByIdempotency ?? false,
        stateStatus,
        maxAttempts,
        baseDelayMs: policyBaseDelayMs,
        multiplier: policyMultiplier,
        maxDelayMs: policyMaxDelayMs,
        jitterPercent: policyJitterPercent,
        retryableOnly,
        retryableCodes,
        retryAfterMsPath,
        retryAfterAtPath,
        remainingAttempts,
        exhaustedValue,
        unsafeValue,
        stateKey,
        summary: {
          status: decision.branch,
          mode,
          stateKey,
          stateStatus,
          attempt,
          nextAttempt: decision.branch === "retry" ? attempt + 1 : attempt,
          maxAttempts,
          remainingAttempts,
          delayMs: decision.delayMs,
          retryAfterMs,
          nextRetryAt,
          retryable: decision.state?.retryable ?? null,
          idempotent: decision.state?.idempotent ?? null,
          requiresIdempotency: decision.state?.requiresIdempotency ?? requireIdempotency,
          blockedByIdempotency: decision.state?.blockedByIdempotency ?? false,
          exhaustedValue,
          unsafeValue,
        },
      },
    };
  },
});

function applyMode(
  previous: PersistedRetryState | null,
  options: {
    mode: RetryStateMode;
    error: unknown;
    idempotent: unknown;
    requireIdempotency: boolean;
    retryableOnly: boolean;
    maxAttempts: number;
    baseDelayMs: number;
    multiplier: number;
    maxDelayMs: number;
    jitterPercent: number;
    retryableCodes: unknown;
    retryAfterMsPath: string;
    retryAfterAtPath: string;
    stateKey: string;
    locator: { retryFlowId: string; retryRunId: string; retryNodeId: string };
    now: number;
    nodeId: string;
  },
):
  | { kind: "success"; branch: RetryStateBranch; state: PersistedRetryState | null; delayMs: number }
  | ReturnType<typeof error> {
  const { mode, now } = options;
  if (mode === "reset" || mode === "record_success") {
    return { kind: "success", branch: "reset", state: null, delayMs: 0 };
  }
  if (mode === "check") {
    if (!previous) return { kind: "success", branch: "idle", state: null, delayMs: 0 };
    if (previous.status === "exhausted") {
      return { kind: "success", branch: "exhausted", state: previous, delayMs: 0 };
    }
    if (previous.status === "unsafe") {
      return { kind: "success", branch: "unsafe", state: previous, delayMs: 0 };
    }
    if (previous.nextRetryAt !== null && now < previous.nextRetryAt) {
      return { kind: "success", branch: "waiting", state: previous, delayMs: 0 };
    }
    return {
      kind: "success",
      branch: "retry",
      state: { ...previous, status: "retry", updatedAt: now },
      delayMs: 0,
    };
  }

  const convertedError = toJsonValue(options.error);
  if (convertedError === undefined) {
    return error(
      "node.retry_state.unsupported_error",
      "retry_state error must be JSON-compatible",
      options.nodeId,
    );
  }
  const retryable = readRetryable(options.error, options.retryableCodes);
  const idempotent = readIdempotent(options.idempotent, options.error);
  const blockedByIdempotency = options.requireIdempotency && idempotent !== true;
  const attempt = (previous?.attempt ?? 0) + 1;
  if (blockedByIdempotency) {
    return {
      kind: "success",
      branch: "unsafe",
      delayMs: 0,
      state: {
        status: "unsafe",
        retryFlowId: options.locator.retryFlowId,
        retryRunId: options.locator.retryRunId,
        retryNodeId: options.locator.retryNodeId,
        attempt,
        maxAttempts: options.maxAttempts,
        retryable: retryable ?? null,
        idempotent: idempotent ?? null,
        requiresIdempotency: true,
        blockedByIdempotency: true,
        lastError: convertedError,
        nextRetryAt: null,
        exhaustedAt: now,
        updatedAt: now,
      },
    };
  }
  const canRetry =
    attempt < options.maxAttempts && (!options.retryableOnly || retryable === true);
  if (!canRetry) {
    return {
      kind: "success",
      branch: "exhausted",
      delayMs: 0,
      state: {
        status: "exhausted",
        retryFlowId: options.locator.retryFlowId,
        retryRunId: options.locator.retryRunId,
        retryNodeId: options.locator.retryNodeId,
        attempt,
        maxAttempts: options.maxAttempts,
        retryable: retryable ?? null,
        idempotent: idempotent ?? null,
        requiresIdempotency: options.requireIdempotency,
        blockedByIdempotency: false,
        lastError: convertedError,
        nextRetryAt: null,
        exhaustedAt: now,
        updatedAt: now,
      },
    };
  }

  const delayMs = calculateDelay(options, attempt);
  return {
    kind: "success",
    branch: "retry",
    delayMs,
    state: {
      status: "waiting",
      retryFlowId: options.locator.retryFlowId,
      retryRunId: options.locator.retryRunId,
      retryNodeId: options.locator.retryNodeId,
      attempt,
      maxAttempts: options.maxAttempts,
      retryable: retryable ?? null,
      idempotent: idempotent ?? null,
      requiresIdempotency: options.requireIdempotency,
      blockedByIdempotency: false,
      lastError: convertedError,
      nextRetryAt: now + delayMs,
      exhaustedAt: null,
      updatedAt: now,
    },
  };
}

function buildStateKey(name: unknown, key: unknown): string {
  const base = String(name ?? "").trim();
  if (base === "") return "";
  const suffix = String(key ?? "").trim();
  return suffix === "" ? base : `${base}:${suffix}`;
}

function calculateDelay(
  options: {
    baseDelayMs: number;
    multiplier: number;
    maxDelayMs: number;
    jitterPercent: number;
    stateKey: string;
    error?: unknown;
    retryAfterMsPath?: string;
    retryAfterAtPath?: string;
    now?: number;
  },
  attempt: number,
): number {
  const exponential =
    options.baseDelayMs * options.multiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(options.maxDelayMs, Math.trunc(exponential));
  const hinted = readRetryAfterDelay(options.error, {
    retryAfterMsPath: options.retryAfterMsPath ?? "retryAfterMs",
    retryAfterAtPath: options.retryAfterAtPath ?? "retryAfterAt",
    now: options.now ?? Date.now(),
  });
  if (options.jitterPercent <= 0 || capped <= 0) return Math.max(capped, hinted);
  const spread = capped * (options.jitterPercent / 100);
  const unit = stableUnit(`${options.stateKey}:${attempt}`);
  const jittered = Math.max(0, Math.trunc(capped - spread + unit * spread * 2));
  return Math.max(jittered, hinted);
}

function readRetryAfterDelay(
  error: unknown,
  options: {
    retryAfterMsPath: string;
    retryAfterAtPath: string;
    now: number;
  },
): number {
  const retryAfterMs = readNonNegativeNumber(
    readDottedPath(error, options.retryAfterMsPath),
  );
  if (retryAfterMs !== undefined) return retryAfterMs;

  const retryAfterAt = readTimestamp(readDottedPath(error, options.retryAfterAtPath));
  return retryAfterAt === null ? 0 : Math.max(0, retryAfterAt - options.now);
}

function readDottedPath(value: unknown, path: string): unknown {
  const segments = path
    .trim()
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? readPath(value, segments) : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}

function stableUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function readRetryable(error: unknown, retryableCodes: unknown): boolean | undefined {
  const codeAllowed = matchesRetryableCodes(error, retryableCodes);
  if (codeAllowed !== undefined && !codeAllowed) return false;
  const retryable = readPath(error, ["retryable"]);
  if (codeAllowed === true && retryable === undefined) return true;
  return typeof retryable === "boolean" ? retryable : undefined;
}

function readIdempotent(inputValue: unknown, error: unknown): boolean | undefined {
  if (typeof inputValue === "boolean") return inputValue;
  const direct = readPath(error, ["idempotent"]);
  if (typeof direct === "boolean") return direct;
  const context = readPath(error, ["context", "idempotent"]);
  return typeof context === "boolean" ? context : undefined;
}

function matchesRetryableCodes(error: unknown, retryableCodes: unknown): boolean | undefined {
  const patterns = parseCodePatterns(retryableCodes);
  if (patterns.length === 0) return undefined;
  const code = readPath(error, ["code"]);
  if (typeof code !== "string" || code.trim() === "") return false;
  return patterns.some((pattern) => matchesCodePattern(code, pattern));
}

function parseCodePatterns(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesCodePattern(code: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return code === pattern;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(code);
}

function readRetryState(
  value: unknown,
  locator: { retryFlowId: string; retryRunId: string; retryNodeId: string },
): PersistedRetryState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const lastError = toJsonValue(record.lastError);
  return {
    status: readStatus(record.status),
    retryFlowId: readString(record.retryFlowId) ?? locator.retryFlowId,
    retryRunId: readString(record.retryRunId) ?? locator.retryRunId,
    retryNodeId: readString(record.retryNodeId) ?? locator.retryNodeId,
    attempt: readPositiveInteger(record.attempt, 0),
    maxAttempts: readPositiveInteger(record.maxAttempts, 1),
    retryable: typeof record.retryable === "boolean" ? record.retryable : null,
    idempotent: typeof record.idempotent === "boolean" ? record.idempotent : null,
    requiresIdempotency: record.requiresIdempotency === true,
    blockedByIdempotency: record.blockedByIdempotency === true,
    lastError: lastError ?? null,
    nextRetryAt: readTimestamp(record.nextRetryAt),
    exhaustedAt: readTimestamp(record.exhaustedAt),
    updatedAt: readTimestamp(record.updatedAt) ?? Date.now(),
  };
}

function readStatus(value: unknown): RetryStatus {
  return value === "retry" || value === "waiting" || value === "exhausted" || value === "unsafe"
    ? value
    : "waiting";
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readMode(value: unknown): RetryStateMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "record_failure" ||
    normalized === "record_success" ||
    normalized === "check" ||
    normalized === "reset"
    ? normalized
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number;
function readPositiveInteger(value: unknown, fallback?: undefined): number | undefined;
function readPositiveInteger(value: unknown, fallback?: number): number | undefined {
  const parsed = Math.trunc(Number(value ?? fallback));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number;
function readNonNegativeInteger(value: unknown, fallback?: undefined): number | undefined;
function readNonNegativeInteger(value: unknown, fallback?: number): number | undefined {
  const parsed = Math.trunc(Number(value ?? fallback));
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function readNumberAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : undefined;
}

function clampPercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(100, Math.max(0, number));
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (
      cursor &&
      typeof cursor === "object" &&
      segment in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
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

function toVariableValue(state: PersistedRetryState): VariableValue {
  return {
    status: state.status,
    retryFlowId: state.retryFlowId,
    retryRunId: state.retryRunId,
    retryNodeId: state.retryNodeId,
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    retryable: state.retryable,
    idempotent: state.idempotent,
    requiresIdempotency: state.requiresIdempotency,
    blockedByIdempotency: state.blockedByIdempotency,
    lastError: state.lastError,
    nextRetryAt: state.nextRetryAt,
    exhaustedAt: state.exhaustedAt,
    updatedAt: state.updatedAt,
  };
}

function metadata(flowId: string): VariableMetadata {
  return {
    source: "runtime",
    scope: { flowId },
    description: "Persisted retry state",
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
