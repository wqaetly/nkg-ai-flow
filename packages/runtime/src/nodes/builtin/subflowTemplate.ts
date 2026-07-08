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
import {
  InMemoryVariableStore,
  type MutableVariableStore,
  type VariableEntry,
  type VariableMetadata,
  type VariableStore,
  type VariableValue,
} from "@ai-native-flow/variable-store";
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
  variables?: unknown;
  secrets?: unknown;
}) => Promise<SubflowInvokeResult>;

interface TemplateDefinition {
  id: string;
  flowId: string;
  flowVersion: string;
  input: VariableValue | null;
  localVariables: VariableEntry[];
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
    localScope: z
      .boolean()
      .default(false)
      .describe("When true, child variable writes are isolated to the child run."),
    localVariables: z
      .unknown()
      .optional()
      .describe("Optional JSON object used as child-local variable overrides."),
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
    localScope: {
      label: "Local Scope",
      control: "switch",
      order: 9,
    },
    localVariables: {
      label: "Local Variables",
      control: "textarea",
      order: 10,
      placeholder: '{ "TENANT": "acme" }',
    },
    failOnError: {
      label: "Fail On Error",
      control: "switch",
      order: 11,
    },
  },
  ports: [
    controlIn,
    { id: "templateId", direction: "input", kind: "data", label: "Template Id", schema: { type: "string" } },
    { id: "templates", direction: "input", kind: "data", label: "Templates" },
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "inputMode", direction: "input", kind: "data", label: "Input Mode", schema: { type: "string" } },
    { id: "inputValue", direction: "input", kind: "data", label: "Input Value" },
    { id: "inputSchema", direction: "input", kind: "data", label: "Input Schema" },
    { id: "outputSchema", direction: "input", kind: "data", label: "Output Schema" },
    { id: "contractMode", direction: "input", kind: "data", label: "Contract Mode", schema: { type: "string" } },
    { id: "maxDepth", direction: "input", kind: "data", label: "Max Depth", schema: { type: "number" } },
    { id: "localScope", direction: "input", kind: "data", label: "Local Scope", schema: { type: "boolean" } },
    { id: "localVariables", direction: "input", kind: "data", label: "Local Variables" },
    { id: "failOnError", direction: "input", kind: "data", label: "Fail On Error", schema: { type: "boolean" } },
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
    { id: "childStartedAt", direction: "output", kind: "data", label: "Child Started At", schema: { type: "string" } },
    { id: "childFinishedAt", direction: "output", kind: "data", label: "Child Finished At", schema: { type: "string" } },
    { id: "childDurationMs", direction: "output", kind: "data", label: "Child Duration Ms", schema: { type: "number" } },
    { id: "childTraceId", direction: "output", kind: "data", label: "Child Trace Id", schema: { type: "string" } },
    { id: "subflowDepth", direction: "output", kind: "data", label: "Subflow Depth", schema: { type: "number" } },
    { id: "childDepth", direction: "output", kind: "data", label: "Child Depth", schema: { type: "number" } },
    { id: "inputMode", direction: "output", kind: "data", label: "Input Mode", schema: { type: "string" } },
    { id: "contractMode", direction: "output", kind: "data", label: "Contract Mode", schema: { type: "string" } },
    { id: "maxDepth", direction: "output", kind: "data", label: "Max Depth", schema: { type: "number" } },
    { id: "failOnError", direction: "output", kind: "data", label: "Fail On Error", schema: { type: "boolean" } },
    { id: "localVariableCount", direction: "output", kind: "data", label: "Local Variable Count", schema: { type: "number" } },
    { id: "localScope", direction: "output", kind: "data", label: "Local Scope", schema: { type: "boolean" } },
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

    const subflowDepth = Math.max(
      0,
      Math.trunc(Number((ctx as { subflowDepth?: number }).subflowDepth ?? 0)),
    );
    const policy = readTemplatePolicy(input, config);
    const childTraceId = `${ctx.runId}:${ctx.nodeId}:${templateId}`;

    const templates = readTemplates(input.templates ?? config.templates);
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
          ...childRunTiming(null),
          childTraceId,
          subflowDepth,
          childDepth: subflowDepth,
          inputMode: policy.inputMode,
          contractMode: policy.contractMode,
          maxDepth: policy.maxDepth,
          failOnError: policy.failOnError,
          localScope: false,
          localVariableCount: 0,
        },
      };
    }

    if (
      template.flowId === ctx.flowId &&
      (template.flowVersion === "" || template.flowVersion === ctx.flowVersion)
    ) {
      return error(
        "node.subflow_template.recursive_call",
        "subflow_template node cannot directly invoke its own flow version",
        ctx.nodeId,
      );
    }

    const invokeFlow = (ctx as { invokeFlow?: SubflowInvokeFlow }).invokeFlow;
    if (!invokeFlow) {
      return error(
        "node.subflow_template.invoke_unavailable",
        "runtime flow invocation is not configured",
        ctx.nodeId,
      );
    }

    const maxDepth = policy.maxDepth;
    if (subflowDepth >= maxDepth) {
      return error(
        "node.subflow_template.max_depth_exceeded",
        `subflow template depth ${subflowDepth} reached maxDepth ${maxDepth}`,
        ctx.nodeId,
      );
    }
    const childDepth = subflowDepth + 1;

    const configLocalVariables = readLocalVariables(policy.localVariables, "subflow_template localVariables");
    if (configLocalVariables instanceof Error) {
      return error(
        "node.subflow_template.invalid_local_variables",
        configLocalVariables.message,
        ctx.nodeId,
      );
    }
    const localVariables = [...template.localVariables, ...configLocalVariables];
    const hasLocalVariables = localVariables.length > 0;
    const localScope = policy.localScope || hasLocalVariables;
    const parentVariables = (ctx as unknown as { variables: VariableStore }).variables;
    const childVariables = localScope
      ? new LocalVariableOverlay(parentVariables, localVariables)
      : parentVariables;

    const payload = childInput(input, policy, template);
    const inputContract = validateContract(policy.inputSchema, payload, "input");
    if (inputContract instanceof Error) {
      return error(
        "node.subflow_template.invalid_input_schema",
        inputContract.message,
        ctx.nodeId,
      );
    }
    if (inputContract.issues.length > 0) {
      return contractFailure({
        policy,
        ctxNodeId: ctx.nodeId,
        stage: "input",
        issues: inputContract.issues,
        output: null,
        runRecord: null,
        templateId,
        flowId: template.flowId,
        flowVersion: template.flowVersion,
        childTraceId,
        subflowDepth,
        childDepth,
        localScope,
        localVariableCount: localVariables.length,
      });
    }

    let result: SubflowInvokeResult;
    try {
      result = await invokeFlow({
        flowId: template.flowId,
        ...(template.flowVersion === "" ? {} : { flowVersion: template.flowVersion }),
        input: payload,
        traceId: childTraceId,
        subflowDepth: childDepth,
        variables: childVariables,
        secrets: childVariables,
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
      ...childRunTiming(result.runRecord),
      childTraceId,
      subflowDepth,
      childDepth,
      inputMode: policy.inputMode,
      contractMode: policy.contractMode,
      maxDepth,
      failOnError: policy.failOnError,
      localScope,
      localVariableCount: localVariables.length,
    };

    if (status === "succeeded" || !policy.failOnError) {
      if (status === "succeeded") {
        const outputContract = validateContract(policy.outputSchema, result.output ?? null, "output");
        if (outputContract instanceof Error) {
          return error(
            "node.subflow_template.invalid_output_schema",
            outputContract.message,
            ctx.nodeId,
          );
        }
        if (outputContract.issues.length > 0) {
          return contractFailure({
            policy,
            ctxNodeId: ctx.nodeId,
            stage: "output",
            issues: outputContract.issues,
            output: result.output ?? null,
            runRecord: result.runRecord,
            templateId,
            flowId: template.flowId,
            flowVersion: result.runRecord.flowVersion,
            childTraceId,
            subflowDepth,
            childDepth,
            localScope,
            localVariableCount: localVariables.length,
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
    const localVariables = readLocalVariables(
      record.localVariables,
      `subflow_template templates.${id}.localVariables`,
    );
    if (localVariables instanceof Error) return localVariables;
    templates.set(id, {
      id,
      flowId,
      flowVersion: typeof record.flowVersion === "string" ? record.flowVersion.trim() : "",
      input,
      localVariables,
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
  policy: { inputMode: "input" | "runInput" | "literal" | "template"; inputValue?: unknown },
  template: TemplateDefinition,
): unknown {
  switch (policy.inputMode) {
    case "runInput":
      return input.__runInput__ ?? null;
    case "literal":
      return input.inputValue ?? policy.inputValue ?? null;
    case "template":
      return template.input;
    default:
      return input.input ?? input.in ?? input.__runInput__ ?? template.input;
  }
}

function readTemplatePolicy(
  input: Record<string, unknown>,
  config: {
    inputMode?: unknown;
    inputValue?: unknown;
    inputSchema?: unknown;
    outputSchema?: unknown;
    contractMode?: unknown;
    maxDepth?: unknown;
    localScope?: unknown;
    localVariables?: unknown;
    failOnError?: unknown;
  },
): {
  inputMode: "input" | "runInput" | "literal" | "template";
  inputValue?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  contractMode: "fail" | "route";
  maxDepth: number;
  localScope: boolean;
  localVariables?: unknown;
  failOnError: boolean;
} {
  return {
    inputMode:
      readInputMode(input.inputMode) ??
      readInputMode(config.inputMode) ??
      "input",
    inputValue: input.inputValue ?? config.inputValue,
    inputSchema: input.inputSchema ?? config.inputSchema,
    outputSchema: input.outputSchema ?? config.outputSchema,
    contractMode:
      readContractMode(input.contractMode) ??
      readContractMode(config.contractMode) ??
      "fail",
    maxDepth:
      readIntegerAtLeast(input.maxDepth, 0) ??
      readIntegerAtLeast(config.maxDepth, 0) ??
      10,
    localScope:
      readBoolean(input.localScope) ??
      readBoolean(config.localScope) ??
      false,
    localVariables: input.localVariables ?? config.localVariables,
    failOnError:
      readBoolean(input.failOnError) ??
      readBoolean(config.failOnError) ??
      true,
  };
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
  policy: {
    inputMode: string;
    contractMode: "fail" | "route";
    maxDepth: number;
    failOnError: boolean;
  };
  ctxNodeId: string;
  stage: "input" | "output";
  issues: SchemaIssue[];
  output: unknown;
  runRecord: SubflowInvokeResult["runRecord"] | null;
  templateId: string;
  flowId: string;
  flowVersion: string;
  childTraceId: string;
  subflowDepth: number;
  childDepth: number;
  localScope: boolean;
  localVariableCount: number;
}): {
  kind: "success";
  outputs: Record<string, unknown>;
} | {
  kind: "error";
  error: { code: string; message: string; [key: string]: unknown };
} {
  const firstIssue = args.issues[0]?.message ?? "";
  if (args.policy.contractMode === "route") {
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
        ...childRunTiming(args.runRecord),
        childTraceId: args.childTraceId,
        subflowDepth: args.subflowDepth,
        childDepth: args.childDepth,
        contractStage: args.stage,
        contractIssues: args.issues,
        contractIssueCount: args.issues.length,
        firstContractIssue: firstIssue,
        inputMode: args.policy.inputMode,
        contractMode: args.policy.contractMode,
        maxDepth: args.policy.maxDepth,
        failOnError: args.policy.failOnError,
        localScope: args.localScope,
        localVariableCount: args.localVariableCount,
      },
    };
  }
  return error(
    `node.subflow_template.${args.stage}_contract_failed`,
    `subflow_template ${args.stage} contract failed: ${firstIssue}`,
    args.ctxNodeId,
  );
}

function childRunTiming(runRecord: SubflowInvokeResult["runRecord"] | null): {
  childStartedAt: string | null;
  childFinishedAt: string | null;
  childDurationMs: number | null;
} {
  const childStartedAt = typeof runRecord?.startedAt === "string" ? runRecord.startedAt : null;
  const childFinishedAt = typeof runRecord?.finishedAt === "string" ? runRecord.finishedAt : null;
  const startedMs = childStartedAt === null ? NaN : Date.parse(childStartedAt);
  const finishedMs = childFinishedAt === null ? NaN : Date.parse(childFinishedAt);
  const childDurationMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, finishedMs - startedMs)
      : null;
  return { childStartedAt, childFinishedAt, childDurationMs };
}

function readInputMode(
  value: unknown,
): "input" | "runInput" | "literal" | "template" | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim();
  return mode === "input" ||
    mode === "runInput" ||
    mode === "literal" ||
    mode === "template"
    ? mode
    : undefined;
}

function readContractMode(value: unknown): "fail" | "route" | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim();
  return mode === "fail" || mode === "route" ? mode : undefined;
}

function readIntegerAtLeast(value: unknown, minimum: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.trunc(number) : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function readLocalVariables(value: unknown, label: string): VariableEntry[] | Error {
  if (value === undefined || value === null || value === "") return [];
  const raw = typeof value === "string" ? parseLocalVariables(value, label) : value;
  if (raw instanceof Error) return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return new Error(`${label} must be a JSON object.`);
  }
  const entries: VariableEntry[] = [];
  for (const [name, item] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return new Error(`${label} cannot contain an empty name.`);
    }
    const value = toJsonValue(item);
    if (value === undefined) {
      return new Error(`${label}.${trimmed} must be JSON-compatible.`);
    }
    entries.push({
      name: trimmed,
      value,
      metadata: {
        source: "runtime",
        scope: { flowId: "subflow_template_local" },
        description: "Subflow template-local variable",
      },
    });
  }
  return entries;
}

function parseLocalVariables(value: string, label: string): unknown | Error {
  const trimmed = value.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    return new Error(
      `${label} must be valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
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

class LocalVariableOverlay implements MutableVariableStore {
  private readonly local: InMemoryVariableStore;

  constructor(
    parent: VariableStore,
    initial: readonly VariableEntry[],
  ) {
    this.parent = parent;
    this.local = new InMemoryVariableStore(initial);
  }

  private readonly parent: VariableStore;

  get(name: string): VariableValue | undefined {
    return this.local.has(name) ? this.local.get(name) : this.parent.get(name);
  }

  getRequired(name: string): VariableValue {
    const value = this.get(name);
    if (value === undefined) throw new Error(`variable ${name} is not defined`);
    return value;
  }

  getString(name: string): string | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`variable ${name} is not a string`);
    return value;
  }

  getNumber(name: string): number | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`variable ${name} is not a number`);
  }

  getBoolean(name: string): boolean | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower === "true" || lower === "1") return true;
      if (lower === "false" || lower === "0") return false;
    }
    throw new Error(`variable ${name} is not a boolean`);
  }

  has(name: string): boolean {
    return this.local.has(name) || this.parent.has(name);
  }

  list(): readonly VariableEntry[] {
    const seen = new Map<string, VariableEntry>();
    for (const entry of this.local.list()) seen.set(entry.name, entry);
    for (const entry of this.parent.list()) {
      if (!seen.has(entry.name)) seen.set(entry.name, entry);
    }
    return [...seen.values()];
  }

  describe(name: string): VariableEntry | undefined {
    return this.local.describe(name) ?? this.parent.describe(name);
  }

  set(name: string, value: VariableValue, metadata?: VariableMetadata): void {
    this.local.set(name, value, metadata);
  }

  delete(name: string): boolean {
    return this.local.delete(name);
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
