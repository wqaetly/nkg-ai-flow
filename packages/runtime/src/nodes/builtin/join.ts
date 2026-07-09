/**
 * `join` — explicit all-join barrier.
 *
 * The scheduler already waits for every inbound edge before executing a
 * node. This pseudo-node makes that all-join point visible on the canvas
 * and bundles inbound data values for downstream nodes.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlOut } from "./_helpers.js";

const joinConfig = z
  .object({
    expectedCount: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Expected number of branch values. When omitted, the arrived value count is treated as complete."),
  })
  .passthrough();

export const joinNode = defineNode({
  type: "join",
  typeVersion: "1.0.0",
  title: "Join",
  description: "Waits for all inbound branches, then emits collected values.",
  kind: "pseudo",
  config: joinConfig,
  fieldMeta: {
    expectedCount: {
      label: "Expected count",
      control: "number",
      order: 1,
    },
  },
  ports: [
    {
      id: "in",
      direction: "input",
      kind: "control",
      label: "Inputs",
      multiple: true,
    },
    {
      id: "values",
      direction: "input",
      kind: "data",
      label: "Values",
      multiple: true,
    },
    {
      id: "expectedCount",
      direction: "input",
      kind: "data",
      label: "Expected Count",
      schema: { type: "number" },
    },
    controlOut,
    {
      id: "values",
      direction: "output",
      kind: "data",
      label: "Values",
    },
    {
      id: "indexedValues",
      direction: "output",
      kind: "data",
      label: "Indexed Values",
    },
    {
      id: "presentIndexes",
      direction: "output",
      kind: "data",
      label: "Present Indexes",
      schema: { type: "array", items: { type: "number" } },
    },
    {
      id: "absentIndexes",
      direction: "output",
      kind: "data",
      label: "Absent Indexes",
      schema: { type: "array", items: { type: "number" } },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
    {
      id: "presentCount",
      direction: "output",
      kind: "data",
      label: "Present Count",
      schema: { type: "number" },
    },
    {
      id: "expectedCount",
      direction: "output",
      kind: "data",
      label: "Expected Count",
      schema: { type: "number" },
    },
    {
      id: "missingCount",
      direction: "output",
      kind: "data",
      label: "Missing Count",
      schema: { type: "number" },
    },
    {
      id: "missingIndexes",
      direction: "output",
      kind: "data",
      label: "Missing Indexes",
      schema: { type: "array", items: { type: "number" } },
    },
    {
      id: "complete",
      direction: "output",
      kind: "data",
      label: "Complete",
      schema: { type: "boolean" },
    },
    {
      id: "empty",
      direction: "output",
      kind: "data",
      label: "Empty",
      schema: { type: "boolean" },
    },
    {
      id: "firstValue",
      direction: "output",
      kind: "data",
      label: "First Value",
    },
    {
      id: "lastValue",
      direction: "output",
      kind: "data",
      label: "Last Value",
    },
    {
      id: "status",
      direction: "output",
      kind: "data",
      label: "Status",
      schema: { type: "string" },
    },
  ],
  validateInput: false,
  run({ input, config }) {
    const values =
      input.values === undefined
        ? []
        : Array.isArray(input.values)
          ? input.values
          : [input.values];
    const count = values.length;
    const expectedCount = readExpectedCount(input.expectedCount ?? config.expectedCount, count);
    const missingCount = Math.max(0, expectedCount - count);
    const complete = missingCount === 0;
    const empty = count === 0;
    const indexedValues = values.map((value, index) => ({
      index,
      value,
      present: value !== null && value !== undefined,
    }));
    const presentIndexes = indexedValues
      .filter((entry) => entry.present)
      .map((entry) => entry.index);
    const absentIndexes = indexedValues
      .filter((entry) => !entry.present)
      .map((entry) => entry.index);
    const missingIndexes = Array.from(
      { length: missingCount },
      (_, index) => count + index,
    );
    return {
      kind: "success",
      outputs: {
        out: null,
        values,
        indexedValues,
        presentIndexes,
        absentIndexes,
        count,
        presentCount: presentIndexes.length,
        expectedCount,
        missingCount,
        missingIndexes,
        complete,
        empty,
        firstValue: values[0] ?? null,
        lastValue: values[count - 1] ?? null,
        status: empty && expectedCount === 0 ? "empty" : complete ? "joined" : "partial",
      },
    };
  },
});

function readExpectedCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}
