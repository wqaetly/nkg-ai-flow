/**
 * `schedule_window` - business time window gate.
 *
 * The node does not sleep or schedule work. It checks the current or
 * data-driven timestamp against an author-visible window and routes to
 * `open` or `closed`, so downstream flows can decide whether to proceed,
 * delay, enqueue, or skip.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

const scheduleWindowConfig = z
  .object({
    startTime: z.string().default("09:00").describe("Window start time as HH:mm."),
    endTime: z.string().default("17:00").describe("Window end time as HH:mm."),
    days: z
      .string()
      .default("1,2,3,4,5")
      .describe("Allowed days as comma-separated 0-6 values; 0 is Sunday."),
    timezoneOffsetMinutes: z
      .number()
      .int()
      .default(0)
      .describe("Timezone offset from UTC in minutes used for day/time calculation."),
  })
  .passthrough();

export const scheduleWindowNode = defineNode({
  type: "schedule_window",
  typeVersion: "1.0.0",
  title: "Schedule Window",
  description: "Routes execution based on a configured business time window.",
  kind: "pseudo",
  config: scheduleWindowConfig,
  fieldMeta: {
    startTime: {
      label: "Start Time",
      control: "input",
      order: 1,
      placeholder: "09:00",
    },
    endTime: {
      label: "End Time",
      control: "input",
      order: 2,
      placeholder: "17:00",
    },
    days: {
      label: "Days",
      control: "input",
      order: 3,
      placeholder: "1,2,3,4,5",
    },
    timezoneOffsetMinutes: {
      label: "Timezone Offset Minutes",
      control: "number",
      order: 4,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "now", direction: "input", kind: "data", label: "Now" },
    { id: "startTime", direction: "input", kind: "data", label: "Start Time", schema: { type: "string" } },
    { id: "endTime", direction: "input", kind: "data", label: "End Time", schema: { type: "string" } },
    { id: "days", direction: "input", kind: "data", label: "Days", schema: { type: "string" } },
    {
      id: "timezoneOffsetMinutes",
      direction: "input",
      kind: "data",
      label: "Timezone Offset Minutes",
      schema: { type: "number" },
    },
    { id: "open", direction: "output", kind: "control", label: "Open" },
    { id: "closed", direction: "output", kind: "control", label: "Closed" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "now", direction: "output", kind: "data", label: "Now", schema: { type: "number" } },
    { id: "startTime", direction: "output", kind: "data", label: "Start Time", schema: { type: "string" } },
    { id: "endTime", direction: "output", kind: "data", label: "End Time", schema: { type: "string" } },
    { id: "days", direction: "output", kind: "data", label: "Days", schema: { type: "string" } },
    {
      id: "timezoneOffsetMinutes",
      direction: "output",
      kind: "data",
      label: "Timezone Offset Minutes",
      schema: { type: "number" },
    },
    { id: "day", direction: "output", kind: "data", label: "Day", schema: { type: "number" } },
    {
      id: "minuteOfDay",
      direction: "output",
      kind: "data",
      label: "Minute of day",
      schema: { type: "number" },
    },
    {
      id: "nextOpenInMs",
      direction: "output",
      kind: "data",
      label: "Next open in ms",
      schema: { type: "number" },
    },
    {
      id: "nextOpenAt",
      direction: "output",
      kind: "data",
      label: "Next open at",
      schema: { type: "number" },
    },
    {
      id: "startMinute",
      direction: "output",
      kind: "data",
      label: "Start minute",
      schema: { type: "number" },
    },
    {
      id: "endMinute",
      direction: "output",
      kind: "data",
      label: "End minute",
      schema: { type: "number" },
    },
    { id: "openValue", direction: "output", kind: "data", label: "Open", schema: { type: "boolean" } },
    { id: "closedValue", direction: "output", kind: "data", label: "Closed", schema: { type: "boolean" } },
    { id: "overnightValue", direction: "output", kind: "data", label: "Overnight", schema: { type: "boolean" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const startTime = String(input.startTime ?? config.startTime ?? "09:00");
    const endTime = String(input.endTime ?? config.endTime ?? "17:00");
    const daysValue = String(input.days ?? config.days ?? "1,2,3,4,5");
    const startMinute = readTime(startTime);
    const endMinute = readTime(endTime);
    if (startMinute === undefined || endMinute === undefined) {
      return error(
        "node.schedule_window.invalid_time",
        "schedule_window requires HH:mm startTime and endTime",
        ctx.nodeId,
      );
    }

    const days = readDays(daysValue);
    if (days.size === 0) {
      return error(
        "node.schedule_window.invalid_days",
        "schedule_window requires at least one day between 0 and 6",
        ctx.nodeId,
      );
    }

    const now = readTimestamp(input.now ?? input.input ?? input.in) ?? Date.now();
    const offsetMinutes =
      readInteger(input.timezoneOffsetMinutes) ?? readInteger(config.timezoneOffsetMinutes) ?? 0;
    const local = localParts(now, offsetMinutes);
    const open = isWindowOpen(local.day, local.minuteOfDay, startMinute, endMinute, days);
    const nextOpenInMs = open
      ? 0
      : computeNextOpenInMs(local.absoluteMinute, startMinute, endMinute, days);
    const nextOpenAt = now + nextOpenInMs;
    const status = open ? "open" : "closed";

    ctx.log.debug("schedule_window selected branch", {
      status,
      day: local.day,
      minuteOfDay: local.minuteOfDay,
      nextOpenInMs,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        status,
        now,
        startTime,
        endTime,
        days: daysValue,
        timezoneOffsetMinutes: offsetMinutes,
        day: local.day,
        minuteOfDay: local.minuteOfDay,
        nextOpenInMs,
        nextOpenAt,
        startMinute,
        endMinute,
        openValue: open,
        closedValue: !open,
        overnightValue: startMinute > endMinute,
        summary: {
          status,
          now,
          startTime,
          endTime,
          days: daysValue,
          timezoneOffsetMinutes: offsetMinutes,
          day: local.day,
          minuteOfDay: local.minuteOfDay,
          nextOpenInMs,
          nextOpenAt,
          startMinute,
          endMinute,
          openValue: open,
          closedValue: !open,
          overnightValue: startMinute > endMinute,
        },
      },
    };
  },
});

function isWindowOpen(
  day: number,
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
  days: ReadonlySet<number>,
): boolean {
  if (startMinute === endMinute) return days.has(day);
  if (startMinute < endMinute) {
    return days.has(day) && minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }
  if (minuteOfDay >= startMinute) return days.has(day);
  return days.has(previousDay(day)) && minuteOfDay < endMinute;
}

function computeNextOpenInMs(
  absoluteMinute: number,
  startMinute: number,
  endMinute: number,
  days: ReadonlySet<number>,
): number {
  for (let delta = 0; delta <= 7 * MINUTES_PER_DAY; delta += 1) {
    const candidate = absoluteMinute + delta;
    const day = positiveModulo(Math.floor(candidate / MINUTES_PER_DAY) + 4, 7);
    const minuteOfDay = positiveModulo(candidate, MINUTES_PER_DAY);
    if (
      isWindowOpen(day, minuteOfDay, startMinute, endMinute, days) &&
      (delta === 0 || minuteOfDay === startMinute || startMinute === endMinute)
    ) {
      return delta * MS_PER_MINUTE;
    }
  }
  return MS_PER_DAY * 7;
}

function localParts(
  timestamp: number,
  offsetMinutes: number,
): { day: number; minuteOfDay: number; absoluteMinute: number } {
  const shifted = timestamp + offsetMinutes * MS_PER_MINUTE;
  const date = new Date(shifted);
  return {
    day: date.getUTCDay(),
    minuteOfDay: date.getUTCHours() * 60 + date.getUTCMinutes(),
    absoluteMinute: Math.floor(shifted / MS_PER_MINUTE),
  };
}

function readTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return hour * 60 + minute;
}

function readDays(value: unknown): Set<number> {
  const items = String(value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  return new Set(items);
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

function previousDay(day: number): number {
  return positiveModulo(day - 1, 7);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
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
