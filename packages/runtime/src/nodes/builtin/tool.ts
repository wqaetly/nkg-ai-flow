/**
 * `tool` — invoke a built-in tool, MCP tool, or external tool.
 *
 * Phase 1 placeholder: just echoes the input back. Phase 3 wires this
 * up to the MCP / built-in tool dispatch table so authors can call
 * registered tools by name with structured arguments.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

export const toolNode = defineNode({
  type: "tool",
  typeVersion: "1.0.0",
  title: "Tool",
  description: "Invoke a built-in tool, MCP tool, or external tool.",
  config: z
    .object({ tool: z.string() })
    .passthrough(),
  ports: [
    {
      id: "result",
      direction: "output",
      kind: "data",
      label: "Result",
      schema: { type: "object" },
    },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input as Record<string, unknown>;
    return {
      kind: "success",
      outputs: { out: null, result: raw.input ?? null },
    };
  },
});
