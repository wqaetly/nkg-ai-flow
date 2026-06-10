import { describe, expect, it } from "vitest";
import type { NodeEvent } from "@ai-native-flow/event-bus";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";

import { getBuiltinNodeDefinitions } from "../src/builtinDefinitions.js";
import type { NodeContext } from "../src/nodeContext.js";
import { createBuiltinRunnerRegistry } from "../src/nodes/createBuiltinRunnerRegistry.js";
import { DeterministicLlmProvider } from "./helpers/deterministicLlmProvider.js";

const BUILTIN_TYPES = [
  "start",
  "end",
  "transform",
  "condition",
  "http",
  "tool",
  "text_input",
  "llm",
  "agent",
  "event_trigger",
  "send_event",
] as const;

function testContext(): NodeContext {
  const variables = new InMemoryVariableStore();
  const noop = () => undefined;
  return {
    runId: "builtin_catalogue_test",
    flowId: "builtin_catalogue",
    flowVersion: "1.0.0",
    nodeId: "agent",
    nodeType: "agent",
    nodeVersion: "1.0.0",
    attempt: 1,
    variables,
    secrets: new InMemorySecretStore(),
    signal: new AbortController().signal,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    triggerEvent: async () => [],
    emit: async (): Promise<NodeEvent> => ({
      eventId: "event_1",
      seq: 1,
      runId: "builtin_catalogue_test",
      flowId: "builtin_catalogue",
      flowVersion: "1.0.0",
      nodeId: "agent",
      nodeVersion: "1.0.0",
      attempt: 1,
      timestamp: new Date().toISOString(),
      kind: "node_log",
      payload: { level: "info", message: "test" },
    }),
    stream: async () =>
      ({
        id: "stream_1",
        portId: "out",
        write: async () => undefined,
        close: async () => undefined,
        fail: async () => undefined,
      }),
  };
}

describe("runtime / built-in catalogue", () => {
  it("exposes exactly the current built-in definitions including agent", () => {
    const definitions = getBuiltinNodeDefinitions({
      llmProvider: new DeterministicLlmProvider(),
    });

    expect(definitions.map((definition) => definition.type)).toEqual(BUILTIN_TYPES);
    expect(new Set(definitions.map((definition) => definition.type)).size).toBe(
      BUILTIN_TYPES.length,
    );
    expect(definitions.map((definition) => definition.typeVersion)).toEqual(
      BUILTIN_TYPES.map(() => "1.0.0"),
    );

    const agent = definitions.find((definition) => definition.type === "agent");
    expect(agent?.defaultPorts.map((port) => port.id)).toEqual(
      expect.arrayContaining([
        "task",
        "context",
        "working_dir",
        "summary",
        "changed_files",
        "tool_log",
      ]),
    );
  });

  it("registers agent through the standard built-in runner catalogue", async () => {
    const registry = createBuiltinRunnerRegistry({
      llmProvider: new DeterministicLlmProvider({
        respond: () =>
          JSON.stringify({
            action: "final",
            summary: "agent runner reachable",
            context: { ok: true },
          }),
      }),
    });

    expect(registry.list().map((entry) => entry.type)).toEqual(BUILTIN_TYPES);
    expect(registry.has("agent", "1.0.0")).toBe(true);

    const runner = registry.get("agent", "1.0.0");
    const result = await runner(
      {
        __config__: { maxSteps: 1 },
        task: "finish without tools",
      },
      testContext(),
    );

    expect(result).toEqual({
      kind: "success",
      outputs: {
        out: {
          summary: "agent runner reachable",
          context: {
            ok: true,
            changed_files: [],
            written_files: [],
            verification_results: [],
          },
          changed_files: [],
          tool_log: [],
        },
        summary: "agent runner reachable",
        context: {
          ok: true,
          changed_files: [],
          written_files: [],
          verification_results: [],
        },
        changed_files: [],
        tool_log: [],
      },
    });
  });
});
