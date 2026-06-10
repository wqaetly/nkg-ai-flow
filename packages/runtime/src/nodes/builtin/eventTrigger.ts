/**
 * `event_trigger` — event-based flow entry point.
 *
 * This is the smallest n8n-style trigger analogue: an active flow can
 * start when the Runtime receives a matching string event. The trigger
 * emits both a control signal and the event string so downstream nodes
 * can continue exactly like they would after `start`.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlOut } from "./_helpers.js";

const eventTriggerConfig = z
  .object({
    event: z.string().default("").describe("String event that starts this flow."),
  })
  .passthrough();

export const eventTriggerNode = defineNode({
  type: "event_trigger",
  typeVersion: "1.0.0",
  title: "Event Trigger",
  description: "Starts the flow when a matching string event is published.",
  kind: "pseudo",
  config: eventTriggerConfig,
  fieldMeta: {
    event: {
      label: "Event",
      placeholder: "order.created",
      control: "input",
    },
  },
  ports: [
    controlOut,
    {
      id: "event",
      direction: "output",
      kind: "data",
      label: "Event",
      schema: { type: "string" },
    },
  ],
  validateInput: false,
  run({ input, config }) {
    const raw = input as Record<string, unknown>;
    const event =
      typeof raw.event === "string"
        ? raw.event
        : typeof raw.__runInput__ === "string"
          ? raw.__runInput__
          : config.event;
    return {
      kind: "success",
      outputs: { out: null, event },
    };
  },
});
