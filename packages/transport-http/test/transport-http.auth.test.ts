import { describe, expect, it } from "vitest";
import { createRuntime } from "@ai-native-flow/runtime";
import { createHttpHandler } from "../src/index.js";

describe("HTTP transport authorization", () => {
  it("rejects unauthenticated requests before routing", async () => {
    const handler = createHttpHandler({
      runtime: createRuntime(),
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer launch-token",
    });

    const rejected = await handler(new Request("http://runtime.local/runs/unknown"));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({
      error: {
        code: "transport.unauthorized",
        message: "Runtime authentication failed",
      },
    });

    const accepted = await handler(new Request("http://runtime.local/runs/unknown", {
      headers: { authorization: "Bearer launch-token" },
    }));
    expect(accepted.status).toBe(404);
  });

  it("allows CORS preflight without exposing Runtime data", async () => {
    const handler = createHttpHandler({
      runtime: createRuntime(),
      cors: ["tauri://localhost"],
      authorize: () => false,
    });
    const response = await handler(new Request("http://runtime.local/flows/a/invoke", {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost" },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
