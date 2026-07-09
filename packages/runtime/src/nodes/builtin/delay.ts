/**
 * `delay` — cancellable control-flow wait.
 *
 * Useful for small backoff steps, demo flows, and local orchestration
 * where a flow needs to pause before continuing to the next node.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";

const delayConfig = z
  .object({
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .default(1000)
      .describe("How long to wait before firing the output control port."),
  })
  .passthrough();

export const delayNode = defineNode({
  type: "delay",
  typeVersion: "1.0.0",
  title: "Delay",
  description: "Waits for a configured duration, then continues the flow.",
  config: delayConfig,
  fieldMeta: {
    durationMs: {
      label: "Duration (ms)",
      control: "number",
      order: 1,
    },
  },
  ports: [
    {
      id: "durationMs",
      direction: "input",
      kind: "data",
      label: "Duration ms",
      schema: { type: "number" },
    },
    {
      id: "elapsedMs",
      direction: "output",
      kind: "data",
      label: "Elapsed ms",
      schema: { type: "number" },
    },
    {
      id: "durationMs",
      direction: "output",
      kind: "data",
      label: "Duration ms",
      schema: { type: "number" },
    },
    {
      id: "startedAt",
      direction: "output",
      kind: "data",
      label: "Started At",
      schema: { type: "number" },
    },
    {
      id: "completedAt",
      direction: "output",
      kind: "data",
      label: "Completed At",
      schema: { type: "number" },
    },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const durationMs = readDurationMs(input.durationMs) ?? readDurationMs(config.durationMs) ?? 1000;
    const startedAt = Date.now();
    const completed = await wait(durationMs, ctx.signal);
    if (!completed) {
      return {
        kind: "skip",
        reason: "delay cancelled",
      };
    }
    const completedAt = Date.now();
    const elapsedMs = completedAt - startedAt;
    return {
      kind: "success",
      outputs: {
        out: null,
        elapsedMs,
        durationMs,
        startedAt,
        completedAt,
        summary: {
          status: "delayed",
          durationMs,
          elapsedMs,
          startedAt,
          completedAt,
          driftMs: Math.max(0, elapsedMs - durationMs),
        },
      },
    };
  },
});

function readDurationMs(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(86_400_000, Math.max(0, Math.trunc(number)));
}

function wait(durationMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
