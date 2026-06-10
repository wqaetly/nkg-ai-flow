/**
 * Smoke tests for the Node SDK. These tests do **not** depend on the
 * runtime; they verify that `defineNode` / `defineNodeFactory` /
 * `installNode` form a closed, self-consistent contract.
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  defineNode,
  defineNodeFactory,
  installNode,
  isNodeFactory,
  type InstallTarget,
  type SdkNodeContext,
} from "../src/index.js";

/** A no-op `InstallTarget` that just records what it was given. */
function makeRecorderTarget() {
  const types: Array<{ type: string; typeVersion: string }> = [];
  const runners: Array<{
    type: string;
    typeVersion: string;
    runner: unknown;
  }> = [];
  const target: InstallTarget = {
    registerType(def) {
      types.push({ type: def.type, typeVersion: def.typeVersion });
    },
    registerRunner(type, typeVersion, runner) {
      runners.push({ type, typeVersion, runner });
    },
  };
  return { target, types, runners };
}

/** Bare-bones context fake good enough for a runner smoke test. */
function makeFakeCtx(): SdkNodeContext {
  return {
    runId: "run-1",
    flowId: "flow-1",
    flowVersion: "1",
    nodeId: "n1",
    nodeType: "extract-keywords",
    nodeVersion: "1.0.0",
    attempt: 0,
    signal: new AbortController().signal,
    variables: {
      getString: () => undefined,
      getNumber: () => undefined,
      getBoolean: () => undefined,
      get: () => undefined,
    },
    secrets: { get: () => undefined },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    triggerEvent: async () => [],
    emit: async () => undefined,
    stream: async () => undefined,
  };
}

describe("defineNode", () => {
  test("produces both definition and runner; runner reads __config__", async () => {
    const node = defineNode<
      { text: string },
      { topN: number },
      { keywords: string[]; out: null }
    >({
      type: "extract-keywords",
      typeVersion: "1.0.0",
      title: "Extract Keywords",
      config: z.object({ topN: z.number().default(10) }) as z.ZodType<{
        topN: number;
      }>,
      input: z.object({ text: z.string() }) as z.ZodType<{ text: string }>,
      run({ input, config }) {
        return {
          kind: "success",
          outputs: {
            out: null,
            keywords: input.text
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, config.topN),
          },
        };
      },
    });

    expect(node.definition.type).toBe("extract-keywords");
    expect(node.definition.typeVersion).toBe("1.0.0");
    // Auto-generated control + error ports.
    const portIds = node.definition.defaultPorts.map((p) => p.id).sort();
    expect(portIds).toContain("in");
    expect(portIds).toContain("out");
    expect(portIds).toContain("error");

    const result = await node.runner(
      { __config__: { topN: 2 }, text: "alpha beta gamma delta" },
      makeFakeCtx(),
    );
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.outputs.keywords).toEqual(["alpha", "beta"]);
    }
  });

  test("kind: pseudo skips auto control ports", () => {
    const node = defineNode({
      type: "start",
      typeVersion: "1.0.0",
      title: "Start",
      kind: "pseudo",
      ports: [
        { id: "out", direction: "output", kind: "control", label: "Out" },
      ],
      run() {
        return { kind: "success", outputs: { out: null } };
      },
    });
    expect(node.definition.defaultPorts.map((p) => p.id)).toEqual(["out"]);
  });

  test("config Zod failure surfaces as structured error", async () => {
    const node = defineNode({
      type: "needs-config",
      typeVersion: "1.0.0",
      title: "Needs Config",
      config: z.object({ topN: z.number() }) as z.ZodType<{ topN: number }>,
      run() {
        return { kind: "success", outputs: {} };
      },
    });
    const result = await node.runner(
      { __config__: { topN: "not-a-number" } },
      makeFakeCtx(),
    );
    expect(result.kind).toBe("error");
  });
});

describe("defineNodeFactory + installNode", () => {
  test("factory binds deps and installs into target", () => {
    interface Deps {
      llmProvider: { complete(p: string): string };
    }
    const llmNode = defineNodeFactory<Deps>(({ llmProvider }) =>
      defineNode({
        type: "llm",
        typeVersion: "1.0.0",
        title: "LLM",
        config: z.object({ prompt: z.string() }) as z.ZodType<{
          prompt: string;
        }>,
        run({ config }) {
          return {
            kind: "success",
            outputs: { out: null, result: llmProvider.complete(config.prompt) },
          };
        },
      }),
    );
    expect(isNodeFactory(llmNode)).toBe(true);

    const { target, types, runners } = makeRecorderTarget();
    installNode(target, llmNode, {
      llmProvider: { complete: (p) => `echo:${p}` },
    });
    expect(types).toEqual([{ type: "llm", typeVersion: "1.0.0" }]);
    expect(runners).toHaveLength(1);
    expect(runners[0]?.type).toBe("llm");
  });
});
