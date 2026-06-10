import { describe, expect, it } from "vitest";
import {
  IdAllocator,
  isValidId,
  sanitizeSlug,
  createDefaultRegistry,
  BUILTIN_NODE_TYPES,
  FLOW_GRAPH_SCHEMA_VERSION,
  FlowGraphSchema,
  createRuntimeError,
  isRuntimeError,
  normalizeError,
  RuntimeErrorException,
} from "../src/index.js";

describe("flow-ir / IdAllocator", () => {
  it("allocates deterministic IDs based on prefix and slug", () => {
    const a = new IdAllocator();
    expect(a.allocate("node", "llm")).toBe("node_llm_01");
    expect(a.allocate("node", "llm")).toBe("node_llm_02");
    expect(a.allocate("edge")).toBe("edge_01");
  });

  it("rejects duplicate explicit IDs", () => {
    const a = new IdAllocator();
    a.reserveExplicit("node_x");
    expect(() => a.reserveExplicit("node_x")).toThrow();
  });

  it("skips collisions between explicit IDs and counter-allocated IDs", () => {
    const a = new IdAllocator();
    a.reserveExplicit("node_llm_01");
    expect(a.allocate("node", "llm")).toBe("node_llm_02");
  });
});

describe("flow-ir / sanitizeSlug + isValidId", () => {
  it("sanitises arbitrary text into a safe slug", () => {
    expect(sanitizeSlug("Hello World!")).toBe("hello_world");
    expect(sanitizeSlug("  __abc__  ")).toBe("abc");
    expect(sanitizeSlug(undefined)).toBe("");
  });
  it("rejects identifiers that do not match the safe pattern", () => {
    expect(isValidId("ok_id_01")).toBe(true);
    expect(isValidId("1starts_with_digit")).toBe(false);
    expect(isValidId("has space")).toBe(false);
    expect(isValidId("dash-ok-no")).toBe(false);
  });
});

describe("flow-ir / registry", () => {
  it("pre-registers built-in node types", () => {
    const r = createDefaultRegistry();
    for (const def of BUILTIN_NODE_TYPES) {
      expect(r.has(def.type, def.typeVersion)).toBe(true);
    }
  });

  it("throws RuntimeErrorException on unknown type", () => {
    const r = createDefaultRegistry();
    expect(() => r.get("nope")).toThrow(RuntimeErrorException);
  });
});

describe("flow-ir / Zod schema", () => {
  it("accepts a minimal valid flow", () => {
    const minimal = {
      id: "f",
      version: "1.0.0",
      schemaVersion: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [],
      edges: [],
    };
    const parsed = FlowGraphSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid id pattern", () => {
    const bad = {
      id: "1bad",
      version: "1.0.0",
      schemaVersion: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [],
      edges: [],
    };
    expect(FlowGraphSchema.safeParse(bad).success).toBe(false);
  });
});

describe("flow-ir / errors", () => {
  it("creates structured RuntimeError with default retryable", () => {
    const e = createRuntimeError({
      code: "validator.foo",
      kind: "validation",
      category: "user_input",
      message: "bad",
      source: { module: "validator" },
    });
    expect(isRuntimeError(e)).toBe(true);
    expect(e.retryable).toBe(false);
  });

  it("normalises native Error", () => {
    const native = new Error("boom");
    const r = normalizeError(native, { module: "node_runner" });
    expect(r.kind).toBe("internal");
    expect(r.category).toBe("system");
    expect(r.retryable).toBe(false);
    expect(r.message).toBe("boom");
  });

  it("normalises strings", () => {
    const r = normalizeError("oops", { module: "node_runner" });
    expect(r.kind).toBe("internal");
    expect(r.message).toBe("oops");
  });
});
