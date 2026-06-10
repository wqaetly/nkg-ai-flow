/**
 * Compiler MVP tests (Phase 3).
 *
 * Three slices of confidence:
 *   1. `compileDefinedNode` produces a deterministic, content-addressed
 *      artifact: same DefinedNode → same hash, byte-for-byte.
 *   2. `loadArtifactFromString` rehydrates the runner so calling it
 *      yields the same NodeResult as the original DefinedNode runner.
 *   3. End-to-end with the in-process sandbox: compile → load → feed
 *      the rehydrated runner into `InProcessSandboxAdapter` → execute
 *      → result matches the in-process baseline.
 *
 * Phase 3 MVP constraint (also documented in
 * `packages/compiler/src/compile.ts` and `docs/specs/sandbox.md` §6):
 * runners must be **self-contained** — no closure variables, no module
 * imports inside the function body. The SDK's `defineNode` currently
 * produces runners that capture local variables (configSchema, spec
 * etc.) so we don't run them through compileDefinedNode in the MVP;
 * instead these tests use a hand-written self-contained runner paired
 * with a minimal NodeTypeDefinition. A future compiler upgrade will
 * pre-bake the schema closure into the emitted source so vanilla
 * `defineNode` output also becomes self-contained.
 */
import { describe, expect, it } from "vitest";
import {
  compileDefinedNode,
  loadArtifactFromString,
  canonicalJSON,
  sha256Hex,
} from "../src/index.js";
import { InProcessSandboxAdapter } from "@ai-native-flow/sandbox";
import type {
  SandboxedNodeRunner,
  SandboxNodeContext,
} from "@ai-native-flow/sandbox";
import type { DefinedNode } from "@ai-native-flow/node-sdk";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a self-contained `DefinedNode`-shaped fixture. The runner is a
 * plain top-level function expression — its body references nothing
 * outside its own arguments, so `Function.prototype.toString()` round-
 * trips losslessly.
 */
function makeEchoNode(): DefinedNode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner: any = async function compiler_echo(
    input: Record<string, unknown>,
  ) {
    const cfg = (input.__config__ ?? {}) as { prefix?: string };
    const prefix = typeof cfg.prefix === "string" ? cfg.prefix : "hello";
    const name = typeof input.name === "string" ? input.name : "?";
    return {
      kind: "success",
      outputs: { out: null, message: `${prefix}:${name}` },
    };
  };
  return {
    definition: {
      type: "compiler_echo",
      typeVersion: "1.0.0",
      title: "Compiler Echo",
      defaultPorts: [
        { id: "in", direction: "input", kind: "control", label: "In" },
        { id: "out", direction: "output", kind: "control", label: "Out" },
      ],
      runtime: "builtin",
    },
    runner,
  };
}

function makeCtx(): SandboxNodeContext {
  return {
    runId: "r",
    nodeId: "n",
    nodeType: "compiler_echo",
    nodeVersion: "1.0.0",
    attempt: 1,
    signal: new AbortController().signal,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("compiler / compileDefinedNode (Phase 3 MVP)", () => {
  it("produces a deterministic content-addressed artifact for the same DefinedNode", async () => {
    const a1 = await compileDefinedNode(makeEchoNode());
    const a2 = await compileDefinedNode(makeEchoNode());

    // Identity fields match.
    expect(a1.type).toBe("compiler_echo");
    expect(a1.typeVersion).toBe("1.0.0");
    expect(a1.schemaVersion).toBe(1);
    // The runnerSrc is a function source string, not pretty-printed.
    expect(typeof a1.runnerSrc).toBe("string");
    expect(a1.runnerSrc.length).toBeGreaterThan(20);

    // Crucially: both compilations agree on the hash. This is the
    // identity promise used by hot-swap, replay, diffing, and artifact
    // deduplication.
    expect(a1.hash).toBe(a2.hash);
    // 64 hex chars == 256 bits.
    expect(a1.hash).toMatch(/^[0-9a-f]{64}$/);

    // Sanity-check the canonicaliser actually canonicalises: hash MUST
    // change if we tweak any input bit.
    const tampered = await sha256Hex(
      canonicalJSON({ ...a1, runnerSrc: a1.runnerSrc + "/*x*/" }),
    );
    expect(tampered).not.toBe(a1.hash);
  });

  it("loadArtifactFromString rehydrates a runner that matches the original behaviour", async () => {
    const node = makeEchoNode();
    const artifact = await compileDefinedNode(node);
    const { runner } = loadArtifactFromString(artifact);

    // Both runners run on identical inputs and must agree.
    const inputs = { __config__: { prefix: "Hi" }, name: "Node" };
    const ctx = makeCtx();
    const baseline = await (node.runner as unknown as SandboxedNodeRunner)(
      inputs,
      ctx,
    );
    const rehydrated = await runner(inputs, ctx);
    expect(rehydrated).toEqual(baseline);
    // And concretely: the rehydrated runner produces the templated message.
    expect(rehydrated).toEqual({
      kind: "success",
      outputs: { out: null, message: "Hi:Node" },
    });
  });

  it("end-to-end: compile → load → execute through the in-process sandbox", async () => {
    const artifact = await compileDefinedNode(makeEchoNode());
    const { runner } = loadArtifactFromString(artifact);

    const adapter = new InProcessSandboxAdapter();
    const handle = await adapter.load(runner, {
      type: artifact.type,
      typeVersion: artifact.typeVersion,
    });
    const result = await handle.execute(
      { __config__: { prefix: "Yo" }, name: "Sandbox" },
      makeCtx(),
    );
    expect(result).toEqual({
      kind: "success",
      outputs: { out: null, message: "Yo:Sandbox" },
    });
    await handle.dispose();
  });
});
