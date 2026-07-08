/**
 * `subflow` - invoke another registered Flow as a child run.
 *
 * This node turns composition into an authorable graph primitive: a parent
 * flow can call a reusable child flow, wait for its RunRecord to reach a
 * terminal status, and continue based on success / failure / cancellation.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn, errorOut } from "./_helpers.js";

interface SubflowInvokeResult {
  runRecord: {
    runId: string;
    flowVersion: string;
    status: string;
    [key: string]: unknown;
  };
  succeeded: boolean;
  cancelled: boolean;
  output?: unknown;
  error?: unknown;
}

type SubflowInvokeFlow = (args: {
  flowId: string;
  flowVersion?: string;
  input: unknown;
  traceId?: string;
  variables?: unknown;
  secrets?: unknown;
}) => Promise<SubflowInvokeResult>;

const subflowConfig = z
  .object({
    flowId: z.string().default("").describe("Target flow id."),
    flowVersion: z
      .string()
      .default("")
      .describe("Optional target flow version; empty uses the active version."),
    inputMode: z
      .enum(["input", "runInput", "literal"])
      .default("input")
      .describe("How to build the child flow input."),
    inputValue: z
      .unknown()
      .optional()
      .describe("Static child input when inputMode is literal."),
    failOnError: z
      .boolean()
      .default(true)
      .describe("Fail this node when the child flow fails or is cancelled."),
  })
  .passthrough();

export const subflowNode = defineNode({
  type: "subflow",
  typeVersion: "1.0.0",
  title: "Subflow",
  description: "Invokes another registered flow and routes by child run status.",
  kind: "pseudo",
  config: subflowConfig,
  fieldMeta: {
    flowId: {
      label: "Flow Id",
      control: "input",
      order: 1,
      placeholder: "reusable_order_validation",
    },
    flowVersion: {
      label: "Flow Version",
      control: "input",
      order: 2,
      placeholder: "1.0.0 (optional)",
    },
    inputMode: { label: "Input Mode", control: "select", order: 3 },
    inputValue: {
      label: "Input Value",
      control: "textarea",
      order: 4,
      placeholder: "Static JSON-compatible input for the child flow.",
    },
    failOnError: { label: "Fail On Error", control: "switch", order: 5 },
  },
  ports: [
    controlIn,
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "out", direction: "output", kind: "control", label: "Out" },
    {
      id: "succeeded",
      direction: "output",
      kind: "control",
      label: "Succeeded",
    },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    {
      id: "cancelled",
      direction: "output",
      kind: "control",
      label: "Cancelled",
    },
    { id: "output", direction: "output", kind: "data", label: "Output" },
    { id: "runId", direction: "output", kind: "data", label: "Run Id" },
    { id: "status", direction: "output", kind: "data", label: "Status" },
    { id: "runRecord", direction: "output", kind: "data", label: "Run Record" },
    errorOut,
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const flowId = String(config.flowId ?? "").trim();
    if (flowId === "") {
      return error(
        "node.subflow.missing_flow_id",
        "subflow node requires config.flowId",
        ctx.nodeId,
      );
    }

    const flowVersion = String(config.flowVersion ?? "").trim();
    if (
      flowId === ctx.flowId &&
      (flowVersion === "" || flowVersion === ctx.flowVersion)
    ) {
      return error(
        "node.subflow.recursive_call",
        "subflow node cannot directly invoke its own flow version",
        ctx.nodeId,
      );
    }

    const invokeFlow = (ctx as { invokeFlow?: SubflowInvokeFlow }).invokeFlow;
    if (!invokeFlow) {
      return error(
        "node.subflow.invoke_unavailable",
        "runtime flow invocation is not configured",
        ctx.nodeId,
      );
    }

    let result: SubflowInvokeResult;
    try {
      result = await invokeFlow({
        flowId,
        ...(flowVersion === "" ? {} : { flowVersion }),
        input: childInput(input, config),
        traceId: `${ctx.runId}:${ctx.nodeId}`,
        variables: ctx.variables,
        secrets: ctx.secrets,
      });
    } catch (cause) {
      return error(
        "node.subflow.invoke_failed",
        cause instanceof Error ? cause.message : String(cause),
        ctx.nodeId,
      );
    }

    const status = result.cancelled
      ? "cancelled"
      : result.succeeded
        ? "succeeded"
        : "failed";
    const outputs: Record<string, unknown> = {
      [status]: null,
      output: result.output ?? null,
      runId: result.runRecord.runId,
      status,
      runRecord: result.runRecord,
    };

    if (status === "succeeded") {
      outputs.out = null;
      ctx.log.debug("subflow completed", {
        flowId,
        flowVersion: result.runRecord.flowVersion,
        childRunId: result.runRecord.runId,
      });
      return { kind: "success", outputs };
    }

    const childError =
      result.error ??
      createRuntimeError({
        code: "node.subflow.child_cancelled",
        kind: "cancelled",
        category: "system",
        message: `child flow ${flowId}@${result.runRecord.flowVersion} was cancelled`,
        source: { module: "node_logic", nodeId: ctx.nodeId },
        context: { childRunId: result.runRecord.runId },
      });
    outputs.error = childError;

    if (config.failOnError !== false) {
      return {
        kind: "error",
        error: createRuntimeError({
          code: "node.subflow.child_failed",
          kind: "internal",
          category: "system",
          message: `child flow ${flowId}@${result.runRecord.flowVersion} ${status}`,
          source: { module: "node_logic", nodeId: ctx.nodeId },
          context: {
            childRunId: result.runRecord.runId,
            childStatus: status,
            childError,
          },
        }) as unknown as {
          code: string;
          message: string;
          [key: string]: unknown;
        },
      };
    }

    return { kind: "success", outputs };
  },
});

function childInput(
  input: Record<string, unknown>,
  config: { inputMode?: string; inputValue?: unknown },
): unknown {
  switch (config.inputMode) {
    case "runInput":
      return input.__runInput__ ?? null;
    case "literal":
      return config.inputValue ?? null;
    default:
      return input.input ?? input.in ?? input.__runInput__ ?? null;
  }
}

function error(
  code: string,
  message: string,
  nodeId: string,
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
    }) as unknown as {
      code: string;
      message: string;
      [key: string]: unknown;
    },
  };
}
