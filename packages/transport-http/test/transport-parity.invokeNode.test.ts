/**
 * Step 5 \u2014 sub-graph (sink-node) invocation parity across HTTP, SDK
 * and CLI.
 *
 * MCP is intentionally NOT covered here: MCP is the public LLM-tool
 * surface, and exposing internal node-level debug invocations to LLMs
 * would muddle that contract. Sub-graph invocation is a debugging /
 * authoring affordance for HTTP, SDK and CLI only \u2014 the three
 * transports Studio and the CLI build on.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  createRuntime,
  type Runtime,
} from "@ai-native-flow/runtime";
import { DeterministicLlmProvider } from "../../runtime/test/helpers/deterministicLlmProvider.js";
import { createHttpHandler } from "@ai-native-flow/transport-http";
import { createFlowCli, type CliIo } from "@ai-native-flow/transport-cli";
import { createFlowSdkClient } from "@ai-native-flow/transport-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";

function newRuntime(): Runtime {
  return createRuntime({
    variables: new InMemoryVariableStore(),
    secrets: new InMemorySecretStore(),
    llmProvider: new DeterministicLlmProvider(),
  });
}

function createTestIo(): CliIo & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
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
    readFile: async () => {
      throw new Error("No files are registered for this test IO");
    },
  };
}

async function registerSubGraphFlow(rt: Runtime, id: string): Promise<void> {
  const flow = defineFlow({
    id,
    version: "1.0.0",
    registry: rt.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
  const upper = flow.node("transform", {
    id: "upper",
    position: { x: 100, y: 0 },
    config: { template: "Hi ${input.name}" },
  });
  const tail = flow.node("transform", {
    id: "tail",
    position: { x: 200, y: 0 },
    config: { template: "${input}!" },
  });
  const end = flow.node("end", { id: "e", position: { x: 300, y: 0 } });
  flow.connect(start.out("out"), upper.in("in"));
  flow.connect(upper.out("out"), tail.in("in"));
  flow.connect(tail.out("out"), end.in("in"));
  const json = flow.dump();
  await rt.registry.register({
    graph: JSON.parse(json),
    json,
    status: "staging",
  });
  await rt.registry.promote(id, "1.0.0");
}

describe("transport parity \u00b7 invokeNode (HTTP / SDK / CLI)", () => {
  it("returns equivalent sub-graph output across HTTP, SDK and CLI", async () => {
    const runtime = newRuntime();
    await registerSubGraphFlow(runtime, "parity_node");
    const handler = createHttpHandler({ runtime });
    const sdk = createFlowSdkClient({ runtime });
    const cliIo = createTestIo();
    const cli = createFlowCli({ client: sdk, io: cliIo });

    // Each transport sends its own `name`, but they all run the same
    // sub-graph (start -> upper) and surface the same "Hi <name>"
    // output shape \u2014 that uniformity is the parity assertion.
    const httpRes = await handler(
      new Request("http://test/flows/parity_node/nodes/upper/invoke", {
        method: "POST",
        body: JSON.stringify({ input: { name: "HTTP" } }),
      }),
    );
    const httpBody = (await httpRes.json()) as {
      output: unknown;
      status: string;
      flowId: string;
      nodeId: string;
    };
    const sdkResult = await sdk.invokeNode("parity_node", "upper", {
      name: "SDK",
    });
    await cli.run([
      "run-node",
      "parity_node",
      "upper",
      "--input",
      JSON.stringify({ name: "CLI" }),
    ]);
    const cliBody = JSON.parse(cliIo.stdoutLines[0]!);

    expect(httpRes.status).toBe(200);
    expect(httpBody.status).toBe("succeeded");
    expect(httpBody.output).toBe("Hi HTTP");
    expect(httpBody.flowId).toBe("parity_node");
    expect(httpBody.nodeId).toBe("upper");

    expect(sdkResult.succeeded).toBe(true);
    expect(sdkResult.output).toBe("Hi SDK");
    expect(sdkResult.runRecord.flowId).toBe("parity_node");

    expect(cliBody.succeeded).toBe(true);
    expect(cliBody.output).toBe("Hi CLI");
    expect(cliBody.flowId).toBe("parity_node");
    expect(cliBody.nodeId).toBe("upper");
  });

  it("emits identical run-event sequences across HTTP-SSE, SDK and CLI", async () => {
    const runtime = newRuntime();
    await registerSubGraphFlow(runtime, "parity_stream_node");
    const handler = createHttpHandler({ runtime });
    const sdk = createFlowSdkClient({ runtime });
    const cliIo = createTestIo();
    const cli = createFlowCli({ client: sdk, io: cliIo });

    // SDK reference run produces the canonical kind sequence \u2014 every
    // other transport must reproduce it modulo ordering of node-level
    // events that happen at the same scheduler tick (Phase 1 has none
    // for this trivial linear flow).
    const sdkKinds: string[] = [];
    for await (const event of sdk.streamNode(
      "parity_stream_node",
      "upper",
      { name: "Stream" },
    )) {
      sdkKinds.push(event.kind);
    }

    // HTTP SSE
    const sseRes = await handler(
      new Request("http://test/flows/parity_stream_node/nodes/upper/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { name: "Stream" } }),
      }),
    );
    const sseBody = await readBody(sseRes);
    const httpKinds = parseSseEventKinds(sseBody);

    // CLI stream-node
    await cli.run([
      "stream-node",
      "parity_stream_node",
      "upper",
      "--input",
      JSON.stringify({ name: "Stream" }),
    ]);
    const cliKinds = cliIo.stdoutLines.map(
      (line) => (JSON.parse(line) as { kind: string }).kind,
    );

    expect(httpKinds).toEqual(sdkKinds);
    expect(cliKinds).toEqual(sdkKinds);
  });
});

/* -------------------------------------------------------------------------- */
/* SSE parsing helpers (local copy to avoid importing test fixtures)          */
/* -------------------------------------------------------------------------- */

async function readBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

function parseSseEventKinds(body: string): string[] {
  const kinds: string[] = [];
  for (const block of body.split("\n\n")) {
    if (!block.trim()) continue;
    if (block.startsWith(":")) continue;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        kinds.push(line.slice(6).trim());
        break;
      }
    }
  }
  return kinds;
}

