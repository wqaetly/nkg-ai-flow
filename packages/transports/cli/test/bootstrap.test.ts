import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../../runtime/test/helpers/deterministicLlmProvider.js";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import { runFlowCli } from "../src/bootstrap.js";

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
}

async function registerHello(runtime: Runtime): Promise<void> {
  const flow = defineFlow({
    id: "bootstrap_hello",
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const transform = flow.node("transform", {
    id: "t",
    position: { x: 100, y: 0 },
    config: { template: "Hello ${input.name}" },
  });
  const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), transform.in("in"));
  flow.connect(transform.out("out"), end.in("in"));
  const json = flow.dump();
  await runtime.registry.register({
    graph: JSON.parse(json),
    json,
    status: "staging",
  });
  await runtime.registry.promote(flow.id, flow.version);
}

describe("transport-cli bootstrap", () => {
  it("runs the command runner with injected runtime and IO", async () => {
    const runtime = newRuntime();
    await registerHello(runtime);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const result = await runFlowCli({
      runtime,
      argv: ["run", "bootstrap_hello", "--input", "@input.json"],
      io: {
        stdout: {
          write: (chunk) => {
            stdoutLines.push(chunk.trimEnd());
          },
        },
        stderr: {
          write: (chunk) => {
            stderrLines.push(chunk.trimEnd());
          },
        },
        readFile: async (path) => {
          expect(path).toBe("input.json");
          return JSON.stringify({ name: "Bootstrap" });
        },
      },
    });
    const payload = JSON.parse(stdoutLines[0]!);

    expect(result.exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(payload.output).toBe("Hello Bootstrap");
  });
});

