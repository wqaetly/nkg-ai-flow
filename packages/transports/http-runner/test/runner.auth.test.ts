import { describe, expect, it } from "vitest";
import { createRuntime } from "@ai-native-flow/runtime";
import { buildHttpRunnerHandler } from "../src/index.js";

describe("HTTP runner launch token", () => {
  it("protects both discovery and Runtime routes", async () => {
    const runner = await buildHttpRunnerHandler({
      runtime: createRuntime(),
      token: "ephemeral-launch-token",
      startDir: import.meta.dirname,
      builtinRootDir: null,
    });

    const discoveryDenied = await runner.handler(new Request("http://127.0.0.1/"));
    expect(discoveryDenied.status).toBe(401);

    const runtimeDenied = await runner.handler(new Request("http://127.0.0.1/runs/unknown"));
    expect(runtimeDenied.status).toBe(401);

    const discoveryAllowed = await runner.handler(new Request("http://127.0.0.1/", {
      headers: { authorization: "Bearer ephemeral-launch-token" },
    }));
    expect(discoveryAllowed.status).toBe(200);
  });
});
