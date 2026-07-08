/**
 * `merge` - any-join control merge.
 *
 * Unlike `join`, this node should run as soon as any inbound branch
 * arrives. The execution engine gives this node a dedicated OR-join
 * readiness rule; the runner itself only normalizes whichever values
 * have arrived into a primary `value` and a `values` list.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { controlOut } from "./_helpers.js";

export const mergeNode = defineNode({
  type: "merge",
  typeVersion: "1.0.0",
  title: "Merge",
  description: "Continues when any inbound branch arrives.",
  kind: "pseudo",
  ports: [
    {
      id: "in",
      direction: "input",
      kind: "control",
      label: "Inputs",
      multiple: true,
    },
    {
      id: "value",
      direction: "input",
      kind: "data",
      label: "Value",
      multiple: true,
    },
    controlOut,
    {
      id: "value",
      direction: "output",
      kind: "data",
      label: "Value",
    },
    {
      id: "values",
      direction: "output",
      kind: "data",
      label: "Values",
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  run({ input }) {
    const values = normalizeValues(input.value);
    const value = values.find((item) => item !== null && item !== undefined) ?? null;
    return {
      kind: "success",
      outputs: {
        out: null,
        value,
        values,
        count: values.length,
      },
    };
  },
});

function normalizeValues(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
