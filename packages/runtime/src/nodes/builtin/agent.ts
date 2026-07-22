/**
 * `agent` - a small Codex/Claude-Code style worker node.
 *
 * The node itself is browser-safe: Vercel AI SDK owns the model/tool loop,
 * while concrete file / process tools are injected through `AgentToolHost`.
 */

import { z } from "zod";
import { defineNode, defineNodeFactory } from "@ai-native-flow/node-sdk";
import {
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
} from "../llmProviderDefaults.js";
import type {
  LlmProvider,
  LlmToolDefinition,
} from "../llmProvider.js";
import {
  AGENT_TOOL_NAMES,
  type AgentToolCall,
  type AgentToolHost,
  type AgentToolName,
  type AgentToolResult,
} from "../../agentTools.js";

export {
  AGENT_TOOL_NAMES,
  type AgentToolCall,
  type AgentToolHost,
  type AgentToolName,
  type AgentToolResult,
} from "../../agentTools.js";

export interface AgentNodeDeps {
  llmProvider: LlmProvider;
  toolHost: AgentToolHost;
}

interface VerificationResult {
  step: number;
  command: string;
  ok: boolean;
  error?: string;
  output?: unknown;
}

const agentConfig = z
  .object({
    baseUrl: z.string().min(1).default(DEFAULT_LLM_BASE_URL_REF),
    apiKey: z.string().min(1).default(DEFAULT_LLM_API_KEY_REF),
    model: z.string().min(1).default(DEFAULT_LLM_MODEL_REF),
    temperature: z.number().min(0).max(2).default(DEFAULT_LLM_TEMPERATURE),
    maxTokens: z.number().int().min(1).max(32_000).default(DEFAULT_LLM_MAX_TOKENS),
    maxSteps: z.number().int().min(1).max(50).default(8),
    workingDir: z.string().default(""),
    allowedTools: z
      .array(z.enum(AGENT_TOOL_NAMES))
      .default([...AGENT_TOOL_NAMES]),
    allowBash: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    maxOutputChars: z.number().int().min(512).max(200_000).default(20_000),
    systemPrompt: z
      .string()
      .default("You are a terse coding agent. Use tools to complete the task."),
  })
  .passthrough();
type AgentConfig = z.infer<typeof agentConfig>;

interface ToolLogEntry {
  step: number;
  tool: AgentToolName;
  args: Record<string, unknown>;
  result: AgentToolResult;
}

const TOOL_SCHEMAS: Record<AgentToolName, Omit<LlmToolDefinition, "execute">> = {
  list_files: {
    description: "List files below the working directory.",
    inputSchema: objectSchema({
      path: { type: "string" },
      path_ref: { type: "string" },
      recursive: { type: "boolean" },
      max_entries: { type: "number" },
    }),
  },
  read_file: {
    description: "Read a UTF-8 text file from the working directory.",
    inputSchema: objectSchema({
      path: { type: "string" },
      path_ref: { type: "string" },
      max_chars: { type: "number" },
    }),
  },
  grep: {
    description: "Search text files with a regular expression.",
    inputSchema: objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      path_ref: { type: "string" },
      max_matches: { type: "number" },
    }, ["pattern"]),
  },
  edit_file: {
    description: "Replace text in one file, or create/overwrite it when requested.",
    inputSchema: objectSchema({
      path: { type: "string" },
      path_ref: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
      new_text_ref: { type: "string" },
      create: { type: "boolean" },
    }),
  },
  write_files: {
    description: "Write a batch of files atomically within the working directory.",
    inputSchema: objectSchema({
      files_ref: { type: "string" },
      files: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
      create: { type: "boolean" },
    }),
  },
  run_bash: {
    description: "Run a shell command inside the working directory.",
    inputSchema: objectSchema({
      command: { type: "string" },
      timeout_ms: { type: "number" },
    }, ["command"]),
  },
};

export const agentNode = defineNodeFactory<AgentNodeDeps>(
  ({ llmProvider, toolHost }) =>
    defineNode({
      type: "agent",
      typeVersion: "1.0.0",
      title: "Agent",
      description:
        "LLM tool-loop worker with small file/search/edit/bash primitives.",
      capabilities: {
        streaming: true,
        supportsCancel: true,
        requiredPermissions: ["network.http", "secret.read"],
      },
      config: agentConfig,
      fieldMeta: {
        baseUrl: { label: "URL", placeholder: DEFAULT_LLM_BASE_URL_REF, order: 1 },
        apiKey: {
          label: "APIKEY",
          placeholder: DEFAULT_LLM_API_KEY_REF,
          secret: true,
          order: 2,
        },
        model: { label: "Model", placeholder: DEFAULT_LLM_MODEL_REF, order: 3 },
        temperature: { label: "Temperature", order: 4 },
        maxTokens: { label: "Max Tokens", order: 5 },
        workingDir: { label: "Working directory", order: 6 },
        maxSteps: { label: "Max steps", order: 7 },
        allowBash: { label: "Allow bash", control: "switch", order: 8 },
        systemPrompt: { label: "System prompt", control: "textarea", order: 9 },
      },
      ports: [
        {
          id: "task",
          direction: "input",
          kind: "data",
          label: "Task",
          schema: { type: "string" },
        },
        {
          id: "context",
          direction: "input",
          kind: "data",
          label: "Context",
          schema: { type: "object" },
        },
        {
          id: "working_dir",
          direction: "input",
          kind: "data",
          label: "Working directory",
          schema: { type: "string" },
        },
        {
          id: "summary",
          direction: "output",
          kind: "data",
          label: "Summary",
          schema: { type: "string" },
        },
        {
          id: "context",
          direction: "output",
          kind: "data",
          label: "Context",
          schema: { type: "object" },
        },
        {
          id: "changed_files",
          direction: "output",
          kind: "data",
          label: "Changed files",
          schema: { type: "array" },
        },
        {
          id: "tool_log",
          direction: "output",
          kind: "data",
          label: "Tool log",
          schema: { type: "array" },
        },
      ],
      validateInput: false,
      async run({ input, config, ctx }) {
        const cfg = config as AgentConfig;
        const raw = input as Record<string, unknown>;
        const task =
          stringOrUndefined(raw.task) ??
          stringOrUndefined(raw.input) ??
          stringOrUndefined(raw.prompt);
        if (!task || !task.trim()) {
          return {
            kind: "error",
            error: {
              code: "node.agent.missing_task",
              message:
                "agent: provide a task via input.task, input.input, or input.prompt.",
              kind: "validation",
              category: "user_input",
            },
          };
        }

        const workingDir =
          stringOrUndefined(raw.working_dir) ??
          stringOrUndefined(raw.workingDir) ??
          cfg.workingDir;
        const allowedTools = cfg.allowedTools.filter((tool) =>
          cfg.allowBash ? true : tool !== "run_bash",
        );
        const toolLog: ToolLogEntry[] = [];
        const changedFiles = new Set<string>();
        const baseContext =
          raw.context && typeof raw.context === "object"
            ? (raw.context as Record<string, unknown>)
            : {};

        if (!llmProvider.completeWithTools) {
          return {
            kind: "error",
            error: {
              code: "node.agent.native_tool_calling_unavailable",
              message: "agent: the configured LLM provider does not support native tool calling",
              kind: "validation",
              category: "author",
            },
          };
        }

        let toolStep = 0;
        const tools = Object.fromEntries(allowedTools.map((toolName) => {
          const definition = TOOL_SCHEMAS[toolName];
          return [toolName, {
            ...definition,
            execute: async (args: Record<string, unknown>) => {
              const step = ++toolStep;
              await ctx.emit({
                kind: "tool_call_started",
                payload: { toolName, args },
              });
              const result = await toolHost.callTool(
                { tool: toolName, args },
                {
                  workingDir,
                  allowedTools,
                  allowBash: cfg.allowBash,
                  timeoutMs: cfg.timeoutMs,
                  maxOutputChars: cfg.maxOutputChars,
                  context: baseContext,
                  runtime: {
                    flowId: ctx.flowId,
                    flowVersion: ctx.flowVersion,
                    runId: ctx.runId,
                    nodeId: ctx.nodeId,
                  },
                },
              );
              for (const file of result.changedFiles ?? []) changedFiles.add(file);
              toolLog.push({ step, tool: toolName, args, result });
              await ctx.emit({
                kind: "tool_call_finished",
                payload: {
                  toolName,
                  ok: result.ok,
                  output: result.output ?? null,
                  error: result.error ?? null,
                  changedFiles: result.changedFiles ?? [],
                },
              });
              return result;
            },
          } satisfies LlmToolDefinition];
        }));

        try {
          const response = await llmProvider.completeWithTools(
            {
              system: cfg.systemPrompt,
              prompt: buildAgentPrompt({ task, context: baseContext, allowedTools }),
              model: resolveConfigStringRef(cfg.model, ctx) || undefined,
              temperature: cfg.temperature,
              maxTokens: cfg.maxTokens,
              baseUrl: resolveConfigStringRef(cfg.baseUrl, ctx) || undefined,
              apiKey: resolveConfigStringRef(cfg.apiKey, ctx) || undefined,
              maxSteps: cfg.maxSteps,
              tools,
            },
            // The SDK ctx is structurally compatible with runtime NodeContext.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx as any,
          );
          if (response.text.trim()) {
            const changedFilesList = [...changedFiles];
            const runtimeFacts = buildRuntimeFactsContext(
              baseContext,
              changedFilesList,
              toolLog,
              response.context,
            );
            const context = {
              ...baseContext,
              ...(response.context ?? {}),
              ...runtimeFacts,
            };
            const summary = response.text.trim();
            const finalPayload = {
              summary,
              context,
              changed_files: changedFilesList,
              tool_log: toolLog,
            };
            return {
              kind: "success",
              outputs: {
                out: finalPayload,
                summary,
                context,
                changed_files: finalPayload.changed_files,
                tool_log: toolLog,
              },
            };
          }
        } catch (cause) {
          return {
            kind: "error",
            error: {
              code: "node.agent.llm_failed",
              message: (cause as Error).message,
              kind: "external",
              category: "external",
            },
          };
        }

        const changedFilesList = [...changedFiles];
        return {
          kind: "error",
          error: {
            code: "node.agent.max_steps_exceeded",
            message: `agent: reached maxSteps=${cfg.maxSteps} without final answer.`,
            kind: "validation",
            category: "author",
            context: {
              ...buildRuntimeFactsContext(baseContext, changedFilesList, toolLog),
              tool_log: toolLog,
            },
          },
        };
      },
    }),
);

function buildAgentPrompt(args: {
  task: string;
  context: Record<string, unknown>;
  allowedTools: readonly AgentToolName[];
}): string {
  return [
    "Use the provided native tools when they are needed, then return a concise final summary as plain text.",
    "Only put model-owned notes in final context; express them in the final answer rather than guessing runtime facts.",
    "Do not guess changed_files, written_files, verification_results, or validator_status; the runtime fills those from real tool logs and input context.",
    "If semantic problems remain after your work, you may include unresolved_errors. The runtime appends verification failures to unresolved_errors when commands still fail.",
    `Allowed tools: ${args.allowedTools.join(", ")}`,
    "",
    "Tool schemas:",
    '- list_files: {"path"?: string, "path_ref"?: string, "recursive"?: boolean, "max_entries"?: number}',
    '- read_file: {"path"?: string, "path_ref"?: string, "max_chars"?: number}',
    '- grep: {"pattern": string, "path"?: string, "path_ref"?: string, "max_matches"?: number}',
    '- edit_file: {"path"?: string, "path_ref"?: string, "old_text"?: string, "new_text"?: string, "new_text_ref"?: string, "create"?: boolean}',
    '- write_files: {"files_ref"?: string, "files"?: [{"path"?: string, "path_ref"?: string, "pathRef"?: string, "contents"?: string, "contents_ref"?: string, "new_text"?: string, "new_text_ref"?: string, "contentsRef"?: string}], "create"?: boolean}',
    '- run_bash: {"command": string, "timeout_ms"?: number}',
    "",
    "For batch writes, prefer write_files with files_ref when Context contains a materializationPlan.files array.",
    "If write_files returns output.kind=\"duplicate_paths\", retry with an explicit files array using unique safe paths.",
    "If write_files returns output.kind=\"missing_files\", retry with create=true when creating those files is intended.",
    "For generated files already present in Context, prefer edit_file path_ref/new_text_ref instead of copying long file contents into new_text.",
    "If Context contains materializationPlan.files, use each entry's pathRef and contentsRef values as edit_file path_ref/new_text_ref arguments.",
    "",
    `Task:\n${args.task}`,
    "",
    `Context:\n${JSON.stringify(compactContextForPrompt(args.context))}`,
    "",
    "Previous observations: none",
  ].join("\n");
}

function resolveConfigStringRef(
  value: string | undefined,
  ctx: { variables: { getString(name: string): string | undefined } },
): string | undefined {
  if (value === undefined) return undefined;
  const ref = /^\$(?:var|secret):([A-Za-z0-9_.:-]+)$/.exec(value.trim());
  if (!ref?.[1]) return value;
  return ctx.variables.getString(ref[1]) ?? value;
}

function buildRuntimeFactsContext(
  baseContext: Record<string, unknown>,
  changedFilesList: readonly string[],
  toolLog: readonly ToolLogEntry[],
  modelContext?: Record<string, unknown>,
): Record<string, unknown> {
  const verificationResults = buildVerificationResults(toolLog);
  const validatorStatus = buildValidatorStatus(baseContext);
  const unresolvedErrors = mergeUnresolvedErrors(
    baseContext.unresolved_errors,
    modelContext?.unresolved_errors,
    buildUnresolvedErrors(verificationResults),
  );
  return {
    ...(baseContext.requirements !== undefined
      ? { requirements: baseContext.requirements }
      : {}),
    ...(validatorStatus !== undefined
      ? { validator_status: validatorStatus }
      : {}),
    changed_files: [...changedFilesList],
    written_files: [...changedFilesList],
    verification_results: verificationResults,
    ...(unresolvedErrors.length > 0
      ? { unresolved_errors: unresolvedErrors }
      : {}),
  };
}

function mergeUnresolvedErrors(...sources: readonly unknown[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const values =
      typeof source === "string"
        ? [source]
        : Array.isArray(source)
          ? source.filter((value): value is string => typeof value === "string")
          : [];
    for (const value of values) {
      if (seen.has(value)) continue;
      seen.add(value);
      merged.push(value);
    }
  }
  return merged;
}

function buildVerificationResults(toolLog: readonly ToolLogEntry[]): VerificationResult[] {
  return toolLog
    .filter((entry) => entry.tool === "run_bash")
    .map((entry) => ({
      step: entry.step,
      command: typeof entry.args.command === "string" ? entry.args.command : "",
      ok: entry.result.ok,
      ...(entry.result.error !== undefined ? { error: entry.result.error } : {}),
      ...(entry.result.output !== undefined ? { output: entry.result.output } : {}),
    }));
}

function buildUnresolvedErrors(
  verificationResults: readonly VerificationResult[],
): string[] {
  const lastByCommand = new Map<string, VerificationResult>();
  for (const result of verificationResults) {
    lastByCommand.set(result.command, result);
  }
  return [...lastByCommand.values()]
    .filter((result) => !result.ok)
    .map((result) =>
      result.error
        ? `verification failed at step ${result.step}: ${result.command}: ${result.error}`
        : `verification failed at step ${result.step}: ${result.command}`,
    );
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildValidatorStatus(
  context: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const hasValidatorShape =
    "isValid" in context ||
    "errors" in context ||
    "warnings" in context ||
    "fileIssues" in context;
  if (!hasValidatorShape) return undefined;
  return {
    isValid: context.isValid,
    errors: context.errors,
    warnings: context.warnings,
    fileIssues: context.fileIssues,
  };
}

function compactContextForPrompt(value: unknown, path = ""): unknown {
  if (typeof value === "string") {
    if (shouldPreserveLongContextString(path)) return value;
    if (value.length <= 240) return value;
    const ref = path || "<root>";
    return `[string:${value.length} chars; ref=${ref}]`;
  }
  if (Array.isArray(value)) {
    const maxItems = 50;
    const items = value
      .slice(0, maxItems)
      .map((item, index) =>
        compactContextForPrompt(item, path ? `${path}.${index}` : String(index)),
      );
    if (value.length > maxItems) {
      items.push(`[array truncated: ${value.length - maxItems} more items]`);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      out[key] = compactContextForPrompt(child, childPath);
    }
    return out;
  }
  return value;
}

function shouldPreserveLongContextString(path: string): boolean {
  return (
    /^requirements(?:\.|$)/.test(path) ||
    /(?:^|\.)errors\.\d+$/.test(path) ||
    /(?:^|\.)warnings\.\d+$/.test(path) ||
    /(?:^|\.)unresolved_errors\.\d+$/.test(path)
  );
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
