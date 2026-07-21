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
      runtime?: {
        flowId: string;
        flowVersion: string;
        runId: string;
        nodeId: string;
      };
    },
  ): Promise<AgentToolResult>;
}
