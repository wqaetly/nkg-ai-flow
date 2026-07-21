import { describe, expect, it } from "vitest";

import {
  FALLBACK_SIDECAR_URL,
  resolveInitialSidecarUrl,
} from "./sidecarUrl.js";

describe("resolveInitialSidecarUrl", () => {
  it("uses the coordinated launcher URL before stale local storage", () => {
    expect(
      resolveInitialSidecarUrl({
        injected: "http://127.0.0.1:5175",
        stored: "http://127.0.0.1:5173",
      }),
    ).toBe("http://127.0.0.1:5175");
  });

  it("lets an explicit query override the launcher", () => {
    expect(
      resolveInitialSidecarUrl({
        search: "?sidecar=https%3A%2F%2Fexample.test%2Fapi%2F",
        injected: "http://127.0.0.1:5175",
      }),
    ).toBe("https://example.test/api");
  });

  it("falls back safely when candidates are invalid", () => {
    expect(
      resolveInitialSidecarUrl({
        search: "?sidecar=javascript%3Aalert(1)",
        injected: "not-a-url",
        stored: null,
      }),
    ).toBe(FALLBACK_SIDECAR_URL);
  });
});
