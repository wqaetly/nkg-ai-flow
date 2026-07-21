import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  PORTABLE_CORE_CAPABILITIES,
  createBrowserRuntime,
  createRuntimeCapabilityManifest,
} from "../src/browser.js";
import { createNodeRuntime } from "../src/node.js";

function toolFlow(tool: string, allowBash = false) {
  const runtime = createBrowserRuntime();
  const flow = defineFlow({
    id: `tool_${tool}`,
    version: "1.0.0",
    registry: runtime.nodeTypeRegistry,
  });
  const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
  const toolNode = flow.node("tool", {
    id: "tool",
    position: { x: 100, y: 0 },
    config: { tool, allowBash },
  });
  const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
  flow.connect(start.out("out"), toolNode.in("in"));
  flow.connect(toolNode.out("out"), end.in("in"));
  return { runtime, graph: JSON.parse(flow.dump()) };
}

describe("Runtime capability preflight", () => {
  it("reports node, platform, and missing capability before registering a Flow", async () => {
    const { runtime, graph } = toolFlow("write_files");

    const failure = await runtime.registry.register({ graph }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeErrorException);
    expect((failure as RuntimeErrorException).error).toMatchObject({
      code: "runtime.capability_missing",
      kind: "permission",
      source: { nodeId: "tool" },
      context: {
        platform: "portable",
        nodeType: "tool",
        missingCapabilities: ["filesystem.write"],
      },
    });
    expect(await runtime.registry.list(graph.id)).toEqual([]);
  });

  it("allows a read-only tool when the host explicitly exposes filesystem.read", async () => {
    const runtime = createBrowserRuntime({
      capabilities: createRuntimeCapabilityManifest({
        platform: "ios",
        available: [...PORTABLE_CORE_CAPABILITIES, "filesystem.read"],
      }),
    });
    const flow = defineFlow({ id: "read_only", version: "1.0.0", registry: runtime.nodeTypeRegistry });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const read = flow.node("tool", {
      id: "read",
      position: { x: 100, y: 0 },
      config: { tool: "read_file" },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), read.in("in"));
    flow.connect(read.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());

    await expect(runtime.registry.register({ graph })).resolves.toMatchObject({
      flowId: "read_only",
    });
  });

  it("requires process.spawn when a direct tool selects run_bash", async () => {
    const { runtime, graph } = toolFlow("run_bash", true);

    await expect(runtime.registry.register({ graph })).rejects.toMatchObject({
      error: {
        code: "runtime.capability_missing",
        context: { missingCapabilities: ["process.spawn"] },
      },
    });
  });

  it("lets the explicit Node host register filesystem and process tools", async () => {
    const runtime = createNodeRuntime();
    const flow = defineFlow({
      id: "node_tools",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const write = flow.node("tool", {
      id: "write",
      position: { x: 100, y: 0 },
      config: { tool: "write_files" },
    });
    const shell = flow.node("tool", {
      id: "shell",
      position: { x: 200, y: 0 },
      config: { tool: "run_bash", allowBash: true },
    });
    flow.connect(start.out("out"), write.in("in"));
    flow.connect(write.out("out"), shell.in("in"));

    await expect(runtime.registry.register({ graph: JSON.parse(flow.dump()) }))
      .resolves.toMatchObject({ flowId: "node_tools" });
  });

  it("rechecks capabilities when a stored Flow is resolved for execution", async () => {
    const available = new Set([
      ...PORTABLE_CORE_CAPABILITIES,
      "filesystem.read",
    ] as const);
    const runtime = createBrowserRuntime({
      capabilities: { platform: "android", available },
    });
    const flow = defineFlow({ id: "resolved_read", version: "1.0.0", registry: runtime.nodeTypeRegistry });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const read = flow.node("tool", {
      id: "read",
      position: { x: 100, y: 0 },
      config: { tool: "read_file" },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), read.in("in"));
    flow.connect(read.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());
    await runtime.registry.register({ graph });

    available.delete("filesystem.read");

    await expect(runtime.registry.resolve(graph.id, graph.version)).rejects.toMatchObject({
      error: {
        code: "runtime.capability_missing",
        context: { missingCapabilities: ["filesystem.read"] },
      },
    });
  });

  it("propagates custom node capability declarations through the SDK install path", async () => {
    const notify = defineNode({
      type: "notify",
      typeVersion: "1.0.0",
      title: "Notify",
      capabilities: { requiredPermissions: ["notification.send"] },
      run() { return { kind: "success", outputs: { out: null } }; },
    });
    const runtime = createBrowserRuntime({
      nodes: [notify],
      capabilities: createRuntimeCapabilityManifest({ platform: "android" }),
    });
    expect(runtime.nodeTypeRegistry.getCapabilities("notify").requiredPermissions)
      .toEqual(["notification.send"]);

    const flow = defineFlow({ id: "notify", version: "1.0.0", registry: runtime.nodeTypeRegistry });
    flow.node("notify", { id: "notify", position: { x: 0, y: 0 } });
    await expect(runtime.registry.register({ graph: JSON.parse(flow.dump()) }))
      .rejects.toMatchObject({
        error: {
          code: "runtime.capability_missing",
          context: { missingCapabilities: ["notification.send"] },
        },
      });
  });

  it("publishes built-in capability metadata for Studio badges", () => {
    const runtime = createBrowserRuntime();
    expect(runtime.nodeTypeRegistry.getCapabilities("http").requiredPermissions)
      .toEqual(["network.http"]);
    expect(runtime.nodeTypeRegistry.getCapabilities("checkpoint")).toMatchObject({
      supportsCheckpoint: true,
      requiredPermissions: ["lifecycle.checkpoint"],
    });
  });
});
