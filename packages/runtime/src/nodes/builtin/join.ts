/**
 * `join` — explicit all-join barrier.
 *
 * The scheduler already waits for every inbound edge before executing a
 * node. This pseudo-node makes that all-join point visible on the canvas
 * and bundles inbound data values for downstream nodes.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { controlOut } from "./_helpers.js";

export const joinNode = defineNode({
  type: "join",
  typeVersion: "1.0.0",
  title: "Join",
  description: "Waits for all inbound branches, then emits collected values.",
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
    controlOut,
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
  run({ input }) {
    const values =
      input.values === undefined
        ? []
        : Array.isArray(input.values)
          ? input.values
          : [input.values];
    const count = values.length;
    const empty = count === 0;
    return {
      kind: "success",
      outputs: {
        out: null,
        values,
        count,
        empty,
        firstValue: values[0] ?? null,
        lastValue: values[count - 1] ?? null,
        status: empty ? "empty" : "joined",
      },
    };
  },
});
