/**
 * `schema_guard` - lightweight data contract gate.
 *
 * It validates a payload against a pragmatic JSON-Schema subset and routes to
 * `valid` or `invalid`. Invalid data is a business branch, while malformed
 * author config is a node error.
 */

import { z } from "zod";
import { createRuntimeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

interface SchemaIssue {
  path: string;
  code: string;
  message: string;
}

type JsonSchemaObject = Record<string, unknown>;

const schemaGuardConfig = z
  .object({
    schema: z
      .unknown()
      .default({})
      .describe("JSON Schema subset used to validate the input payload."),
  })
  .passthrough();

export const schemaGuardNode = defineNode({
  type: "schema_guard",
  typeVersion: "1.0.0",
  title: "Schema Guard",
  description: "Routes data to valid or invalid after checking a JSON schema subset.",
  kind: "pseudo",
  config: schemaGuardConfig,
  fieldMeta: {
    schema: {
      label: "Schema",
      control: "textarea",
      order: 1,
      placeholder:
        '{ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } }',
    },
  },
  ports: [
    controlIn,
    { id: "input", direction: "input", kind: "data", label: "Input" },
    { id: "valid", direction: "output", kind: "control", label: "Valid" },
    { id: "invalid", direction: "output", kind: "control", label: "Invalid" },
    { id: "value", direction: "output", kind: "data", label: "Value" },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "issues", direction: "output", kind: "data", label: "Issues", schema: { type: "array" } },
    {
      id: "issueCount",
      direction: "output",
      kind: "data",
      label: "Issue count",
      schema: { type: "number" },
    },
    {
      id: "firstIssue",
      direction: "output",
      kind: "data",
      label: "First issue",
      schema: { type: "string" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const schema = readSchema(config.schema);
    if (schema instanceof Error) {
      return error(
        "node.schema_guard.invalid_schema",
        schema.message,
        ctx.nodeId,
      );
    }

    const value = input.input ?? input.in ?? input.__runInput__ ?? input;
    const issues = validateValue(value, schema, "$");
    const valid = issues.length === 0;
    const status = valid ? "valid" : "invalid";

    ctx.log.debug("schema_guard evaluated payload", {
      status,
      issueCount: issues.length,
    });

    return {
      kind: "success",
      outputs: {
        [status]: null,
        value,
        status,
        issues,
        issueCount: issues.length,
        firstIssue: issues[0]?.message ?? "",
      },
    };
  },
});

function readSchema(value: unknown): JsonSchemaObject | Error {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return {};
    try {
      return assertSchemaObject(JSON.parse(trimmed));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Invalid JSON schema.";
      return new Error(`schema_guard requires valid JSON schema: ${message}`);
    }
  }
  return assertSchemaObject(value);
}

function assertSchemaObject(value: unknown): JsonSchemaObject | Error {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Error("schema_guard schema must be a JSON object.");
  }
  return value as JsonSchemaObject;
}

function validateValue(
  value: unknown,
  schema: JsonSchemaObject,
  path: string,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const types = readTypes(schema.type);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    issues.push(issue(path, "type", `${path} must be ${types.join(" or ")}`));
    return issues;
  }

  if ("const" in schema && !sameValue(value, schema.const)) {
    issues.push(issue(path, "const", `${path} must equal ${formatValue(schema.const)}`));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameValue(item, value))) {
    issues.push(issue(path, "enum", `${path} must be one of ${schema.enum.map(formatValue).join(", ")}`));
  }

  if (isObject(value)) {
    issues.push(...validateObject(value, schema, path));
  }
  if (Array.isArray(value)) {
    issues.push(...validateArray(value, schema, path));
  }
  if (typeof value === "string") {
    issues.push(...validateString(value, schema, path));
  }
  if (typeof value === "number") {
    issues.push(...validateNumber(value, schema, path));
  }

  return issues;
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchemaObject,
  path: string,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in value)) {
      issues.push(issue(`${path}.${key}`, "required", `${path}.${key} is required`));
    }
  }

  const properties = isObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (!(key in value)) continue;
    const schemaObject = assertSchemaObject(childSchema);
    if (schemaObject instanceof Error) {
      issues.push(issue(`${path}.${key}`, "schema", `${path}.${key} schema must be an object`));
      continue;
    }
    issues.push(...validateValue(value[key], schemaObject, `${path}.${key}`));
  }

  const additional = schema.additionalProperties;
  if (additional === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        issues.push(issue(`${path}.${key}`, "additional", `${path}.${key} is not allowed`));
      }
    }
  } else if (additional && typeof additional === "object" && !Array.isArray(additional)) {
    for (const key of Object.keys(value)) {
      if (key in properties) continue;
      issues.push(...validateValue(value[key], additional as JsonSchemaObject, `${path}.${key}`));
    }
  }

  return issues;
}

function validateArray(
  value: unknown[],
  schema: JsonSchemaObject,
  path: string,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const minItems = readInteger(schema.minItems);
  if (minItems !== undefined && value.length < minItems) {
    issues.push(issue(path, "minItems", `${path} must contain at least ${minItems} items`));
  }
  const maxItems = readInteger(schema.maxItems);
  if (maxItems !== undefined && value.length > maxItems) {
    issues.push(issue(path, "maxItems", `${path} must contain at most ${maxItems} items`));
  }

  const itemSchema = schema.items;
  if (itemSchema === undefined) return issues;
  const schemaObject = assertSchemaObject(itemSchema);
  if (schemaObject instanceof Error) {
    issues.push(issue(`${path}[]`, "schema", `${path} items schema must be an object`));
    return issues;
  }
  value.forEach((item, index) => {
    issues.push(...validateValue(item, schemaObject, `${path}[${index}]`));
  });
  return issues;
}

function validateString(
  value: string,
  schema: JsonSchemaObject,
  path: string,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const minLength = readInteger(schema.minLength);
  if (minLength !== undefined && value.length < minLength) {
    issues.push(issue(path, "minLength", `${path} must contain at least ${minLength} characters`));
  }
  const maxLength = readInteger(schema.maxLength);
  if (maxLength !== undefined && value.length > maxLength) {
    issues.push(issue(path, "maxLength", `${path} must contain at most ${maxLength} characters`));
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        issues.push(issue(path, "pattern", `${path} must match /${schema.pattern}/`));
      }
    } catch {
      issues.push(issue(path, "schema", `${path} pattern is not a valid regular expression`));
    }
  }
  return issues;
}

function validateNumber(
  value: number,
  schema: JsonSchemaObject,
  path: string,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push(issue(path, "minimum", `${path} must be >= ${schema.minimum}`));
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push(issue(path, "maximum", `${path} must be <= ${schema.maximum}`));
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    issues.push(issue(path, "exclusiveMinimum", `${path} must be > ${schema.exclusiveMinimum}`));
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    issues.push(issue(path, "exclusiveMaximum", `${path} must be < ${schema.exclusiveMaximum}`));
  }
  return issues;
}

function readTypes(value: unknown): JsonSchemaType[] {
  const source = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return source.filter((item): item is JsonSchemaType =>
    item === "object" ||
    item === "array" ||
    item === "string" ||
    item === "number" ||
    item === "integer" ||
    item === "boolean" ||
    item === "null",
  );
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? Number(value) : undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function issue(path: string, code: string, message: string): SchemaIssue {
  return { path, code, message };
}

function error(
  code: string,
  message: string,
  nodeId: string,
): {
  kind: "error";
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
} {
  return {
    kind: "error",
    error: createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "node_logic", nodeId },
    }) as unknown as {
      code: string;
      message: string;
      [key: string]: unknown;
    },
  };
}
