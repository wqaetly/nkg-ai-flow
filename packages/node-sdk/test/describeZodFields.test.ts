/**
 * Tests for the Zod-reflection layer powering the Node Field Inspector.
 *
 * These verify that `describeZodFields` recognises every kind we
 * advertise, that wrappers (`optional`, `nullable`, `default`) get
 * stripped while their flags are preserved, and that `mergeFieldMeta`
 * gives author-provided UI hints precedence over reflection.
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  describeZodFields,
  mergeFieldMeta,
} from "../src/describeZodFields.js";
import { defineNode } from "../src/index.js";
import type {
  FieldDescriptor,
  NodeConfigSchema,
} from "@ai-native-flow/flow-ir";

function fieldByName(
  fields: FieldDescriptor[],
  name: string,
): FieldDescriptor {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`field ${name} not found`);
  return f;
}

/**
 * Convenience for tests that only care about the first field of a
 * single-property schema. `describeZodFields` returns `FieldDescriptor[]`
 * which, under `noUncheckedIndexedAccess`, surfaces as `T | undefined`
 * when destructured. Asserting once here keeps every assertion site
 * narrow and gives a clear failure message when the schema is wrong.
 */
function firstField(fields: FieldDescriptor[]): FieldDescriptor {
  const f = fields[0];
  if (!f) throw new Error("expected describeZodFields to return at least one field");
  return f;
}

describe("describeZodFields", () => {
  test("string field: kind + constraints from .min/.max/.url", () => {
    const schema = z.object({
      url: z.string().url().min(1).max(2000).describe("Endpoint URL"),
    });
    const f = firstField(describeZodFields(schema));
    expect(f.name).toBe("url");
    expect(f.kind).toBe("string");
    expect(f.optional).toBe(false);
    expect(f.description).toBe("Endpoint URL");
    expect(f.constraints?.min).toBe(1);
    expect(f.constraints?.max).toBe(2000);
    expect(f.constraints?.format).toBe("url");
  });

  test("number field with min/max", () => {
    const schema = z.object({ temperature: z.number().min(0).max(2) });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("number");
    expect(f.constraints?.min).toBe(0);
    expect(f.constraints?.max).toBe(2);
  });

  test("boolean field", () => {
    const schema = z.object({ stream: z.boolean() });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("boolean");
  });

  test("enum field surfaces values via enumOptions", () => {
    const schema = z.object({ method: z.enum(["GET", "POST", "PUT"]) });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("enum");
    expect(f.enumOptions?.map((o) => o.value)).toEqual(["GET", "POST", "PUT"]);
  });

  test("optional + default unwrap and record both flags / default value", () => {
    const schema = z.object({
      retries: z.number().min(0).default(3).optional(),
    });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("number");
    expect(f.optional).toBe(true);
    expect(f.default).toBe(3);
    expect(f.constraints?.min).toBe(0);
  });

  test("record<string,string> field", () => {
    const schema = z.object({ headers: z.record(z.string()) });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("record");
  });

  test("nested object yields children, deeper levels collapse", () => {
    const schema = z.object({
      auth: z.object({
        kind: z.enum(["bearer", "basic"]),
        token: z.string(),
        nested: z.object({ x: z.string() }),
      }),
    });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("object");
    expect(f.children?.length).toBe(3);
    const inner = f.children!.find((c) => c.name === "nested");
    // Second-level objects are present but their grand-children are dropped
    expect(inner?.kind).toBe("object");
    expect(inner?.children).toBeUndefined();
  });

  test("string-array maps to string[]", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("string[]");
  });

  test("string enum array maps to string[] with enumOptions", () => {
    const schema = z.object({
      tools: z.array(z.enum(["read_file", "grep"])),
    });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("string[]");
    expect(f.enumOptions?.map((o) => o.value)).toEqual(["read_file", "grep"]);
  });

  test("non-string array degrades to unknown", () => {
    const schema = z.object({ scores: z.array(z.number()) });
    const f = firstField(describeZodFields(schema));
    expect(f.kind).toBe("unknown");
  });

  test("returns [] when input is not a ZodObject", () => {
    expect(describeZodFields(z.string())).toEqual([]);
    expect(describeZodFields(undefined)).toEqual([]);
  });
});

describe("mergeFieldMeta", () => {
  test("author hints win over reflected values", () => {
    const schema = z.object({ apiKey: z.string() });
    const reflected = describeZodFields(schema);
    const merged = mergeFieldMeta(reflected, {
      apiKey: { secret: true, label: "API Key", placeholder: "sk-..." },
    });
    const f = fieldByName(merged, "apiKey");
    expect(f.secret).toBe(true);
    expect(f.label).toBe("API Key");
    expect(f.placeholder).toBe("sk-...");
    // Reflection still owns kind / optional flags
    expect(f.kind).toBe("string");
  });

  test("returns input unchanged when no meta is provided", () => {
    const fields = describeZodFields(z.object({ a: z.number() }));
    expect(mergeFieldMeta(fields, undefined)).toBe(fields);
  });
});

describe("defineNode integration", () => {
  test("publishes fields[] under configSchema", () => {
    const node = defineNode({
      type: "demo",
      typeVersion: "1.0.0",
      title: "Demo",
      config: z.object({
        url: z.string().url(),
        method: z.enum(["GET", "POST"]).default("GET"),
        apiKey: z.string().optional(),
      }),
      fieldMeta: { apiKey: { secret: true } },
      run() {
        return { kind: "success", outputs: { out: null } };
      },
    });
    const schema = node.definition.configSchema as NodeConfigSchema;
    expect(schema.fields?.length).toBe(3);
    const apiKey = fieldByName(schema.fields!, "apiKey");
    expect(apiKey.secret).toBe(true);
    expect(apiKey.optional).toBe(true);
  });

  test("no config still yields a stable definition", () => {
    const node = defineNode({
      type: "noop",
      typeVersion: "1.0.0",
      title: "Noop",
      run() {
        return { kind: "success", outputs: { out: null } };
      },
    });
    expect(node.definition.configSchema).toBeUndefined();
  });
});
