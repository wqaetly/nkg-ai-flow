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
    { id: "path", direction: "input", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "case1", direction: "input", kind: "data", label: "Case 1", schema: { type: "string" } },
    { id: "case2", direction: "input", kind: "data", label: "Case 2", schema: { type: "string" } },
    { id: "case3", direction: "input", kind: "data", label: "Case 3", schema: { type: "string" } },
    { id: "case4", direction: "input", kind: "data", label: "Case 4", schema: { type: "string" } },
    { id: "case1", direction: "output", kind: "control", label: "Case 1" },
    { id: "case2", direction: "output", kind: "control", label: "Case 2" },
    { id: "case3", direction: "output", kind: "control", label: "Case 3" },
    { id: "case4", direction: "output", kind: "control", label: "Case 4" },
    { id: "default", direction: "output", kind: "control", label: "Default" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "path", direction: "output", kind: "data", label: "Path", schema: { type: "string" } },
    { id: "selected", direction: "output", kind: "data", label: "Selected" },
    { id: "selectedText", direction: "output", kind: "data", label: "Selected text", schema: { type: "string" } },
    { id: "branch", direction: "output", kind: "data", label: "Branch", schema: { type: "string" } },
    { id: "summary", direction: "output", kind: "data", label: "Summary" },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const payload = readPayload(raw);
    const path = String(raw.path ?? config.path ?? "value");
    const selected = selectValue(raw, path, payload);
    const selectedText = selected == null ? "" : String(selected);
    const cases = readCases(raw, config);
    const branch = findMatchingCase(cases, selectedText) ?? "default";
    const summary = {
      path,
      selected,
      selectedText,
      branch,
      cases,
      matched: branch !== "default",
    };

    ctx.log.debug("switch_case selected branch", summary);

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        value: payload,
        path,
        selected,
        selectedText,
        branch,
        summary,
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

function readCases(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const cases: Record<string, unknown> = {};
  for (let index = 1; index <= CASE_COUNT; index++) {
    const key = `case${index}`;
    cases[key] = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : config[key];
  }
  return cases;
}

function findMatchingCase(
  cases: Record<string, unknown>,
  selectedText: string,
): string | undefined {
  for (let index = 1; index <= CASE_COUNT; index++) {
    const key = `case${index}`;
    const expected = cases[key];
    if (typeof expected === "string" && expected !== "" && expected === selectedText) {
      return key;
    }
  }
  return undefined;
}
