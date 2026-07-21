/**
 * `tool` — invoke a built-in runtime tool.
 *
 * The browser-safe node definition is dependency-injected with the same
 * Node-side `AgentToolHost` used by the `agent` node, so regular workflows
 * can call tools directly without going through an LLM loop.
 */

import { z } from "zod";
import { defineNode, defineNodeFactory } from "@ai-native-flow/node-sdk";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import {
  AGENT_TOOL_NAMES,
  type AgentToolHost,
  type AgentToolName,
} from "./agent.js";

export interface ToolNodeDeps {
  toolHost: AgentToolHost;
}

const toolConfig = z
  .object({
    tool: z.string().default("").describe("Tool name to invoke."),
    args: z.unknown().optional().describe("Static JSON-compatible arguments."),
    workingDir: z.string().default("").describe("Working directory for file/process tools."),
    allowedTools: z.array(z.string()).default([]).describe("Optional allow-list; empty means every built-in tool."),
    allowBash: z.boolean().default(false).describe("Allow the run_bash tool."),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    maxOutputChars: z.number().int().min(512).max(200_000).default(20_000),
    failOnError: z.boolean().default(true).describe("Fail the node when the tool returns ok=false."),
  })
  .passthrough();

type ToolConfig = z.infer<typeof toolConfig>;

export const toolNode = defineNodeFactory<ToolNodeDeps>(
  ({ toolHost }) =>
    defineNode({
      type: "tool",
      typeVersion: "1.0.0",
      title: "Tool",
      description: "Invokes a built-in runtime tool with structured arguments.",
      config: toolConfig,
      fieldMeta: {
        tool: {
          label: "Tool",
          control: "select",
          order: 1,
          enumOptions: AGENT_TOOL_NAMES.map((tool) => ({ label: tool, value: tool })),
        },
        args: { label: "Arguments", control: "textarea", order: 2 },
        workingDir: { label: "Working directory", order: 3 },
        allowedTools: { label: "Allowed tools", control: "textarea", order: 4 },
        allowBash: { label: "Allow bash", control: "switch", order: 5 },
        timeoutMs: { label: "Timeout (ms)", control: "number", order: 6 },
        maxOutputChars: { label: "Max output chars", control: "number", order: 7 },
        failOnError: { label: "Fail on error", control: "switch", order: 8 },
      },
      ports: [
        { id: "args", direction: "input", kind: "data", label: "Arguments", schema: { type: "object" } },
        { id: "context", direction: "input", kind: "data", label: "Context", schema: { type: "object" } },
        { id: "workingDir", direction: "input", kind: "data", label: "Working directory", schema: { type: "string" } },
        { id: "success", direction: "output", kind: "control", label: "Success" },
        { id: "failed", direction: "output", kind: "control", label: "Failed" },
        { id: "result", direction: "output", kind: "data", label: "Result", schema: { type: "object" } },
        { id: "ok", direction: "output", kind: "data", label: "OK", schema: { type: "boolean" } },
        { id: "errorMessage", direction: "output", kind: "data", label: "Error message", schema: { type: "string" } },
        { id: "changedFiles", direction: "output", kind: "data", label: "Changed files", schema: { type: "array" } },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
      ],
      validateInput: false,
      async run({ input, config, ctx }) {
        const cfg = config as ToolConfig;
        const raw = input as Record<string, unknown>;
        const tool = readToolName(raw.tool ?? cfg.tool);
        if (!tool) {
          return nodeError(
            "node.tool.missing_tool",
            "tool node requires config.tool or tool input",
            ctx.nodeId,
          );
        }

        const args = readArgs(raw.args ?? raw.input ?? cfg.args ?? {});
        if (!args.ok) {
          return nodeError(
            "node.tool.invalid_args",
            "tool node arguments must be a JSON object",
            ctx.nodeId,
          );
        }

        const workingDir =
          stringOr(raw.workingDir) ??
          stringOr(raw.working_dir) ??
          stringOr(cfg.workingDir) ??
          "";
        const allowedTools = readAllowedTools(cfg.allowedTools, cfg.allowBash);
        const context =
          raw.context && typeof raw.context === "object" && !Array.isArray(raw.context)
            ? (raw.context as Record<string, unknown>)
            : undefined;

        await ctx.emit({
          kind: "tool_call_started",
          payload: {
            toolName: tool,
            args: args.value,
          },
        });
        const result = await toolHost.callTool(
          { tool, args: args.value },
          {
            workingDir,
            allowedTools,
            allowBash: cfg.allowBash,
            timeoutMs: cfg.timeoutMs,
            maxOutputChars: cfg.maxOutputChars,
            ...(context !== undefined ? { context } : {}),
            runtime: {
              flowId: ctx.flowId,
              flowVersion: ctx.flowVersion,
              runId: ctx.runId,
              nodeId: ctx.nodeId,
            },
          },
        );
        await ctx.emit({
          kind: "tool_call_finished",
          payload: {
            toolName: tool,
            ok: result.ok,
            output: result.output ?? null,
            error: result.error ?? null,
            changedFiles: result.changedFiles ?? [],
          },
        });

        if (!result.ok && cfg.failOnError) {
          return nodeError(
            "node.tool.call_failed",
            result.error ?? `tool "${tool}" failed`,
            ctx.nodeId,
            { tool, result },
          );
        }

        const output = result.output ?? null;
        const changedFiles = result.changedFiles ?? [];
        const summary = {
          tool,
          branch: result.ok ? "success" : "failed",
          ok: result.ok,
          resultType: valueType(output),
          changedFileCount: changedFiles.length,
          hasError: Boolean(result.error),
          failOnError: cfg.failOnError,
        };

        return {
          kind: "success",
          outputs: {
            [result.ok ? "success" : "failed"]: null,
            out: output,
            result: output,
            ok: result.ok,
            errorMessage: result.error ?? "",
            changedFiles,
            summary,
          },
        };
      },
    }),
);

function readToolName(value: unknown): AgentToolName | undefined {
  if (typeof value !== "string") return undefined;
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value)
    ? (value as AgentToolName)
    : undefined;
}

function readArgs(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  return { ok: false };
}

function readAllowedTools(
  configured: readonly string[],
  allowBash: boolean,
): readonly AgentToolName[] {
  const source = configured.length > 0 ? configured : AGENT_TOOL_NAMES;
  return source
    .map(readToolName)
    .filter((tool): tool is AgentToolName => tool !== undefined)
    .filter((tool) => allowBash || tool !== "run_bash");
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}

function nodeError(
  code: string,
  message: string,
  nodeId: string,
  context?: Record<string, unknown>,
) {
  return {
    kind: "error" as const,
    error: createRuntimeError({
      code,
      kind: "validation",
      category: "user_input",
      message,
      source: { module: "node_logic", nodeId },
      ...(context !== undefined ? { context } : {}),
    }) as unknown as { code: string; message: string; [key: string]: unknown },
  };
}
