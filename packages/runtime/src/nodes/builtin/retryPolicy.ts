/**
 * `retry_policy` - route an error to retry or exhausted branches.
 *
 * The runtime keeps graph scheduling explicit, so this node does not
 * secretly re-run an upstream node. Instead it turns an error plus an
 * attempt counter into authorable control decisions that can be combined
 * with `delay`, `loop_*`, `state_*`, or a fallback branch.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const retryPolicyConfig = z
  .object({
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
      .describe("When true, route non-idempotent or unknown operations to unsafe instead of retrying."),
  })
  .passthrough();

export const retryPolicyNode = defineNode({
  type: "retry_policy",
  typeVersion: "1.0.0",
  title: "Retry Policy",
  description: "Routes failures to retry or exhausted branches.",
  kind: "pseudo",
  config: retryPolicyConfig,
  fieldMeta: {
    maxAttempts: { label: "Max Attempts", control: "number", order: 1 },
    baseDelayMs: { label: "Base Delay (ms)", control: "number", order: 2 },
    multiplier: { label: "Multiplier", control: "number", order: 3 },
    maxDelayMs: { label: "Max Delay (ms)", control: "number", order: 4 },
    jitterPercent: { label: "Jitter Percent", control: "number", order: 5 },
    retryableOnly: { label: "Retryable Only", control: "switch", order: 6 },
    retryableCodes: { label: "Retryable Codes", control: "input", order: 7 },
    retryAfterMsPath: {
      label: "Retry After Ms Path",
      control: "input",
      order: 8,
      placeholder: "retryAfterMs",
    },
    retryAfterAtPath: {
      label: "Retry After At Path",
      control: "input",
      order: 9,
      placeholder: "retryAfterAt",
    },
    requireIdempotency: { label: "Require Idempotency", control: "switch", order: 10 },
  },
  ports: [
    { id: "error", direction: "input", kind: "data", label: "Error" },
    {
      id: "idempotent",
      direction: "input",
      kind: "data",
      label: "Idempotent",
      schema: { type: "boolean" },
    },
    {
      id: "attempt",
      direction: "input",
      kind: "data",
      label: "Attempt",
      schema: { type: "number" },
    },
    {
      id: "maxAttempts",
      direction: "input",
      kind: "data",
      label: "Max Attempts",
      schema: { type: "number" },
    },
    {
      id: "baseDelayMs",
      direction: "input",
      kind: "data",
      label: "Base Delay ms",
      schema: { type: "number" },
    },
    {
      id: "multiplier",
      direction: "input",
      kind: "data",
      label: "Multiplier",
      schema: { type: "number" },
    },
    {
      id: "maxDelayMs",
      direction: "input",
      kind: "data",
      label: "Max Delay ms",
      schema: { type: "number" },
    },
    {
      id: "jitterPercent",
      direction: "input",
      kind: "data",
      label: "Jitter Percent",
      schema: { type: "number" },
    },
    {
      id: "retryableOnly",
      direction: "input",
      kind: "data",
      label: "Retryable Only",
      schema: { type: "boolean" },
    },
    { id: "retryableCodes", direction: "input", kind: "data", label: "Retryable Codes" },
    {
      id: "retryAfterMsPath",
      direction: "input",
      kind: "data",
      label: "Retry After ms Path",
      schema: { type: "string" },
    },
    {
      id: "retryAfterAtPath",
      direction: "input",
      kind: "data",
      label: "Retry After At Path",
      schema: { type: "string" },
    },
    {
      id: "requireIdempotency",
      direction: "input",
      kind: "data",
      label: "Require Idempotency",
      schema: { type: "boolean" },
    },
    { id: "retry", direction: "output", kind: "control", label: "Retry" },
    {
      id: "exhausted",
      direction: "output",
      kind: "control",
      label: "Exhausted",
    },
    { id: "unsafe", direction: "output", kind: "control", label: "Unsafe" },
    { id: "error", direction: "output", kind: "data", label: "Error" },
    {
      id: "attempt",
      direction: "output",
      kind: "data",
      label: "Attempt",
      schema: { type: "number" },
    },
    {
      id: "nextAttempt",
      direction: "output",
      kind: "data",
      label: "Next Attempt",
      schema: { type: "number" },
    },
    {
      id: "delayMs",
      direction: "output",
      kind: "data",
      label: "Delay ms",
      schema: { type: "number" },
    },
    {
      id: "backoffDelayMs",
      direction: "output",
      kind: "data",
      label: "Backoff Delay ms",
      schema: { type: "number" },
    },
    {
      id: "retryAfterDelayMs",
      direction: "output",
      kind: "data",
      label: "Retry After Delay ms",
      schema: { type: "number" },
    },
    {
      id: "delaySource",
      direction: "output",
      kind: "data",
      label: "Delay Source",
      schema: { type: "string" },
    },
    {
      id: "retryable",
      direction: "output",
      kind: "data",
      label: "Retryable",
      schema: { type: "boolean" },
    },
    {
      id: "idempotent",
      direction: "output",
      kind: "data",
      label: "Idempotent",
      schema: { type: "boolean" },
    },
    {
      id: "requiresIdempotency",
      direction: "output",
      kind: "data",
      label: "Requires Idempotency",
      schema: { type: "boolean" },
    },
    {
      id: "blockedByIdempotency",
      direction: "output",
      kind: "data",
      label: "Blocked By Idempotency",
      schema: { type: "boolean" },
    },
    {
      id: "status",
      direction: "output",
      kind: "data",
      label: "Status",
      schema: { type: "string" },
    },
    {
      id: "decisionReason",
      direction: "output",
      kind: "data",
      label: "Decision Reason",
      schema: { type: "string" },
    },
    {
      id: "maxAttempts",
      direction: "output",
      kind: "data",
      label: "Max Attempts",
      schema: { type: "number" },
    },
    {
      id: "remainingAttempts",
      direction: "output",
      kind: "data",
      label: "Remaining Attempts",
      schema: { type: "number" },
    },
    {
      id: "baseDelayMs",
      direction: "output",
      kind: "data",
      label: "Base Delay ms",
      schema: { type: "number" },
    },
    {
      id: "multiplier",
      direction: "output",
      kind: "data",
      label: "Multiplier",
      schema: { type: "number" },
    },
    {
      id: "maxDelayMs",
      direction: "output",
      kind: "data",
      label: "Max Delay ms",
      schema: { type: "number" },
    },
    {
      id: "jitterPercent",
      direction: "output",
      kind: "data",
      label: "Jitter Percent",
      schema: { type: "number" },
    },
    {
      id: "retryableOnly",
      direction: "output",
      kind: "data",
      label: "Retryable Only",
      schema: { type: "boolean" },
    },
    { id: "retryableCodes", direction: "output", kind: "data", label: "Retryable Codes" },
    {
      id: "retryAfterMsPath",
      direction: "output",
      kind: "data",
      label: "Retry After ms Path",
      schema: { type: "string" },
    },
    {
      id: "retryAfterAtPath",
      direction: "output",
      kind: "data",
      label: "Retry After At Path",
      schema: { type: "string" },
    },
    {
      id: "retryValue",
      direction: "output",
      kind: "data",
      label: "Retry",
      schema: { type: "boolean" },
    },
    {
      id: "exhaustedValue",
      direction: "output",
      kind: "data",
      label: "Exhausted",
      schema: { type: "boolean" },
    },
    {
      id: "unsafeValue",
      direction: "output",
      kind: "data",
      label: "Unsafe",
      schema: { type: "boolean" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const attempt = readAttempt(input);
    const policy = readPolicy(input, config);
    const retryable = readRetryable(input.error, policy.retryableCodes);
    const idempotent = readIdempotent(input.idempotent, input.error);
    const maxAttempts = policy.maxAttempts;
    const requiresIdempotency = policy.requireIdempotency;
    const blockedByIdempotency = requiresIdempotency && idempotent !== true;
    const canRetry =
      attempt < maxAttempts &&
      !blockedByIdempotency &&
      (!policy.retryableOnly || retryable === true);
    const nextAttempt = canRetry ? attempt + 1 : attempt;
    const delay = canRetry ? calculateDelay(policy, input.error, attempt) : emptyDelay();
    const branch = blockedByIdempotency ? "unsafe" : canRetry ? "retry" : "exhausted";
    const decisionReason = retryDecisionReason({
      attempt,
      maxAttempts,
      retryable,
      retryableOnly: policy.retryableOnly,
      blockedByIdempotency,
      branch,
    });
    const remainingAttempts = Math.max(0, maxAttempts - attempt);

    ctx.log.debug("retry_policy selected branch", {
      attempt,
      maxAttempts,
      retryable,
      idempotent,
      requiresIdempotency,
      retryableOnly: policy.retryableOnly,
      branch,
      decisionReason,
      delayMs: delay.delayMs,
      delaySource: delay.delaySource,
    });
    const summary = {
      status: branch,
      decisionReason,
      attempt,
      nextAttempt,
      maxAttempts,
      remainingAttempts,
      retryable,
      retryableOnly: policy.retryableOnly,
      idempotent,
      requiresIdempotency,
      blockedByIdempotency,
      delayMs: delay.delayMs,
      backoffDelayMs: delay.backoffDelayMs,
      retryAfterDelayMs: delay.retryAfterDelayMs,
      delaySource: delay.delaySource,
      retryValue: branch === "retry",
      exhaustedValue: branch === "exhausted",
      unsafeValue: branch === "unsafe",
    };

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        error: input.error ?? null,
        attempt,
        nextAttempt,
        delayMs: delay.delayMs,
        backoffDelayMs: delay.backoffDelayMs,
        retryAfterDelayMs: delay.retryAfterDelayMs,
        delaySource: delay.delaySource,
        retryable,
        idempotent,
        requiresIdempotency,
        blockedByIdempotency,
        status: branch,
        decisionReason,
        maxAttempts,
        remainingAttempts,
        baseDelayMs: policy.baseDelayMs,
        multiplier: policy.multiplier,
        maxDelayMs: policy.maxDelayMs,
        jitterPercent: policy.jitterPercent,
        retryableOnly: policy.retryableOnly,
        retryableCodes: policy.retryableCodes,
        retryAfterMsPath: policy.retryAfterMsPath,
        retryAfterAtPath: policy.retryAfterAtPath,
        retryValue: branch === "retry",
        exhaustedValue: branch === "exhausted",
        unsafeValue: branch === "unsafe",
        summary,
      },
    };
  },
});

function retryDecisionReason(input: {
  attempt: number;
  maxAttempts: number;
  retryable: boolean | undefined;
  retryableOnly: boolean;
  blockedByIdempotency: boolean;
  branch: "retry" | "exhausted" | "unsafe";
}): string {
  if (input.blockedByIdempotency) return "blocked_by_idempotency";
  if (input.branch === "retry") return "retry_allowed";
  if (input.attempt >= input.maxAttempts) return "attempts_exhausted";
  if (input.retryableOnly && input.retryable === false) return "not_retryable";
  if (input.retryableOnly && input.retryable !== true) return "retryability_unknown";
  return "retry_exhausted";
}

function readAttempt(input: Record<string, unknown>): number {
  const explicit = Number(input.attempt);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const sourceAttempt = Number(readPath(input.error, ["source", "attempt"]));
  if (Number.isFinite(sourceAttempt) && sourceAttempt > 0) {
    return Math.trunc(sourceAttempt);
  }
  const contextAttempt = Number(readPath(input.error, ["context", "attempt"]));
  if (Number.isFinite(contextAttempt) && contextAttempt > 0) {
    return Math.trunc(contextAttempt);
  }
  return 1;
}

function readPolicy(
  input: Record<string, unknown>,
  config: {
    maxAttempts?: unknown;
    baseDelayMs?: unknown;
    multiplier?: unknown;
    maxDelayMs?: unknown;
    jitterPercent?: unknown;
    retryableOnly?: unknown;
    retryableCodes?: unknown;
    retryAfterMsPath?: unknown;
    retryAfterAtPath?: unknown;
    requireIdempotency?: unknown;
  },
): {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitterPercent: number;
  retryableOnly: boolean;
  retryableCodes: string;
  retryAfterMsPath: string;
  retryAfterAtPath: string;
  requireIdempotency: boolean;
} {
  return {
    maxAttempts:
      readIntegerAtLeast(input.maxAttempts, 1) ??
      readIntegerAtLeast(config.maxAttempts, 1) ??
      3,
    baseDelayMs:
      readIntegerAtLeast(input.baseDelayMs, 0) ??
      readIntegerAtLeast(config.baseDelayMs, 0) ??
      1000,
    multiplier:
      readNumberAtLeast(input.multiplier, 1) ??
      readNumberAtLeast(config.multiplier, 1) ??
      2,
    maxDelayMs:
      readIntegerAtLeast(input.maxDelayMs, 0) ??
      readIntegerAtLeast(config.maxDelayMs, 0) ??
      30000,
    jitterPercent:
      readNumberBetween(input.jitterPercent, 0, 100) ??
      readNumberBetween(config.jitterPercent, 0, 100) ??
      0,
    retryableOnly:
      readBoolean(input.retryableOnly) ??
      readBoolean(config.retryableOnly) ??
      true,
    retryableCodes: String(input.retryableCodes ?? config.retryableCodes ?? ""),
    retryAfterMsPath: String(input.retryAfterMsPath ?? config.retryAfterMsPath ?? "retryAfterMs"),
    retryAfterAtPath: String(input.retryAfterAtPath ?? config.retryAfterAtPath ?? "retryAfterAt"),
    requireIdempotency:
      readBoolean(input.requireIdempotency) ??
      readBoolean(config.requireIdempotency) ??
      false,
  };
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

interface DelayDetails {
  delayMs: number;
  backoffDelayMs: number;
  retryAfterDelayMs: number;
  delaySource: "backoff" | "retry_after" | "none";
}

function emptyDelay(): DelayDetails {
  return {
    delayMs: 0,
    backoffDelayMs: 0,
    retryAfterDelayMs: 0,
    delaySource: "none",
  };
}

function calculateDelay(
  config: {
    baseDelayMs: number;
    multiplier: number;
    maxDelayMs: number;
    jitterPercent: number;
    retryAfterMsPath: string;
    retryAfterAtPath: string;
  },
  error: unknown,
  attempt: number,
): DelayDetails {
  const baseDelayMs = config.baseDelayMs;
  const multiplier = config.multiplier;
  const maxDelayMs = config.maxDelayMs;
  const jitterPercent = config.jitterPercent;
  const exponential = baseDelayMs * multiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(maxDelayMs, Math.trunc(exponential));
  const hinted = readRetryAfterDelay(error, {
    retryAfterMsPath: config.retryAfterMsPath,
    retryAfterAtPath: config.retryAfterAtPath,
    now: Date.now(),
  });
  if (jitterPercent <= 0 || capped <= 0) {
    return delayDetails(capped, hinted);
  }
  const spread = capped * (jitterPercent / 100);
  const code = readPath(error, ["code"]);
  const unit = stableUnit(`${typeof code === "string" ? code : ""}:${attempt}`);
  const jittered = Math.max(0, Math.trunc(capped - spread + unit * spread * 2));
  return delayDetails(jittered, hinted);
}

function delayDetails(backoffDelayMs: number, retryAfterDelayMs: number): DelayDetails {
  const delayMs = Math.max(backoffDelayMs, retryAfterDelayMs);
  return {
    delayMs,
    backoffDelayMs,
    retryAfterDelayMs,
    delaySource:
      delayMs <= 0
        ? "none"
        : retryAfterDelayMs > backoffDelayMs
          ? "retry_after"
          : "backoff",
  };
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
  return retryAfterAt === undefined ? 0 : Math.max(0, retryAfterAt - options.now);
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

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.trunc(number) : undefined;
}

function readNumberAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : undefined;
}

function readNumberBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
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

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stableUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
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
