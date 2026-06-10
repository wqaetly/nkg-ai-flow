import { describe, expect, test } from "vitest";
import { envReferenceForFieldPick } from "../src/fields/NodeFieldsPanel.js";

describe("Node field environment references", () => {
  test("stores variable picks as live $var references", () => {
    expect(
      envReferenceForFieldPick({
        key: "LLM_DEFAULT_MODEL",
        value: "gpt-4o-mini",
        secret: false,
      }),
    ).toEqual({ $var: "LLM_DEFAULT_MODEL" });
  });

  test("stores secret-flagged picks as live $var references", () => {
    expect(
      envReferenceForFieldPick({
        key: "LLM_API_KEY",
        value: "",
        secret: true,
      }),
    ).toEqual({ $var: "LLM_API_KEY" });
  });
});
