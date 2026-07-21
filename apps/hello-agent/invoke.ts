/**
 * Self-contained Hello Agent invoke example.
 *
 * Run:
 *   tsx apps/hello-agent/invoke.ts
 */

import { createNodeRuntime, type LlmProvider } from "@ai-native-flow/runtime/node";
import { bootstrapDefaults } from "@ai-native-flow/variable-store";
import flow from "./helloagent.flow.js";
import { writeRunLog } from "./writeRunLog.js";

bootstrapDefaults({
  env: null,
});

const demoProvider: LlmProvider = {
  async complete(req) {
    if (req.prompt.includes("Previous observations: none")) {
      return {
        text: JSON.stringify({
          action: "edit_file",
          args: {
            path: "helloagent.cs",
            create: true,
            new_text: [
              "using System;",
              "",
              "public class Program",
              "{",
              "    public static void Main()",
              "    {",
              "        Console.WriteLine(\"HelloAgent\");",
              "    }",
              "}",
              "",
            ].join("\n"),
          },
        }),
      };
    }

    return {
      text: JSON.stringify({
        action: "final",
        summary: "created helloagent.cs on the desktop",
        context: { language: "csharp", file: "helloagent.cs" },
      }),
    };
  },
};

const runtime = createNodeRuntime({ llmProvider: demoProvider });
const json = flow.dump();
await runtime.registry.register({ graph: JSON.parse(json), json });
await runtime.registry.promote("helloagent", "1.0.0");

const result = await runtime.invocationRouter.invokeNode({
  flowId: "helloagent",
  input: {},
  nodeId: "agent_create_helloagent",
});

const { jsonPath, textPath } = await writeRunLog(runtime, result);

console.log(JSON.stringify({
  succeeded: result.succeeded,
  status: result.runRecord.status,
  output: result.output,
  runId: result.runRecord.runId,
  log: { json: jsonPath, text: textPath },
}, null, 2));
