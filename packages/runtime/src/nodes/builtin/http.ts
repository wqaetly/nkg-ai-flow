/**
 * `http` — call an external HTTP API.
 *
 * Reads the optional ambient `HTTP_DEFAULT_TIMEOUT_MS` variable to
 * demonstrate the "any node, any logic, same interface" rule.
 * Hard-coding values in `node.config` still works, but going through
 * `ctx.variables` lets a single workspace variable retune every HTTP
 * node deployed in the project.
 *
 * Cancellation: a single `AbortController` merges (a) the engine's
 * `ctx.signal` (set when the run is cancelled / times out) and (b) the
 * per-call `setTimeout` derived from the timeout variable.
 */

import { z } from "zod";
import { createRuntimeError, normalizeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";

const httpConfig = z
  .object({
    url: z
      .string()
      .url()
      .optional()
      .describe("Endpoint URL (required at runtime)."),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
      .default("GET")
      .describe("HTTP method."),
    headers: z
      .record(z.string())
      .optional()
      .describe("Header map serialised as JSON."),
    body: z
      .unknown()
      .optional()
      .describe("Body (string for raw, object for JSON)."),
  })
  .passthrough();

export const httpNode = defineNode({
  type: "http",
  typeVersion: "1.0.0",
  title: "HTTP",
  description: "Call an HTTP API.",
  config: httpConfig,
  fieldMeta: {
    url: { label: "URL", placeholder: "https://api.example.com/v1", order: 1 },
    method: { label: "Method", control: "select", order: 2 },
    headers: { label: "Headers", control: "json", order: 3 },
    body: { label: "Body", control: "json", order: 4 },
  },
  ports: [
    {
      id: "response",
      direction: "output",
      kind: "data",
      label: "Response",
      schema: { type: "object" },
    },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const raw = input as Record<string, unknown>;
    const url = config.url;
    const method = config.method ?? "GET";
    if (!url) {
      return {
        kind: "error",
        error: createRuntimeError({
          code: "node.http.missing_url",
          kind: "validation",
          category: "author",
          message: "http node requires config.url",
          source: { module: "node_logic", nodeId: ctx.nodeId },
          context: { nodeId: ctx.nodeId },
        }) as unknown as {
          code: string;
          message: string;
          [k: string]: unknown;
        },
      };
    }

    const timeoutMs =
      ctx.variables.getNumber("HTTP_DEFAULT_TIMEOUT_MS") ?? 30000;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const headers = config.headers ?? {};
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : typeof config.body === "string"
            ? config.body
            : JSON.stringify(config.body ?? raw.input ?? {});
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: ac.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as text */
      }
      return {
        kind: "success",
        outputs: {
          out: null,
          response: {
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: parsed,
          },
        },
      };
    } catch (cause) {
      return {
        kind: "error",
        error: normalizeError(cause, {
          module: "node_logic",
          nodeId: ctx.nodeId,
        }) as unknown as {
          code: string;
          message: string;
          [k: string]: unknown;
        },
      };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
});
