/**
 * `subflow_template` - invoke a reusable subflow template.
 *
 * `subflow` calls a fixed flow. This node adds a small template registry so
 * authors can route by a stable template id while pinning the underlying
 * flow id/version and default input in graph configuration.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import type { VariableValue } from "@ai-native-flow/variable-store";
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
  subflowDepth?: number;
}) => Promise<SubflowInvokeResult>;

interface TemplateDefinition {
  id: string;
  flowId: string;
  flowVersion: string;
  input: VariableValue | null;
}

const subflowTemplateConfig = z
  .object({
    templateId: z.string().default("").describe("Template id to invoke."),
    templates: z
      .unknown()
      .optional()
      .describe("JSON object mapping template ids to flowId/flowVersion/input."),
    inputMode: z
      .enum(["input", "runInput", "literal", "template"])
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
    maxDepth: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe("Maximum allowed nested subflow depth."),
    failOnError: z
      .boolean()
      .default(true)
      .describe("Fail this node when the child flow fails or is cancelled."),
  })
  .passthrough();

export const subflowTemplateNode = defineNode({
  type: "subflow_template",
  typeVersion: "1.0.0",
  title: "Subflow Template",
  description: "Invokes a registered child flow through a reusable template id.",
  kind: "pseudo",
  config: subflowTemplateConfig,
  fieldMeta: {
    templateId: {
      label: "Template Id",
      control: "input",
      order: 1,
      placeholder: "order_validation",
    },
    templates: {
      label: "Templates",
      control: "textarea",
      order: 2,
      placeholder: '{ "order_validation": { "flowId": "validate_order", "flowVersion": "1.0.0" } }',
    },
    inputMode: {
      label: "Input Mode",
      control: "select",
      order: 3,
      enumOptions: [
        { label: "Input", value: "input" },
        { label: "Run Input", value: "runInput" },
        { label: "Literal", value: "literal" },
        { label: "Template Default", value: "template" },
      ],
    },
    inputValue: {
      label: "Input Value",
      control: "textarea",
      order: 4,
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
    maxDepth: {
      label: "Max Depth",
      control: "number",
      order: 8,
    },
    failOnError: {
      label: "Fail On Error",
      control: "switch",
      order: 9,
    },
  },
  ports: [
    controlIn,
    { id: "templateId", direction: "input", kind: "data", label: "Template Id", schema: { type: "string" } },
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "succeeded", direction: "output", kind: "control", label: "Succeeded" },
    { id: "failed", direction: "output", kind: "control", label: "Failed" },
    {
      id: "contract_failed",
      direction: "output",
      kind: "control",
      label: "Contract Failed",
    },
    { id: "cancelled", direction: "output", kind: "control", label: "Cancelled" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "output", direction: "output", kind: "data", label: "Output" },
    { id: "runId", direction: "output", kind: "data", label: "Run Id" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "runRecord", direction: "output", kind: "data", label: "Run Record" },
    { id: "templateId", direction: "output", kind: "data", label: "Template Id", schema: { type: "string" } },
    { id: "flowId", direction: "output", kind: "data", label: "Flow Id", schema: { type: "string" } },
    { id: "flowVersion", direction: "output", kind: "data", label: "Flow Version", schema: { type: "string" } },
    { id: "contractStage", direction: "output", kind: "data", label: "Contract Stage" },
    { id: "contractIssues", direction: "output", kind: "data", label: "Contract Issues" },
    { id: "contractIssueCount", direction: "output", kind: "data", label: "Contract Issue Count", schema: { type: "number" } },
    { id: "firstContractIssue", direction: "output", kind: "data", label: "First Contract Issue" },
    errorOut,
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const templateId = String(input.templateId ?? config.templateId ?? "").trim();
    if (templateId === "") {
      return error(
        "node.subflow_template.missing_template_id",
        "subflow_template node requires config.templateId or templateId input",
        ctx.nodeId,
      );
    }

    const templates = readTemplates(config.templates);
    if (templates instanceof Error) {
      return error(
        "node.subflow_template.invalid_templates",
        templates.message,
        ctx.nodeId,
      );
    }
    const template = templates.get(templateId);
    if (!template) {
      return {
        kind: "success",
        outputs: {
          missing: null,
          output: null,
          runId: null,
          status: "missing",
          runRecord: null,
          templateId,
          flowId: "",
          flowVersion: "",
        },
      };
    }

    const invokeFlow = (ctx as { invokeFlow?: SubflowInvokeFlow }).invokeFlow;
    if (!invokeFlow) {
      return error(
        "node.subflow_template.invoke_unavailable",
        "runtime flow invocation is not configured",
        ctx.nodeId,
      );
    }

    const subflowDepth = Math.max(
      0,
      Math.trunc(Number((ctx as { subflowDepth?: number }).subflowDepth ?? 0)),
    );
    const maxDepth = Math.max(0, Math.trunc(Number(config.maxDepth ?? 10)));
    if (subflowDepth >= maxDepth) {
      return error(
        "node.subflow_template.max_depth_exceeded",
        `subflow template depth ${subflowDepth} reached maxDepth ${maxDepth}`,
        ctx.nodeId,
      );
    }

    const payload = childInput(input, config, template);
    const inputContract = validateContract(config.inputSchema, payload, "input");
    if (inputContract instanceof Error) {
      return error(
        "node.subflow_template.invalid_input_schema",
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
        templateId,
        flowId: template.flowId,
        flowVersion: template.flowVersion,
      });
    }

    let result: SubflowInvokeResult;
    try {
      result = await invokeFlow({
        flowId: template.flowId,
        ...(template.flowVersion === "" ? {} : { flowVersion: template.flowVersion }),
        input: payload,
        traceId: `${ctx.runId}:${ctx.nodeId}:${templateId}`,
        subflowDepth: subflowDepth + 1,
      });
    } catch (cause) {
      return error(
        "node.subflow_template.invoke_failed",
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
      templateId,
      flowId: template.flowId,
      flowVersion: result.runRecord.flowVersion,
    };

    if (status === "succeeded" || config.failOnError === false) {
      if (status === "succeeded") {
        const outputContract = validateContract(config.outputSchema, result.output ?? null, "output");
        if (outputContract instanceof Error) {
          return error(
            "node.subflow_template.invalid_output_schema",
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
            templateId,
            flowId: template.flowId,
            flowVersion: result.runRecord.flowVersion,
          });
        }
      }
      return { kind: "success", outputs };
    }

    return {
      kind: "error",
      error: createRuntimeError({
        code: "node.subflow_template.child_failed",
        kind: "internal",
        category: "system",
        message: `template ${templateId} child flow ${template.flowId}@${result.runRecord.flowVersion} ${status}`,
        source: { module: "node_logic", nodeId: ctx.nodeId },
        context: {
          templateId,
          childRunId: result.runRecord.runId,
          childStatus: status,
          childError: result.error ?? null,
        },
      }) as unknown as {
        code: string;
        message: string;
        [key: string]: unknown;
      },
    };
  },
});

function readTemplates(value: unknown): Map<string, TemplateDefinition> | Error {
  const raw = typeof value === "string" ? parseJson(value) : value;
  if (raw instanceof Error) return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return new Error("subflow_template templates must be a JSON object.");
  }

  const templates = new Map<string, TemplateDefinition>();
  for (const [id, definition] of Object.entries(raw as Record<string, unknown>)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      return new Error(`subflow_template templates.${id} must be an object.`);
    }
    const record = definition as Record<string, unknown>;
    const flowId = typeof record.flowId === "string" ? record.flowId.trim() : "";
    if (flowId === "") {
      return new Error(`subflow_template templates.${id}.flowId is required.`);
    }
    const input = toJsonValue(record.input ?? null);
    if (input === undefined) {
      return new Error(`subflow_template templates.${id}.input must be JSON-compatible.`);
    }
    templates.set(id, {
      id,
      flowId,
      flowVersion: typeof record.flowVersion === "string" ? record.flowVersion.trim() : "",
      input,
    });
  }
  return templates;
}

function parseJson(value: string): unknown | Error {
  const trimmed = value.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    return new Error(
      `subflow_template templates must be valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function childInput(
  input: Record<string, unknown>,
  config: { inputMode?: string; inputValue?: unknown },
  template: TemplateDefinition,
): unknown {
  switch (config.inputMode) {
    case "runInput":
      return input.__runInput__ ?? null;
    case "literal":
      return config.inputValue ?? null;
    case "template":
      return template.input;
    default:
      return input.input ?? input.in ?? input.__runInput__ ?? template.input;
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
    return new Error(`subflow_template ${stage} schema is invalid: ${schema.message}`);
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
  templateId: string;
  flowId: string;
  flowVersion: string;
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
        templateId: args.templateId,
        flowId: args.flowId,
        flowVersion: args.runRecord?.flowVersion ?? args.flowVersion,
        contractStage: args.stage,
        contractIssues: args.issues,
        contractIssueCount: args.issues.length,
        firstContractIssue: firstIssue,
      },
    };
  }
  return error(
    `node.subflow_template.${args.stage}_contract_failed`,
    `subflow_template ${args.stage} contract failed: ${firstIssue}`,
    args.ctxNodeId,
  );
}

function toJsonValue(value: unknown): VariableValue | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(toJsonValue);
    return items.some((item) => item === undefined)
      ? undefined
      : (items as VariableValue[]);
  }
  if (value && typeof value === "object") {
    const out: Record<string, VariableValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item);
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
