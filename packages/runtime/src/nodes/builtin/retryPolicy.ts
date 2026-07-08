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
    retryableOnly: z
      .boolean()
      .default(true)
      .describe("Only retry errors whose retryable flag is true."),
    retryableCodes: z
      .string()
      .default("")
      .describe("Comma-separated exact or wildcard error codes allowed to retry."),
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
    retryableOnly: { label: "Retryable Only", control: "switch", order: 5 },
    retryableCodes: { label: "Retryable Codes", control: "input", order: 6 },
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
    const delayMs = canRetry ? calculateDelay(config, attempt) : 0;
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
  config: { baseDelayMs?: unknown; multiplier?: unknown; maxDelayMs?: unknown },
  attempt: number,
): number {
  const baseDelayMs = Math.max(0, Math.trunc(Number(config.baseDelayMs ?? 1000)));
  const multiplier = Math.max(1, Number(config.multiplier ?? 2));
  const maxDelayMs = Math.max(0, Math.trunc(Number(config.maxDelayMs ?? 30000)));
  const exponential = baseDelayMs * multiplier ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, Math.trunc(exponential));
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
