/**
 * `send_event` — publishes a simple string event.
 *
 * The first implementation intentionally keeps the event payload as the
 * event name itself. Matching active `event_trigger` flows receive that
 * string as their run input.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const sendEventConfig = z
  .object({
    event: z.string().default("").describe("String event to publish."),
  })
  .passthrough();

export const sendEventNode = defineNode({
  type: "send_event",
  typeVersion: "1.0.0",
  title: "Send Event",
  description: "Publishes a string event to trigger matching active flows.",
  config: sendEventConfig,
  fieldMeta: {
    event: {
      label: "Event",
      placeholder: "order.created",
      control: "input",
    },
  },
  ports: [
    {
      id: "event",
      direction: "input",
      kind: "data",
      label: "Event",
      schema: { type: "string" },
    },
    {
      id: "event",
      direction: "output",
      kind: "data",
      label: "Event",
      schema: { type: "string" },
    },
    {
      id: "triggeredRuns",
      direction: "output",
      kind: "data",
      label: "Triggered Runs",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const event =
      typeof raw.event === "string" && raw.event.length > 0
        ? raw.event
        : typeof config.event === "string"
          ? config.event
          : "";

    if (event.length === 0) {
      return {
        kind: "error",
        error: {
          code: "node.send_event.missing_event",
          message: "send_event: provide a non-empty event string.",
          kind: "validation",
          category: "author",
          context: { nodeId: ctx.nodeId, nodeType: ctx.nodeType },
        },
      };
    }

    const triggered = await ctx.triggerEvent(event);
    const triggeredRuns = Array.isArray(triggered) ? triggered.length : 0;
    return {
      kind: "success",
      outputs: { out: null, event, triggeredRuns },
    };
  },
});
