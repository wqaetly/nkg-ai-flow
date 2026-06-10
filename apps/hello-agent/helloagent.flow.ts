import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  DEFAULT_LLM_API_KEY_REF,
  DEFAULT_LLM_BASE_URL_REF,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL_REF,
  DEFAULT_LLM_TEMPERATURE,
  createRuntime,
} from "@ai-native-flow/runtime";
import { join } from "node:path";
import { homedir } from "node:os";

const runtime = createRuntime();
const desktopDir = join(homedir(), "Desktop");

export const flow = defineFlow({
  id: "helloagent",
  version: "1.0.0",
  label: "Hello Agent",
  description:
    "A minimal text_input -> agent flow that asks the agent to create a C# helloagent file on the desktop.",
  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      tool_log: { type: "array" },
    },
  },
  registry: runtime.nodeTypeRegistry,
});

const task = flow.node("text_input", {
  id: "task_create_helloagent",
  label: "创建 helloagent 文件的任务",
  position: { x: 80, y: 160 },
  config: {
    value:
      "帮我在桌面创建一个helloagent文件，里面写上c#版本的helloagent打印代码",
  },
});

const agent = flow.node("agent", {
  id: "agent_create_helloagent",
  label: "HelloAgent 文件 Agent",
  position: { x: 400, y: 160 },
  config: {
    baseUrl: DEFAULT_LLM_BASE_URL_REF,
    apiKey: DEFAULT_LLM_API_KEY_REF,
    model: DEFAULT_LLM_MODEL_REF,
    temperature: DEFAULT_LLM_TEMPERATURE,
    maxTokens: DEFAULT_LLM_MAX_TOKENS,
    workingDir: desktopDir,
    maxSteps: 6,
    allowBash: false,
    allowedTools: ["list_files", "read_file", "edit_file"],
    systemPrompt:
      "You are a terse file agent. Understand the user's intent, create or update files inside working_dir, read files when useful, and finish with a concise summary.",
  },
});

flow.connect(task.out("out"), agent.in("in"));
flow.connect(task.out("text"), agent.in("task"));

export default flow;
