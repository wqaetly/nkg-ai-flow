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
    maxDepth: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe("Maximum allowed nested subflow depth. Root runs start at depth 0."),
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
    maxDepth: { label: "Max Depth", control: "number", order: 8 },
    localScope: { label: "Local Scope", control: "switch", order: 9 },
    localVariables: {
      label: "Local Variables",
      control: "textarea",
      order: 10,
      placeholder: '{ "TENANT": "acme" }',
    },
    failOnError: { label: "Fail On Error", control: "switch", order: 11 },
  },
  ports: [
    controlIn,
    { id: "flowId", direction: "input", kind: "data", label: "Flow Id", schema: { type: "string" } },
    { id: "flowVersion", direction: "input", kind: "data", label: "Flow Version", schema: { type: "string" } },
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
    { id: "parentFlowId", direction: "output", kind: "data", label: "Parent Flow Id", schema: { type: "string" } },
    { id: "parentFlowVersion", direction: "output", kind: "data", label: "Parent Flow Version", schema: { type: "string" } },
    { id: "parentRunId", direction: "output", kind: "data", label: "Parent Run Id", schema: { type: "string" } },
    { id: "parentNodeId", direction: "output", kind: "data", label: "Parent Node Id", schema: { type: "string" } },
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
    const flowId = String(input.flowId ?? config.flowId ?? "").trim();
    if (flowId === "") {
      return error(
        "node.subflow.missing_flow_id",
        "subflow node requires config.flowId or flowId input",
        ctx.nodeId,
      );
    }

    const flowVersion = String(input.flowVersion ?? config.flowVersion ?? "").trim();
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

    const policy = readSubflowPolicy(input, config);
    const subflowDepth = Math.max(
      0,
      Math.trunc(Number((ctx as { subflowDepth?: number }).subflowDepth ?? 0)),
    );
    const maxDepth = policy.maxDepth;
    if (subflowDepth >= maxDepth) {
      return error(
        "node.subflow.max_depth_exceeded",
        `subflow depth ${subflowDepth} reached maxDepth ${maxDepth}`,
        ctx.nodeId,
        { subflowDepth, maxDepth, flowId, flowVersion: flowVersion || undefined },
      );
    }
    const childDepth = subflowDepth + 1;
    const childTraceId = `${ctx.runId}:${ctx.nodeId}`;
    const parentLocator = {
      parentFlowId: ctx.flowId,
      parentFlowVersion: ctx.flowVersion,
      parentRunId: ctx.runId,
      parentNodeId: ctx.nodeId,
    };

    const parentVariables = (ctx as unknown as { variables: VariableStore }).variables;
    const localVariables = readLocalVariables(policy.localVariables);
    if (localVariables instanceof Error) {
      return error(
        "node.subflow.invalid_local_variables",
        localVariables.message,
        ctx.nodeId,
      );
    }
    const hasLocalVariables = localVariables.length > 0;
    const localScope = policy.localScope || hasLocalVariables;
    const childVariables = localScope
      ? new LocalVariableOverlay(parentVariables, localVariables)
      : parentVariables;

    const payload = childInput(input, policy);
    const inputContract = validateContract(policy.inputSchema, payload, "input");
    if (inputContract instanceof Error) {
      return error(
        "node.subflow.invalid_input_schema",
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
        flowId,
        flowVersion,
        childTraceId,
        parentLocator,
        subflowDepth,
        childDepth,
        localScope,
        localVariableCount: localVariables.length,
      });
    }

    let result: SubflowInvokeResult;
    try {
      result = await invokeFlow({
        flowId,
        ...(flowVersion === "" ? {} : { flowVersion }),
        input: payload,
        traceId: childTraceId,
        subflowDepth: childDepth,
        variables: childVariables,
        secrets: childVariables,
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
      flowId,
      flowVersion: result.runRecord.flowVersion,
      ...childRunTiming(result.runRecord),
      childTraceId,
      ...parentLocator,
      subflowDepth,
      childDepth,
      inputMode: policy.inputMode,
      contractMode: policy.contractMode,
      maxDepth,
      failOnError: policy.failOnError,
      localScope,
      localVariableCount: localVariables.length,
    };

    if (status === "succeeded") {
      outputs.out = null;
      ctx.log.debug("subflow completed", {
        flowId,
        flowVersion: result.runRecord.flowVersion,
        childRunId: result.runRecord.runId,
      });

      const outputContract = validateContract(policy.outputSchema, result.output ?? null, "output");
      if (outputContract instanceof Error) {
        return error(
          "node.subflow.invalid_output_schema",
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
          flowId,
          flowVersion: result.runRecord.flowVersion,
          childTraceId,
          parentLocator,
          subflowDepth,
          childDepth,
          localScope,
          localVariableCount: localVariables.length,
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

    if (policy.failOnError) {
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
  policy: { inputMode: "input" | "runInput" | "literal"; inputValue?: unknown },
): unknown {
  switch (policy.inputMode) {
    case "runInput":
      return input.__runInput__ ?? null;
    case "literal":
      return input.inputValue ?? policy.inputValue ?? null;
    default:
      return input.input ?? input.in ?? input.__runInput__ ?? null;
  }
}

function readSubflowPolicy(
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
  inputMode: "input" | "runInput" | "literal";
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
    return new Error(`subflow ${stage} schema is invalid: ${schema.message}`);
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
  flowId: string;
  flowVersion: string;
  childTraceId: string;
  parentLocator: {
    parentFlowId: string;
    parentFlowVersion: string;
    parentRunId: string;
    parentNodeId: string;
  };
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
        flowId: args.flowId,
        flowVersion: args.runRecord?.flowVersion ?? args.flowVersion,
        ...childRunTiming(args.runRecord),
        childTraceId: args.childTraceId,
        ...args.parentLocator,
        contractStage: args.stage,
        contractIssues: args.issues,
        contractIssueCount: args.issues.length,
        firstContractIssue: firstIssue,
        subflowDepth: args.subflowDepth,
        childDepth: args.childDepth,
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

function readInputMode(value: unknown): "input" | "runInput" | "literal" | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim();
  return mode === "input" || mode === "runInput" || mode === "literal"
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

function readLocalVariables(value: unknown): VariableEntry[] | Error {
  if (value === undefined || value === null || value === "") return [];
  const raw = typeof value === "string" ? parseLocalVariables(value) : value;
  if (raw instanceof Error) return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return new Error("subflow localVariables must be a JSON object.");
  }
  const entries: VariableEntry[] = [];
  for (const [name, item] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return new Error("subflow localVariables cannot contain an empty name.");
    }
    const value = toVariableValue(item);
    if (value === undefined) {
      return new Error(`subflow localVariables.${trimmed} must be JSON-compatible.`);
    }
    entries.push({
      name: trimmed,
      value,
      metadata: {
        source: "runtime",
        scope: { flowId: "subflow_local" },
        description: "Subflow-local variable",
      },
    });
  }
  return entries;
}

function parseLocalVariables(value: string): unknown | Error {
  const trimmed = value.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    return new Error(
      `subflow localVariables must be valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
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
