/**
 * `schema_transform` - map structured input into a target shape.
 *
 * Mappings are newline-delimited `target.path = source.path` rules.
 * This keeps schema projection explicit on the graph without requiring
 * arbitrary JavaScript.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { readPath } from "./_helpers.js";

interface MappingRule {
  targetPath: string;
  sourceExpr: string;
}

interface MissingMapping {
  targetPath: string;
  sourceExpr: string;
  reason: string;
}

const schemaTransformConfig = z
  .object({
    mappings: z
      .string()
      .default("")
      .describe("Newline-delimited mapping rules, e.g. user.id = id."),
    includeSource: z
      .boolean()
      .default(false)
      .describe("When true, starts from a shallow clone of the input object."),
    requireAll: z
      .boolean()
      .default(false)
      .describe("When true, missing source fields route to missing."),
    defaultValue: z
      .unknown()
      .optional()
      .describe("Fallback value used for missing source paths when provided."),
  })
  .passthrough();

export const schemaTransformNode = defineNode({
  type: "schema_transform",
  typeVersion: "1.0.0",
  title: "Schema Transform",
  description: "Maps structured input fields into a target schema shape.",
  kind: "pseudo",
  config: schemaTransformConfig,
  fieldMeta: {
    mappings: {
      label: "Mappings",
      control: "textarea",
      order: 1,
      placeholder: "user.id = id\nuser.name = profile.name",
    },
    includeSource: {
      label: "Include Source",
      control: "switch",
      order: 2,
    },
    requireAll: {
      label: "Require All",
      control: "switch",
      order: 3,
    },
    defaultValue: {
      label: "Default Value",
      control: "textarea",
      order: 4,
    },
  },
  ports: [
    { id: "in", direction: "input", kind: "control", label: "Input" },
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "transformed", direction: "output", kind: "control", label: "Transformed" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "missingMappings", direction: "output", kind: "data", label: "Missing mappings" },
    { id: "mappedCount", direction: "output", kind: "data", label: "Mapped count", schema: { type: "number" } },
    { id: "missingCount", direction: "output", kind: "data", label: "Missing count", schema: { type: "number" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = input.input ?? input.in ?? input.__runInput__ ?? {};
    const rules = parseMappings(String(config.mappings ?? ""));
    const output = config.includeSource === true && isPlainObject(source)
      ? { ...(source as Record<string, unknown>) }
      : {};
    const missingMappings: MissingMapping[] = [];
    let mappedCount = 0;
    const hasDefault = Object.prototype.hasOwnProperty.call(config, "defaultValue");

    for (const rule of rules) {
      const resolved = resolveSource(rule.sourceExpr, source);
      if (!resolved.exists && !hasDefault) {
        missingMappings.push({
          targetPath: rule.targetPath,
          sourceExpr: rule.sourceExpr,
          reason: "source_missing",
        });
        continue;
      }
      setPath(output, rule.targetPath, resolved.exists ? resolved.value : config.defaultValue);
      mappedCount += 1;
    }

    const missingCount = missingMappings.length;
    const status = config.requireAll === true && missingCount > 0 ? "missing" : "transformed";

    ctx.log.debug("schema_transform mapped payload", {
      status,
      mappedCount,
      missingCount,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        value: output,
        missingMappings,
        mappedCount,
        missingCount,
        status,
      },
    };
  },
});

function parseMappings(value: string): MappingRule[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map(parseMapping)
    .filter((rule): rule is MappingRule => rule !== undefined);
}

function parseMapping(line: string): MappingRule | undefined {
  const match = line.match(/^(.+?)(?:<-|=)(.+)$/);
  if (!match) return undefined;
  const targetPath = match[1]?.trim() ?? "";
  const sourceExpr = match[2]?.trim() ?? "";
  if (targetPath === "" || sourceExpr === "") return undefined;
  return { targetPath, sourceExpr };
}

function resolveSource(
  expression: string,
  source: unknown,
): { exists: boolean; value: unknown } {
  if (
    (expression.startsWith("\"") && expression.endsWith("\"")) ||
    (expression.startsWith("'") && expression.endsWith("'"))
  ) {
    return { exists: true, value: expression.slice(1, -1) };
  }
  if (expression.startsWith("json:")) {
    try {
      return { exists: true, value: JSON.parse(expression.slice(5)) };
    } catch {
      return { exists: false, value: undefined };
    }
  }
  if (expression === "$input" || expression === ".") {
    return { exists: true, value: source };
  }
  const value = readPath(source, expression);
  return { exists: value !== undefined, value };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = parsePath(path);
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
}

function parsePath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
