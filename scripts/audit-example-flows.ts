import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowGraph, NodeTypeRegistry } from "@ai-native-flow/flow-ir";
import { validateFlow } from "@ai-native-flow/flow-validator";
import {
  PORTABLE_CORE_CAPABILITIES,
  RUNTIME_CAPABILITIES,
  createBrowserRuntime,
  createRuntimeCapabilityManifest,
  inspectFlowCapabilities,
} from "@ai-native-flow/runtime/browser";
import { createNodeRuntime } from "@ai-native-flow/runtime/node";
import { flow as helloAgentFlow } from "../apps/hello-agent/helloagent.flow.js";
import {
  buildSkillToFlowFlow,
  buildSkillToFlowRegistry,
} from "../apps/skill-to-flow/build.js";
import {
  createDeterministicExampleProvider,
  createDeterministicSkillToFlowNodes,
  InMemoryAgentToolHost,
} from "./example-flow-fixtures.js";

const root = fileURLToPath(new URL("..", import.meta.url));
export const BUNDLED_EXAMPLE_SOURCES = [
  "apps/hello-agent/helloagent.flow.ts",
  "apps/skill-to-flow/flows/skill-to-flow.json",
  "apps/studio/flows/loop-block-showcase.json",
] as const;
const portableManifest = createRuntimeCapabilityManifest({
  platform: "portable",
  available: [...PORTABLE_CORE_CAPABILITIES, "filesystem.read"],
});

export interface ExampleFlowResult {
  id: string;
  source: string;
  structural: "passed" | "failed";
  execution: "passed" | "failed" | "not_applicable";
  deterministic: boolean;
  hostClass: "portable" | "desktop-power" | "unknown";
  missingPortableCapabilities: string[];
  output?: unknown;
  error?: string;
}

export interface ExampleFlowAudit {
  flows: ExampleFlowResult[];
  structural: { passed: number; total: number; rate: number };
  deterministicExecution: { passed: number; total: number; rate: number };
}

export async function auditBundledExampleFlows(): Promise<ExampleFlowAudit> {
  assertAuditManifestComplete();
  const flows = await Promise.all([
    auditLoopShowcase(),
    auditHelloAgent(),
    auditSkillToFlow(),
  ]);
  const structuralPassed = flows.filter((flow) => flow.structural === "passed").length;
  const deterministic = flows.filter((flow) => flow.deterministic);
  const executionPassed = deterministic.filter((flow) => flow.execution === "passed").length;
  return {
    flows,
    structural: metric(structuralPassed, flows.length),
    deterministicExecution: metric(executionPassed, deterministic.length),
  };
}

export function discoverBundledExampleFlowSources(): string[] {
  const files: string[] = [];
  visit(resolve(root, "apps"), files);
  return files.sort();
}

function assertAuditManifestComplete(): void {
  const discovered = discoverBundledExampleFlowSources();
  const declared = [...BUNDLED_EXAMPLE_SOURCES].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(declared)) {
    throw new Error(
      `bundled Flow audit manifest is stale: discovered=${JSON.stringify(discovered)} declared=${JSON.stringify(declared)}`,
    );
  }
}

async function auditLoopShowcase(): Promise<ExampleFlowResult> {
  const source = "apps/studio/flows/loop-block-showcase.json";
  return capture("loop_block_showcase", source, true, async () => {
    const graph = readGraph(source);
    const runtime = createBrowserRuntime({
      capabilities: portableManifest,
      generateRunId: () => "example_flow_audit_loop",
    });
    await runtime.registry.register({ graph, json: JSON.stringify(graph) });
    await runtime.registry.promote(graph.id, graph.version);
    const result = await runtime.invocationRouter.invoke({ flowId: graph.id, input: null });
    if (!result.succeeded) throw new Error("deterministic portable execution did not succeed");
    return resultFor(graph, runtime.nodeTypeRegistry, "passed", result.output);
  });
}

async function auditHelloAgent(): Promise<ExampleFlowResult> {
  const source = "apps/hello-agent/helloagent.flow.ts";
  return capture("helloagent", source, true, async () => {
    const graph = JSON.parse(helloAgentFlow.dump()) as FlowGraph;
    const llmProvider = createDeterministicExampleProvider();
    const portableToolHost = new InMemoryAgentToolHost();
    const runtime = createBrowserRuntime({
      llmProvider,
      toolHost: portableToolHost,
      capabilities: createRuntimeCapabilityManifest({
        platform: "desktop-power",
        available: RUNTIME_CAPABILITIES,
      }),
      generateRunId: () => "example_hello_portable",
    });
    await runtime.registry.register({ graph });
    await runtime.registry.promote(graph.id, graph.version);
    const portable = await runtime.invocationRouter.invoke({ flowId: graph.id, input: {} });
    const nodeRuntime = createNodeRuntime({
      llmProvider,
      toolHost: new InMemoryAgentToolHost(),
    });
    await nodeRuntime.registry.register({ graph });
    await nodeRuntime.registry.promote(graph.id, graph.version);
    const node = await nodeRuntime.invocationRouter.invoke({ flowId: graph.id, input: {} });
    assertParity("helloagent", portable, node);
    return resultFor(graph, runtime.nodeTypeRegistry, "passed", portable.output);
  });
}

async function auditSkillToFlow(): Promise<ExampleFlowResult> {
  const source = "apps/skill-to-flow/flows/skill-to-flow.json";
  return capture("skill_to_flow", source, true, async () => {
    const registry = buildSkillToFlowRegistry();
    const generated = buildSkillToFlowFlow().dump();
    const bundled = readFileSync(resolve(root, source), "utf8");
    if (!semanticallyEqualFlowJson(generated, bundled)) {
      throw new Error("bundled Flow JSON differs from buildSkillToFlowFlow().dump() output");
    }
    const graph = JSON.parse(bundled) as FlowGraph;
    assertValid(graph, registry);
    const llmProvider = createDeterministicExampleProvider();
    const nodes = createDeterministicSkillToFlowNodes(llmProvider);
    const runtime = createBrowserRuntime({
      llmProvider,
      nodes,
      toolHost: new InMemoryAgentToolHost(),
      capabilities: createRuntimeCapabilityManifest({
        platform: "desktop-power",
        available: RUNTIME_CAPABILITIES,
      }),
      generateRunId: () => "example_skill_portable",
    });
    await runtime.registry.register({ graph });
    await runtime.registry.promote(graph.id, graph.version);
    const input = {
      skill_content: "---\nname: fixture-skill\ndescription: fixture\n---\nReturn a deterministic result.",
      output_dir: "fixture-output",
    };
    const portable = await runtime.invocationRouter.invoke({ flowId: graph.id, input });
    const nodeRuntime = createNodeRuntime({
      llmProvider,
      nodes: createDeterministicSkillToFlowNodes(llmProvider),
      toolHost: new InMemoryAgentToolHost(),
    });
    await nodeRuntime.registry.register({ graph });
    await nodeRuntime.registry.promote(graph.id, graph.version);
    const node = await nodeRuntime.invocationRouter.invoke({ flowId: graph.id, input });
    assertParity("skill_to_flow", portable, node);
    return resultFor(graph, runtime.nodeTypeRegistry, "passed", portable.output);
  });
}

function assertParity(
  id: string,
  portable: { succeeded: boolean; output?: unknown },
  node: { succeeded: boolean; output?: unknown },
): void {
  if (!portable.succeeded || !node.succeeded) {
    throw new Error(`${id} fixture failed: portable=${JSON.stringify(portable)} node=${JSON.stringify(node)}`);
  }
  if (JSON.stringify(portable.output) !== JSON.stringify(node.output)) {
    throw new Error(`${id} output differs between portable and node runtimes`);
  }
}

export function semanticallyEqualFlowJson(left: string, right: string): boolean {
  return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
}

async function capture(
  id: string,
  source: string,
  deterministic: boolean,
  run: () => Promise<Omit<ExampleFlowResult, "id" | "source" | "structural" | "deterministic">>,
): Promise<ExampleFlowResult> {
  try {
    return { id, source, structural: "passed", ...(await run()), deterministic };
  } catch (cause) {
    return {
      id,
      source,
      structural: "failed",
      execution: "failed",
      deterministic,
      hostClass: "unknown",
      missingPortableCapabilities: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function resultFor(
  graph: FlowGraph,
  registry: NodeTypeRegistry,
  execution: ExampleFlowResult["execution"],
  output?: unknown,
): Omit<ExampleFlowResult, "id" | "source" | "structural" | "deterministic"> {
  assertValid(graph, registry);
  const missing = [...new Set(
    inspectFlowCapabilities(graph, registry, portableManifest)
      .flatMap((issue) => issue.missing),
  )].sort();
  return {
    execution,
    hostClass: missing.length === 0 ? "portable" : "desktop-power",
    missingPortableCapabilities: missing,
    ...(output !== undefined ? { output } : {}),
  };
}

function assertValid(graph: FlowGraph, registry: NodeTypeRegistry): void {
  const validation = validateFlow(graph, { registry });
  if (!validation.flow) {
    throw new Error(`Flow validation failed: ${JSON.stringify(validation.result.errors)}`);
  }
}

function readGraph(relativePath: string): FlowGraph {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as FlowGraph;
}

function visit(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["artifacts", "dist", "node_modules"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      visit(path, files);
      continue;
    }
    const normalized = relative(root, path).replaceAll("\\", "/");
    if (entry.name.endsWith(".flow.ts") ||
        (extname(entry.name) === ".json" && normalized.includes("/flows/"))) {
      files.push(normalized);
    }
  }
}

function metric(passed: number, total: number) {
  return { passed, total, rate: total === 0 ? 1 : passed / total };
}

async function main(): Promise<void> {
  const audit = await auditBundledExampleFlows();
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  if (audit.structural.rate !== 1 || audit.deterministicExecution.rate !== 1) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
