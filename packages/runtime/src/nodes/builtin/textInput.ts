/**
 * `text_input` — emits a static string typed by the author on the canvas.
 *
 * The Studio renders an inline textarea inside the node card and writes
 * back to `config.value` via the `update_node_config` graph operation.
 * The runner is intentionally trivial: it forwards `config.value` to the
 * `text` data port and fires the control-out signal so downstream nodes
 * (typically `llm.prompt`) can consume the value.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const textInputConfig = z
  .object({
    value: z.string().default("").describe("Static text emitted to the data output."),
  })
  .passthrough();

export const textInputNode = defineNode({
  type: "text_input",
  typeVersion: "1.0.0",
  title: "Text Input",
  description: "Static string entered on the canvas; emits to its data output.",
  config: textInputConfig,
  fieldMeta: {
    value: {
      label: "Input text",
      placeholder: "Type a prompt…",
      control: "textarea",
    },
  },
  ports: [
    {
      id: "text",
      direction: "output",
      kind: "data",
      label: "Text",
      schema: { type: "string" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ config }) {
    const value = typeof config.value === "string" ? config.value : "";
    const summary = {
      length: value.length,
      empty: value.length === 0,
      lineCount: value.length === 0 ? 0 : value.split(/\r?\n/).length,
    };
    return {
      kind: "success",
      outputs: { out: null, text: value, summary },
    };
  },
});
