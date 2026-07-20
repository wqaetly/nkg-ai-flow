/**
 * HTTP transport for the Runtime.
 *
 * Phase 1 implements the synchronous invoke endpoint plus inspection
 * endpoints. Streaming (`/flows/:id/stream`) is added in Phase 2 after the
 * EventBus has live subscribe semantics in place.
 *
 * Endpoint surface (per `docs/specs/transports.md` §8.1):
 *
 *   POST /flows/:flowId/invoke   - run a flow, await completion, return final
 *                                  output. Body: { input?: unknown, flowVersion?: string }.
 *   GET  /runs/:runId            - read RunRecord.
 *   GET  /runs/:runId/events     - read events (cursor=:eventId optional).
 *   POST /runs/:runId/cancel     - abort an in-flight run.
 *
 * The handler is a plain `(Request) => Promise<Response>` so it works
 * with Node fetch-compatible handlers handlers, Cloudflare Workers, or anything
 * else that speaks the WHATWG fetch API.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  type FlowGraph,
  type Position,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import type { Runtime } from "@ai-native-flow/runtime";
import {
  InMemoryVariableStore,
  chainVariableStores,
  type VariableStore,
  type VariableValue,
} from "@ai-native-flow/variable-store/browser";
import { pickCursor, streamRunEvents } from "./sse.js";

export interface CreateHttpHandlerOptions {
  runtime: Runtime;
  /** Optional URL prefix, e.g. "/api". Empty by default. */
  basePath?: string;
  /**
   * Allowed origins for CORS. When set the handler emits the standard
   * Access-Control-* headers and short-circuits OPTIONS preflight. Use
   * `"*"` for permissive local development or pass an explicit list of
   * origins for production deployments. Omit to disable CORS entirely
   * (the default; same-origin or non-browser callers don't need it).
   */
  cors?: "*" | readonly string[];
  /**
   * Generates the one-shot version id used for per-invocation node overrides.
   * Defaults to Web Crypto; injectable for deterministic hosts and tests.
   */
  createOverrideVersion?: (
    graphJson: string,
    baseVersion: string,
  ) => Promise<string>;
  /** Optional host authentication gate, evaluated before Runtime routes. */
  authorize?: (request: Request) => boolean | Promise<boolean>;
}

export type HttpHandler = (request: Request) => Promise<Response>;

interface InvokeBody {
  input?: unknown;
  flowVersion?: string;
  traceId?: string;
  envOverrides?: EnvOverridesBody;
  /**
   * Per-node parameter overrides applied for THIS invocation only.
   * Equivalent to Langflow's `tweaks`. The transport materialises a
   * one-shot, content-addressed flow version so concurrent requests
   * with different overrides never see each other's state and the
   * registry's active pointer is never touched.
   *
   * Shape: `{ [nodeId]: { config?: {...}, label?, position? } }`.
   * Unknown node ids are rejected (400). Each `config` is shallow-
   * merged on top of the node's existing `config` so callers only
   * need to send the fields they want to change.
   */
  nodeOverrides?: NodeOverridesBody;
}

export type NodeOverridesBody = Record<string, NodeOverrideBody>;

export interface NodeOverrideBody {
  config?: Record<string, unknown>;
  label?: string;
  position?: Position;
}

interface EnvOverridesBody {
  variables?: Record<string, VariableValue>;
  secrets?: Record<string, string>;
}

interface ResolvedEnvOverrides {
  variables?: VariableStore;
}

interface InvokeNodeBody extends InvokeBody {
  /** Optional override; when omitted the body's `input` is used. */
  nodeInput?: unknown;
}

interface ResumePointBody {
  resumePointName?: string;
  name?: string;
  flowVersion?: string;
  traceId?: string;
  envOverrides?: EnvOverridesBody;
  nodeOverrides?: NodeOverridesBody;
}

export function createHttpHandler(options: CreateHttpHandlerOptions): HttpHandler {
  const { runtime } = options;
  const base = options.basePath ?? "";
  const cors = options.cors;
  const createOverrideVersion =
    options.createOverrideVersion ?? createPortableOverrideVersion;

  /**
   * Decide what value to echo into `Access-Control-Allow-Origin`. We
   * mirror the request's `Origin` when the caller is in the allow-list
   * (so credentials-aware browsers can be used later), or `"*"` when
   * the host opted into wide-open CORS, or omit the header entirely
   * when CORS is disabled.
   */
  const resolveAllowOrigin = (request: Request): string | undefined => {
    if (!cors) return undefined;
    if (cors === "*") return "*";
    const origin = request.headers.get("origin");
    if (!origin) return undefined;
    return cors.includes(origin) ? origin : undefined;
  };

  const corsHeaders = (request: Request): Record<string, string> => {
    const origin = resolveAllowOrigin(request);
    if (!origin) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, last-event-id",
      // SSE responses include `Last-Event-ID`; expose it so resume code
      // running in the browser can read it back.
      "access-control-expose-headers": "last-event-id",
      vary: "Origin",
    };
  };

  const withCors = (response: Response, request: Request): Response => {
    const headers = corsHeaders(request);
    if (Object.keys(headers).length === 0) return response;
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  };

  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    // CORS preflight — short-circuit with the allow headers; the rest
    // of the routing tree never sees `OPTIONS`.
    if (method === "OPTIONS" && cors) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }
    if (options.authorize && !(await options.authorize(request))) {
      return withCors(json(401, {
        error: {
          code: "transport.unauthorized",
          message: "Runtime authentication failed",
        },
      }), request);
    }
    // Run the real router and decorate every response with CORS in
    // one place \u2014 saves us from threading `withCors(\u2026)` through every
    // single `return` statement.
    const response = await handleRequest(request);
    return withCors(response, request);
  };

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    const method = request.method.toUpperCase();

    try {
      // POST /flows/register (Studio convenience: register-and-promote
      // a graph in one shot). Body: { graph: FlowGraph, status?: "staging" }.
      // Always promotes after registering so subsequent invokeNode /
      // streamFlow calls hit the active version. Idempotent: a graph
      // with the same id+version replaces the prior staging copy.
      if (path === "/flows/register" && method === "POST") {
        const body = (await safeJson(request)) as { graph?: unknown };
        const graph = body.graph as
          | { id: string; version: string; nodes: unknown[]; edges: unknown[] }
          | undefined;
        if (
          !graph ||
          typeof graph.id !== "string" ||
          typeof graph.version !== "string" ||
          !Array.isArray(graph.nodes) ||
          !Array.isArray(graph.edges)
        ) {
          return json(400, {
            error: {
              code: "transport.invalid_input",
              message: "Body must be { graph: FlowGraph } with id, version, nodes, edges.",
            },
          });
        }
        const jsonStr = JSON.stringify(graph);
        // The flow registry's `register()` upserts on (id, version), so a
        // re-register from Studio after a graph edit just replaces the
        // staging copy \u2014 no conflict to swallow.
        await runtime.registry.register({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          graph: graph as any,
          json: jsonStr,
          status: "staging",
        });
        await runtime.registry.promote(graph.id, graph.version);
        return json(204, null);
      }
      // POST /flows/:flowId/invoke
      const invoke = path.match(/^\/flows\/([^/]+)\/invoke$/);
      if (invoke && method === "POST") {
        const flowId = decodeURIComponent(invoke[1]!);
        const body = (await safeJson(request)) as InvokeBody;
        const env = buildEnvOverrides(runtime, body.envOverrides);
        const flowVersion = await materialiseOverrides(
          runtime,
          flowId,
          body.flowVersion,
          body.nodeOverrides,
          createOverrideVersion,
        );
        const result = await runtime.invocationRouter.invoke({
          flowId,
          input: body.input ?? null,
          ...(flowVersion !== undefined ? { flowVersion } : {}),
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
          ...env,
        });
        const status = result.succeeded ? 200 : result.cancelled ? 499 : 500;
        return json(status, {
          runId: result.runRecord.runId,
          flowId: result.runRecord.flowId,
          flowVersion: result.runRecord.flowVersion,
          status: result.runRecord.status,
          output: result.output ?? null,
          error: result.error ?? null,
        });
      }

      // POST /flows/:flowId/nodes/:nodeId/invoke (Step 3: sub-graph)
      // Synchronous sub-graph invocation. Runs the upstream closure of
      // `:nodeId` and returns the sink's primary data output. The
      // RunRecord stays pinned to the original flow id/version so
      // run-listing endpoints continue to behave correctly.
      const invokeNode = path.match(
        /^\/flows\/([^/]+)\/nodes\/([^/]+)\/invoke$/,
      );
      if (invokeNode && method === "POST") {
        const flowId = decodeURIComponent(invokeNode[1]!);
        const nodeId = decodeURIComponent(invokeNode[2]!);
        const body = (await safeJson(request)) as InvokeNodeBody;
        const env = buildEnvOverrides(runtime, body.envOverrides);
        // `nodeInput` lets a future client override the Run input that
        // a node sees without mutating the flow's `input` semantics for
        // wider tooling — today we accept either, with `nodeInput`
        // taking precedence when both are present.
        const runInput =
          body.nodeInput !== undefined ? body.nodeInput : body.input ?? null;
        const flowVersion = await materialiseOverrides(
          runtime,
          flowId,
          body.flowVersion,
          body.nodeOverrides,
          createOverrideVersion,
        );
        const result = await runtime.invocationRouter.invokeNode({
          flowId,
          nodeId,
          input: runInput,
          ...(flowVersion !== undefined ? { flowVersion } : {}),
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
          ...env,
        });
        const status = result.succeeded ? 200 : result.cancelled ? 499 : 500;
        return json(status, {
          runId: result.runRecord.runId,
          flowId: result.runRecord.flowId,
          flowVersion: result.runRecord.flowVersion,
          nodeId,
          status: result.runRecord.status,
          output: result.output ?? null,
          error: result.error ?? null,
        });
      }

      // POST /flows/:flowId/resume
      // Resume from a durable `resume_point` marker. The marker provides
      // the target node and snapshot input, so the body only needs the
      // marker name plus optional version / environment overrides.
      const resume = path.match(/^\/flows\/([^/]+)\/resume$/);
      if (resume && method === "POST") {
        const flowId = decodeURIComponent(resume[1]!);
        const body = (await safeJson(request)) as ResumePointBody;
        const env = buildEnvOverrides(runtime, body.envOverrides);
        const flowVersion = await materialiseOverrides(
          runtime,
          flowId,
          body.flowVersion,
          body.nodeOverrides,
          createOverrideVersion,
        );
        const resumePointName = body.resumePointName ?? body.name ?? "";
        const result = await runtime.invocationRouter.resumeFromPoint({
          flowId,
          resumePointName,
          ...(flowVersion !== undefined ? { flowVersion } : {}),
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
          ...env,
        });
        const status = result.succeeded ? 200 : result.cancelled ? 499 : 500;
        return json(status, {
          runId: result.runRecord.runId,
          flowId: result.runRecord.flowId,
          flowVersion: result.runRecord.flowVersion,
          resumePointName,
          status: result.runRecord.status,
          output: result.output ?? null,
          error: result.error ?? null,
        });
      }

      // GET /runs/:runId
      const runGet = path.match(/^\/runs\/([^/]+)$/);
      if (runGet && method === "GET") {
        const runId = decodeURIComponent(runGet[1]!);
        const record = await runtime.runManager.get(runId);
        if (!record) return notFound(`run ${runId} not found`);
        return json(200, record);
      }

      // GET /runs/:runId/events
      const runEvents = path.match(/^\/runs\/([^/]+)\/events$/);
      if (runEvents && method === "GET") {
        const runId = decodeURIComponent(runEvents[1]!);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "1000", 10);
        const events = await runtime.eventBus.store.read(runId, {
          ...(cursor !== undefined ? { sinceEventId: cursor } : {}),
          limit: Number.isFinite(limit) ? limit : 1000,
        });
        return json(200, { events });
      }

      // GET /runs/:runId/events/stream  (Phase 2 SSE)
      const runEventsStream = path.match(/^\/runs\/([^/]+)\/events\/stream$/);
      if (runEventsStream && method === "GET") {
        const runId = decodeURIComponent(runEventsStream[1]!);
        const record = await runtime.runManager.get(runId);
        if (!record) return notFound(`run ${runId} not found`);
        const cursor = pickCursor(request, url);
        return streamRunEvents(runtime.eventBus, runId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }

      // POST /flows/:flowId/stream  (Phase 2 SSE)
      // Starts a Run and streams its events. Input and run-scoped
      // environment overrides are read from the JSON body so browsers can
      // pass secrets without exposing them in a URL.
      const flowStream = path.match(/^\/flows\/([^/]+)\/stream$/);
      if (flowStream && method === "POST") {
        const flowId = decodeURIComponent(flowStream[1]!);
        const body = (await safeJson(request)) as InvokeBody;
        const env = buildEnvOverrides(runtime, body.envOverrides);
        const flowVersion = await materialiseOverrides(
          runtime,
          flowId,
          body.flowVersion,
          body.nodeOverrides,
          createOverrideVersion,
        );
        const started = await runtime.invocationRouter.startDeferred({
          flowId,
          input: body.input ?? null,
          ...(flowVersion !== undefined ? { flowVersion } : {}),
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
          ...env,
        });
        // Detach the completion promise: the SSE response will close
        // itself once the run reaches a terminal kind, regardless of
        // success / failure / cancellation.
        void started.completed.catch(() => {
          /* errors are surfaced as run_failed events on the bus */
        });
        const cursor = pickCursor(request, url);
        return streamRunEvents(runtime.eventBus, started.runRecord.runId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          onStart: () => started.startExecution(),
        });
      }

      // POST /flows/:flowId/nodes/:nodeId/stream (Step 3: sub-graph SSE)
      // Starts a sub-graph Run terminating at `:nodeId` and streams its
      // events. The request body mirrors the full-flow stream endpoint.
      const nodeStream = path.match(
        /^\/flows\/([^/]+)\/nodes\/([^/]+)\/stream$/,
      );
      if (nodeStream && method === "POST") {
        const flowId = decodeURIComponent(nodeStream[1]!);
        const nodeId = decodeURIComponent(nodeStream[2]!);
        const body = (await safeJson(request)) as InvokeNodeBody;
        const env = buildEnvOverrides(runtime, body.envOverrides);
        const runInput =
          body.nodeInput !== undefined ? body.nodeInput : body.input ?? null;
        const flowVersion = await materialiseOverrides(
          runtime,
          flowId,
          body.flowVersion,
          body.nodeOverrides,
          createOverrideVersion,
        );
        const started = await runtime.invocationRouter.startNodeDeferred({
          flowId,
          nodeId,
          input: runInput,
          ...(flowVersion !== undefined ? { flowVersion } : {}),
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
          ...env,
        });
        void started.completed.catch(() => {
          /* errors are surfaced as run_failed events on the bus */
        });
        const cursor = pickCursor(request, url);
        return streamRunEvents(runtime.eventBus, started.runRecord.runId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          onStart: () => started.startExecution(),
        });
      }

      // POST /flows/:flowId/resume/stream
      const resumeStream = path.match(/^\/flows\/([^/]+)\/resume\/stream$/);
      if (resumeStream && method === "POST") {
        const flowId = decodeURIComponent(resumeStream[1]!);
        const body = (await safeJson(request)) as ResumePointBody;
        const env = buildEnvOverrides(runtime, body.envOverrides);
        const flowVersion = await materialiseOverrides(
          runtime,
          flowId,
          body.flowVersion,
          body.nodeOverrides,
          createOverrideVersion,
        );
        const started = await runtime.invocationRouter.startFromPoint({
          flowId,
          resumePointName: body.resumePointName ?? body.name ?? "",
          ...(flowVersion !== undefined ? { flowVersion } : {}),
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
          ...env,
        });
        void started.completed.catch(() => {
          /* errors are surfaced as run_failed events on the bus */
        });
        const cursor = pickCursor(request, url);
        return streamRunEvents(runtime.eventBus, started.runRecord.runId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }

      // POST /runs/:runId/cancel
      const runCancel = path.match(/^\/runs\/([^/]+)\/cancel$/);
      if (runCancel && method === "POST") {
        const runId = decodeURIComponent(runCancel[1]!);
        try {
          await runtime.runManager.cancel(runId);
          return json(202, { runId, cancelled: true });
        } catch (cause) {
          if (cause instanceof RuntimeErrorException) {
            return jsonError(404, cause.error);
          }
          throw cause;
        }
      }

      return notFound(`no handler for ${method} ${path}`);
    } catch (cause) {
      if (cause instanceof RuntimeErrorException) {
        const status = mapErrorStatus(cause.error);
        return jsonError(status, cause.error);
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return json(500, { error: { code: "transport.internal", message } });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function json(status: number, body: unknown): Response {
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(status: number, error: RuntimeError): Response {
  return json(status, { error });
}

function buildEnvOverrides(
  runtime: Runtime,
  overrides: EnvOverridesBody | undefined,
): ResolvedEnvOverrides {
  if (!overrides) return {};
  const result: ResolvedEnvOverrides = {};
  const variables = {
    ...(overrides.variables && typeof overrides.variables === "object"
      ? overrides.variables
      : {}),
    ...(overrides.secrets && typeof overrides.secrets === "object"
      ? overrides.secrets
      : {}),
  };
  if (Object.keys(variables).length > 0) {
    const store = new InMemoryVariableStore(
      Object.entries(variables).map(([name, value]) => ({
        name,
        value,
        metadata: { source: "request" },
      })),
    );
    result.variables = chainVariableStores(store, runtime.variables);
  }
  return result;
}

function notFound(message: string): Response {
  return json(404, { error: { code: "transport.not_found", message } });
}

async function safeJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-length") === "0") return {};
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Materialise a one-shot Flow Version with `nodeOverrides` applied.
 *
 * Returns the version string the caller should pass to the Runtime
 * (either the user-supplied `flowVersion`, or a freshly registered
 * derived version, or `undefined` to fall back to the active version
 * when no overrides are present).
 *
 * Concurrency contract:
 *   - The temporary version id is content-addressed (sha256 of the
 *     overridden graph JSON) AND suffixed with a per-call random hex,
 *     so concurrent requests with the SAME overrides each get their
 *     own registry entry. Identical content from the same caller stays
 *     idempotent within a single call (the suffix is generated once).
 *   - We NEVER call `registry.promote(...)`, so the active pointer is
 *     untouched. RunRecord pins (flowId, version, artifactHash) at
 *     creation time, so even if the temp version were later evicted
 *     the in-flight Run is unaffected.
 *   - `register()` revalidates the cloned graph; malformed overrides
 *     surface as a 400 (validation) instead of corrupting later runs.
 */
async function materialiseOverrides(
  runtime: Runtime,
  flowId: string,
  baseVersion: string | undefined,
  overrides: NodeOverridesBody | undefined,
  createOverrideVersion: (
    graphJson: string,
    baseVersion: string,
  ) => Promise<string>,
): Promise<string | undefined> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return baseVersion;
  }
  const baseRef = baseVersion
    ? await runtime.registry.resolve(flowId, baseVersion)
    : await runtime.registry.getActive(flowId);

  const derived = applyNodeOverrides(baseRef.graph, overrides);
  const json = JSON.stringify(derived);
  const derivedVersion = await createOverrideVersion(json, baseRef.version);
  const cloned: FlowGraph = { ...derived, version: derivedVersion };
  const clonedJson = JSON.stringify(cloned);

  await runtime.registry.register({
    graph: cloned,
    json: clonedJson,
    status: "staging",
  });
  return derivedVersion;
}

async function createPortableOverrideVersion(
  graphJson: string,
  baseVersion: string,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof globalThis.crypto.randomUUID !== "function") {
    throw new Error(
      "nodeOverrides require globalThis.crypto.subtle and crypto.randomUUID",
    );
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(graphJson),
  );
  const contentHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("").slice(0, 12);
  const random = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${baseVersion}+ov.${contentHash}.${random}`;
}

function applyNodeOverrides(
  graph: FlowGraph,
  overrides: NodeOverridesBody,
): FlowGraph {
  // Deep clone so the cached graph in the registry is never mutated.
  const clone = structuredClone(graph) as FlowGraph;
  const nodeIndex = new Map(clone.nodes.map((n, i) => [n.id, i] as const));

  for (const [nodeId, patch] of Object.entries(overrides)) {
    const idx = nodeIndex.get(nodeId);
    if (idx === undefined) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "transport.node_overrides.unknown_node",
          kind: "validation",
          category: "user_input",
          message: `nodeOverrides target "${nodeId}" not found in flow ${graph.id}@${graph.version}`,
          source: { module: "transport", flowId: graph.id, flowVersion: graph.version },
          context: { flowId: graph.id, flowVersion: graph.version, nodeId },
        }),
      );
    }
    const node = clone.nodes[idx]!;
    if (patch.config && typeof patch.config === "object") {
      node.config = { ...node.config, ...patch.config };
    }
    if (patch.label !== undefined) {
      node.label = patch.label;
    }
    if (patch.position) {
      node.position = { x: patch.position.x, y: patch.position.y };
    }
  }
  return clone;
}

function mapErrorStatus(error: RuntimeError): number {
  switch (error.kind) {
    case "validation":
      return 400;
    case "permission":
      return 403;
    case "not_found":
      return 404;
    case "timeout":
      return 504;
    case "unavailable":
      return 503;
    case "external":
      return 502;
    default:
      return 500;
  }
}
