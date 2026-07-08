/**
 * `cron_schedule` - cron trigger gate.
 *
 * Evaluates a standard five-field cron expression (minute hour day month
 * weekday) against a timestamp and reports whether it is due now, plus
 * the next due timestamp for delay/queue based orchestration.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";

const MS_PER_MINUTE = 60 * 1000;

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const cronScheduleConfig = z
  .object({
    cron: z
      .string()
      .default("* * * * *")
      .describe("Five-field cron expression: minute hour day-of-month month day-of-week."),
    timezoneOffsetMinutes: z
      .number()
      .int()
      .default(0)
      .describe("Timezone offset from UTC in minutes used for cron matching."),
  })
  .passthrough();

export const cronScheduleNode = defineNode({
  type: "cron_schedule",
  typeVersion: "1.0.0",
  title: "Cron Schedule",
  description: "Routes when a five-field cron expression is due.",
  kind: "pseudo",
  config: cronScheduleConfig,
  fieldMeta: {
    cron: {
      label: "Cron",
      control: "input",
      order: 1,
      placeholder: "*/15 9-17 * * 1-5",
    },
    timezoneOffsetMinutes: {
      label: "Timezone Offset Minutes",
      control: "number",
      order: 2,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "now", direction: "input", kind: "data", label: "Now" },
    { id: "cron", direction: "input", kind: "data", label: "Cron", schema: { type: "string" } },
    {
      id: "timezoneOffsetMinutes",
      direction: "input",
      kind: "data",
      label: "Timezone Offset Minutes",
      schema: { type: "number" },
    },
    { id: "due", direction: "output", kind: "control", label: "Due" },
    { id: "not_due", direction: "output", kind: "control", label: "Not due" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "cron", direction: "output", kind: "data", label: "Cron", schema: { type: "string" } },
    {
      id: "timezoneOffsetMinutes",
      direction: "output",
      kind: "data",
      label: "Timezone Offset Minutes",
      schema: { type: "number" },
    },
    { id: "now", direction: "output", kind: "data", label: "Now", schema: { type: "number" } },
    { id: "nextAt", direction: "output", kind: "data", label: "Next at", schema: { type: "number" } },
    { id: "nextAtIso", direction: "output", kind: "data", label: "Next at ISO", schema: { type: "string" } },
    { id: "waitMs", direction: "output", kind: "data", label: "Wait ms", schema: { type: "number" } },
    { id: "minute", direction: "output", kind: "data", label: "Minute", schema: { type: "number" } },
    { id: "hour", direction: "output", kind: "data", label: "Hour", schema: { type: "number" } },
    {
      id: "dayOfMonth",
      direction: "output",
      kind: "data",
      label: "Day of month",
      schema: { type: "number" },
    },
    { id: "month", direction: "output", kind: "data", label: "Month", schema: { type: "number" } },
    {
      id: "dayOfWeek",
      direction: "output",
      kind: "data",
      label: "Day of week",
      schema: { type: "number" },
    },
    { id: "dueValue", direction: "output", kind: "data", label: "Due", schema: { type: "boolean" } },
    { id: "notDueValue", direction: "output", kind: "data", label: "Not Due", schema: { type: "boolean" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const cron = String(input.cron ?? config.cron ?? "* * * * *");
    const spec = parseCron(cron);
    if (!spec) {
      return error(
        "node.cron_schedule.invalid_cron",
        "cron_schedule requires a valid five-field cron expression",
        ctx.nodeId,
      );
    }

    const now = readTimestamp(input.now ?? input.input ?? input.in) ?? Date.now();
    const offsetMinutes =
      readInteger(input.timezoneOffsetMinutes) ?? readInteger(config.timezoneOffsetMinutes) ?? 0;
    const local = localParts(now, offsetMinutes);
    const due = matchesCron(local, spec);
    const nextAt = due ? now : findNextAt(now, offsetMinutes, spec);
    const waitMs = Math.max(0, nextAt - now);
    const status = due ? "due" : "not_due";

    ctx.log.debug("cron_schedule selected branch", {
      status,
      cron,
      nextAt,
      waitMs,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        status,
        cron,
        timezoneOffsetMinutes: offsetMinutes,
        now,
        nextAt,
        nextAtIso: new Date(nextAt).toISOString(),
        waitMs,
        minute: local.minute,
        hour: local.hour,
        dayOfMonth: local.dayOfMonth,
        month: local.month,
        dayOfWeek: local.dayOfWeek,
        dueValue: due,
        notDueValue: !due,
      },
    };
  },
});

function parseCron(expression: string): CronSpec | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minutes = parseField(minute ?? "", 0, 59);
  const hours = parseField(hour ?? "", 0, 23);
  const daysOfMonth = parseField(dayOfMonth ?? "", 1, 31);
  const months = parseField(month ?? "", 1, 12);
  const daysOfWeek = parseField(dayOfWeek ?? "", 0, 6);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return undefined;
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (part === "") return undefined;
    const parsed = parsePart(part, min, max);
    if (!parsed) return undefined;
    for (const value of parsed) values.add(value);
  }
  return values.size > 0 ? values : undefined;
}

function parsePart(part: string, min: number, max: number): number[] | undefined {
  const [rangePart, stepPart] = part.split("/");
  if (part.includes("/") && (stepPart === undefined || stepPart.trim() === "")) {
    return undefined;
  }
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isInteger(step) || step < 1) return undefined;
  const range = parseRange(rangePart ?? "", min, max);
  if (!range) return undefined;
  const values: number[] = [];
  for (let value = range.start; value <= range.end; value += step) {
    values.push(value);
  }
  return values;
}

function parseRange(
  part: string,
  min: number,
  max: number,
): { start: number; end: number } | undefined {
  if (part === "*") return { start: min, end: max };
  if (part.includes("-")) {
    const [startRaw, endRaw] = part.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!validFieldValue(start, min, max) || !validFieldValue(end, min, max)) {
      return undefined;
    }
    return start <= end ? { start, end } : undefined;
  }
  const value = Number(part);
  return validFieldValue(value, min, max) ? { start: value, end: value } : undefined;
}

function validFieldValue(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function matchesCron(parts: ReturnType<typeof localParts>, spec: CronSpec): boolean {
  return (
    spec.minutes.has(parts.minute) &&
    spec.hours.has(parts.hour) &&
    spec.daysOfMonth.has(parts.dayOfMonth) &&
    spec.months.has(parts.month) &&
    spec.daysOfWeek.has(parts.dayOfWeek)
  );
}

function findNextAt(now: number, offsetMinutes: number, spec: CronSpec): number {
  const start = Math.floor(now / MS_PER_MINUTE) * MS_PER_MINUTE + MS_PER_MINUTE;
  for (let offset = 0; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = start + offset * MS_PER_MINUTE;
    if (matchesCron(localParts(candidate, offsetMinutes), spec)) return candidate;
  }
  return start + 366 * 24 * 60 * MS_PER_MINUTE;
}

function localParts(timestamp: number, offsetMinutes: number) {
  const shifted = timestamp + offsetMinutes * MS_PER_MINUTE;
  const date = new Date(shifted);
  return {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    dayOfMonth: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    dayOfWeek: date.getUTCDay(),
  };
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

function readInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
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
