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
import { readSchema, validateValue, type SchemaIssue } from "./schemaGuard.js";

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
    inputSchema: z
      .unknown()
      .optional()
      .describe("Optional JSON Schema subset contract for child input."),
    outputSchema: z
      .unknown()
      .optional()
      .describe("Optional JSON Schema subset contract for successful child output."),
    contractMode: z
      .enum(["fail", "route"])
      .default("fail")
      .describe("Whether contract violations fail this node or route to contract_failed."),
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
    inputSchema: {
      label: "Input Schema",
      control: "textarea",
      order: 5,
      placeholder: '{ "type": "object", "required": ["id"] }',
    },
    outputSchema: {
      label: "Output Schema",
      control: "textarea",
      order: 6,
      placeholder: '{ "type": "object", "required": ["ok"] }',
    },
    contractMode: {
      label: "Contract Mode",
      control: "select",
      order: 7,
      enumOptions: [
        { label: "Fail Node", value: "fail" },
        { label: "Route Branch", value: "route" },
      ],
    },
    failOnError: { label: "Fail On Error", control: "switch", order: 8 },
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
      id: "contract_failed",
      direction: "output",
      kind: "control",
      label: "Contract Failed",
    },
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
    { id: "contractStage", direction: "output", kind: "data", label: "Contract Stage" },
    { id: "contractIssues", direction: "output", kind: "data", label: "Contract Issues" },
    { id: "contractIssueCount", direction: "output", kind: "data", label: "Contract Issue Count", schema: { type: "number" } },
    { id: "firstContractIssue", direction: "output", kind: "data", label: "First Contract Issue" },
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

    const payload = childInput(input, config);
    const inputContract = validateContract(config.inputSchema, payload, "input");
    if (inputContract instanceof Error) {
      return error(
        "node.subflow.invalid_input_schema",
        inputContract.message,
        ctx.nodeId,
      );
    }
    if (inputContract.issues.length > 0) {
      return contractFailure({
        config,
        ctxNodeId: ctx.nodeId,
        stage: "input",
        issues: inputContract.issues,
        output: null,
        runRecord: null,
      });
    }

    let result: SubflowInvokeResult;
    try {
      result = await invokeFlow({
        flowId,
        ...(flowVersion === "" ? {} : { flowVersion }),
        input: payload,
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

      const outputContract = validateContract(config.outputSchema, result.output ?? null, "output");
      if (outputContract instanceof Error) {
        return error(
          "node.subflow.invalid_output_schema",
          outputContract.message,
          ctx.nodeId,
        );
      }
      if (outputContract.issues.length > 0) {
        return contractFailure({
          config,
          ctxNodeId: ctx.nodeId,
          stage: "output",
          issues: outputContract.issues,
          output: result.output ?? null,
          runRecord: result.runRecord,
        });
      }

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

function validateContract(
  schemaConfig: unknown,
  value: unknown,
  stage: "input" | "output",
): { issues: SchemaIssue[] } | Error {
  if (schemaConfig === undefined || schemaConfig === null || schemaConfig === "") {
    return { issues: [] };
  }
  const schema = readSchema(schemaConfig);
  if (schema instanceof Error) {
    return new Error(`subflow ${stage} schema is invalid: ${schema.message}`);
  }
  return { issues: validateValue(value, schema, "$") };
}

function contractFailure(args: {
  config: { contractMode?: string };
  ctxNodeId: string;
  stage: "input" | "output";
  issues: SchemaIssue[];
  output: unknown;
  runRecord: SubflowInvokeResult["runRecord"] | null;
}): {
  kind: "success";
  outputs: Record<string, unknown>;
} | {
  kind: "error";
  error: { code: string; message: string; [key: string]: unknown };
} {
  const firstIssue = args.issues[0]?.message ?? "";
  if (args.config.contractMode === "route") {
    return {
      kind: "success",
      outputs: {
        contract_failed: null,
        output: args.output,
        runId: args.runRecord?.runId ?? null,
        status: "contract_failed",
        runRecord: args.runRecord,
        contractStage: args.stage,
        contractIssues: args.issues,
        contractIssueCount: args.issues.length,
        firstContractIssue: firstIssue,
      },
    };
  }
  return error(
    `node.subflow.${args.stage}_contract_failed`,
    `subflow ${args.stage} contract failed: ${firstIssue}`,
    args.ctxNodeId,
    {
      contractStage: args.stage,
      contractIssues: args.issues,
      contractIssueCount: args.issues.length,
    },
  );
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
