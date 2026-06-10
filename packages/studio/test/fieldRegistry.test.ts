/**
 * Verifies the priority ordering of `FieldRendererRegistry`:
 *   exact > control > kind > fallback.
 */

import { describe, expect, test } from "vitest";
import type { FieldDescriptor } from "@ai-native-flow/flow-ir";
import {
  createFieldRendererRegistry,
  type FieldRenderer,
} from "../src/fields/registry.js";

const make =
  (id: string): FieldRenderer =>
  () => id as unknown as null;

function descriptor(
  partial: Partial<FieldDescriptor> & { name: string; kind: FieldDescriptor["kind"] },
): FieldDescriptor {
  return {
    optional: false,
    nullable: false,
    ...partial,
  };
}

describe("FieldRendererRegistry", () => {
  test("uses fallback when no matcher is registered", () => {
    const reg = createFieldRendererRegistry();
    reg.setFallback(make("fallback"));
    const r = reg.resolve(descriptor({ name: "x", kind: "unknown" }), "n1");
    expect(r({} as never)).toBe("fallback");
  });

  test("kind match beats fallback", () => {
    const reg = createFieldRendererRegistry();
    reg.setFallback(make("fallback"));
    reg.register({ kind: "string" }, make("kind:string"));
    const r = reg.resolve(descriptor({ name: "x", kind: "string" }), "n1");
    expect(r({} as never)).toBe("kind:string");
  });

  test("control match beats kind", () => {
    const reg = createFieldRendererRegistry();
    reg.register({ kind: "string" }, make("kind:string"));
    reg.register({ control: "textarea" }, make("ctrl:textarea"));
    const r = reg.resolve(
      descriptor({ name: "x", kind: "string", control: "textarea" }),
      "n1",
    );
    expect(r({} as never)).toBe("ctrl:textarea");
  });

  test("exact (nodeType+fieldName) beats everything else", () => {
    const reg = createFieldRendererRegistry();
    reg.register({ kind: "string" }, make("kind:string"));
    reg.register({ control: "textarea" }, make("ctrl:textarea"));
    reg.register(
      { nodeType: "text_input", fieldName: "value" },
      make("exact:text_input.value"),
    );
    const r = reg.resolve(
      descriptor({ name: "value", kind: "string", control: "textarea" }),
      "text_input",
    );
    expect(r({} as never)).toBe("exact:text_input.value");
  });

  test("falls back when control hint has no registration", () => {
    const reg = createFieldRendererRegistry();
    reg.setFallback(make("fallback"));
    reg.register({ kind: "string" }, make("kind:string"));
    // control "json" not registered → should fall back to kind
    const r = reg.resolve(
      descriptor({ name: "x", kind: "string", control: "json" }),
      "n1",
    );
    expect(r({} as never)).toBe("kind:string");
  });
});
