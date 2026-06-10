/**
 * `agent` - a small Codex/Claude-Code style worker node.
 *
 * The node itself is browser-safe: it owns the LLM loop and tool-call
 * protocol, while concrete file / process tools are injected by the
 * Node runtime through `AgentToolHost`.
 */

import { z } from "zod";
import { defineNode, defineNodeFactory } from "@ai-native-flow/node-sdk";
import {
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
  type LlmProvider,
} from "../llmProvider.js";

export const AGENT_TOOL_NAMES = [
  "list_files",
  "read_file",
  "grep",
  "edit_file",
  "write_files",
  "run_bash",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolCall {
  tool: AgentToolName;
  args: Record<string, unknown>;
}

export interface AgentToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  changedFiles?: string[];
}

export interface AgentToolHost {
  callTool(
    call: AgentToolCall,
    env: {
      workingDir: string;
      allowedTools: readonly AgentToolName[];
      allowBash: boolean;
      timeoutMs: number;
      maxOutputChars: number;
      context?: Record<string, unknown>;
    },
  ): Promise<AgentToolResult>;
}

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

type AgentDecision =
  | {
      action: AgentToolName;
      args?: Record<string, unknown>;
      thought?: string;
    }
  | {
      action: "final";
      summary: string;
      context?: Record<string, unknown>;
    };

interface ToolLogEntry {
  step: number;
  tool: AgentToolName;
  args: Record<string, unknown>;
  result: AgentToolResult;
}

export const agentNode = defineNodeFactory<AgentNodeDeps>(
  ({ llmProvider, toolHost }) =>
    defineNode({
      type: "agent",
      typeVersion: "1.0.0",
      title: "Agent",
      description:
        "LLM tool-loop worker with small file/search/edit/bash primitives.",
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
        const transcript: string[] = [];
        const toolLog: ToolLogEntry[] = [];
        const changedFiles = new Set<string>();
        const baseContext =
          raw.context && typeof raw.context === "object"
            ? (raw.context as Record<string, unknown>)
            : {};

        for (let step = 1; step <= cfg.maxSteps; step += 1) {
          const prompt = buildAgentPrompt({
            systemPrompt: cfg.systemPrompt,
            task,
            context: baseContext,
            allowedTools,
            transcript,
          });
          let text: string;
          try {
            const response = await llmProvider.complete(
              {
                prompt,
                model: resolveConfigStringRef(cfg.model, ctx) || undefined,
                temperature: cfg.temperature,
                maxTokens: cfg.maxTokens,
                baseUrl: resolveConfigStringRef(cfg.baseUrl, ctx) || undefined,
                apiKey: resolveConfigStringRef(cfg.apiKey, ctx) || undefined,
              },
              // The SDK ctx is structurally compatible with runtime NodeContext.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ctx as any,
            );
            text = response.text;
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

          const decision = parseDecision(text);
          if (!decision) {
            transcript.push(
              `Step ${step} model output was not valid JSON: ${truncate(text, 800)}`,
            );
            continue;
          }

          if (decision.action === "final") {
            const changedFilesList = [...changedFiles];
            const runtimeFacts = buildRuntimeFactsContext(
              baseContext,
              changedFilesList,
              toolLog,
              decision.context,
            );
            const context = {
              ...baseContext,
              ...(decision.context ?? {}),
              ...runtimeFacts,
            };
            const finalPayload = {
              summary: decision.summary,
              context,
              changed_files: changedFilesList,
              tool_log: toolLog,
            };
            return {
              kind: "success",
              outputs: {
                out: finalPayload,
                summary: decision.summary,
                context,
                changed_files: finalPayload.changed_files,
                tool_log: toolLog,
              },
            };
          }

          const args = decision.args ?? {};
          if (!allowedTools.includes(decision.action)) {
            return {
              kind: "error",
              error: {
                code: "node.agent.tool_not_allowed",
                message: `agent: tool "${decision.action}" is not allowed by config.allowedTools / config.allowBash.`,
                kind: "validation",
                category: "author",
              },
            };
          }

          const result = await toolHost.callTool(
            { tool: decision.action, args },
            {
              workingDir,
              allowedTools,
              allowBash: cfg.allowBash,
              timeoutMs: cfg.timeoutMs,
              maxOutputChars: cfg.maxOutputChars,
              context: baseContext,
            },
          );
          for (const file of result.changedFiles ?? []) changedFiles.add(file);
          toolLog.push({ step, tool: decision.action, args, result });
          transcript.push(
            [
              `Step ${step} tool ${decision.action}`,
              `args: ${JSON.stringify(args)}`,
              `observation: ${truncate(JSON.stringify(result), 2000)}`,
            ].join("\n"),
          );
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
  systemPrompt: string;
  task: string;
  context: Record<string, unknown>;
  allowedTools: readonly AgentToolName[];
  transcript: readonly string[];
}): string {
  return [
    args.systemPrompt,
    "",
    "Use exactly one JSON object as your response. Do not include markdown.",
    'To call a tool: {"action":"read_file","args":{"path":"src/index.ts"}}',
    'To finish: {"action":"final","summary":"...","context":{"key":"value"}}',
    "Only put model-owned notes in final context. Do not guess changed_files, written_files, verification_results, or validator_status; the runtime fills those from real tool logs and input context.",
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
    args.transcript.length
      ? `Previous observations:\n${args.transcript.join("\n\n")}`
      : "Previous observations: none",
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

function parseDecision(text: string): AgentDecision | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const action = (parsed as Record<string, unknown>).action;
    if (action === "final") {
      const summary = (parsed as Record<string, unknown>).summary;
      return {
        action: "final",
        summary: typeof summary === "string" ? summary : "",
        context:
          (parsed as Record<string, unknown>).context &&
          typeof (parsed as Record<string, unknown>).context === "object"
            ? ((parsed as Record<string, unknown>).context as Record<
                string,
                unknown
              >)
            : undefined,
      };
    }
    if (AGENT_TOOL_NAMES.includes(action as AgentToolName)) {
      const args = (parsed as Record<string, unknown>).args;
      return {
        action: action as AgentToolName,
        args:
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {},
      };
    }
    return null;
  } catch {
    return null;
  }
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

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = /```(?:json)?\s*({[\s\S]*?})\s*```/.exec(text);
  if (fenced?.[1]) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
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

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
