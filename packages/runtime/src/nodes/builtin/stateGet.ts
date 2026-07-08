/**
 * `state_get` - read a runtime state value.
 *
 * Complements `state_set` by making state reads visible in the data-flow
 * graph. Missing values are not errors: the node emits `found=false` and
 * a configured default (or null) so authors can branch explicitly.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const stateGetConfig = z
  .object({
    name: z.string().default("").describe("State variable name to read."),
    defaultValue: z
      .unknown()
      .optional()
      .describe("Value emitted when the state variable is missing."),
  })
  .passthrough();

export const stateGetNode = defineNode({
  type: "state_get",
  typeVersion: "1.0.0",
  title: "Get State",
  description: "Reads a value from the runtime variable store.",
  config: stateGetConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "FLOW_STATE_KEY",
    },
    defaultValue: {
      label: "Default Value",
      control: "textarea",
      order: 2,
      placeholder: "Fallback when the state variable is missing.",
    },
  },
  ports: [
    {
      id: "name",
      direction: "input",
      kind: "data",
      label: "Name",
      schema: { type: "string" },
    },
    {
      id: "defaultValue",
      direction: "input",
      kind: "data",
      label: "Default value",
    },
    {
      id: "value",
      direction: "output",
      kind: "data",
      label: "Value",
    },
    {
      id: "found",
      direction: "output",
      kind: "data",
      label: "Found",
      schema: { type: "boolean" },
    },
    {
      id: "name",
      direction: "output",
      kind: "data",
      label: "Name",
      schema: { type: "string" },
    },
    {
      id: "defaultValue",
      direction: "output",
      kind: "data",
      label: "Default value",
    },
    {
      id: "metadata",
      direction: "output",
      kind: "data",
      label: "Metadata",
      schema: { type: "object" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    const entry = name === "" ? undefined : describeVariable(ctx.variables, name);
    const fallbackValue = name === "" ? undefined : ctx.variables.get(name);
    const found = entry !== undefined || fallbackValue !== undefined;
    const hasInputDefault = Object.prototype.hasOwnProperty.call(input, "defaultValue");
    const hasConfigDefault = Object.prototype.hasOwnProperty.call(config, "defaultValue");
    const defaultValue = hasInputDefault ? input.defaultValue : hasConfigDefault ? config.defaultValue : null;
    const value = found ? entry?.value ?? fallbackValue : defaultValue;

    ctx.log.debug("state_get read variable", { name, found });

    return {
      kind: "success",
      outputs: {
        out: null,
        name,
        value,
        found,
        defaultValue,
        metadata: entry?.metadata ?? null,
      },
    };
  },
});

function describeVariable(
  variables: unknown,
  name: string,
):
  | {
      value: unknown;
      metadata?: unknown;
    }
  | undefined {
  if (
    variables &&
    typeof variables === "object" &&
    typeof (variables as { describe?: unknown }).describe === "function"
  ) {
    return (variables as {
      describe(name: string): { value: unknown; metadata?: unknown } | undefined;
    }).describe(name);
  }
  return undefined;
}
