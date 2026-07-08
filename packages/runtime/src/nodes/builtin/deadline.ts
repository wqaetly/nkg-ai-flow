/**
 * `deadline` - explicit SLA / timeout gate.
 *
 * The node does not sleep. It checks a configured or data-driven deadline
 * and routes execution to `on_time` or `overdue`, making time-bound business
 * decisions visible in the graph.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";

const deadlineConfig = z
  .object({
    deadlineAt: z
      .string()
      .default("")
      .describe("Absolute deadline as ISO string or epoch milliseconds."),
    durationMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Relative deadline duration from startedAt; 0 disables it."),
    graceMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Additional grace period before routing to overdue."),
  })
  .passthrough();

export const deadlineNode = defineNode({
  type: "deadline",
  typeVersion: "1.0.0",
  title: "Deadline",
  description: "Routes execution based on an absolute or relative deadline.",
  kind: "pseudo",
  config: deadlineConfig,
  fieldMeta: {
    deadlineAt: {
      label: "Deadline At",
      control: "input",
      order: 1,
      placeholder: "2026-07-08T12:00:00.000Z or 1783500000000",
    },
    durationMs: { label: "Duration (ms)", control: "number", order: 2 },
    graceMs: { label: "Grace (ms)", control: "number", order: 3 },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "deadlineAt", direction: "input", kind: "data", label: "Deadline At" },
    { id: "startedAt", direction: "input", kind: "data", label: "Started At" },
    { id: "on_time", direction: "output", kind: "control", label: "On time" },
    { id: "overdue", direction: "output", kind: "control", label: "Overdue" },
    { id: "status", direction: "output", kind: "data", label: "Status" },
    {
      id: "deadlineAt",
      direction: "output",
      kind: "data",
      label: "Deadline At",
      schema: { type: "number" },
    },
    {
      id: "effectiveDeadlineAt",
      direction: "output",
      kind: "data",
      label: "Effective Deadline At",
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
    {
      id: "onTimeValue",
      direction: "output",
      kind: "data",
      label: "On Time",
      schema: { type: "boolean" },
    },
    {
      id: "overdueValue",
      direction: "output",
      kind: "data",
      label: "Overdue",
      schema: { type: "boolean" },
    },
    {
      id: "now",
      direction: "output",
      kind: "data",
      label: "Now",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const now = Date.now();
    const graceMs = Math.max(0, Math.trunc(Number(config.graceMs ?? 0)));
    const deadlineAt =
      readTimestamp(input.deadlineAt) ??
      readTimestamp(config.deadlineAt) ??
      relativeDeadline(input.startedAt, config.durationMs, now);

    if (deadlineAt === undefined) {
      return error(
        "node.deadline.missing_deadline",
        "deadline node requires deadlineAt or a positive durationMs",
        ctx.nodeId,
      );
    }

    const effectiveDeadline = deadlineAt + graceMs;
    const overdueByMs = Math.max(0, now - effectiveDeadline);
    const remainingMs = Math.max(0, effectiveDeadline - now);
    const overdue = overdueByMs > 0;
    const status = overdue ? "overdue" : "on_time";

    ctx.log.debug("deadline selected branch", {
      deadlineAt,
      graceMs,
      status,
      remainingMs,
      overdueByMs,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        status,
        deadlineAt,
        effectiveDeadlineAt: effectiveDeadline,
        graceMs,
        remainingMs,
        overdueByMs,
        onTimeValue: !overdue,
        overdueValue: overdue,
        now,
      },
    };
  },
});

function relativeDeadline(
  startedAtValue: unknown,
  durationMsValue: unknown,
  now: number,
): number | undefined {
  const durationMs = Math.trunc(Number(durationMsValue ?? 0));
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  return (readTimestamp(startedAtValue) ?? now) + durationMs;
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
