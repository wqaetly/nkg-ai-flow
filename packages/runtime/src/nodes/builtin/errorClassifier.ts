/**
 * `error_classifier` - explicit error routing.
 *
 * It turns structured runtime errors into author-visible matched/unmatched
 * branches before retry, compensation, approval, or dead-letter handling.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

type RetryableFilter = "any" | "true" | "false";

interface ErrorFacts {
  code: string;
  kind: string;
  category: string;
  retryable: boolean | null;
  message: string;
}

const errorClassifierConfig = z
  .object({
    codes: z
      .string()
      .default("")
      .describe("Comma-separated error code patterns; supports * wildcards."),
    kinds: z
      .string()
      .default("")
      .describe("Comma-separated runtime error kinds to match."),
    categories: z
      .string()
      .default("")
      .describe("Comma-separated runtime error categories to match."),
    retryable: z
      .enum(["any", "true", "false"])
      .default("any")
      .describe("Retryable flag filter."),
    messageIncludes: z
      .string()
      .default("")
      .describe("Optional substring that must appear in the error message."),
    label: z.string().default("").describe("Optional classifier label emitted on output."),
  })
  .passthrough();

export const errorClassifierNode = defineNode({
  type: "error_classifier",
  typeVersion: "1.0.0",
  title: "Error Classifier",
  description: "Routes structured errors by code, kind, category, retryability, or message.",
  kind: "pseudo",
  config: errorClassifierConfig,
  fieldMeta: {
    codes: {
      label: "Codes",
      control: "input",
      order: 1,
      placeholder: "node.http.*,service.timeout",
    },
    kinds: {
      label: "Kinds",
      control: "input",
      order: 2,
      placeholder: "validation,runtime",
    },
    categories: {
      label: "Categories",
      control: "input",
      order: 3,
      placeholder: "author,user_input,system",
    },
    retryable: {
      label: "Retryable",
      control: "select",
      order: 4,
      enumOptions: [
        { label: "Any", value: "any" },
        { label: "True", value: "true" },
        { label: "False", value: "false" },
      ],
    },
    messageIncludes: {
      label: "Message Includes",
      control: "input",
      order: 5,
    },
    label: {
      label: "Label",
      control: "input",
      order: 6,
    },
  },
  ports: [
    { id: "error", direction: "input", kind: "data", label: "Error" },
    { id: "matched", direction: "output", kind: "control", label: "Matched" },
    { id: "unmatched", direction: "output", kind: "control", label: "Unmatched" },
    { id: "error", direction: "output", kind: "data", label: "Error" },
    { id: "code", direction: "output", kind: "data", label: "Code", schema: { type: "string" } },
    { id: "kind", direction: "output", kind: "data", label: "Kind", schema: { type: "string" } },
    { id: "category", direction: "output", kind: "data", label: "Category", schema: { type: "string" } },
    { id: "retryable", direction: "output", kind: "data", label: "Retryable", schema: { type: "boolean" } },
    { id: "message", direction: "output", kind: "data", label: "Message", schema: { type: "string" } },
    { id: "label", direction: "output", kind: "data", label: "Label", schema: { type: "string" } },
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const error = input.error ?? input.input ?? input.in ?? null;
    const facts = readFacts(error);
    const label = String(config.label ?? "").trim();
    const decision = facts
      ? classify(facts, {
          codes: parseList(config.codes),
          kinds: parseList(config.kinds),
          categories: parseList(config.categories),
          retryable: readRetryableFilter(config.retryable),
          messageIncludes: String(config.messageIncludes ?? "").trim(),
        })
      : { matched: false, reason: "no_error" };
    const branch = decision.matched ? "matched" : "unmatched";

    ctx.log.debug("error_classifier selected branch", {
      branch,
      reason: decision.reason,
      code: facts?.code ?? "",
      kind: facts?.kind ?? "",
      category: facts?.category ?? "",
    });

    return {
      kind: "success",
      outputs: {
        [branch]: null,
        error,
        code: facts?.code ?? "",
        kind: facts?.kind ?? "",
        category: facts?.category ?? "",
        retryable: facts?.retryable ?? null,
        message: facts?.message ?? "",
        label,
        reason: decision.reason,
      },
    };
  },
});

function readFacts(error: unknown): ErrorFacts | null {
  if (!error || typeof error !== "object") return null;
  const code = readString(error, "code");
  const kind = readString(error, "kind");
  const category = readString(error, "category");
  const message = readString(error, "message");
  const retryable = readPath(error, "retryable");
  if (code === "" && kind === "" && category === "" && message === "") return null;
  return {
    code,
    kind,
    category,
    retryable: typeof retryable === "boolean" ? retryable : null,
    message,
  };
}

function readString(value: unknown, path: string): string {
  const item = readPath(value, path);
  return item === undefined || item === null ? "" : String(item);
}

function parseList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readRetryableFilter(value: unknown): RetryableFilter {
  return value === "true" || value === "false" ? value : "any";
}

function classify(
  facts: ErrorFacts,
  filters: {
    codes: string[];
    kinds: string[];
    categories: string[];
    retryable: RetryableFilter;
    messageIncludes: string;
  },
): { matched: boolean; reason: string } {
  if (filters.codes.length > 0 && !filters.codes.some((item) => matchesPattern(facts.code, item))) {
    return { matched: false, reason: "code_mismatch" };
  }
  if (filters.kinds.length > 0 && !filters.kinds.includes(facts.kind)) {
    return { matched: false, reason: "kind_mismatch" };
  }
  if (filters.categories.length > 0 && !filters.categories.includes(facts.category)) {
    return { matched: false, reason: "category_mismatch" };
  }
  if (filters.retryable !== "any") {
    const expected = filters.retryable === "true";
    if (facts.retryable !== expected) {
      return { matched: false, reason: "retryable_mismatch" };
    }
  }
  if (filters.messageIncludes !== "" && !facts.message.includes(filters.messageIncludes)) {
    return { matched: false, reason: "message_mismatch" };
  }
  return { matched: true, reason: "matched" };
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const [prefix = "", suffix = ""] = pattern.split("*", 2);
  return value.startsWith(prefix) && value.endsWith(suffix);
}
