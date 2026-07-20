import {
  RuntimeErrorException,
  createRuntimeError,
  type FlowGraph,
  type NodeInstance,
  type NodeTypeRegistry,
} from "@ai-native-flow/flow-ir";

export const RUNTIME_CAPABILITIES = [
  "network.http",
  "storage.run",
  "storage.registry",
  "storage.artifact",
  "secret.read",
  "filesystem.read",
  "filesystem.write",
  "process.spawn",
  "notification.send",
  "lifecycle.checkpoint",
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface RuntimeCapabilityManifest {
  readonly available: ReadonlySet<RuntimeCapability>;
  readonly platform: string;
}

export interface FlowCapabilityIssue {
  nodeId: string;
  nodeType: string;
  nodeTypeVersion: string;
  missing: string[];
}

export const PORTABLE_CORE_CAPABILITIES: readonly RuntimeCapability[] = [
  "network.http",
  "storage.run",
  "storage.registry",
  "storage.artifact",
  "secret.read",
  "lifecycle.checkpoint",
];

export function createRuntimeCapabilityManifest(options: {
  platform?: string;
  available?: Iterable<RuntimeCapability>;
} = {}): RuntimeCapabilityManifest {
  return {
    platform: options.platform ?? "unknown",
    available: new Set(options.available ?? PORTABLE_CORE_CAPABILITIES),
  };
}

export function inspectFlowCapabilities(
  graph: FlowGraph,
  registry: NodeTypeRegistry,
  manifest: RuntimeCapabilityManifest,
): FlowCapabilityIssue[] {
  const issues: FlowCapabilityIssue[] = [];
  for (const node of graph.nodes) {
    const required = requiredCapabilities(node, registry);
    const missing = [...required].filter((item) =>
      !manifest.available.has(item as RuntimeCapability));
    if (missing.length > 0) {
      issues.push({
        nodeId: node.id,
        nodeType: node.type,
        nodeTypeVersion: node.typeVersion,
        missing: missing.sort(),
      });
    }
  }
  return issues;
}

export function assertFlowCapabilities(
  graph: FlowGraph,
  registry: NodeTypeRegistry,
  manifest: RuntimeCapabilityManifest,
): void {
  const issues = inspectFlowCapabilities(graph, registry, manifest);
  if (issues.length === 0) return;
  const first = issues[0]!;
  throw new RuntimeErrorException(createRuntimeError({
    code: "runtime.capability_missing",
    kind: "permission",
    category: "author",
    message: `node ${first.nodeId} (${first.nodeType}) requires unavailable capabilities: ${first.missing.join(", ")}`,
    source: {
      module: "registry",
      flowId: graph.id,
      flowVersion: graph.version,
      nodeId: first.nodeId,
    },
    context: {
      platform: manifest.platform,
      nodeId: first.nodeId,
      nodeType: first.nodeType,
      nodeTypeVersion: first.nodeTypeVersion,
      missingCapabilities: first.missing,
      availableCapabilities: [...manifest.available].sort(),
      issues,
    },
  }));
}

function requiredCapabilities(
  node: NodeInstance,
  registry: NodeTypeRegistry,
): Set<string> {
  const required = new Set(
    registry.getCapabilities(node.type, node.typeVersion).requiredPermissions,
  );
  switch (node.type) {
    case "http":
      required.add("network.http");
      break;
    case "llm":
      required.add("network.http");
      required.add("secret.read");
      break;
    case "checkpoint":
    case "resume_point":
    case "wait_signal":
    case "wait_timer":
    case "signal_resume":
      required.add("lifecycle.checkpoint");
      break;
    case "tool":
      addToolCapabilities(required, configuredTools(node, false));
      break;
    case "agent":
      required.add("network.http");
      required.add("secret.read");
      addToolCapabilities(required, configuredTools(node, true));
      break;
  }
  return required;
}

function configuredTools(node: NodeInstance, agent: boolean): string[] {
  const config = node.config as Record<string, unknown>;
  if (!agent && typeof config.tool === "string" && config.tool.trim()) {
    return [config.tool.trim()];
  }
  const configured = Array.isArray(config.allowedTools)
    ? config.allowedTools.filter((item): item is string => typeof item === "string")
    : [];
  const tools = configured.length > 0
    ? configured
    : ["list_files", "read_file", "grep", "edit_file", "write_files", "run_bash"];
  return config.allowBash === true ? tools : tools.filter((tool) => tool !== "run_bash");
}

function addToolCapabilities(required: Set<string>, tools: readonly string[]): void {
  if (tools.some((tool) => ["list_files", "read_file", "grep"].includes(tool))) {
    required.add("filesystem.read");
  }
  if (tools.some((tool) => ["edit_file", "write_files"].includes(tool))) {
    required.add("filesystem.write");
  }
  if (tools.includes("run_bash")) required.add("process.spawn");
}
