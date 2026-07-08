/**
 * `window_items` - sliding/tumbling windows over an array.
 *
 * Produces overlapping or stepped item windows for stream-like data-flow,
 * rolling checks, context construction, and fixed-width downstream batches.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

interface WindowRange {
  index: number;
  start: number;
  end: number;
  count: number;
  partial: boolean;
}

const windowItemsConfig = z
  .object({
    size: z
      .number()
      .int()
      .min(1)
      .default(2)
      .describe("Number of source items per window."),
    step: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Number of items to advance between window starts."),
    includePartial: z
      .boolean()
      .default(false)
      .describe("When true, emits final incomplete windows."),
  })
  .passthrough();

export const windowItemsNode = defineNode({
  type: "window_items",
  typeVersion: "1.0.0",
  title: "Window Items",
  description: "Builds sliding or stepped fixed-size windows from an array.",
  config: windowItemsConfig,
  fieldMeta: {
    size: {
      label: "Size",
      control: "number",
      order: 1,
    },
    step: {
      label: "Step",
      control: "number",
      order: 2,
    },
    includePartial: {
      label: "Include Partial",
      control: "switch",
      order: 3,
    },
  },
  ports: [
    {
      id: "items",
      direction: "input",
      kind: "data",
      label: "Items",
      schema: { type: "array" },
    },
    {
      id: "size",
      direction: "input",
      kind: "data",
      label: "Size",
      schema: { type: "number" },
    },
    {
      id: "step",
      direction: "input",
      kind: "data",
      label: "Step",
      schema: { type: "number" },
    },
    {
      id: "includePartial",
      direction: "input",
      kind: "data",
      label: "Include partial",
      schema: { type: "boolean" },
    },
    {
      id: "windows",
      direction: "output",
      kind: "data",
      label: "Windows",
      schema: { type: "array" },
    },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Windows",
      schema: { type: "array" },
    },
    {
      id: "size",
      direction: "output",
      kind: "data",
      label: "Size",
      schema: { type: "number" },
    },
    {
      id: "step",
      direction: "output",
      kind: "data",
      label: "Step",
      schema: { type: "number" },
    },
    {
      id: "includePartial",
      direction: "output",
      kind: "data",
      label: "Include partial",
      schema: { type: "boolean" },
    },
    {
      id: "ranges",
      direction: "output",
      kind: "data",
      label: "Ranges",
      schema: { type: "array" },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Window count",
      schema: { type: "number" },
    },
    {
      id: "itemCount",
      direction: "output",
      kind: "data",
      label: "Item count",
      schema: { type: "number" },
    },
    {
      id: "hasPartial",
      direction: "output",
      kind: "data",
      label: "Has partial",
      schema: { type: "boolean" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const size = readPositiveInteger(input.size, 0) ?? readPositiveInteger(config.size, 2) ?? 2;
    const step = readPositiveInteger(input.step, 0) ?? readPositiveInteger(config.step, 1) ?? 1;
    const includePartial = readBoolean(input.includePartial) ?? readBoolean(config.includePartial) ?? false;
    const windows: unknown[][] = [];
    const ranges: WindowRange[] = [];
    let hasPartial = false;

    for (let start = 0; start < source.length; start += step) {
      const window = source.slice(start, start + size);
      const partial = window.length < size;
      hasPartial ||= partial;
      if (partial && !includePartial) continue;
      windows.push(window);
      ranges.push({
        index: ranges.length,
        start,
        end: start + window.length,
        count: window.length,
        partial,
      });
    }

    ctx.log.debug("window_items built windows", {
      size,
      step,
      includePartial,
      itemCount: source.length,
      windowCount: windows.length,
      hasPartial,
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        windows,
        items: windows,
        size,
        step,
        includePartial,
        ranges,
        count: windows.length,
        itemCount: source.length,
        hasPartial,
      },
    };
  },
});

function readPositiveInteger(value: unknown, fallback: number): number | undefined {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback > 0 ? fallback : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}
