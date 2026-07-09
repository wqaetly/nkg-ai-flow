/**
 * `schema_transform` - map structured input into a target shape.
 *
 * Mappings are newline-delimited `target.path = source.path` rules.
 * This keeps schema projection explicit on the graph without requiring
 * arbitrary JavaScript.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { evaluateExpression, readPath } from "./_helpers.js";

interface MappingRule {
  targetPath: string;
  sourceExpr: string;
}

interface MissingMapping {
  targetPath: string;
  sourceExpr: string;
  reason: string;
}

interface MappedMapping {
  targetPath: string;
  sourceExpr: string;
  usedDefault: boolean;
  value: unknown;
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
      placeholder: "user.id = id\nuser.name = template:${profile.first} ${profile.last}",
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
    { id: "mappings", direction: "input", kind: "data", label: "Mappings", schema: { type: "string" } },
    { id: "includeSource", direction: "input", kind: "data", label: "Include source", schema: { type: "boolean" } },
    { id: "requireAll", direction: "input", kind: "data", label: "Require all", schema: { type: "boolean" } },
    { id: "defaultValue", direction: "input", kind: "data", label: "Default value" },
    { id: "transformed", direction: "output", kind: "control", label: "Transformed" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "mappings", direction: "output", kind: "data", label: "Mappings", schema: { type: "string" } },
    { id: "includeSource", direction: "output", kind: "data", label: "Include source", schema: { type: "boolean" } },
    { id: "requireAll", direction: "output", kind: "data", label: "Require all", schema: { type: "boolean" } },
    { id: "defaultValue", direction: "output", kind: "data", label: "Default value" },
    {
      id: "hasDefaultValue",
      direction: "output",
      kind: "data",
      label: "Has default value",
      schema: { type: "boolean" },
    },
    { id: "ruleCount", direction: "output", kind: "data", label: "Rule count", schema: { type: "number" } },
    { id: "mappedMappings", direction: "output", kind: "data", label: "Mapped mappings" },
    { id: "mappedTargets", direction: "output", kind: "data", label: "Mapped targets", schema: { type: "array" } },
    { id: "missingMappings", direction: "output", kind: "data", label: "Missing mappings" },
    { id: "mappedCount", direction: "output", kind: "data", label: "Mapped count", schema: { type: "number" } },
    { id: "missingCount", direction: "output", kind: "data", label: "Missing count", schema: { type: "number" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = input.input ?? input.in ?? input.__runInput__ ?? {};
    const mappings = String(input.mappings ?? config.mappings ?? "");
    const rules = parseMappings(mappings);
    const includeSource = readBoolean(input.includeSource) ?? readBoolean(config.includeSource) ?? false;
    const requireAll = readBoolean(input.requireAll) ?? readBoolean(config.requireAll) ?? false;
    const hasInputDefault = Object.prototype.hasOwnProperty.call(input, "defaultValue");
    const hasConfigDefault = Object.prototype.hasOwnProperty.call(config, "defaultValue");
    const hasDefaultValue = hasInputDefault || hasConfigDefault;
    const defaultValue = hasInputDefault ? input.defaultValue : config.defaultValue;
    const output = includeSource && isPlainObject(source)
      ? { ...(source as Record<string, unknown>) }
      : {};
    const missingMappings: MissingMapping[] = [];
    const mappedMappings: MappedMapping[] = [];
    let mappedCount = 0;

    for (const rule of rules) {
      const resolved = resolveSource(rule.sourceExpr, source);
      if (!resolved.exists && !hasDefaultValue) {
        missingMappings.push({
          targetPath: rule.targetPath,
          sourceExpr: rule.sourceExpr,
          reason: "source_missing",
        });
        continue;
      }
      const value = resolved.exists ? resolved.value : defaultValue;
      setPath(output, rule.targetPath, value);
      mappedMappings.push({
        targetPath: rule.targetPath,
        sourceExpr: rule.sourceExpr,
        usedDefault: !resolved.exists,
        value,
      });
      mappedCount += 1;
    }

    const missingCount = missingMappings.length;
    const status = requireAll && missingCount > 0 ? "missing" : "transformed";

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
        mappings,
        includeSource,
        requireAll,
        defaultValue: hasDefaultValue ? defaultValue : null,
        hasDefaultValue,
        ruleCount: rules.length,
        mappedMappings,
        mappedTargets: mappedMappings.map((mapping) => mapping.targetPath),
        missingMappings,
        mappedCount,
        missingCount,
        status,
      },
    };
  },
});

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

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
  if (expression.startsWith("template:")) {
    return renderMappingTemplate(expression.slice("template:".length), source);
  }
  if (expression.startsWith("expr:")) {
    const value = evaluateExpression(expression.slice("expr:".length), expressionContext(source));
    return { exists: value !== undefined, value };
  }
  if (expression === "$input" || expression === ".") {
    return { exists: true, value: source };
  }
  const value = readPath(source, expression);
  return { exists: value !== undefined, value };
}

function renderMappingTemplate(
  template: string,
  source: unknown,
): { exists: boolean; value: unknown } {
  let missing = false;
  const value = template.replace(/\$\{([^}]+)\}/g, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const resolved = path === "$input" || path === "." ? source : readPath(source, path);
    if (resolved === undefined) {
      missing = true;
      return "";
    }
    return resolved === null ? "" : String(resolved);
  });
  return { exists: !missing, value };
}

function expressionContext(source: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    input: source,
    source,
  };
  return isPlainObject(source) ? { ...source, ...base } : base;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = parsePath(path);
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index === segments.length - 1) {
      assignSegment(cursor, segment, value);
      return;
    }
    const next = readSegment(cursor, segment);
    if (!isContainer(next)) {
      const created: Record<string, unknown> | unknown[] = isArrayIndex(segments[index + 1] ?? "")
        ? []
        : {};
      assignSegment(cursor, segment, created);
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

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return isPlainObject(value) || Array.isArray(value);
}

function isArrayIndex(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment);
}

function readSegment(source: Record<string, unknown> | unknown[], segment: string): unknown {
  if (Array.isArray(source)) return isArrayIndex(segment) ? source[Number(segment)] : undefined;
  return source[segment];
}

function assignSegment(
  target: Record<string, unknown> | unknown[],
  segment: string,
  value: unknown,
): void {
  if (Array.isArray(target) && isArrayIndex(segment)) {
    target[Number(segment)] = value;
    return;
  }
  (target as Record<string, unknown>)[segment] = value;
}
