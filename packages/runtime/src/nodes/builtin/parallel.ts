/**
 * `parallel` — explicit fan-out control node.
 *
 * It emits a configurable number of branch control ports and mirrors the
 * inbound data as `value`, so downstream branch nodes can consume the
 * same payload through the engine's control-edge data forwarding.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

const MAX_BRANCHES = 4;

const parallelConfig = z
  .object({
    branchCount: z
      .number()
      .int()
      .min(1)
      .max(MAX_BRANCHES)
      .default(2)
      .describe("Number of branch control outputs to fire."),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_BRANCHES)
      .default(MAX_BRANCHES)
      .describe("Maximum number of direct branch entry nodes to start at once."),
  })
  .passthrough();

export const parallelNode = defineNode({
  type: "parallel",
  typeVersion: "1.0.0",
  title: "Parallel",
  description: "Fans out execution to multiple named branches.",
  kind: "pseudo",
  config: parallelConfig,
  fieldMeta: {
    branchCount: {
      label: "Branch count",
      control: "number",
      order: 1,
    },
    concurrency: {
      label: "Concurrency",
      control: "number",
      order: 2,
    },
  },
  ports: [
    controlIn,
    { id: "input", direction: "input", kind: "data", label: "Input" },
    {
      id: "branchCount",
      direction: "input",
      kind: "data",
      label: "Branch count",
      schema: { type: "number" },
    },
    {
      id: "concurrency",
      direction: "input",
      kind: "data",
      label: "Concurrency",
      schema: { type: "number" },
    },
    { id: "branch1", direction: "output", kind: "control", label: "Branch 1" },
    { id: "branch2", direction: "output", kind: "control", label: "Branch 2" },
    { id: "branch3", direction: "output", kind: "control", label: "Branch 3" },
    { id: "branch4", direction: "output", kind: "control", label: "Branch 4" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    {
      id: "branchCount",
      direction: "output",
      kind: "data",
      label: "Branch count",
      schema: { type: "number" },
    },
    {
      id: "concurrency",
      direction: "output",
      kind: "data",
      label: "Concurrency",
      schema: { type: "number" },
    },
    {
      id: "branchIds",
      direction: "output",
      kind: "data",
      label: "Branch IDs",
      schema: { type: "array", items: { type: "string" } },
    },
  ],
  validateInput: false,
  run({ input, config }) {
    const branchCount = clampBranchCount(input.branchCount ?? config.branchCount);
    const concurrency = clampConcurrency(input.concurrency ?? config.concurrency, branchCount);
    const value = input.input ?? input.in ?? input.__runInput__ ?? null;
    const branchIds = Array.from({ length: branchCount }, (_, index) => `branch${index + 1}`);
    const outputs: Record<string, unknown> = { value, branchCount, concurrency, branchIds };
    for (let index = 1; index <= branchCount; index++) {
      outputs[`branch${index}`] = null;
    }
    return {
      kind: "success",
      outputs,
    };
  },
});

function clampBranchCount(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 2;
  return Math.min(MAX_BRANCHES, Math.max(1, Math.trunc(number)));
}

function clampConcurrency(value: unknown, branchCount: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return branchCount;
  return Math.min(branchCount, Math.max(1, Math.trunc(number)));
}
