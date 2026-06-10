/**
 * One-shot generator that materialises the three "starter" flows used
 * by the studio-browser example as real JSON files on disk.
 *
 * Run with:
 *   tsx src/generateStarterFlows.ts
 *
 * Why a script instead of hand-written JSON: the canonical schema
 * (field order, ports, schemaVersion, validation) is owned by
 * `@ai-native-flow/flow-builder`. Generating from `defineFlow().dump()`
 * guarantees the on-disk files always match the latest IR, and
 * regenerating them is a single command if we ever bump the schema.
 *
 * The generated JSON files are the single source of truth at runtime —
 * the Studio sidecar exposes them via /studio/flows/list and the
 * editor saves edits straight back into the same files (no Save-As
 * dialog, no lost handles across page reloads).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { createDefaultRegistry } from "@ai-native-flow/flow-ir";
import { getBuiltinNodeDefinitions } from "@ai-native-flow/runtime/builtin-definitions";

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = path.resolve(here, "..", "flows");
const DEFAULT_LLM_CONFIG = {
  baseUrl: "$var:LLM_BASE_URL",
  apiKey: "$var:LLM_API_KEY",
  model: "$var:LLM_DEFAULT_MODEL",
  temperature: 0,
  maxTokens: 4096,
};

/**
 * Shared registry seeded with the IR-level pseudo-nodes plus every
 * `defineNode`-authored built-in (`transform`, `llm`, `http`, …). The
 * generator runs offline (no `createRuntime` available), so we layer
 * the runtime's reflected definitions on top of the IR pseudo-nodes
 * exactly as `apps/studio/main.tsx` does at boot.
 */
const registry = createDefaultRegistry();
for (const def of getBuiltinNodeDefinitions()) {
  if (registry.has(def.type, def.typeVersion)) continue;
  registry.register(def);
}

interface StarterSpec {
  /** Filename (relative to FLOWS_DIR), e.g. "hello-agent.json". */
  file: string;
  /** Builder factory that returns the canonical JSON string. */
  build(): string;
}

const starters: StarterSpec[] = [
  {
    file: "hello-agent.json",
    build() {
      const flow = defineFlow({
        id: "helloagent",
        version: "1.0.0",
        label: "Hello Agent",
        description:
          "Text input asks an agent to create a C# helloagent file on the desktop.",
        registry,
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
        position: { x: 360, y: 160 },
        config: {
          ...DEFAULT_LLM_CONFIG,
          workingDir: "",
          maxSteps: 6,
          allowBash: false,
          allowedTools: ["list_files", "read_file", "edit_file"],
          systemPrompt:
            "You are a terse file agent. Understand the user's intent, create or update files inside working_dir, read files when useful, and finish with a concise summary.",
        },
      });
      flow.connect(task.out("out"), agent.in("in"));
      flow.connect(task.out("text"), agent.in("task"));
      return flow.dump();
    },
  },
  {
    file: "fan-out-flow.json",
    build() {
      const flow = defineFlow({
        id: "fan_out_flow",
        version: "1.0.0",
        label: "Fan-Out Flow",
        description: "Start fans out to two parallel transforms, each into its own End.",
        registry,
      });
      const start = flow.node("start", {
        id: "node_start",
        label: "Start",
        position: { x: 80, y: 200 },
      });
      const upper = flow.node("transform", {
        id: "node_upper",
        label: "To Upper",
        position: { x: 340, y: 80 },
        config: { expression: "input.text.toUpperCase()" },
      });
      const lower = flow.node("transform", {
        id: "node_lower",
        label: "To Lower",
        position: { x: 340, y: 320 },
        config: { expression: "input.text.toLowerCase()" },
      });
      const endUpper = flow.node("end", {
        id: "node_end_upper",
        label: "End (Upper)",
        position: { x: 640, y: 80 },
      });
      const endLower = flow.node("end", {
        id: "node_end_lower",
        label: "End (Lower)",
        position: { x: 640, y: 320 },
      });
      flow.connect(start.out("out"), upper.in("in"));
      flow.connect(start.out("out"), lower.in("in"));
      flow.connect(upper.out("out"), endUpper.in("in"));
      flow.connect(lower.out("out"), endLower.in("in"));
      return flow.dump();
    },
  },
  {
    file: "draft.json",
    build() {
      const flow = defineFlow({
        id: "draft_flow",
        version: "0.1.0",
        label: "Draft (Empty)",
        description: "An empty canvas to scribble on.",
        registry,
      });
      flow.node("start", { id: "node_start", label: "Start", position: { x: 120, y: 200 } });
      flow.node("end", { id: "node_end", label: "End", position: { x: 480, y: 200 } });
      return flow.dump();
    },
  },
];

async function main(): Promise<void> {
  await fs.mkdir(FLOWS_DIR, { recursive: true });
  for (const starter of starters) {
    const target = path.join(FLOWS_DIR, starter.file);
    const json = starter.build();
    await fs.writeFile(target, json, "utf8");
    // eslint-disable-next-line no-console
    console.log(`[generateStarterFlows] wrote ${path.relative(process.cwd(), target)}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
