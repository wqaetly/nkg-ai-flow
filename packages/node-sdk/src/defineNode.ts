/**
 * `defineNode` is the **single supported way** to declare a node logic
 * unit. It produces a `DefinedNode` containing both a
 * `NodeTypeDefinition` (data track) and a runner function (behaviour
 * track), so callers don't have to remember to register both halves.
 *
 * Authors stay in this file's contract:
 *
 *   ```ts
 *   import { defineNode } from "@ai-native-flow/node-sdk";
 *   import { z } from "zod";
 *
 *   export default defineNode({
 *     type: "extract-keywords",
 *     typeVersion: "1.0.0",
 *     title: "Extract Keywords",
 *     config: z.object({ topN: z.number().default(10) }),
 *     input:  z.object({ text: z.string() }),
 *     output: z.object({ keywords: z.array(z.string()) }),
 *     async run({ input, config }) {
 *       return {
 *         kind: "success",
 *         outputs: {
 *           out: null,
 *           keywords: input.text.split(/\s+/).filter(Boolean).slice(0, config.topN),
 *         },
 *       };
 *     },
 *   });
 *   ```
 *
 * The runner returned here is structurally compatible with the
 * Execution Engine's `NodeRunner`. It pulls `__config__` out of the
 * input bag (the Engine injects it pre-call), validates with Zod when
 * a schema is provided, and forwards the rest as the user-visible
 * `input`.
 */

import type { z } from "zod";
import type {
  NodeConfigSchema,
  NodeTypeDefinition,
  PortDefinition,
} from "@ai-native-flow/flow-ir";
import type {
  DefinedNode,
  DefineNodeSpec,
  SdkInternalRunner,
  SdkNodeContext,
  SdkNodeResult,
} from "./types.js";
import { describeZodFields, mergeFieldMeta } from "./describeZodFields.js";

/** Conventional control-in port; reused unless the spec opts out. */
const CONTROL_IN: PortDefinition = {
  id: "in",
  direction: "input",
  kind: "control",
  label: "输入",
  multiple: true,
};

/** Conventional control-out port. */
const CONTROL_OUT: PortDefinition = {
  id: "out",
  direction: "output",
  kind: "control",
  label: "输出",
};

/** Conventional error-output port. */
const ERROR_OUT: PortDefinition = {
  id: "error",
  direction: "output",
  kind: "error",
  label: "错误",
};

/**
 * Author entry-point. Returns a `DefinedNode` ready for `installNode`.
 *
 * The function is generic over input/config/output to give callers full
 * Zod-driven type inference inside `run({ input, config })`.
 */
export function defineNode<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(spec: DefineNodeSpec<TInput, TConfig, TOutput>): DefinedNode {
  const definition = buildDefinition(spec);
  const runner = buildRunner(spec);
  return { definition, runner };
}

function buildDefinition<
  TInput extends Record<string, unknown>,
  TConfig extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(
  spec: DefineNodeSpec<TInput, TConfig, TOutput>,
): NodeTypeDefinition {
  const ports: PortDefinition[] = [];
  if (spec.kind !== "pseudo") {
    ports.push(CONTROL_IN, CONTROL_OUT);
  }
  if (spec.ports) {
    ports.push(...spec.ports);
  }
  // Append a default error-output port unless the author already
  // declared one (matches the convention used by every Phase 1 builtin).
  if (
    spec.kind !== "pseudo" &&
    !ports.some((p) => p.kind === "error" && p.direction === "output")
  ) {
    ports.push(ERROR_OUT);
  }

  const definition: NodeTypeDefinition = {
    type: spec.type,
    typeVersion: spec.typeVersion,
    title: spec.title,
    defaultPorts: ports,
    runtime: spec.runtime ?? "builtin",
  };
  if (spec.description !== undefined) {
    definition.description = spec.description;
  }
  if (spec.config !== undefined) {
    // Reflect the Zod shape into a `FieldDescriptor[]` and layer the
    // author-provided `fieldMeta` UI hints on top. The result is plain
    // JSON, so Studio can read it without a Zod runtime dependency.
    const fields = mergeFieldMeta(
      describeZodFields(spec.config),
      spec.fieldMeta,
    );
    const configSchema: NodeConfigSchema = {
      "x-zod": true,
      typeName:
        ((spec.config as unknown as { _def?: { typeName?: string } })._def
          ?.typeName) ?? "ZodUnknown",
      fields,
    };
    definition.configSchema = configSchema;
  } else if (spec.fieldMeta) {
    // No Zod schema but the author still authored UI hints — surface
    // them so Studio can render orphan rows. Each entry becomes an
    // `unknown`-kind descriptor with the hint applied on top.
    const fields = mergeFieldMeta(
      Object.keys(spec.fieldMeta).map((name) => ({
        name,
        kind: "unknown" as const,
        optional: true,
        nullable: false,
      })),
      spec.fieldMeta,
    );
    const configSchema: NodeConfigSchema = { fields };
    definition.configSchema = configSchema;
  }
  return definition;
}

/**
 * Best-effort textual description of a Zod schema. Kept for backward
 * compatibility — the real field list now lives under
 * `configSchema.fields`. This helper is no longer used in the default
 * code path but is preserved for tests / external tooling that still
 * inspects the legacy shape.
 */
function describeZod(schema: z.ZodTypeAny): unknown {
  return {
    "x-zod": true,
    typeName: (schema._def as { typeName?: string }).typeName ?? "ZodUnknown",
  };
}

function buildRunner<
  TInput extends Record<string, unknown>,
  TConfig extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(
  spec: DefineNodeSpec<TInput, TConfig, TOutput>,
): SdkInternalRunner {
  const inputSchema = spec.input;
  const configSchema = spec.config;
  const validateInput = spec.validateInput ?? inputSchema !== undefined;

  return async (rawInputs, ctx) => {
    // The Execution Engine injects the resolved config under `__config__`.
    // Pull it off so the user-visible `input` matches what they declared.
    const { __config__: rawConfig, ...userInput } = rawInputs;

    // ── config parsing ─────────────────────────────────────────────
    let parsedConfig: Record<string, unknown>;
    if (configSchema) {
      const result = configSchema.safeParse(rawConfig ?? {});
      if (!result.success) {
        return zodErrorToResult(
          result.error,
          spec.type,
          ctx,
          "config",
        );
      }
      parsedConfig = result.data as Record<string, unknown>;
    } else {
      parsedConfig = (rawConfig as Record<string, unknown>) ?? {};
    }

    // ── input parsing ──────────────────────────────────────────────
    let parsedInput: Record<string, unknown> = userInput;
    if (validateInput && inputSchema) {
      const result = inputSchema.safeParse(userInput);
      if (!result.success) {
        return zodErrorToResult(result.error, spec.type, ctx, "input");
      }
      parsedInput = result.data as Record<string, unknown>;
    }

    return spec.run({
      input: parsedInput as TInput,
      config: parsedConfig as TConfig,
      ctx,
    }) as SdkNodeResult<Record<string, unknown>> | Promise<
      SdkNodeResult<Record<string, unknown>>
    >;
  };
}

function zodErrorToResult(
  error: z.ZodError,
  nodeType: string,
  ctx: SdkNodeContext,
  channel: "config" | "input",
): SdkNodeResult<Record<string, unknown>> {
  return {
    kind: "error",
    error: {
      code: `node.${nodeType}.invalid_${channel}`,
      message: `${channel} validation failed for node ${nodeType}: ${error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
      kind: "validation",
      category: "author",
      context: { nodeId: ctx.nodeId, nodeType, channel },
    },
  };
}
