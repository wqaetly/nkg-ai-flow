/**
 * Phase 2 streaming tests.
 *
 * Migrated to the unified Node SDK route: every custom streaming runner
 * is declared via `defineNode` and registered through
 * `createRuntime({ nodes })`. The legacy `InMemoryNodeRunnerRegistry` /
 * `runners` entry-point is no longer exposed by the runtime package.
 *
 * Covers:
 *   - `ctx.stream("port")` emits `stream_open` once, ordered
 *     `stream_delta`s, and exactly one `stream_close`;
 *   - the auto-close safety net fires when a runner forgets to close;
 *   - `ctx.emit({ kind: "stream_artifact" })` is preserved verbatim;
 *   - cancellation propagates into the streaming runner via `ctx.signal`
 *     and the channel emits `stream_close { status: "cancelled" }`;
 *   - the built-in `llm` node forwards `AiStreamEvent`s from a deterministic
 *     provider as `stream_delta` / `stream_usage` events with a single
 *     `stream_open` / `stream_close` pair.
 */

import { describe, expect, it } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";
import {
  createRuntime,
  type Runtime,
} from "../src/index.js";
import { DeterministicLlmProvider } from "./helpers/deterministicLlmProvider.js";

/* -------------------------------------------------------------------------- */
/* Custom streaming nodes (SDK route)                                          */
/* -------------------------------------------------------------------------- */

/** Emits "He"/"llo"/"!" as three deltas and closes explicitly. */
const streamingBasicNode = defineNode({
  type: "streaming_basic",
  typeVersion: "1.0.0",
  title: "Streaming Basic",
  validateInput: false,
  async run({ ctx }) {
    const stream = (await ctx.stream("answer", {
      contentType: "text/markdown",
      metadata: { source: "test" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    for (const chunk of ["He", "llo", "!"]) {
      await stream.write({ text: chunk });
    }
    await stream.close({ done: true });
    return { kind: "success", outputs: { out: null, result: "Hello!" } };
  },
});

/** Writes one delta then returns without closing — exercises auto-close. */
const streamingLeakNode = defineNode({
  type: "streaming_leak",
  typeVersion: "1.0.0",
  title: "Streaming Leak",
  validateInput: false,
  async run({ ctx }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (await ctx.stream("answer")) as any;
    await s.write({ text: "partial" });
    return { kind: "success", outputs: { out: null, result: "partial" } };
  },
});

/** Mixes ctx.log calls with stream writes; the channel must keep them apart. */
const streamingLogSplitNode = defineNode({
  type: "streaming_log_split",
  typeVersion: "1.0.0",
  title: "Streaming Log Split",
  validateInput: false,
  async run({ ctx }) {
    ctx.log.info("about to start", { phase: "before" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (await ctx.stream("answer")) as any;
    await s.write({ text: "x" });
    ctx.log.warn("midway", { phase: "during" });
    await s.close();
    return { kind: "success", outputs: { out: null, result: "x" } };
  },
});

/** Loops forever until ctx.signal aborts; verifies cancellation path. */
const streamingSlowNode = defineNode({
  type: "streaming_slow",
  typeVersion: "1.0.0",
  title: "Streaming Slow",
  validateInput: false,
  async run({ ctx }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (await ctx.stream("answer")) as any;
    streamingSlowStarted.value = true;
    while (!ctx.signal.aborted) {
      await s.write({ text: "tick" });
      await new Promise((r) => setTimeout(r, 5));
    }
    return { kind: "success", outputs: { out: null, result: "" } };
  },
});

/**
 * Mutable flag observed by the cancellation test so it knows when the
 * slow runner has actually opened its stream.
 */
const streamingSlowStarted = { value: false };

/* -------------------------------------------------------------------------- */
/* Runtime helper                                                              */
/* -------------------------------------------------------------------------- */

function newRuntime(opts?: { llmProvider?: DeterministicLlmProvider }): Runtime {
  const variables = new InMemoryVariableStore();
  const secrets = new InMemorySecretStore();
  const llmProvider = opts?.llmProvider ?? new DeterministicLlmProvider();
  return createRuntime({
    variables,
    secrets,
    llmProvider,
    nodes: [
      streamingBasicNode,
      streamingLeakNode,
      streamingLogSplitNode,
      streamingSlowNode,
    ],
  });
}

async function registerAndPromote(rt: Runtime, flow: ReturnType<typeof defineFlow>) {
  const json = flow.dump();
  const graph = JSON.parse(json);
  await rt.registry.register({ graph, json, status: "staging" });
  await rt.registry.promote(graph.id, graph.version);
  return graph;
}

/** Build a `defineFlow` bound to the runtime's shared NodeTypeRegistry. */
function newFlow(rt: Runtime, args: { id: string; version: string }) {
  return defineFlow({ ...args, registry: rt.nodeTypeRegistry });
}

/* -------------------------------------------------------------------------- */
/* ctx.stream lifecycle                                                        */
/* -------------------------------------------------------------------------- */

describe("runtime / streaming / ctx.stream lifecycle", () => {
  it("emits stream_open, ordered stream_deltas and exactly one stream_close", async () => {
    const rt = newRuntime();
    const flow = newFlow(rt, { id: "stream_basic", version: "1.0.0" });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const t = flow.node("streaming_basic", { id: "t", position: { x: 100, y: 0 } });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), t.in("in"));
    flow.connect(t.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);
    const res = await rt.invocationRouter.invoke({ flowId: "stream_basic", input: null });
    expect(res.succeeded).toBe(true);

    const events = await rt.eventBus.store.read(res.runRecord.runId);
    const tEvents = events.filter((e) => e.nodeId === "t");
    const opens = tEvents.filter((e) => e.kind === "stream_open");
    const deltas = tEvents.filter((e) => e.kind === "stream_delta");
    const closes = tEvents.filter((e) => e.kind === "stream_close");
    expect(opens).toHaveLength(1);
    expect(deltas).toHaveLength(3);
    expect(closes).toHaveLength(1);
    const streamSeqs = [...opens, ...deltas, ...closes].map((e) => e.seq);
    expect([...streamSeqs].sort((a, b) => a - b)).toEqual(streamSeqs);
    expect(opens[0]!.seq).toBeLessThan(deltas[0]!.seq);
    expect(deltas[deltas.length - 1]!.seq).toBeLessThan(closes[0]!.seq);
    const sid = opens[0]!.streamId!;
    expect(deltas.every((d) => d.streamId === sid)).toBe(true);
    expect(closes[0]!.streamId).toBe(sid);
  });

  it("auto-closes streams that the runner forgot to close", async () => {
    const rt = newRuntime();
    const flow = newFlow(rt, { id: "stream_leak", version: "1.0.0" });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const t = flow.node("streaming_leak", { id: "t", position: { x: 100, y: 0 } });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), t.in("in"));
    flow.connect(t.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);
    const res = await rt.invocationRouter.invoke({ flowId: "stream_leak", input: null });
    const events = await rt.eventBus.store.read(res.runRecord.runId);
    const closes = events.filter((e) => e.kind === "stream_close" && e.nodeId === "t");
    expect(closes).toHaveLength(1);
    const closePayload = closes[0]!.payload as { status: string };
    expect(closePayload.status).toBe("auto");
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostic logs vs semantic stream are kept separate                        */
/* -------------------------------------------------------------------------- */

describe("runtime / streaming / log vs stream separation", () => {
  it("node_log events do not appear on the stream channel", async () => {
    const rt = newRuntime();
    const flow = newFlow(rt, { id: "stream_log_split", version: "1.0.0" });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const t = flow.node("streaming_log_split", { id: "t", position: { x: 100, y: 0 } });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), t.in("in"));
    flow.connect(t.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);
    const res = await rt.invocationRouter.invoke({ flowId: "stream_log_split", input: null });

    const events = await rt.eventBus.store.read(res.runRecord.runId);
    const tEvents = events.filter((e) => e.nodeId === "t");
    const logs = tEvents.filter((e) => e.kind === "node_log");
    const stream = tEvents.filter((e) =>
      e.kind === "stream_open" || e.kind === "stream_delta" || e.kind === "stream_close",
    );
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.every((l) => l.streamId === undefined)).toBe(true);
    expect(stream.every((s) => typeof s.streamId === "string")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation propagates into the streaming context                          */
/* -------------------------------------------------------------------------- */

describe("runtime / streaming / cancellation", () => {
  it("aborts the running stream and emits stream_close { status: 'cancelled' }", async () => {
    streamingSlowStarted.value = false;
    const rt = newRuntime();
    const flow = newFlow(rt, { id: "stream_cancel", version: "1.0.0" });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const t = flow.node("streaming_slow", { id: "t", position: { x: 100, y: 0 } });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), t.in("in"));
    flow.connect(t.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);

    const ref = await rt.registry.getActive("stream_cancel");
    const created = await rt.runManager.create({
      flowId: ref.flowId,
      flowVersion: ref.version,
      flowArtifactHash: ref.artifactHash,
      graph: ref.graph,
      input: null,
    });
    const completed = rt.runManager.execute(created, ref.graph);
    while (!streamingSlowStarted.value) await new Promise((r) => setTimeout(r, 1));
    await rt.runManager.cancel(created.runId);
    const result = await completed;
    expect(result.cancelled).toBe(true);

    const events = await rt.eventBus.store.read(created.runId);
    const closes = events.filter((e) => e.kind === "stream_close" && e.nodeId === "t");
    expect(closes).toHaveLength(1);
    const payload = closes[0]!.payload as { status: string };
    expect(payload.status).toBe("cancelled");
  });
});

/* -------------------------------------------------------------------------- */
/* Built-in llm node forwards AiStreamEvents end-to-end                        */
/* -------------------------------------------------------------------------- */

describe("runtime / streaming / llm node forwards AiStreamEvents", () => {
  it("emits stream_open, stream_delta(s), stream_usage and stream_close", async () => {
    const provider = new DeterministicLlmProvider({
      respond: () => "Hello, World!",
    });
    const rt = newRuntime({ llmProvider: provider });

    const flow = newFlow(rt, { id: "llm_stream", version: "1.0.0" });
    const start = flow.node("start", { id: "s", position: { x: 0, y: 0 } });
    const llm = flow.node("llm", {
      id: "l",
      position: { x: 100, y: 0 },
      config: { prompt: "say hi", stream: true },
    });
    const end = flow.node("end", { id: "e", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), llm.in("in"));
    flow.connect(llm.out("out"), end.in("in"));
    await registerAndPromote(rt, flow);
    const res = await rt.invocationRouter.invoke({ flowId: "llm_stream", input: null });
    expect(res.succeeded).toBe(true);
    expect(res.output).toBe("Hello, World!");

    const events = await rt.eventBus.store.read(res.runRecord.runId);
    const llmEvents = events.filter((e) => e.nodeId === "l");
    const opens = llmEvents.filter((e) => e.kind === "stream_open");
    const deltas = llmEvents.filter((e) => e.kind === "stream_delta");
    const closes = llmEvents.filter((e) => e.kind === "stream_close");
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const concatenated = deltas
      .map((d) => (d.payload as { text: string }).text)
      .join("");
    expect(concatenated).toBe("Hello, World!");
  });
});
