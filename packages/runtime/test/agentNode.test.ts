import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";

import {
  createRuntime,
  type CreateRuntimeOptions,
  type Runtime,
} from "../src/index.js";
import { createNodeAgentToolHost } from "../src/nodes/builtin/agentTools.node.js";
import { DeterministicLlmProvider } from "./helpers/deterministicLlmProvider.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anf-agent-"));
  tempDirs.push(dir);
  return dir;
}

function newRuntime(
  llmProvider: DeterministicLlmProvider,
  nodes?: CreateRuntimeOptions["nodes"],
): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider,
    nodes,
  });
}

async function registerAndPromote(
  rt: Runtime,
  flow: ReturnType<typeof defineFlow>,
) {
  const json = flow.dump();
  const graph = JSON.parse(json);
  await rt.registry.register({ graph, json, status: "staging" });
  await rt.registry.promote(graph.id, graph.version);
  return graph;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("runtime / agent node", () => {
  it("executes an LLM tool loop that edits a file and returns final context", async () => {
    const dir = await tempDir();
    const llmProvider = new DeterministicLlmProvider({
      respond(req) {
        if (req.prompt.includes("Previous observations: none")) {
          return JSON.stringify({
            action: "edit_file",
            args: {
              path: "generated.txt",
              new_text: "hello from agent",
              create: true,
            },
          });
        }
        return JSON.stringify({
          action: "final",
          summary: "created generated.txt",
          context: { generated: true },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_edit_file",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const emptyWorkingDir = flow.node("text_input", {
      id: "empty_working_dir",
      position: { x: 100, y: 160 },
      config: { value: "" },
    });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 100, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 3,
        allowBash: false,
      },
    });
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("out"), emptyWorkingDir.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(emptyWorkingDir.out("text"), agent.in("working_dir"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "create the file",
      sinkNodeId: "agent",
    });

    expect(result.succeeded).toBe(true);
    expect(await readFile(path.join(dir, "generated.txt"), "utf8")).toBe(
      "hello from agent",
    );
    expect(result.output).toBe("created generated.txt");
  });

  it("adds changed files into final context for downstream nodes", async () => {
    const dir = await tempDir();
    const llmProvider = new DeterministicLlmProvider({
      respond(req) {
        if (req.prompt.includes("Previous observations: none")) {
          return JSON.stringify({
            action: "write_files",
            args: {
              files: [{ path: "nodes/demo.ts", contents: "export const demo = 1;" }],
              create: true,
            },
          });
        }
        return JSON.stringify({
          action: "final",
          summary: "package written",
          context: {
            verification: { ok: true },
            changed_files: ["model-guessed.ts"],
            written_files: ["model-guessed.ts"],
            verification_results: [{ command: "model-guessed", ok: false }],
          },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_changed_files_context",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 100, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 3,
        allowBash: false,
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "write the package",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual(
      expect.objectContaining({
        summary: "package written",
        context: {
          verification: { ok: true },
          changed_files: ["nodes/demo.ts"],
          written_files: ["nodes/demo.ts"],
          verification_results: [],
        },
        changed_files: ["nodes/demo.ts"],
      }),
    );
    expect(await readFile(path.join(dir, "nodes", "demo.ts"), "utf8")).toBe(
      "export const demo = 1;",
    );
  });

  it("derives validator_status from artifact-shaped input context", async () => {
    const artifactContext = {
      isValid: false,
      errors: ["graph.missing_port: missing port"],
      warnings: ["lint.llm_ctx_missing: node omits ctx"],
      fileIssues: [
        {
          kind: "non_posix_file_path",
          path: "nodes\\demo.ts",
          message: "use POSIX paths",
        },
      ],
      materializationPlan: { files: [], verifyCommands: [] },
    };
    const llmProvider = new DeterministicLlmProvider({
      respond() {
        return JSON.stringify({
          action: "final",
          summary: "no edits needed",
          context: {
            reviewed: true,
            validator_status: { isValid: true, errors: [], warnings: [], fileIssues: [] },
          },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_validator_status_context",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const contextSource = flow.node("transform", {
      id: "validator_context",
      position: { x: 100, y: 120 },
      config: { value: artifactContext },
    });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 200, y: 0 },
      config: { maxSteps: 1 },
    });
    const end = flow.node("end", { id: "end", position: { x: 300, y: 0 } });
    flow.connect(start.out("out"), contextSource.in("in"));
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(contextSource.out("output"), agent.in("context"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "summarize validator status",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          reviewed: true,
          validator_status: {
            isValid: artifactContext.isValid,
            errors: artifactContext.errors,
            warnings: artifactContext.warnings,
            fileIssues: artifactContext.fileIssues,
          },
        }),
      }),
    );
  });

  it("preserves input requirements over model final context guesses", async () => {
    const requirements = {
      goals: ["Honor the original skill goal."],
      inputContract: [
        { name: "request", description: "Caller request", dataType: "object" },
      ],
      outputContract: [
        { name: "answer", description: "Final answer", dataType: "string" },
      ],
      acceptanceCriteria: ["The generated package preserves context handoff."],
      constraints: ["Use the runtime LlmProvider boundary."],
      contextHandoff: "Carry cumulative context through the generated flow.",
    };
    const llmProvider = new DeterministicLlmProvider({
      respond() {
        return JSON.stringify({
          action: "final",
          summary: "done",
          context: {
            requirements: {
              goals: ["model guessed a different goal"],
            },
          },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_requirements_context",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const contextSource = flow.node("transform", {
      id: "requirements_context",
      position: { x: 100, y: 120 },
      config: { value: { requirements } },
    });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 200, y: 0 },
      config: { maxSteps: 1 },
    });
    const end = flow.node("end", { id: "end", position: { x: 300, y: 0 } });
    flow.connect(start.out("out"), contextSource.in("in"));
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(contextSource.out("output"), agent.in("context"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "finish",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          requirements,
        }),
      }),
    );
  });

  it("passes its final payload through end in full-flow mode", async () => {
    const llmProvider = new DeterministicLlmProvider({
      respond() {
        return JSON.stringify({
          action: "final",
          summary: "ready",
          context: { ok: true },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_end_payload",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 100, y: 0 },
      config: { maxSteps: 1 },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "finish",
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual({
      summary: "ready",
      context: { ok: true, changed_files: [], written_files: [], verification_results: [] },
      changed_files: [],
      tool_log: [],
    });
  });

  it("keeps file tools confined to workingDir", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      { tool: "read_file", args: { path: "../outside.txt" } },
      {
        workingDir: dir,
        allowedTools: ["read_file"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("path escapes working_dir");
  });

  it("writes files from context references without copying content through the LLM", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "edit_file",
        args: {
          path_ref: "package.buildScript.path",
          new_text_ref: "package.buildScript.contents",
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["edit_file"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
        context: {
          package: {
            buildScript: {
              path: "build.ts",
              contents: "console.log('built from context');",
            },
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(dir, "build.ts"), "utf8")).toBe(
      "console.log('built from context');",
    );
  });

  it("writes files from materializationPlan refs that point at package refs", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "edit_file",
        args: {
          path_ref: "materializationPlan.files.0.pathRef",
          new_text_ref: "materializationPlan.files.0.contentsRef",
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["edit_file"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
        context: {
          materializationPlan: {
            files: [
              {
                pathRef: "package.files.0.path",
                contentsRef: "package.files.0.contents",
              },
            ],
          },
          package: {
            files: [
              {
                path: "nodes/demo.ts",
                contents: "export const demo = true;",
              },
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(dir, "nodes", "demo.ts"), "utf8")).toBe(
      "export const demo = true;",
    );
  });

  it("batch writes files from a materializationPlan file list", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "write_files",
        args: {
          files_ref: "materializationPlan.files",
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["write_files"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
        context: {
          materializationPlan: {
            files: [
              {
                pathRef: "package.files.0.path",
                contentsRef: "package.files.0.contents",
              },
              {
                pathRef: "package.files.1.path",
                contentsRef: "package.files.1.contents",
              },
            ],
          },
          package: {
            files: [
              {
                path: "nodes/a.ts",
                contents: "export const a = 1;",
              },
              {
                path: "nodes/b.ts",
                contents: "export const b = 2;",
              },
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(["nodes/a.ts", "nodes/b.ts"]);
    expect(await readFile(path.join(dir, "nodes", "a.ts"), "utf8")).toBe(
      "export const a = 1;",
    );
    expect(await readFile(path.join(dir, "nodes", "b.ts"), "utf8")).toBe(
      "export const b = 2;",
    );
  });

  it("batch writes explicit files with contents_ref aliases", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "write_files",
        args: {
          files: [
            {
              path: "nodes/from-ref.ts",
              contents_ref: "package.files.0.contents",
            },
          ],
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["write_files"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
        context: {
          package: {
            files: [{ contents: "export const fromRef = true;" }],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(dir, "nodes", "from-ref.ts"), "utf8")).toBe(
      "export const fromRef = true;",
    );
  });

  it("materializes context files through the agent tool loop and verifies them", async () => {
    const dir = await tempDir();
    const contextSource = defineNode({
      type: "test_materialization_context",
      typeVersion: "1.0.0",
      title: "Test Materialization Context",
      ports: [
        { id: "context", direction: "output", kind: "data", label: "Context" },
      ],
      validateInput: false,
      run() {
        return {
          kind: "success",
          outputs: {
            out: null,
            context: {
              materializationPlan: {
                files: [
                  {
                    pathRef: "package.files.0.path",
                    contentsRef: "package.files.0.contents",
                  },
                ],
              },
              package: {
                files: [
                  {
                    path: "build.ts",
                    contents: "console.log('materialized');",
                  },
                ],
              },
            },
          },
        };
      },
    });
    const llmProvider = new DeterministicLlmProvider({
      respond(req) {
        if (req.prompt.includes("Previous observations: none")) {
          return JSON.stringify({
            action: "write_files",
            args: {
              files_ref: "materializationPlan.files",
              create: true,
            },
          });
        }
        if (req.prompt.includes("tool run_bash")) {
          return JSON.stringify({
            action: "final",
            summary: "verified materialization",
            context: { verification: "passed" },
          });
        }
        if (req.prompt.includes("tool write_files")) {
          return JSON.stringify({
            action: "run_bash",
            args: {
              command:
                "node -e \"const fs=require('fs'); console.log(fs.readFileSync('build.ts','utf8'))\"",
            },
          });
        }
        return JSON.stringify({ action: "final", summary: "unexpected path" });
      },
    });
    const rt = newRuntime(llmProvider, [contextSource]);
    const flow = defineFlow({
      id: "agent_materialize_and_verify",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const context = flow.node("test_materialization_context", {
      id: "context",
      position: { x: 100, y: 0 },
    });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 200, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 4,
        allowBash: true,
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 300, y: 0 } });
    flow.connect(start.out("out"), context.in("in"));
    flow.connect(context.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(context.out("context"), agent.in("context"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "write and verify package",
    });

    expect(result.succeeded).toBe(true);
    expect(await readFile(path.join(dir, "build.ts"), "utf8")).toBe(
      "console.log('materialized');",
    );
    expect(result.output).toEqual(
      expect.objectContaining({
        summary: "verified materialization",
        changed_files: ["build.ts"],
      }),
    );
    expect(
      (result.output as { tool_log: Array<{ tool: string }> }).tool_log.map(
        (entry) => entry.tool,
      ),
    ).toEqual(["write_files", "run_bash"]);
    expect(
      (result.output as {
        context: {
          verification_results: Array<{ step: number; command: string; ok: boolean }>;
        };
      }).context.verification_results,
    ).toEqual([
      expect.objectContaining({
        step: 2,
        command:
          "node -e \"const fs=require('fs'); console.log(fs.readFileSync('build.ts','utf8'))\"",
        ok: true,
      }),
    ]);
    expect(JSON.stringify(result.output)).toContain("materialized");
  });

  it("derives unresolved_errors from verification commands that remain failed", async () => {
    const dir = await tempDir();
    const llmProvider = new DeterministicLlmProvider({
      respond(req) {
        if (req.prompt.includes("Previous observations: none")) {
          return JSON.stringify({
            action: "run_bash",
            args: {
              command: "node -e \"console.error('typecheck failed'); process.exit(2)\"",
            },
          });
        }
        return JSON.stringify({
          action: "final",
          summary: "verification still failing",
          context: { unresolved_errors: ["semantic issue remains"] },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_unresolved_verification",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 100, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 3,
        allowBash: true,
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "verify package",
    });

    expect(result.succeeded).toBe(true);
    const output = result.output as {
      context: {
        verification_results: Array<{ command: string; ok: boolean }>;
        unresolved_errors: string[];
      };
    };
    expect(output.context.verification_results).toEqual([
      expect.objectContaining({
        command: "node -e \"console.error('typecheck failed'); process.exit(2)\"",
        ok: false,
      }),
    ]);
    expect(output.context.unresolved_errors).toEqual([
      "semantic issue remains",
      expect.stringContaining("typecheck failed"),
    ]);
  });

  it("does not keep unresolved_errors for verification commands repaired later", async () => {
    const dir = await tempDir();
    const command =
      "node -e \"const fs=require('fs'); if(!fs.existsSync('flag')){fs.writeFileSync('flag','1'); console.error('first fail'); process.exit(2)} console.log('fixed')\"";
    let calls = 0;
    const llmProvider = new DeterministicLlmProvider({
      respond() {
        calls += 1;
        if (calls <= 2) {
          return JSON.stringify({
            action: "run_bash",
            args: { command },
          });
        }
        return JSON.stringify({
          action: "final",
          summary: "verification repaired",
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_repaired_verification",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 100, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 4,
        allowBash: true,
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "verify package",
    });

    expect(result.succeeded).toBe(true);
    const output = result.output as {
      context: {
        verification_results: Array<{ command: string; ok: boolean }>;
        unresolved_errors?: string[];
      };
    };
    expect(output.context.verification_results).toEqual([
      expect.objectContaining({ command, ok: false }),
      expect.objectContaining({ command, ok: true }),
    ]);
    expect(output.context.unresolved_errors).toBeUndefined();
  });

  it("keeps runtime facts in error context when maxSteps is reached", async () => {
    const dir = await tempDir();
    const command = "node -e \"console.error('still failing'); process.exit(2)\"";
    const requirements = {
      goals: ["Write and verify the generated package."],
      acceptanceCriteria: ["Verification commands should pass or be reported."],
      contextHandoff: "Preserve context for a follow-up repair run.",
    };
    const llmProvider = new DeterministicLlmProvider({
      respond() {
        return JSON.stringify({
          action: "run_bash",
          args: { command },
        });
      },
    });
    const rt = newRuntime(llmProvider);
    const flow = defineFlow({
      id: "agent_max_steps_context",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const contextSource = flow.node("transform", {
      id: "requirements_context",
      position: { x: 100, y: 120 },
      config: { value: { requirements } },
    });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 100, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 2,
        allowBash: true,
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), contextSource.in("in"));
    flow.connect(start.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(contextSource.out("output"), agent.in("context"));
    flow.connect(agent.out("out"), end.in("in"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "verify package",
    });

    expect(result.succeeded).toBe(false);
    expect(result.error?.code).toBe("node.agent.max_steps_exceeded");
    expect(result.error?.context).toEqual(
      expect.objectContaining({
        changed_files: [],
        written_files: [],
        requirements,
        verification_results: [
          expect.objectContaining({ command, ok: false }),
          expect.objectContaining({ command, ok: false }),
        ],
        unresolved_errors: [expect.stringContaining("still failing")],
        tool_log: [
          expect.objectContaining({ tool: "run_bash" }),
          expect.objectContaining({ tool: "run_bash" }),
        ],
      }),
    );
  });

  it("preflights write_files batches before writing any file", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "write_files",
        args: {
          files: [
            { path: "nodes/ok.ts", contents: "export const ok = true;" },
            { path: "../escape.ts", contents: "bad" },
          ],
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["write_files"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("path escapes working_dir");
    await expect(readFile(path.join(dir, "nodes", "ok.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects duplicate paths in write_files batches before writing", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "write_files",
        args: {
          files: [
            { path: "nodes/dup.ts", contents: "export const first = true;" },
            { path: "nodes/dup.ts", contents: "export const second = true;" },
          ],
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["write_files"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate file path");
    expect(result.output).toEqual({
      kind: "duplicate_paths",
      duplicatePaths: ["nodes/dup.ts"],
      plannedPaths: ["nodes/dup.ts", "nodes/dup.ts"],
    });
    await expect(readFile(path.join(dir, "nodes", "dup.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects case-insensitive duplicate paths in write_files batches", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "write_files",
        args: {
          files: [
            { path: "nodes/Dup.ts", contents: "export const first = true;" },
            { path: "nodes/dup.ts", contents: "export const second = true;" },
          ],
          create: true,
        },
      },
      {
        workingDir: dir,
        allowedTools: ["write_files"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toEqual({
      kind: "duplicate_paths",
      duplicatePaths: ["nodes/dup.ts"],
      plannedPaths: ["nodes/Dup.ts", "nodes/dup.ts"],
    });
    await expect(readFile(path.join(dir, "nodes", "Dup.ts"), "utf8")).rejects.toThrow();
  });

  it("reports all missing files in write_files batches when create is false", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "write_files",
        args: {
          files: [
            { path: "nodes/a.ts", contents: "export const a = 1;" },
            { path: "nodes/b.ts", contents: "export const b = 2;" },
          ],
        },
      },
      {
        workingDir: dir,
        allowedTools: ["write_files"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("pass create=true");
    expect(result.output).toEqual({
      kind: "missing_files",
      missingFiles: ["nodes/a.ts", "nodes/b.ts"],
      plannedPaths: ["nodes/a.ts", "nodes/b.ts"],
    });
    await expect(readFile(path.join(dir, "nodes", "a.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(dir, "nodes", "b.ts"), "utf8")).rejects.toThrow();
  });

  it("reads files from context path references", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "src.txt"), "referenced read", "utf8");
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "read_file",
        args: { path_ref: "package.source.path" },
      },
      {
        workingDir: dir,
        allowedTools: ["read_file"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
        context: {
          package: {
            source: { path: "src.txt" },
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("referenced read");
  });

  it("returns current file context when edit_file replacement text is missing", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "edit_file",
        args: {
          path: "notes.txt",
          old_text: "delta",
          new_text: "epsilon",
        },
      },
      {
        workingDir: dir,
        allowedTools: ["edit_file"],
        allowBash: false,
        timeoutMs: 1000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("old_text not found");
    expect(JSON.stringify(result.output)).toContain("alpha");
    expect(JSON.stringify(result.output)).toContain("oldTextLength");
  });

  it("keeps long context strings compact in prompts while tools can write full referenced content", async () => {
    const dir = await tempDir();
    const longSource = `export const generated = "${"x".repeat(1200)}";`;
    const longValidationError = `lint.context: ${"missing ctx ".repeat(80)}`;
    const longUnresolvedError = `verify.context: ${"still failing ".repeat(80)}`;
    const longAcceptanceCriterion = `acceptance.context: ${"preserve structured requirement ".repeat(60)}`;
    let firstPrompt = "";
    const contextSource = defineNode({
      type: "test_context_source",
      typeVersion: "1.0.0",
      title: "Test Context Source",
      ports: [
        { id: "context", direction: "output", kind: "data", label: "Context" },
      ],
      validateInput: false,
      run() {
        return {
          kind: "success",
          outputs: {
            out: null,
            context: {
              requirements: {
                goals: ["Generate a runnable package."],
                acceptanceCriteria: [longAcceptanceCriterion],
                contextHandoff:
                  "Carry cumulative context through every generated step.",
              },
              errors: [longValidationError],
              warnings: [`lint.warning: ${"preserve me ".repeat(60)}`],
              unresolved_errors: [longUnresolvedError],
              package: {
                buildScript: {
                  path: "build.ts",
                  contents: longSource,
                },
              },
            },
          },
        };
      },
    });
    const llmProvider = new DeterministicLlmProvider({
      respond(req) {
        if (req.prompt.includes("Previous observations: none")) {
          firstPrompt = req.prompt;
          return JSON.stringify({
            action: "edit_file",
            args: {
              path_ref: "package.buildScript.path",
              new_text_ref: "package.buildScript.contents",
              create: true,
            },
          });
        }
        return JSON.stringify({
          action: "final",
          summary: "wrote referenced file",
        });
      },
    });
    const rt = newRuntime(llmProvider, [contextSource]);
    const flow = defineFlow({
      id: "agent_compact_context",
      version: "1.0.0",
      registry: rt.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const context = flow.node("test_context_source", {
      id: "context",
      position: { x: 100, y: 0 },
    });
    const agent = flow.node("agent", {
      id: "agent",
      position: { x: 200, y: 0 },
      config: {
        workingDir: dir,
        maxSteps: 3,
        allowBash: false,
      },
    });
    flow.connect(start.out("out"), context.in("in"));
    flow.connect(context.out("out"), agent.in("in"));
    flow.connect(start.out("runInput"), agent.in("task"));
    flow.connect(context.out("context"), agent.in("context"));

    const graph = await registerAndPromote(rt, flow);
    const result = await rt.runManager.invoke({
      flowId: graph.id,
      flowVersion: graph.version,
      flowArtifactHash: "test-hash",
      graph,
      input: "write package",
      sinkNodeId: "agent",
    });

    expect(result.succeeded).toBe(true);
    expect(firstPrompt).not.toContain(longSource);
    expect(firstPrompt).toContain(
      "[string:1228 chars; ref=package.buildScript.contents]",
    );
    expect(firstPrompt).toContain("write_files with files_ref");
    expect(firstPrompt).toContain('output.kind="duplicate_paths"');
    expect(firstPrompt).toContain('output.kind="missing_files"');
    expect(firstPrompt).toContain("materializationPlan.files");
    expect(firstPrompt).toContain("Only put model-owned notes in final context");
    expect(firstPrompt).toContain(
      "Do not guess changed_files, written_files, verification_results, or validator_status",
    );
    expect(firstPrompt).toContain(
      "The runtime appends verification failures to unresolved_errors when commands still fail",
    );
    expect(firstPrompt).toContain(longValidationError);
    expect(firstPrompt).toContain(longUnresolvedError);
    expect(firstPrompt).toContain(longAcceptanceCriterion);
    expect(await readFile(path.join(dir, "build.ts"), "utf8")).toBe(longSource);
  });

  it("runs bash commands only when explicitly allowed", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      { tool: "run_bash", args: { command: "node -e \"console.log('agent-bash')\"" } },
      {
        workingDir: dir,
        allowedTools: ["run_bash"],
        allowBash: true,
        timeoutMs: 5000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("agent-bash");
  });

  it("preserves failed bash stdout and stderr for repair observations", async () => {
    const dir = await tempDir();
    const host = createNodeAgentToolHost();

    const result = await host.callTool(
      {
        tool: "run_bash",
        args: {
          command:
            "node -e \"console.log('before-failure'); console.error('build failed'); process.exit(2)\"",
        },
      },
      {
        workingDir: dir,
        allowedTools: ["run_bash"],
        allowBash: true,
        timeoutMs: 5000,
        maxOutputChars: 2000,
      },
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.output)).toContain("before-failure");
    expect(JSON.stringify(result.output)).toContain("build failed");
    expect(JSON.stringify(result.output)).toContain("exitCode");
  });
});
