/**
 * `state_set` - write a runtime state value.
 *
 * The runtime already resolves `$var` references immediately before each
 * node executes. Writing through this node therefore lets an upstream
 * branch persist a value that downstream node configs can read without
 * adding hidden scheduler state.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type {
  MutableVariableStore,
  VariableMetadata,
  VariableValue,
} from "@ai-native-flow/variable-store";

const stateSetConfig = z
  .object({
    name: z.string().default("").describe("State variable name to write."),
    value: z
      .unknown()
      .optional()
      .describe("Static value to write when no value input is connected."),
    description: z.string().default("").describe("Optional state description."),
  })
  .passthrough();

export const stateSetNode = defineNode({
  type: "state_set",
  typeVersion: "1.0.0",
  title: "Set State",
  description: "Writes a value into the runtime variable store.",
  config: stateSetConfig,
  fieldMeta: {
    name: {
      label: "Name",
      control: "input",
      order: 1,
      placeholder: "FLOW_STATE_KEY",
    },
    value: {
      label: "Value",
      control: "textarea",
      order: 2,
      placeholder: "Static fallback value.",
    },
    description: {
      label: "Description",
      control: "input",
      order: 3,
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
      id: "value",
      direction: "input",
      kind: "data",
      label: "Value",
    },
    {
      id: "value",
      direction: "output",
      kind: "data",
      label: "Value",
    },
    {
      id: "previous",
      direction: "output",
      kind: "data",
      label: "Previous",
    },
    {
      id: "existed",
      direction: "output",
      kind: "data",
      label: "Existed",
      schema: { type: "boolean" },
    },
    {
      id: "name",
      direction: "output",
      kind: "data",
      label: "Name",
      schema: { type: "string" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const name = String(input.name ?? config.name ?? "").trim();
    if (name === "") {
      return error(
        "node.state_set.missing_name",
        "state_set node requires config.name or name input",
        ctx.nodeId,
      );
    }

    const store = asMutableVariableStore(ctx.variables);
    if (!store) {
      return error(
        "node.state_set.readonly_store",
        "state_set requires a mutable VariableStore",
        ctx.nodeId,
      );
    }

    const raw = input.value ?? config.value ?? input.input ?? null;
    const value = toVariableValue(raw);
    if (value === undefined) {
      return error(
        "node.state_set.unsupported_value",
        "state_set value must be JSON-compatible",
        ctx.nodeId,
        { valueType: typeof raw },
      );
    }

    const previous = store.get(name);
    const existed = store.has(name);
    const metadata: VariableMetadata = {
      source: "runtime",
      scope: { flowId: ctx.flowId },
    };
    const description = String(config.description ?? "").trim();
    if (description !== "") metadata.description = description;

    store.set(name, value, metadata);
    ctx.log.debug("state_set wrote variable", { name, existed });

    return {
      kind: "success",
      outputs: {
        out: null,
        name,
        value,
        previous: previous ?? null,
        existed,
      },
    };
  },
});

function asMutableVariableStore(value: unknown): MutableVariableStore | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { set?: unknown }).set === "function"
  ) {
    return value as MutableVariableStore;
  }
  return undefined;
}

function toVariableValue(value: unknown): VariableValue | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(toVariableValue);
    return items.some((item) => item === undefined)
      ? undefined
      : (items as VariableValue[]);
  }
  if (value && typeof value === "object") {
    const out: Record<string, VariableValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toVariableValue(item);
      if (converted === undefined) return undefined;
      out[key] = converted;
    }
    return out;
  }
  return undefined;
}

function error(
  code: string,
  message: string,
  nodeId: string,
  context?: Record<string, unknown>,
): {
  kind: "error";
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
} {
  return {
    kind: "error",
    error: createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "node_logic", nodeId },
      context,
    }) as unknown as {
      code: string;
      message: string;
      [key: string]: unknown;
    },
  };
}
