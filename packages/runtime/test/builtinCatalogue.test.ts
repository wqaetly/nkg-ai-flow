import { describe, expect, it } from "vitest";
import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { NodeConfigSchema, NodeTypeDefinition } from "@ai-native-flow/flow-ir";
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
  "error_classifier",
  "fallback",
  "transform",
  "approval",
  "audit_log",
  "batch_items",
  "batch_window",
  "branch_timeout",
  "cache",
  "checkpoint",
  "circuit_breaker",
  "compare_gate",
  "concat_items",
  "compensation",
  "condition",
  "cooldown_gate",
  "cron_schedule",
  "deadline",
  "dead_letter",
  "delete_path",
  "delay",
  "distinct_until_changed",
  "empty_gate",
  "expression_eval",
  "fail_fast",
  "filter_items",
  "flatten_items",
  "first_success",
  "group_items",
  "http",
  "idempotency_key",
  "join",
  "map_items",
  "merge",
  "merge_object",
  "metric",
  "mutex",
  "parallel",
  "partial_success",
  "parse_json",
  "policy_gate",
  "queue",
  "quorum",
  "race",
  "rate_limit",
  "reduce_items",
  "retry_policy",
  "retry_state",
  "resume_point",
  "rollback",
  "schedule_window",
  "schema_guard",
  "schema_transform",
  "select_path",
  "semaphore",
  "set_path",
  "slice_items",
  "sort_items",
  "split_text",
  "subflow",
  "subflow_template",
  "switch_case",
  "stringify_json",
  "tool",
  "unique_items",
  "window_items",
  "text_input",
  "wait_signal",
  "signal_resume",
  "wait_timer",
  "llm",
  "agent",
  "event_trigger",
  "feature_flag",
  "send_event",
  "state_get",
  "state_set",
  "foreach_begin",
  "foreach_end",
  "for_begin",
  "for_end",
  "loop_begin",
  "loop_break",
  "loop_continue",
  "loop_end",
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
    subflowDepth: 0,
    variables,
    secrets: new InMemorySecretStore(),
    signal: new AbortController().signal,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    triggerEvent: async () => [],
    invokeFlow: async () => ({
      runRecord: {
        schemaVersion: "run.record.v1",
        runId: "child_run",
        flowId: "child",
        flowVersion: "1.0.0",
        flowArtifactHash: "hash",
        status: "succeeded",
        input: null,
        createdAt: new Date().toISOString(),
      },
      succeeded: true,
      cancelled: false,
      output: null,
    }),
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

function configFields(definition: NodeTypeDefinition) {
  const schema = definition.configSchema as NodeConfigSchema | undefined;
  return Array.isArray(schema?.fields) ? schema.fields : [];
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

  it("uses long-text controls instead of dedicated JSON field controls", () => {
    const definitions = getBuiltinNodeDefinitions({
      llmProvider: new DeterministicLlmProvider(),
    });
    const fields = definitions.flatMap((definition) =>
      configFields(definition).map((field) => ({
        nodeType: definition.type,
        ...field,
      })),
    );

    expect(fields.filter((field) => field.control === "json")).toEqual([]);
    expect(
      fields.find(
        (field) => field.nodeType === "transform" && field.name === "value",
      )?.control,
    ).toBe("textarea");
    expect(
      fields.find(
        (field) => field.nodeType === "http" && field.name === "headers",
      )?.control,
    ).toBe("textarea");
    expect(
      fields.find((field) => field.nodeType === "http" && field.name === "body")
        ?.control,
    ).toBe("textarea");
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
