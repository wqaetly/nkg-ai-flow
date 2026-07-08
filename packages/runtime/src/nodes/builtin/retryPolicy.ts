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
  },
  ports: [
    { id: "error", direction: "input", kind: "data", label: "Error" },
    {
      id: "attempt",
      direction: "input",
      kind: "data",
      label: "Attempt",
      schema: { type: "number" },
    },
    { id: "retry", direction: "output", kind: "control", label: "Retry" },
    {
      id: "exhausted",
      direction: "output",
      kind: "control",
      label: "Exhausted",
    },
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
      id: "retryable",
      direction: "output",
      kind: "data",
      label: "Retryable",
      schema: { type: "boolean" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const attempt = readAttempt(input);
    const maxAttempts = Math.max(1, Math.trunc(Number(config.maxAttempts ?? 3)));
    const retryable = readRetryable(input.error, config.retryableCodes);
    const canRetry =
      attempt < maxAttempts && (config.retryableOnly === false || retryable === true);
    const nextAttempt = canRetry ? attempt + 1 : attempt;
    const delayMs = canRetry ? calculateDelay(config, input.error, attempt) : 0;
    const branch = canRetry ? "retry" : "exhausted";

    ctx.log.debug("retry_policy selected branch", {
      attempt,
      maxAttempts,
      retryable,
      branch,
      delayMs,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        error: input.error ?? null,
        attempt,
        nextAttempt,
        delayMs,
        retryable,
      },
    };
  },
});

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

function readRetryable(error: unknown, retryableCodes: unknown): boolean | undefined {
  const codeAllowed = matchesRetryableCodes(error, retryableCodes);
  if (codeAllowed !== undefined && !codeAllowed) return false;
  const retryable = readPath(error, ["retryable"]);
  if (codeAllowed === true && retryable === undefined) return true;
  return typeof retryable === "boolean" ? retryable : undefined;
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

function calculateDelay(
  config: {
    baseDelayMs?: unknown;
    multiplier?: unknown;
    maxDelayMs?: unknown;
    jitterPercent?: unknown;
    retryAfterMsPath?: unknown;
    retryAfterAtPath?: unknown;
  },
  error: unknown,
  attempt: number,
): number {
  const baseDelayMs = Math.max(0, Math.trunc(Number(config.baseDelayMs ?? 1000)));
  const multiplier = Math.max(1, Number(config.multiplier ?? 2));
  const maxDelayMs = Math.max(0, Math.trunc(Number(config.maxDelayMs ?? 30000)));
  const jitterPercent = Math.min(100, Math.max(0, Number(config.jitterPercent ?? 0)));
  const exponential = baseDelayMs * multiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(maxDelayMs, Math.trunc(exponential));
  const hinted = readRetryAfterDelay(error, {
    retryAfterMsPath: String(config.retryAfterMsPath ?? "retryAfterMs"),
    retryAfterAtPath: String(config.retryAfterAtPath ?? "retryAfterAt"),
    now: Date.now(),
  });
  if (jitterPercent <= 0 || capped <= 0) return Math.max(capped, hinted);
  const spread = capped * (jitterPercent / 100);
  const code = readPath(error, ["code"]);
  const unit = stableUnit(`${typeof code === "string" ? code : ""}:${attempt}`);
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
