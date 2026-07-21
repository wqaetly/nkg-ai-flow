import { z } from "zod";
import { createRuntimeError, normalizeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import { searchSearxng } from "../webSearchProvider.js";

const configSchema = z.object({
  baseUrl: z.string().min(1).default("$var:WEB_SEARCH_BASE_URL"),
  apiKey: z.string().min(1).default("$var:WEB_SEARCH_API_KEY"),
  query: z.string().default(""),
  maxResults: z.number().int().min(1).max(20).default(6),
}).passthrough();

export function createWebSearchNode(fetchImpl: typeof fetch) {
  return defineNode({
    type: "web_search",
    typeVersion: "1.0.0",
    title: "Web Search",
    description: "Search the web through a SearXNG-compatible JSON endpoint.",
    capabilities: {
      supportsCancel: true,
      requiredPermissions: ["network.http", "secret.read"],
    },
    config: configSchema,
    fieldMeta: {
      baseUrl: { label: "SearXNG URL", order: 1 },
      apiKey: { label: "API key", order: 2 },
      query: { label: "Query", order: 3 },
      maxResults: { label: "Max results", control: "number", order: 4 },
    },
    ports: [
      { id: "query", direction: "input", kind: "data", label: "Query", schema: { type: "string" } },
      { id: "results", direction: "output", kind: "data", label: "Results", schema: { type: "array" } },
      { id: "count", direction: "output", kind: "data", label: "Count", schema: { type: "number" } },
      { id: "summary", direction: "output", kind: "data", label: "Summary" },
    ],
    validateInput: false,
    async run({ input, config, ctx }) {
      const raw = input as Record<string, unknown>;
      const query = typeof raw.query === "string" ? raw.query : config.query;
      const baseUrl = resolve(config.baseUrl, ctx.variables);
      const apiKey = resolve(config.apiKey, ctx.variables);
      if (!query?.trim() || !baseUrl || !apiKey) {
        return {
          kind: "error",
          error: createRuntimeError({
            code: "node.web_search.missing_config",
            kind: "validation",
            category: "author",
            message: "web_search requires query, baseUrl, and apiKey",
            source: { module: "node_logic", nodeId: ctx.nodeId },
          }) as unknown as { code: string; message: string; [key: string]: unknown },
        };
      }
      try {
        const results = await searchSearxng(baseUrl, apiKey, query, fetchImpl, {
          signal: ctx.signal,
          maxResults: config.maxResults,
        });
        return {
          kind: "success",
          outputs: {
            out: results,
            results,
            count: results.length,
            summary: { provider: "searxng", query: query.trim(), resultCount: results.length },
          },
        };
      } catch (cause) {
        return {
          kind: "error",
          error: normalizeError(cause, { module: "node_logic", nodeId: ctx.nodeId }) as unknown as {
            code: string; message: string; [key: string]: unknown;
          },
        };
      }
    },
  });
}

export const webSearchNode = createWebSearchNode((input, init) => globalThis.fetch(input, init));

function resolve(
  value: string | undefined,
  variables: { getString(name: string): string | undefined },
): string | undefined {
  if (!value) return undefined;
  const match = /^\$(?:var|secret):([A-Za-z0-9_.:-]+)$/.exec(value.trim());
  return match?.[1] ? variables.getString(match[1]) : value.trim() || undefined;
}
