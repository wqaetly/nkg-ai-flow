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
  kind: "control",
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
      id: "elapsedMs",
      direction: "output",
      kind: "data",
      label: "Elapsed ms",
      schema: { type: "number" },
    },
  ],
  validateInput: false,
  async run({ config, ctx }) {
    const durationMs = Math.max(0, Math.trunc(Number(config.durationMs ?? 1000)));
    const startedAt = Date.now();
    const completed = await wait(durationMs, ctx.signal);
    if (!completed) {
      return {
        kind: "skip",
        reason: "delay cancelled",
      };
    }
    return {
      kind: "success",
      outputs: {
        out: null,
        elapsedMs: Date.now() - startedAt,
      },
    };
  },
});

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
