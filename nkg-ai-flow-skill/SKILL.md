---
name: nkg-ai-flow-skill
description: Guide AI agents to design, implement, validate, and document custom AI Native Flow apps in this repository. Use when creating or modifying a custom flow, adding custom nodes, wiring FlowBuilder graphs, preserving context between flow steps, preparing anf.app.json manifests, or turning workflow requirements into runnable apps under apps/*.
---

# Custom Flow Development

## Non-Negotiables

Treat a custom flow as a runnable app, not as an isolated JSON blob.

- Author the graph with TypeScript `FlowBuilder` code first; use exported JSON only as the generated artifact.
- Prefer existing built-in nodes before adding custom nodes.
- Preserve data lineage: every non-root step must consume an upstream output, a cumulative `context`, or an explicit static config/task.
- Use cumulative `context` for multi-step design, validation, repair, and materialization workflows.
- Use the built-in `agent` node for file edits, command execution, iterative verification, or materialization. Do not pretend deterministic nodes can perform filesystem or shell work.
- Treat each flow's companion env JSON as the runtime configuration source. Never base flow runtime configuration on `.env.local`.
- Validate by running the build/typecheck/test commands that actually exercise the changed app.

## First Pass

Before writing code, inspect the closest local reference:

| Need | Read |
|---|---|
| Built-in-only flow | `apps/hello-agent/helloagent.flow.ts` |
| App build runner | `apps/hello-agent/build.ts` |
| Custom-node pipeline | `apps/skill-to-flow/build.ts` |
| Custom node examples | `apps/skill-to-flow/nodes/*.ts` |
| Flow builder contract | `docs/specs/flow-builder.md` |
| Graph schema | `docs/specs/flow-graph-schema.md` |
| Workspace/app discovery | `docs/specs/workspace-model.md` and existing `anf.app.json` files |

If an existing app already does something close, extend that pattern instead of introducing a new shape.

## Environment Configuration

Flow runtime configuration is flow-scoped and artifact-adjacent.

Rules:

- Never instruct users or code to rely on `.env.local` for flow runtime configuration.
- For a flow artifact such as `src/agent-flow/hex-advisor.flow.json`, use sibling files:
  - `src/agent-flow/hex-advisor.flow.env.json` for committed defaults or non-sensitive placeholders.
  - `src/agent-flow/hex-advisor.flow.local.env.json` for local secrets and private runtime values.
- Ensure `*.flow.local.env.json` is ignored by git before writing local keys.
- Builder and Flow JSON config should reference values with `$var.NAME` / `$secret.NAME`; do not hardcode real keys, provider URLs, or model settings into graph JSON.
- Runtime entrypoints, smoke tests, and CLIs should read the sidecar via `createFlowScopedStores({ flowPath })` or an equivalent flow-scoped wrapper before calling `bootstrapDefaults(...)`.
- `.env.example` is documentation only. It can show names and migration hints, but it is not a runtime input source.
- Missing required values, placeholder secrets, and invalid sidecar contents must fail loudly. Do not add mock providers, empty defaults, `.env.local` fallback, or test-only bypasses.

## Design Procedure

### 1. Normalize the request

Write down the flow contract before coding:

```text
flow_id:
purpose:
caller_input:
final_output:
must_use_tools_or_services:
must_not_do:
acceptance_checks:
```

If the request is a skill-to-flow or AI-planning problem, extract goals, input/output contracts, constraints, acceptance criteria, and context handoff policy.

### 2. Choose the app shape

Use this decision:

| Situation | Shape |
|---|---|
| Simple prompt, transform, HTTP/tool call, or agent task | Built-in-only flow |
| Reusable domain behavior, strict input/output validation, or non-trivial parsing | Custom-node flow |
| Generates files, fixes code, runs shell, or verifies artifacts | Flow with `agent` materialization |
| Converts a high-level skill/workflow into a runnable package | Planner/designer/synthesizer/validator/materializer pipeline |

Do not create custom nodes for ordinary prompt templates or simple string/object reshaping; use `llm`, `text_input`, and `transform`.

### 3. Plan nodes and edges

Represent the flow as a table before implementing:

```text
step_id | node_type | purpose | inputs | outputs | upstream_dependencies | validation
```

Rules:

- Root steps read runtime input from `start.runInput` or a first explicit input node.
- Sequential work needs a control edge: `out -> in`.
- Data dependency needs a data edge: `some_output -> some_input`.
- A downstream step with no data edge is suspicious unless it only consumes static config.
- Multi-source reasoning should merge or pass a cumulative `context` object.
- Use stable IDs in lower snake case or lower kebab case. Avoid array-index-derived IDs.

## Built-In Node Use

Use these common built-ins before adding custom nodes:

| Node | Use for | Important ports/config |
|---|---|---|
| `start` | Flow entry | `out`; add a `runInput` output port in builder when wiring run input as data |
| `end` | Explicit completion | `in` |
| `text_input` | Static task/prompt text | output `text`, control `out` |
| `transform` | Static value or template mapping | input `input`, output `output`, config `template`, `expression`, or `value` |
| `llm` | Single model completion | input `prompt` when wired, output `result`, config model/baseUrl/apiKey/prompt |
| `agent` | Tool loop for files, grep, edits, write_files, bash | inputs `task`, `context`, `working_dir`; outputs `summary`, `context`, `changed_files`, `tool_log` |
| `condition` | Branching | Use only when both branch semantics and downstream edges are clear |
| `http` / `tool` | External deterministic calls | Prefer when the call contract is known |

For LLM/agent config, reuse runtime defaults from `@ai-native-flow/runtime`: `DEFAULT_LLM_BASE_URL_REF`, `DEFAULT_LLM_API_KEY_REF`, `DEFAULT_LLM_MODEL_REF`, `DEFAULT_LLM_TEMPERATURE`, and `DEFAULT_LLM_MAX_TOKENS`.

## Recommended App Layout

Create custom flows under `apps/<app-name>/` unless the user asks for a different location.

```text
apps/<app-name>/
  anf.app.json
  package.json
  tsconfig.json
  build.ts
  runtime.ts          optional, for CLI/runtime invocation
  cli.ts              optional, for terminal execution
  flows/              generated Flow JSON
  nodes/              only when custom nodes are needed
    index.ts
    <node>.ts
```

For a built-in-only flow that uses the builder-runner pattern, `<name>.flow.ts` plus `build.ts` is also acceptable, matching `apps/hello-agent`.

## Manifest Rules

`anf.app.json` must match real file locations.

Built-in-only:

```json
{
  "name": "my-flow-app",
  "flowDirs": ["flows"]
}
```

With custom nodes:

```json
{
  "name": "my-flow-app",
  "flowDirs": ["flows"],
  "nodePacks": ["nodes/index.ts"]
}
```

Do not list `nodePacks` if no custom node pack exists. Do not point `flowDirs` at a directory the build script does not write.

## Builder Pattern

Use this pattern for custom-node apps:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, type FlowBuilder } from "@ai-native-flow/flow-builder";
import {
  createDefaultRegistry,
  type InMemoryNodeTypeRegistry,
} from "@ai-native-flow/flow-ir";
import { installNode } from "@ai-native-flow/node-sdk";
import { getBuiltinNodeDefinitions } from "@ai-native-flow/runtime";

import { firstCustomNode } from "./nodes/firstCustomNode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildRegistry(): InMemoryNodeTypeRegistry {
  const registry = createDefaultRegistry();
  for (const def of getBuiltinNodeDefinitions()) {
    if (!registry.has(def.type, def.typeVersion)) registry.register(def);
  }
  for (const node of [firstCustomNode]) {
    installNode(
      {
        registerType: (def) => registry.register(def),
        registerRunner: () => undefined,
      },
      node,
    );
  }
  return registry;
}

export function buildFlow(): FlowBuilder {
  const registry = buildRegistry();
  const flow = defineFlow({
    id: "my_custom_flow",
    version: "1.0.0",
    label: "My Custom Flow",
    description: "What this flow does.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    registry,
  });

  const start = flow.node("start", {
    id: "node_start",
    label: "Start",
    position: { x: -200, y: 0 },
  });
  start.addPort({
    id: "runInput",
    direction: "output",
    kind: "data",
    label: "Run Input",
    schema: { type: "object" },
  });

  const first = flow.node("first_custom_node", {
    id: "first_custom_node",
    label: "First custom node",
    position: { x: 160, y: 0 },
    config: {},
  });

  flow.connect(start.out("out"), first.in("in"));
  flow.connect(start.out("runInput"), first.in("context"));

  return flow;
}

const FLOW_JSON_PATH = path.join(__dirname, "flows", "my_custom_flow.json");

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("build.ts")
) {
  const json = buildFlow().dump();
  mkdirSync(path.dirname(FLOW_JSON_PATH), { recursive: true });
  writeFileSync(FLOW_JSON_PATH, `${json}\n`, "utf8");
  console.log(`Wrote ${FLOW_JSON_PATH} (${json.length} bytes)`);
}
```

Use `flow.validate()` when you need to inspect validation errors without writing output. Use `flow.dump()` as the final gate because it throws on invalid graphs.

## Custom Node Pattern

Use `defineNode(...)` for every custom node.

```ts
import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";

const configSchema = z
  .object({
    strict: z.boolean().default(true),
  })
  .passthrough();

const inputSchema = z
  .object({
    context: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const firstCustomNode = defineNode({
  type: "first_custom_node",
  typeVersion: "1.0.0",
  title: "First Custom Node",
  description: "Explain the domain-specific behavior.",
  config: configSchema,
  input: inputSchema,
  fieldMeta: {
    strict: { label: "Strict mode", control: "switch", order: 1 },
  },
  ports: [
    {
      id: "context",
      direction: "input",
      kind: "data",
      label: "Context",
      schema: { type: "object" },
    },
    {
      id: "context",
      direction: "output",
      kind: "data",
      label: "Context",
      schema: { type: "object" },
    },
  ],
  async run({ input, config, ctx }) {
    const nextContext = {
      ...(input.context ?? {}),
      strict: config.strict,
    };
    ctx.log.info("first_custom_node: completed");
    return {
      kind: "success",
      outputs: {
        out: null,
        context: nextContext,
      },
    };
  },
});
```

Error results should be structured as `{ kind: "error", error: { code, message, kind, category } }`. Use these categories consistently:

- `user_input`: caller provided invalid or incomplete data.
- `author`: the flow/node was wired or configured incorrectly.
- `external`: network, tool, LLM provider, filesystem, or service failure.
- `validation`: generated artifact or schema failed validation.

## Context Handoff

Context is a contract, not a dumping ground.

Recommended shape:

```ts
interface FlowContext {
  requirements?: unknown;
  input?: unknown;
  plan?: unknown;
  artifacts?: Record<string, unknown>;
  validation?: {
    ok: boolean;
    errors: string[];
    warnings: string[];
  };
  unresolved_errors?: string[];
}
```

Guidelines:

- Keep the original user/caller input reachable from context until final reporting.
- When a node refines information, merge into context instead of replacing it wholesale.
- Put validation output under a stable field such as `validation` or `validator_status`.
- For generated files, pass structured file refs or file lists instead of copying long source strings into prompts.
- If a later node needs multiple upstream objects, either mark its `context` input as `multiple` in a custom port or add an explicit merge/transform node.
- Never let a node depend on "whatever the previous node probably did" without an edge.

## Agent Materialization

Use `agent` for operations that need tools.

Typical materialization wiring:

```ts
const task = flow.node("text_input", {
  id: "materialize_task",
  label: "Materialization task",
  position: { x: 800, y: 220 },
  config: {
    value: [
      "Write the generated package from context.materializationPlan.files.",
      "Run context.materializationPlan.verifyCommands when possible.",
      "Use validation errors and command output as repair context.",
      "Finish with summary and unresolved_errors only when problems remain.",
    ].join("\n"),
  },
});

const materializer = flow.node("agent", {
  id: "package_materializer",
  label: "Package materializer",
  position: { x: 1100, y: 0 },
  config: {
    baseUrl: DEFAULT_LLM_BASE_URL_REF,
    apiKey: DEFAULT_LLM_API_KEY_REF,
    model: DEFAULT_LLM_MODEL_REF,
    temperature: DEFAULT_LLM_TEMPERATURE,
    maxTokens: DEFAULT_LLM_MAX_TOKENS,
    workingDir: "./generated/my-flow-output",
    maxSteps: 30,
    allowBash: true,
    allowedTools: [
      "list_files",
      "read_file",
      "grep",
      "edit_file",
      "write_files",
      "run_bash",
    ],
    timeoutMs: 30_000,
    maxOutputChars: 40_000,
    systemPrompt:
      "You are a terse build agent. Use tools to write files, verify them, and repair failures. Stay inside working_dir.",
  },
});

flow.connect(upstream.out("context"), materializer.in("context"));
flow.connect(task.out("text"), materializer.in("task"));
flow.connect(task.out("out"), materializer.in("in"));
```

When configuring an agent:

- Set the narrowest useful `workingDir`.
- Keep `allowBash` false unless verification requires commands.
- Limit `allowedTools` to the task.
- Pass structured context; do not force the model to reconstruct filenames or command lists from prose.
- Let runtime-owned fields such as `changed_files`, `written_files`, `verification_results`, and `tool_log` come from tool logs, not model guesses.

## LLM Step Design

Use the built-in `llm` node for a single prompt/result step. Use a custom node only when the prompt must be wrapped with schema parsing, retries, domain-specific validation, or provider-level logic.

For LLM-heavy flows:

- Keep deterministic parsing before LLM steps.
- Use strict JSON schemas inside custom LLM nodes when downstream nodes need structured data.
- Feed previous validation errors back into the next LLM attempt.
- Make the output port name match the semantic object, such as `plan`, `node_specs`, `package`, or `report`.
- Use `temperature: 0` or the project default for repair/validation-sensitive steps.

## File Generation Flows

When a flow generates a runnable package, preserve these artifacts in context:

```text
package.files[]
package.buildScript
package.runtimeScript
package.cliScript
package.packageJson
package.tsconfig
package.nodesIndex
package.flowJsonFile
materializationPlan.files[]
materializationPlan.verifyCommands[]
```

Validation should happen before materialization when possible. Materialization should still run command verification after writing files.

## Verification

Run the narrowest command that proves the changed behavior.

Use `npx tsx apps/<app-name>/build.ts` plus `npm run typecheck` for a new or changed app. From inside an app directory, use `tsx build.ts` plus `npm run typecheck --if-present`. For shared package changes, run the targeted Vitest command and `npm run typecheck`. For this skill, run `python C:\Users\developli\.codex\skills\.system\skill-creator\scripts\quick_validate.py nkg-ai-flow-skill`.

If validation fails:

- Fix builder code, node definitions, ports, or registry setup.
- Do not patch generated JSON as the primary fix.
- Re-run the failing command.
- Record any command that could not be run and why.

## Common Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `unknown node type` | Custom node was not installed into the registry, or `nodePacks` is wrong | Register built-ins and custom nodes; update `anf.app.json` |
| `unknown port` | Builder connects a port not declared by defaults or custom ports | Inspect node definition; add a custom port or use the correct port name |
| Port kind mismatch | Connecting data to control or control to data | Add separate control and data edges |
| Downstream node has empty input | Missing data edge | Connect upstream semantic output to downstream semantic input |
| Agent does nothing useful | Task is vague or context is prose-only | Pass structured `task`, `context`, and `working_dir` |
| JSON artifact invalid | Direct JSON editing or stale build output | Fix builder source and regenerate |
| Studio cannot find flow | Manifest and output directory disagree | Align `anf.app.json.flowDirs` with build output |

## Completion Checklist

Before reporting completion:

- The flow is authored with `defineFlow(...)`, not final hand-written JSON.
- The app directory has the files needed for its intended execution mode.
- `anf.app.json` points to real flow and node pack locations.
- All custom nodes use `defineNode(...)` and expose explicit data ports.
- Control edges express ordering; data edges express dependency.
- Context handoff is explicit and preserves user input, requirements, validation, and generated artifacts where relevant.
- Agent nodes are used for file/shell/tool work and have constrained tools.
- The build command succeeds and writes the expected JSON.
- Typecheck or targeted tests have been run when TypeScript/runtime behavior changed.
- The final response includes changed files and verification commands.
