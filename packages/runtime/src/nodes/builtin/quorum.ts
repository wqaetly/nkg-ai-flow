/**
 * `quorum` - threshold join.
 *
 * Complements `merge` (any) and `join` (all) by making "continue after N
 * arrivals" visible in the graph.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const quorumConfig = z
  .object({
    threshold: z
      .number()
      .int()
      .min(1)
      .default(2)
      .describe("Minimum number of arrived values required to route to met."),
  })
  .passthrough();

export const quorumNode = defineNode({
  type: "quorum",
  typeVersion: "1.0.0",
  title: "Quorum",
  description: "Routes when a configured threshold of inbound values has arrived.",
  kind: "pseudo",
  config: quorumConfig,
  fieldMeta: {
    threshold: {
      label: "Threshold",
      control: "number",
      order: 1,
    },
  },
  ports: [
    {
      id: "values",
      direction: "input",
      kind: "data",
      label: "Values",
      multiple: true,
    },
    {
      id: "threshold",
      direction: "input",
      kind: "data",
      label: "Threshold",
      schema: { type: "number" },
    },
    { id: "met", direction: "output", kind: "control", label: "Met" },
    { id: "unmet", direction: "output", kind: "control", label: "Unmet" },
    { id: "values", direction: "output", kind: "data", label: "Values" },
    { id: "firstValue", direction: "output", kind: "data", label: "First Value" },
    { id: "lastValue", direction: "output", kind: "data", label: "Last Value" },
    {
      id: "metValue",
      direction: "output",
      kind: "data",
      label: "Met Value",
      schema: { type: "boolean" },
    },
    { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
    {
      id: "threshold",
      direction: "output",
      kind: "data",
      label: "Threshold",
      schema: { type: "number" },
    },
    {
      id: "remaining",
      direction: "output",
      kind: "data",
      label: "Remaining",
      schema: { type: "number" },
    },
    {
      id: "quorumRate",
      direction: "output",
      kind: "data",
      label: "Quorum Rate",
      schema: { type: "number" },
    },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const values = normalizeValues(input.values);
    const threshold = readIntegerAtLeast(input.threshold, 1) ?? readIntegerAtLeast(config.threshold, 1) ?? 2;
    const met = values.length >= threshold;
    const status = met ? "met" : "unmet";
    const remaining = Math.max(0, threshold - values.length);
    const quorumRate = values.length / threshold;

    ctx.log.debug("quorum evaluated arrivals", {
      threshold,
      count: values.length,
      status,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        values,
        firstValue: values[0] ?? null,
        lastValue: values[values.length - 1] ?? null,
        metValue: met,
        count: values.length,
        threshold,
        remaining,
        quorumRate,
        status,
      },
    };
  },
});

function normalizeValues(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return undefined;
  const integerValue = Math.trunc(numericValue);
  return integerValue >= minimum ? integerValue : undefined;
}
