/**
 * `branch_timeout` - classify branch results by elapsed time.
 *
 * This is a branch-level timeout policy gate. It does not cancel work;
 * it evaluates completed branch metadata and makes timeout handling
 * visible in the graph.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

const branchTimeoutConfig = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Timeout threshold in milliseconds; 0 routes to unknown."),
    graceMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Additional grace period before timed_out."),
    durationMsPath: z
      .string()
      .default("durationMs")
      .describe("Path to an elapsed duration in milliseconds."),
    startedAtPath: z
      .string()
      .default("startedAt")
      .describe("Path to a branch start timestamp."),
    finishedAtPath: z
      .string()
      .default("finishedAt")
      .describe("Path to a branch finish timestamp; now is used when absent."),
  })
  .passthrough();

export const branchTimeoutNode = defineNode({
  type: "branch_timeout",
  typeVersion: "1.0.0",
  title: "Branch Timeout",
  description: "Routes branch results based on elapsed time and timeout threshold.",
  kind: "pseudo",
  config: branchTimeoutConfig,
  fieldMeta: {
    timeoutMs: { label: "Timeout (ms)", control: "number", order: 1 },
    graceMs: { label: "Grace (ms)", control: "number", order: 2 },
    durationMsPath: {
      label: "Duration Path",
      control: "input",
      order: 3,
      placeholder: "durationMs",
    },
    startedAtPath: {
      label: "Started At Path",
      control: "input",
      order: 4,
      placeholder: "startedAt",
    },
    finishedAtPath: {
      label: "Finished At Path",
      control: "input",
      order: 5,
      placeholder: "finishedAt",
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "branch", direction: "input", kind: "data", label: "Branch result" },
    {
      id: "timeoutMs",
      direction: "input",
      kind: "data",
      label: "Timeout ms",
      schema: { type: "number" },
    },
    {
      id: "graceMs",
      direction: "input",
      kind: "data",
      label: "Grace ms",
      schema: { type: "number" },
    },
    {
      id: "durationMsPath",
      direction: "input",
      kind: "data",
      label: "Duration Path",
      schema: { type: "string" },
    },
    {
      id: "startedAtPath",
      direction: "input",
      kind: "data",
      label: "Started At Path",
      schema: { type: "string" },
    },
    {
      id: "finishedAtPath",
      direction: "input",
      kind: "data",
      label: "Finished At Path",
      schema: { type: "string" },
    },
    { id: "on_time", direction: "output", kind: "control", label: "On time" },
    { id: "timed_out", direction: "output", kind: "control", label: "Timed out" },
    { id: "unknown", direction: "output", kind: "control", label: "Unknown" },
    { id: "branch", direction: "output", kind: "data", label: "Branch result" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    {
      id: "elapsedMs",
      direction: "output",
      kind: "data",
      label: "Elapsed ms",
      schema: { type: "number" },
    },
    {
      id: "timeoutMs",
      direction: "output",
      kind: "data",
      label: "Timeout ms",
      schema: { type: "number" },
    },
    {
      id: "graceMs",
      direction: "output",
      kind: "data",
      label: "Grace ms",
      schema: { type: "number" },
    },
    {
      id: "effectiveTimeoutMs",
      direction: "output",
      kind: "data",
      label: "Effective timeout ms",
      schema: { type: "number" },
    },
    {
      id: "durationMsPath",
      direction: "output",
      kind: "data",
      label: "Duration Path",
      schema: { type: "string" },
    },
    {
      id: "startedAtPath",
      direction: "output",
      kind: "data",
      label: "Started At Path",
      schema: { type: "string" },
    },
    {
      id: "finishedAtPath",
      direction: "output",
      kind: "data",
      label: "Finished At Path",
      schema: { type: "string" },
    },
    {
      id: "timedOut",
      direction: "output",
      kind: "data",
      label: "Timed out",
      schema: { type: "boolean" },
    },
    {
      id: "remainingMs",
      direction: "output",
      kind: "data",
      label: "Remaining ms",
      schema: { type: "number" },
    },
    {
      id: "overdueByMs",
      direction: "output",
      kind: "data",
      label: "Overdue by ms",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const branch = input.branch ?? input.input ?? null;
    const now = Date.now();
    const timeoutMs = readIntegerAtLeast(input.timeoutMs, 0) ?? readIntegerAtLeast(config.timeoutMs, 0) ?? 0;
    const graceMs = readIntegerAtLeast(input.graceMs, 0) ?? readIntegerAtLeast(config.graceMs, 0) ?? 0;
    const durationMsPath = String(input.durationMsPath ?? config.durationMsPath ?? "durationMs");
    const startedAtPath = String(input.startedAtPath ?? config.startedAtPath ?? "startedAt");
    const finishedAtPath = String(input.finishedAtPath ?? config.finishedAtPath ?? "finishedAt");
    const elapsedMs = readElapsedMs(branch, {
      durationMsPath,
      startedAtPath,
      finishedAtPath,
      now,
    });
    const effectiveTimeoutMs = timeoutMs + graceMs;
    const unknown = timeoutMs <= 0 || elapsedMs === undefined;
    const overdueByMs = unknown ? 0 : Math.max(0, elapsedMs - effectiveTimeoutMs);
    const remainingMs = unknown ? 0 : Math.max(0, effectiveTimeoutMs - elapsedMs);
    const status = unknown ? "unknown" : overdueByMs > 0 ? "timed_out" : "on_time";

    ctx.log.debug("branch_timeout selected branch", {
      status,
      elapsedMs: elapsedMs ?? null,
      timeoutMs,
      graceMs,
      durationMsPath,
      startedAtPath,
      finishedAtPath,
      remainingMs,
      overdueByMs,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        branch,
        status,
        elapsedMs: elapsedMs ?? null,
        timeoutMs,
        graceMs,
        effectiveTimeoutMs,
        durationMsPath,
        startedAtPath,
        finishedAtPath,
        timedOut: status === "timed_out",
        remainingMs,
        overdueByMs,
      },
    };
  },
});

function readElapsedMs(
  branch: unknown,
  options: {
    durationMsPath: string;
    startedAtPath: string;
    finishedAtPath: string;
    now: number;
  },
): number | undefined {
  const duration = readNumber(readOptionalPath(branch, options.durationMsPath));
  if (duration !== undefined) return Math.max(0, duration);

  const startedAt = readTimestamp(readOptionalPath(branch, options.startedAtPath));
  if (startedAt === undefined) return undefined;

  const finishedAt =
    readTimestamp(readOptionalPath(branch, options.finishedAtPath)) ?? options.now;
  return Math.max(0, finishedAt - startedAt);
}

function readOptionalPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  return readPath(value, trimmed);
}

function readNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.trunc(number);
  return integer >= minimum ? integer : undefined;
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
