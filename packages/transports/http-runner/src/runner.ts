/**
 * `transport-http-runner` — turn app manifests into a fully wired HTTP
 * server.
 *
 * The runner builds on top of `@ai-native-flow/transport-http`: that
 * package knows how to translate every `(Request) => Response` route
 * into runtime calls, but it stays deliberately oblivious to *which*
 * flows are loaded. This package fills in the missing piece by:
 *
 *   1. loading built-in apps plus optional host apps via
 *      `@ai-native-flow/workspace-manifest`,
 *   2. dynamically importing every declared `nodePacks[]` so business
 *      nodes show up on the runtime's `NodeTypeRegistry`,
 *   3. walking each `flowDirs[]` root for `*.json` graphs and registering
 *      them through `runtime.registry.register + promote`,
 *   4. exposing a `GET /` endpoint listing every registered flow + its
 *      invoke / stream URLs so curl users can discover the surface
 *      without reading the docs,
 *   5. adapting the resulting fetch handler onto Node's native
 *      `http.Server` for `tsx server.ts` style usage.
 *
 * Both halves are exported separately so embedders can pick the layer
 * they need: tests usually want `buildHttpRunnerHandler` (no socket),
 * production processes use `startHttpRunner` (real listener).
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  createHttpHandler,
  type HttpHandler,
} from "@ai-native-flow/transport-http";
import type { LlmProvider, Runtime } from "@ai-native-flow/runtime";
import { createRuntime } from "@ai-native-flow/runtime";
import type { DefinedNode } from "@ai-native-flow/node-sdk";
import {
  InMemoryVariableStore,
  type SecretStore,
  type VariableStore,
} from "@ai-native-flow/variable-store";
import {
  loadNodePack,
  loadWorkspaceManifest,
  type FlowDirEntry,
  type LoadedNodePack,
  type NodePackEntry,
  type WorkspaceManifest,
} from "@ai-native-flow/workspace-manifest";

import {
  registerFlowsFromManifest,
  type RegisteredFlow,
} from "./registerFlows.js";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Context object handed to every node-pack factory at boot. We expose
 * the exact set of runtime-level dependencies a pack might want to
 * close over (today: just the LLM provider) so packs don't have to
 * import the runtime themselves.
 */
export interface HttpRunnerNodePackContext {
  llmProvider?: LlmProvider;
}

export interface HttpRunnerOptions {
  /**
   * Where to start the manifest discovery walk. Defaults to
   * `process.cwd()`. CLI bins typically pass their own source dir so
   * the runner works regardless of the shell's CWD.
   */
  startDir?: string;
  /** Bind port. Defaults to env `ANF_HTTP_PORT`, then `8787`. */
  port?: number;
  /** Bind host. Defaults to env `ANF_HTTP_HOST`, then `127.0.0.1`. */
  hostname?: string;
  /**
   * CORS allow-list. Same semantics as `transport-http`: `"*"` for
   * permissive local dev, an explicit array for production, or omit
   * to disable CORS entirely. Defaults to `"*"`.
   */
  cors?: "*" | readonly string[];
  /**
   * Optional LLM provider. When supplied it's both wired into the
   * runtime *and* forwarded to every node-pack factory through the
   * `HttpRunnerNodePackContext`.
   */
  llmProvider?: LlmProvider;
  /** Override the default `InMemoryVariableStore`. */
  variables?: VariableStore;
  /** @deprecated Use `variables`; treated as the same store. */
  secrets?: SecretStore;
  /**
   * Extra `DefinedNode`s to install on top of whatever the workspace's
   * `nodePacks[]` produce. Useful for tests that want to inject a
   * stub node without authoring a pack on disk.
   */
  extraNodes?: readonly DefinedNode[];
  /**
   * Pre-built runtime to reuse. When provided the runner skips its
   * own `createRuntime()` call and the `llmProvider` / `variables` /
   * `secrets` / `extraNodes` / `nodePacks[]` options are *not*
   * applied to it (the caller has already wired what they want).
   * Flow registration still runs against this runtime. Tests use this
   * to share a stubbed runtime with other transports in the same
   * process.
   */
  runtime?: Runtime;
  /** Optional progress hook called on every successful flow registration. */
  onRegister?: (flow: RegisteredFlow) => void;
}

/** Snapshot of the booted runner — what's loaded, where, on which port. */
export interface HttpRunnerHandle {
  url: string;
  port: number;
  hostname: string;
  runtime: Runtime;
  manifest: WorkspaceManifest;
  flows: RegisteredFlow[];
  packs: LoadedNodePack[];
  /** Stop the underlying `http.Server`. Idempotent. */
  stop(): Promise<void>;
}

/** Pure (no socket) variant: useful for tests and embedded scenarios. */
export interface HttpRunnerHandler {
  handler: HttpHandler;
  runtime: Runtime;
  manifest: WorkspaceManifest;
  flows: RegisteredFlow[];
  packs: LoadedNodePack[];
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

interface BootstrapResult {
  runtime: Runtime;
  manifest: WorkspaceManifest;
  flows: RegisteredFlow[];
  packs: LoadedNodePack[];
}

async function loadAvailableNodePacks<TCtx>(
  entries: readonly NodePackEntry[],
  ctx: TCtx,
): Promise<LoadedNodePack[]> {
  const packs: LoadedNodePack[] = [];
  for (const entry of entries) {
    try {
      packs.push(await loadNodePack(entry, ctx));
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      console.warn(
        `[http-runner] skipping node pack '${entry.name}': ${msg}`,
      );
    }
  }
  return packs;
}

async function bootstrap(options: HttpRunnerOptions): Promise<BootstrapResult> {
  const manifest = await loadWorkspaceManifest({
    startDir: options.startDir ?? process.cwd(),
  });

  // Reuse a caller-supplied runtime when given. We still load packs +
  // register flows against it, but we don't reach into its internal
  // wiring (provider / stores / built-in nodes are whatever the caller
  // already configured).
  if (options.runtime) {
    const flows = await registerFlowsFromManifest({
      runtime: options.runtime,
      flowDirs: manifest.flowDirs,
      onRegister: options.onRegister,
    });
    return {
      runtime: options.runtime,
      manifest,
      flows,
      packs: [],
    };
  }

  // Build a fresh runtime from the manifest + caller-supplied deps.
  const packCtx: HttpRunnerNodePackContext = options.llmProvider
    ? { llmProvider: options.llmProvider }
    : {};
  const packs = await loadAvailableNodePacks(manifest.nodePacks, packCtx);
  const customNodes: DefinedNode[] = packs.flatMap((p) => p.nodes);
  const allNodes: DefinedNode[] = options.extraNodes
    ? [...customNodes, ...options.extraNodes]
    : customNodes;

  const variables = options.variables ?? options.secrets ?? new InMemoryVariableStore();
  const runtime = createRuntime({
    variables,
    secrets: variables,
    ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
    nodes: allNodes,
  });

  const flows = await registerFlowsFromManifest({
    runtime,
    flowDirs: manifest.flowDirs,
    onRegister: options.onRegister,
  });

  return { runtime, manifest, flows, packs };
}

/* -------------------------------------------------------------------------- */
/* Listing route                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the JSON body returned by `GET /`. Mirrors the shape that
 * Studio / curl users have already learned to expect (Studio reads
 * `flows[]` to populate the run-target dropdown).
 */
function buildEndpointListing(
  flows: readonly RegisteredFlow[],
  manifestSource: string | null,
): unknown {
  return {
    ok: true,
    manifest: manifestSource,
    flows: flows.map((f) => ({
      flowId: f.flowId,
      flowVersion: f.flowVersion,
      workspace: f.workspace,
      file: f.file,
      endpoints: {
        invoke: `POST /flows/${f.flowId}/invoke`,
        stream: `POST /flows/${f.flowId}/stream`,
      },
    })),
    runs: {
      record: "GET  /runs/:runId",
      events: "GET  /runs/:runId/events",
      stream: "GET  /runs/:runId/events/stream",
      cancel: "POST /runs/:runId/cancel",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the fetch-style handler without binding any socket.
 *
 * The returned handler honours `GET /` itself (returning the listing)
 * and delegates everything else to `transport-http`'s `createHttpHandler`.
 */
export async function buildHttpRunnerHandler(
  options: HttpRunnerOptions = {},
): Promise<HttpRunnerHandler> {
  const boot = await bootstrap(options);
  const inner = createHttpHandler({
    runtime: boot.runtime,
    ...(options.cors !== undefined ? { cors: options.cors } : { cors: "*" }),
  });

  const listingBody = buildEndpointListing(boot.flows, boot.manifest.source);

  const handler: HttpHandler = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method.toUpperCase() === "GET") {
      return new Response(JSON.stringify(listingBody, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return inner(request);
  };

  return {
    handler,
    runtime: boot.runtime,
    manifest: boot.manifest,
    flows: boot.flows,
    packs: boot.packs,
  };
}

/**
 * Boot the runner *and* attach it to a Node `http.Server`. Returns a
 * handle the caller can use to read the bound URL and gracefully
 * shut the server down.
 */
export async function startHttpRunner(
  options: HttpRunnerOptions = {},
): Promise<HttpRunnerHandle> {
  const built = await buildHttpRunnerHandler(options);

  const port = resolvePort(options);
  const hostname = resolveHostname(options);

  const server = createServer((req, res) => {
    void dispatch(req, res, built.handler);
  });

  return await new Promise<HttpRunnerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      const address = server.address();
      const actualPort =
        typeof address === "object" && address !== null && "port" in address
          ? address.port
          : port;
      const url = `http://${hostname}:${actualPort}`;
      resolve({
        port: actualPort,
        hostname,
        url,
        runtime: built.runtime,
        manifest: built.manifest,
        flows: built.flows,
        packs: built.packs,
        stop: () => stopServer(server),
      });
    });
  });
}

function resolvePort(options: HttpRunnerOptions): number {
  if (typeof options.port === "number") return options.port;
  const env = process.env.ANF_HTTP_PORT ?? process.env.PORT;
  if (env && env.trim()) {
    const parsed = Number(env);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 8787;
}

function resolveHostname(options: HttpRunnerOptions): string {
  return options.hostname ?? process.env.ANF_HTTP_HOST ?? "127.0.0.1";
}

function stopServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/* -------------------------------------------------------------------------- */
/* Node http <-> fetch adapter                                                */
/* -------------------------------------------------------------------------- */

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  handler: HttpHandler,
): Promise<void> {
  try {
    const fetchRequest = await toFetchRequest(req);
    const fetchResponse = await handler(fetchRequest);
    await writeFetchResponse(fetchResponse, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: { message: (err as Error).message ?? "internal_error" },
      }),
    );
  }
}

async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else if (typeof v === "string") headers.set(k, v);
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    // Stream the body straight through so large uploads don't have to
    // buffer in memory before reaching the handler.
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeFetchResponse(
  fetchResponse: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!fetchResponse.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(
    fetchResponse.body as unknown as NodeReadableStream<Uint8Array>,
  );
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("error", reject);
    res.on("close", resolve);
    res.on("finish", resolve);
    nodeStream.pipe(res);
  });
}

/* Re-exports for callers that want to dig deeper without importing the
 * dependency packages directly. */
export type {
  FlowDirEntry,
  NodePackEntry,
  WorkspaceManifest,
  LoadedNodePack,
} from "@ai-native-flow/workspace-manifest";
export type { RegisteredFlow } from "./registerFlows.js";
