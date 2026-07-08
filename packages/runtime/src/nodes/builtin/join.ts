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
  ],
  validateInput: false,
  run({ input }) {
    const values =
      input.values === undefined
        ? []
        : Array.isArray(input.values)
          ? input.values
          : [input.values];
    return {
      kind: "success",
      outputs: {
        out: null,
        values,
        count: values.length,
      },
    };
  },
});
