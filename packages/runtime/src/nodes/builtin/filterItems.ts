/**
 * `filter_items` — array filtering data-flow node.
 *
 * The condition is evaluated once per item with `{ item, index, input }`
 * in scope, using the same small safe expression evaluator as the
 * built-in condition node.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { evaluateCondition } from "./_helpers.js";

const filterItemsConfig = z
  .object({
    condition: z
      .string()
      .default("item")
      .describe("Condition evaluated for each item. Example: item.status == \"ready\"."),
  })
  .passthrough();

export const filterItemsNode = defineNode({
  type: "filter_items",
  typeVersion: "1.0.0",
  title: "Filter Items",
  description: "Filters an array with a per-item condition.",
  config: filterItemsConfig,
  fieldMeta: {
    condition: {
      label: "Condition",
      control: "input",
      placeholder: "item.status == \"ready\"",
      order: 1,
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
    { id: "condition", direction: "input", kind: "data", label: "Condition", schema: { type: "string" } },
    {
      id: "items",
      direction: "output",
      kind: "data",
      label: "Kept items",
      schema: { type: "array" },
    },
    {
      id: "rejected",
      direction: "output",
      kind: "data",
      label: "Rejected items",
      schema: { type: "array" },
    },
    {
      id: "keptIndexes",
      direction: "output",
      kind: "data",
      label: "Kept indexes",
      schema: { type: "array" },
    },
    {
      id: "rejectedIndexes",
      direction: "output",
      kind: "data",
      label: "Rejected indexes",
      schema: { type: "array" },
    },
    { id: "condition", direction: "output", kind: "data", label: "Condition", schema: { type: "string" } },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Kept count",
      schema: { type: "number" },
    },
    {
      id: "rejectedCount",
      direction: "output",
      kind: "data",
      label: "Rejected count",
      schema: { type: "number" },
    },
    {
      id: "total",
      direction: "output",
      kind: "data",
      label: "Total",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input, config }) {
    const source = Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.input)
        ? input.input
        : [];
    const kept: unknown[] = [];
    const rejected: unknown[] = [];
    const keptIndexes: number[] = [];
    const rejectedIndexes: number[] = [];
    const condition = String(input.condition ?? config.condition ?? "item");

    source.forEach((item, index) => {
      const scope = { item, index, input: item };
      if (evaluateCondition(condition, scope)) {
        kept.push(item);
        keptIndexes.push(index);
      } else {
        rejected.push(item);
        rejectedIndexes.push(index);
      }
    });

    return {
      kind: "success",
      outputs: {
        out: null,
        items: kept,
        rejected,
        keptIndexes,
        rejectedIndexes,
        condition,
        count: kept.length,
        rejectedCount: rejected.length,
        total: source.length,
      },
    };
  },
});
