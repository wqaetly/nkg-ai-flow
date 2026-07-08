/**
 * `race` - first-arrival join.
 *
 * Makes race semantics explicit on the graph: the execution engine only
 * waits for one inbound branch, and this runner exposes the arrived value
 * as the winner while preserving any values already present.
 */

import { defineNode } from "@ai-native-flow/node-sdk";

export const raceNode = defineNode({
  type: "race",
  typeVersion: "1.0.0",
  title: "Race",
  description: "Continues when the first inbound value arrives.",
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
      id: "values",
      direction: "input",
      kind: "data",
      label: "Values",
      multiple: true,
    },
    { id: "winner", direction: "output", kind: "control", label: "Winner" },
    { id: "empty", direction: "output", kind: "control", label: "Empty" },
    { id: "value", direction: "output", kind: "data", label: "Winner" },
    { id: "values", direction: "output", kind: "data", label: "Arrived values" },
    {
      id: "index",
      direction: "output",
      kind: "data",
      label: "Index",
      schema: { type: "number" },
    },
    {
      id: "count",
      direction: "output",
      kind: "data",
      label: "Count",
      schema: { type: "number" },
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
  run({ input, ctx }) {
    const values = normalizeValues(input.values);
    const index = values.findIndex((item) => item !== null && item !== undefined);
    const found = index >= 0;
    const status = found ? "winner" : "empty";
    const value = found ? values[index] : null;

    ctx.log.debug("race selected first arrived value", {
      status,
      index,
      count: values.length,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        value,
        values,
        index,
        count: values.length,
        status,
      },
    };
  },
});

function normalizeValues(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
