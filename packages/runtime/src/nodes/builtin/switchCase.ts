/**
 * `switch_case` - multi-way control router.
 *
 * Routes execution to the first configured case whose string value
 * equals the selected input value. When no case matches, it emits the
 * `default` control port. The original matched payload is mirrored through
 * the `value` data output so the chosen branch can consume the same data.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn, readPath } from "./_helpers.js";

const CASE_COUNT = 4;

const switchCaseConfig = z
  .object({
    path: z
      .string()
      .default("value")
      .describe("Dotted path used to select the value to compare."),
    case1: z.string().default("").describe("Literal value for branch 1."),
    case2: z.string().default("").describe("Literal value for branch 2."),
    case3: z.string().default("").describe("Literal value for branch 3."),
    case4: z.string().default("").describe("Literal value for branch 4."),
  })
  .passthrough();

export const switchCaseNode = defineNode({
  type: "switch_case",
  typeVersion: "1.0.0",
  title: "Switch Case",
  description: "Routes execution to one of several literal match branches.",
  kind: "pseudo",
  config: switchCaseConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      order: 1,
      placeholder: "value.status",
    },
    case1: { label: "Case 1", control: "input", order: 2 },
    case2: { label: "Case 2", control: "input", order: 3 },
    case3: { label: "Case 3", control: "input", order: 4 },
    case4: { label: "Case 4", control: "input", order: 5 },
  },
  ports: [
    controlIn,
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "case1", direction: "output", kind: "control", label: "Case 1" },
    { id: "case2", direction: "output", kind: "control", label: "Case 2" },
    { id: "case3", direction: "output", kind: "control", label: "Case 3" },
    { id: "case4", direction: "output", kind: "control", label: "Case 4" },
    { id: "default", direction: "output", kind: "control", label: "Default" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const payload = readPayload(raw);
    const selected = selectValue(raw, String(config.path ?? "value"), payload);
    const selectedText = selected == null ? "" : String(selected);
    const branch = findMatchingCase(config, selectedText) ?? "default";

    ctx.log.debug("switch_case selected branch", {
      path: config.path,
      value: selectedText,
      branch,
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        value: payload,
      },
    };
  },
});

function readPayload(input: Record<string, unknown>): unknown {
  return input.value ?? input.input ?? input.in ?? input.__runInput__ ?? null;
}

function selectValue(
  input: Record<string, unknown>,
  path: string,
  payload: unknown,
): unknown {
  const trimmed = path.trim();
  if (trimmed !== "") return readPath(input, trimmed);
  return payload;
}

function findMatchingCase(
  config: Record<string, unknown>,
  selectedText: string,
): string | undefined {
  for (let index = 1; index <= CASE_COUNT; index++) {
    const key = `case${index}`;
    const expected = config[key];
    if (typeof expected === "string" && expected !== "" && expected === selectedText) {
      return key;
    }
  }
  return undefined;
}
