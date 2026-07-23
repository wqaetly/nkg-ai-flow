import { describe, expect, it } from "vitest";
import { deriveRuntimeDebugNodeState } from "../src/runtimeDebug.js";

describe("runtime debug projection", () => {
  it("keeps nodes active for progress, log, tool, and stream events", () => {
    const started = { nodeId: "model", timestamp: "2026-07-23T10:00:00.000Z", payload: {} };

    expect(deriveRuntimeDebugNodeState([
      { ...started, kind: "node_started" },
      { ...started, kind: "node_log" },
    ], "model").status).toBe("running");

    expect(deriveRuntimeDebugNodeState([
      { ...started, kind: "node_started" },
      { ...started, kind: "tool_call_started" },
    ], "model").status).toBe("running");

    expect(deriveRuntimeDebugNodeState([
      { ...started, kind: "node_started" },
      { ...started, kind: "stream_delta" },
    ], "model").status).toBe("streaming");
  });

  it("projects canonical terminal state and duration", () => {
    const state = deriveRuntimeDebugNodeState([
      { kind: "node_started", nodeId: "model", timestamp: "2026-07-23T10:00:00.000Z", payload: {} },
      { kind: "stream_delta", nodeId: "model", timestamp: "2026-07-23T10:00:00.100Z", payload: {} },
      { kind: "node_finished", nodeId: "model", timestamp: "2026-07-23T10:00:00.250Z", payload: { durationMs: 250 } },
    ], "model");

    expect(state).toEqual({
      status: "succeeded",
      runtime: { startedAt: 1784800800000, durationMs: 250 },
    });
  });
});
