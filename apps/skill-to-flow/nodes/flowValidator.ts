/**
 * `flow_validator` — final, deterministic stage of the pipeline.
 *
 * Replaces the previous string-grep validator. We now feed the
 * synthesised FlowGraph to the project's first-class validator
 * (`@ai-native-flow/flow-validator`) so structural errors (missing
 * ports, dangling edges, dup node ids, port-kind mismatch, cycles)
 * are caught with the same rigour the runtime applies at load time.
 *
 * On top of graph validation we run a few light TS-source sanity
 * checks — verifying every synthesised file mentions `defineNode` and
 * exports something useful — and surface the result as soft warnings.
 */

import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";

import {
  createDefaultRegistry,
  type FlowGraph,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import { validateGraph } from "@ai-native-flow/flow-validator";
import { getBuiltinNodeDefinitions } from "@ai-native-flow/runtime";

import type {
  FlowArtifact,
  GeneratedFlowPackage,
  MaterializationPlan,
  NodeSpec,
  PackageFileIssue,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

const flowValidatorConfig = z
  .object({
    /** When true, any warning is promoted to an error. Default false. */
    strict: z.boolean().default(false),
    /**
     * Run TS-source lint checks (defineNode + exports). Disabled by
     * default for very large packages where the regexes get slow.
     * Cheap package file-path safety checks always run.
     */
    lint_sources: z.boolean().default(true),
  })
  .passthrough();
type FlowValidatorConfig = z.infer<typeof flowValidatorConfig>;

/* -------------------------------------------------------------------------- */
/* node                                                                       */
/* -------------------------------------------------------------------------- */

export const flowValidatorNode = defineNode({
  type: "flow_validator",
  typeVersion: "1.0.0",
  title: "Flow 验证器",
  description:
    "调用 @ai-native-flow/flow-validator 对生成的 FlowGraph 做真校验，并对生成的 TS 源码做最小 lint，输出 FlowArtifact。",
  config: flowValidatorConfig,
  fieldMeta: {
    strict: { label: "严格模式（warning 视为 error）", control: "switch", order: 1 },
    lint_sources: { label: "校验生成 TS 源码", control: "switch", order: 2 },
  },
  ports: [
    {
      id: "package",
      direction: "input",
      kind: "data",
      label: "GeneratedFlowPackage",
    },
    {
      id: "node_specs",
      direction: "input",
      kind: "data",
      label: "NodeSpec[]",
    },
    {
      id: "artifact",
      direction: "output",
      kind: "data",
      label: "FlowArtifact",
      schema: { type: "object" },
    },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const cfg = config as FlowValidatorConfig;
    const raw = input as Record<string, unknown>;
    const pkg = raw.package as GeneratedFlowPackage | undefined;
    const specs = (raw.node_specs ?? []) as NodeSpec[];

    if (!pkg) {
      return {
        kind: "error",
        error: {
          code: "node.flow_validator.missing_package",
          message:
            "flow_validator: input port `package` is empty. Wire it from `code_synthesizer`.",
          kind: "validation",
          category: "author",
        },
      };
    }

    const flowGraph = pkg.flowGraph as FlowGraph | undefined;
    if (!flowGraph || !Array.isArray(flowGraph.nodes)) {
      return {
        kind: "error",
        error: {
          code: "node.flow_validator.invalid_graph",
          message:
            "flow_validator: package.flowGraph is missing or malformed. The synthesizer should populate it before validation.",
          kind: "validation",
          category: "author",
        },
      };
    }

    // Build a registry that knows about the synthesized custom node
    // types so `validateGraph` can check port presence too.
    const registry = createDefaultRegistry();
    const builtinTypes = new Set<string>();
    for (const def of getBuiltinNodeDefinitions()) {
      builtinTypes.add(def.type);
      if (!registry.has(def.type, def.typeVersion)) registry.register(def);
    }
    const specRegistrationErrors: string[] = [];
    for (const spec of specs) {
      const key = nodeTypeKey(spec.nodeType, spec.typeVersion);
      if (builtinTypes.has(spec.nodeType)) {
        specRegistrationErrors.push(
          `node_spec.builtin_type_collision: nodeType "${spec.nodeType}"@${spec.typeVersion} conflicts with a runtime built-in node; use a skill-scoped custom nodeType instead`,
        );
        continue;
      }
      if (registry.has(spec.nodeType, spec.typeVersion)) {
        specRegistrationErrors.push(
          `node_spec.duplicate_type: duplicate generated nodeType "${spec.nodeType}"@${spec.typeVersion}`,
        );
        continue;
      }
      const def: NodeTypeDefinition = {
        type: spec.nodeType,
        typeVersion: spec.typeVersion,
        title: spec.title,
        defaultPorts: [
          { id: "in", direction: "input", kind: "control", label: "In" },
          { id: "out", direction: "output", kind: "control", label: "Out" },
          ...spec.inputPorts.map((p) => ({
            id: p.id,
            direction: "input" as const,
            kind: p.kind,
            label: p.label || p.id,
            ...(p.multiple !== undefined ? { multiple: p.multiple } : {}),
          })),
          ...spec.outputPorts.map((p) => ({
            id: p.id,
            direction: "output" as const,
            kind: p.kind,
            label: p.label || p.id,
            ...(p.multiple !== undefined ? { multiple: p.multiple } : {}),
          })),
          { id: "error", direction: "output", kind: "error", label: "Error" },
        ],
        runtime: "builtin",
      };
      try {
        registry.register(def);
      } catch (cause) {
        specRegistrationErrors.push(
          `node_spec.registry_error: failed to register "${spec.nodeType}"@${spec.typeVersion}: ${(cause as Error).message}`,
        );
      }
    }

    const result = validateGraph(flowGraph, { registry });

    const errors = [
      ...specRegistrationErrors,
      ...result.errors.map((e) => `${e.code}: ${e.message}`),
    ];
    const warnings = result.warnings.map((e) => `${e.code}: ${e.message}`);

    const fileIssues = collectGeneratedPackageFileIssues(pkg);
    warnings.push(...fileIssues.map(formatPackageFileIssue));
    if (cfg.lint_sources) {
      const lint = lintGeneratedSources(pkg, specs);
      warnings.push(...lint);
    }

    const finalErrors = cfg.strict ? [...errors, ...warnings] : errors;
    const isValid = finalErrors.length === 0;

    const artifact: FlowArtifact = {
      skillName: pkg.skillName,
      flowId: pkg.flowId,
      flowVersion: pkg.flowVersion,
      requirements: pkg.requirements,
      nodeCount: flowGraph.nodes.length,
      edgeCount: Array.isArray(flowGraph.edges) ? flowGraph.edges.length : 0,
      isValid,
      errors: finalErrors,
      warnings: cfg.strict ? [] : warnings,
      fileIssues,
      package: pkg,
      materializationPlan: buildMaterializationPlan(pkg),
    };

    ctx.log.info("flow_validator: done", {
      isValid,
      nodes: artifact.nodeCount,
      edges: artifact.edgeCount,
      errors: finalErrors.length,
      warnings: warnings.length,
    });

    return {
      kind: "success",
      outputs: { out: null, artifact },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* lint helpers                                                                */
/* -------------------------------------------------------------------------- */

function lintGeneratedSources(
  pkg: GeneratedFlowPackage,
  specs: readonly NodeSpec[],
): string[] {
  const warnings: string[] = [];
  const sourcesByType = new Map<string, string>();
  for (const file of pkg.files) {
    if (!file.path.endsWith(".ts")) continue;
    if (file.path.endsWith("/_llm.ts") || file.path.endsWith("/index.ts"))
      continue;
    sourcesByType.set(file.path, file.contents);
  }

  for (const spec of specs) {
    const matchingFile = [...sourcesByType.entries()].find(([p, src]) =>
      p.includes(spec.nodeType) ||
      p.includes(toCamelCase(spec.nodeType)) ||
      src.includes(`type: "${spec.nodeType}"`),
    );
    if (!matchingFile) {
      warnings.push(
        `lint.missing_source: no .ts file matches nodeType "${spec.nodeType}"`,
      );
      continue;
    }
    const [filePath, src] = matchingFile;
    if (!src.includes("defineNode")) {
      warnings.push(
        `lint.no_define_node: ${filePath} does not call defineNode(...)`,
      );
    }
    if (!src.includes(`type: "${spec.nodeType}"`)) {
      warnings.push(
        `lint.type_mismatch: ${filePath} does not declare type: "${spec.nodeType}"`,
      );
    }
    if (!/export\s+(const|default|function)/.test(src)) {
      warnings.push(`lint.no_export: ${filePath} has no top-level export`);
    }
    if (
      (spec.requiresLlm || spec.implementation.strategy === "llm_prompt") &&
      !sourceCallsLlmHelper(src)
    ) {
      warnings.push(
        `lint.llm_call_missing: ${filePath} is an LLM node but does not call chat/chatJson from ./_llm.js`,
      );
    }
    if (
      (spec.requiresLlm || spec.implementation.strategy === "llm_prompt") &&
      sourceCallsLlmHelper(src) &&
      !sourcePassesCtxToLlmHelper(src)
    ) {
      warnings.push(
        `lint.llm_ctx_missing: ${filePath} calls chat/chatJson but does not pass ctx, so run-scoped variables may be lost`,
      );
    }
    if (
      (spec.requiresLlm || spec.implementation.strategy === "llm_prompt") &&
      sourceCallsLlmHelper(src) &&
      sourcePassesCtxToLlmHelper(src) &&
      !sourceBindsCtxInRun(src)
    ) {
      warnings.push(
        `lint.llm_ctx_unbound: ${filePath} passes ctx to chat/chatJson but run() does not bind ctx from the runtime node context`,
      );
    }
    for (const port of [...spec.inputPorts, ...spec.outputPorts]) {
      if (!port.multiple) continue;
      if (!sourceDeclaresMultiplePort(src, port.id)) {
        warnings.push(
          `lint.multiple_port_missing: ${filePath} does not preserve multiple: true for port "${port.id}"`,
        );
      }
    }
    if (
      spec.inputPorts.some((p) => p.id === "context" && p.multiple) &&
      !sourceHandlesContextArray(src)
    ) {
      warnings.push(
        `lint.context_array_merge_missing: ${filePath} does not handle array-valued raw.context for multiple context input`,
      );
    }
    if (
      spec.inputPorts.some((p) => p.id === "context") &&
      !sourceReferencesInputPort(src, "context")
    ) {
      warnings.push(
        `lint.context_input_unused: ${filePath} declares context input but does not read raw.context`,
      );
    }
    for (const port of spec.outputPorts) {
      if (port.kind !== "data") continue;
      if (!sourceReturnsOutputPort(src, port.id)) {
        warnings.push(
          `lint.output_not_returned: ${filePath} does not return output port "${port.id}" from run()`,
        );
      }
    }
  }
  return warnings;
}

function nodeTypeKey(type: string, version: string): string {
  return `${type}@${version}`;
}

function collectGeneratedPackageFileIssues(
  pkg: GeneratedFlowPackage,
): PackageFileIssue[] {
  const issues: PackageFileIssue[] = [];
  const seen = new Set<string>();
  for (const file of buildMaterializationFileRefs(pkg)) {
    const pathKey = generatedPathKey(file.path);
    if (isUnsafeGeneratedPath(file.path)) {
      issues.push(packageFileIssue("unsafe_file_path", file));
    }
    if (file.path.includes("\\")) {
      issues.push(packageFileIssue("non_posix_file_path", file));
    }
    if (/[\\/]$/.test(file.path)) {
      issues.push(packageFileIssue("directory_file_path", file));
    }
    if (seen.has(pathKey)) {
      issues.push(packageFileIssue("duplicate_file_path", file));
    }
    seen.add(pathKey);
  }
  return issues;
}

function lintGeneratedPackageFiles(pkg: GeneratedFlowPackage): string[] {
  return collectGeneratedPackageFileIssues(pkg).map(formatPackageFileIssue);
}

function packageFileIssue(
  kind: PackageFileIssue["kind"],
  file: MaterializationPlan["files"][number],
): PackageFileIssue {
  const { path, pathRef, contentsRef } = file;
  const message =
    kind === "unsafe_file_path"
      ? `generated package file path "${path}" must be relative and stay inside the output directory`
      : kind === "non_posix_file_path"
        ? `generated package file path "${path}" should use "/" separators`
        : kind === "directory_file_path"
          ? `generated package file path "${path}" must point to a file, not a directory`
          : `generated package contains duplicate file path "${path}"`;
  return { kind, path, pathRef, contentsRef, message };
}

function formatPackageFileIssue(issue: PackageFileIssue): string {
  return `lint.${issue.kind}: ${issue.message}`;
}

function generatedPathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function isUnsafeGeneratedPath(filePath: string): boolean {
  if (!filePath.trim()) return true;
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return true;
  return filePath.split(/[\\/]+/).includes("..");
}

function buildMaterializationPlan(pkg: GeneratedFlowPackage): MaterializationPlan {
  return {
    files: buildMaterializationFileRefs(pkg),
    verifyCommands: ["npx tsx build.ts", "npm run typecheck --if-present"],
  };
}

function buildMaterializationFileRefs(
  pkg: GeneratedFlowPackage,
): MaterializationPlan["files"] {
  return [
    ...pkg.files.map((file, index) => ({
      role: file.path.endsWith("/_llm.ts") ? "llm_helper" : "node_source",
      path: file.path,
      pathRef: `package.files.${index}.path`,
      contentsRef: `package.files.${index}.contents`,
    })),
    {
      role: "nodes_index",
      path: pkg.nodesIndex.path,
      pathRef: "package.nodesIndex.path",
      contentsRef: "package.nodesIndex.contents",
    },
    {
      role: "build_script",
      path: pkg.buildScript.path,
      pathRef: "package.buildScript.path",
      contentsRef: "package.buildScript.contents",
    },
    {
      role: "runtime_script",
      path: pkg.runtimeScript.path,
      pathRef: "package.runtimeScript.path",
      contentsRef: "package.runtimeScript.contents",
    },
    {
      role: "cli_script",
      path: pkg.cliScript.path,
      pathRef: "package.cliScript.path",
      contentsRef: "package.cliScript.contents",
    },
    {
      role: "package_json",
      path: pkg.packageJson.path,
      pathRef: "package.packageJson.path",
      contentsRef: "package.packageJson.contents",
    },
    {
      role: "tsconfig",
      path: pkg.tsconfig.path,
      pathRef: "package.tsconfig.path",
      contentsRef: "package.tsconfig.contents",
    },
    {
      role: "flow_json",
      path: pkg.flowJsonFile.path,
      pathRef: "package.flowJsonFile.path",
      contentsRef: "package.flowJsonFile.contents",
    },
    {
      role: "readme",
      path: pkg.readme.path,
      pathRef: "package.readme.path",
      contentsRef: "package.readme.contents",
    },
  ];
}

function sourceDeclaresMultiplePort(source: string, portId: string): boolean {
  const id = escapeRegExp(portId);
  const idThenMultiple = new RegExp(
    `id\\s*:\\s*["']${id}["'][\\s\\S]{0,240}?multiple\\s*:\\s*true`,
  );
  const multipleThenId = new RegExp(
    `multiple\\s*:\\s*true[\\s\\S]{0,240}?id\\s*:\\s*["']${id}["']`,
  );
  return idThenMultiple.test(source) || multipleThenId.test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceHandlesContextArray(source: string): boolean {
  return /Array\.isArray\s*\([^)]*context[^)]*\)/.test(source);
}

function sourceCallsLlmHelper(source: string): boolean {
  const importsLlmHelper = /from\s+["']\.\/_llm\.js["']/.test(source);
  const callsChat = /\bchat(?:Json)?\s*\(/.test(source);
  return importsLlmHelper && callsChat;
}

function sourcePassesCtxToLlmHelper(source: string): boolean {
  return /\bchat(?:Json)?\s*\(\s*{[\s\S]{0,800}\bctx\b/.test(source);
}

function sourceBindsCtxInRun(source: string): boolean {
  return /(?:async\s+)?run\s*\(\s*{[\s\S]{0,240}\bctx\b[\s\S]{0,240}}\s*\)/.test(
    source,
  );
}

function sourceReturnsOutputPort(source: string, portId: string): boolean {
  const id = escapeRegExp(portId);
  const objectKey = new RegExp(`(?:["']${id}["']\\s*:|\\b${id}\\b)`);
  const outputObjects = source.matchAll(/outputs\s*:\s*{([\s\S]{0,800}?)}/g);
  for (const match of outputObjects) {
    if (objectKey.test(match[1] ?? "")) return true;
  }
  return false;
}

function sourceReferencesInputPort(source: string, portId: string): boolean {
  const id = escapeRegExp(portId);
  const directRead = new RegExp(
    `(?:raw|input)\\s*(?:\\.\\s*${id}|\\[\\s*["']${id}["']\\s*\\])`,
  );
  const destructuredRead = new RegExp(
    `(?:const|let|var)\\s*{[\\s\\S]{0,240}\\b${id}\\b[\\s\\S]{0,240}}\\s*=\\s*(?:raw|input)\\b`,
  );
  return directRead.test(source) || destructuredRead.test(source);
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

export const __testing = {
  buildMaterializationPlan,
  collectGeneratedPackageFileIssues,
  lintGeneratedPackageFiles,
  lintGeneratedSources,
};
