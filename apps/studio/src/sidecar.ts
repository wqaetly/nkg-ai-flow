/**
 * Studio sidecar - the local Node process that hosts the runtime so the
 * browser-side editor at `localhost:3000` can register, run and stream
 * flows over HTTP/SSE.
 *
 * Run it standalone from `apps/studio` with:
 *
 *   npm run dev:backend
 *
 * Defaults match the constants Studio ships with (`http://localhost:5173`).
 * Set `ANF_SIDECAR_PORT` / `ANF_SIDECAR_HOSTNAME` to override, and
 * `ANF_SIDECAR_CORS=*` (default) or a comma-separated origin list for
 * stricter local setups.
 *
 * Workspace model:
 *   The sidecar discovers this repository's built-in apps and optionally
 *   loads host apps from the nearest `anf.apps.json`. Each app manifest
 *   declares app-relative `flowDirs[]` and `nodePacks[]`.
 *
 *   Flow roots are exposed under a logical `workspace` name on the wire
 *   so the front-end can prefix the explorer tree. Node packs are
 *   `await import()`ed at boot and their `NodeTypeDefinition`s are
 *   surfaced through `/studio/nodes/list`.
 *
 * LLM provider policy: this sidecar always uses
 * `AiSdkOpenAICompatibleLlmProvider`. Every LLM call must therefore supply
 * `baseUrl`, `apiKey` and `model` directly through the node's `config`
 * (per-call overrides on `LlmCompletionRequest`). The sidecar does NOT
 * read external LLM config; if the
 * graph is missing those fields, the run fails loudly so the author
 * knows to fill them in on the canvas.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
// Use the Web Streams types from node:stream/web rather than the global
// (lib.dom) ReadableStream. Both share the name `ReadableStream`, but
// `Readable.fromWeb` is typed against the node:stream/web variant; the
// dom one has a slightly different BYOB reader shape and TS rejects the
// cast at the boundary.
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AiSdkOpenAICompatibleLlmProvider,
  createNodeRuntime,
} from "@ai-native-flow/runtime/node";
import type { DefinedNode } from "@ai-native-flow/node-sdk";
import type { NodeTypeDefinition } from "@ai-native-flow/flow-ir";
import { createHttpHandler } from "@ai-native-flow/transport-http";
import {
  InMemoryVariableStore,
  chainVariableStores,
  createFlowScopedStores,
  loadFlowEnvSidecars,
  resolveFlowEnvSidecarPaths,
  type VariableValue,
  type VariableStore,
} from "@ai-native-flow/variable-store";
import {
  loadNodePack,
  loadWorkspaceManifest,
  type FlowDirEntry,
  type LoadedNodePack,
  type WorkspaceManifest,
} from "@ai-native-flow/workspace-manifest";
import { findAvailablePort } from "@ai-native-flow/net-utils";

const hostname = process.env.ANF_SIDECAR_HOSTNAME ?? "127.0.0.1";
// Resolve a bindable port before listening. The preferred port (env or 5173)
// may be occupied or kernel-reserved (Windows WinNAT/Hyper-V binds throw
// EACCES); findAvailablePort kills any occupant and falls forward to the next
// free port. When a parent process injected an already-probed ANF_SIDECAR_PORT,
// this resolves to that same port immediately.
const port = await findAvailablePort(Number(process.env.ANF_SIDECAR_PORT ?? "5173"), {
  host: hostname,
  prefix: "studio-sidecar",
});

const corsRaw = (process.env.ANF_SIDECAR_CORS ?? "*").trim();
const cors: "*" | readonly string[] =
  corsRaw === "*" ? "*" : corsRaw.split(",").map((s) => s.trim()).filter(Boolean);

// Resolve paths relative to this source file so they are correct
// regardless of the process cwd.
const sidecarFile = fileURLToPath(import.meta.url);
const sidecarDir = path.dirname(sidecarFile);

const llmProvider = new AiSdkOpenAICompatibleLlmProvider();

/* ------------------------------------------------------------------ */
/* Workspace bootstrap                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-pack context handed to every `nodePacks[]` factory at boot.
 *
 * The shared `loadNodePack` helper accepts an arbitrary `ctx` shape so
 * each integration (sidecar / http-runner / tests) decides what its
 * packs may close over. The Studio sidecar exposes the configured
 * LLM provider so packs that wrap LLM-dependent nodes can register
 * runners against a single provider instance.
 */
export interface NodePackContext {
  readonly llmProvider: AiSdkOpenAICompatibleLlmProvider;
}

async function bootstrapWorkspace(): Promise<{
  manifest: WorkspaceManifest;
  packs: LoadedNodePack[];
  flowRoots: FlowDirEntry[];
}> {
  // Default flow root keeps legacy behaviour when no manifest is
  // present: scan `apps/studio/flows/`. The default name `samples`
  // becomes the workspace prefix on the wire.
  const defaultFlowDir = {
    name: "samples",
    abs: path.resolve(sidecarDir, "..", "flows"),
  };
  const manifest = await loadWorkspaceManifest({
    startDir: sidecarDir,
    defaultFlowDir,
  });

  const packCtx: NodePackContext = { llmProvider };
  const packs: LoadedNodePack[] = [];
  for (const entry of manifest.nodePacks) {
    try {
      const pack = await loadNodePack(entry, packCtx);
      packs.push(pack);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      console.warn(
        `[studio-sidecar] skipping node pack '${entry.name}': ${msg}`,
      );
    }
  }
  return { manifest, packs, flowRoots: manifest.flowDirs };
}

interface LoadedFlowEnv {
  variables: VariableStore;
  sidecars: Array<{ flowPath: string; entries: number; paths: string[] }>;
}

async function loadWorkspaceFlowEnvVariables(
  roots: readonly FlowDirEntry[],
): Promise<LoadedFlowEnv> {
  const layers: VariableStore[] = [];
  const sidecars: LoadedFlowEnv["sidecars"] = [];
  for (const root of roots) {
    const flowPaths: string[] = [];
    await collectFlowJsonFiles(root.abs, flowPaths);
    for (const flowPath of flowPaths) {
      const scoped = createFlowScopedStores({ flowPath, env: null });
      const entries = scoped.variables.list().length;
      if (entries === 0) continue;
      layers.push(scoped.variables);
      sidecars.push({ flowPath, entries, paths: scoped.paths });
    }
  }
  if (layers.length === 0) {
    return { variables: new InMemoryVariableStore(), sidecars };
  }
  return {
    variables: chainVariableStores(...layers),
    sidecars,
  };
}

async function collectFlowJsonFiles(
  dirAbs: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await collectFlowJsonFiles(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isFlowGraphJson(entry.name)) continue;
    out.push(abs);
  }
}

function isFlowGraphJson(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.endsWith(".json") &&
    !lower.endsWith(".env.json") &&
    !lower.endsWith(".local.env.json") &&
    !lower.endsWith(".env.example.json")
  );
}

const { manifest, packs, flowRoots } = await bootstrapWorkspace();
const flowEnv = await loadWorkspaceFlowEnvVariables(flowRoots);
const variables = flowEnv.variables;
const secrets = variables;

const allCustomNodes: DefinedNode[] = packs.flatMap((p) => p.nodes);

const runtime = createNodeRuntime({
  variables,
  secrets,
  llmProvider,
  nodes: allCustomNodes,
});

const handleRequest = createHttpHandler({ runtime, cors });

/* ------------------------------------------------------------------ */
/* Multi-root flow filesystem                                         */
/* ------------------------------------------------------------------ */

interface FlowsListItem {
  /** Logical workspace name (matches a `flowDirs[].name`). */
  workspace: string;
  /** Absolute root directory the file sits under. */
  root: string;
  /** Filename relative to `root`, POSIX separators (e.g. "nested/foo.json"). */
  file: string;
  /** Raw contents (parsed). */
  graph: unknown;
}

interface ResolvedFlowFile {
  abs: string;
  rel: string;
  root: FlowDirEntry;
}

function findFlowRoot(name: string): FlowDirEntry | undefined {
  return flowRoots.find((r) => r.name === name);
}

/**
 * Resolve a relative flow filename inside a specific workspace root,
 * refusing path escapes via `..`. Returns `null` when the workspace
 * doesn't exist or the path is invalid.
 *
 * If `workspace` is empty (or "auto"), the relative path is allowed to
 * embed the workspace as its first segment, e.g. `samples/hello.json`.
 * That keeps the Studio Workbench's existing single-string `sidecarPath`
 * representation working in a multi-root world: the front-end stores
 * `"<ws>/<rel>"`, the sidecar splits it back here.
 */
function resolveFlowFile(workspace: string, relative: string): ResolvedFlowFile | null {
  let ws = workspace;
  let rel = relative.replace(/^[/\\]+/, "");
  if (!ws || ws === "auto") {
    const slash = rel.indexOf("/");
    if (slash > 0) {
      const head = rel.slice(0, slash);
      if (findFlowRoot(head)) {
        ws = head;
        rel = rel.slice(slash + 1);
      }
    }
  }
  const root = findFlowRoot(ws);
  if (!root) return null;
  if (!rel || rel.includes("\0")) return null;
  const abs = path.resolve(root.abs, rel);
  // Confine to the workspace root.
  const inside = path.relative(root.abs, abs);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  // Only `.json` files are addressable.
  if (!abs.toLowerCase().endsWith(".json")) return null;
  return { abs, rel, root };
}

function resolveFlowPath(workspace: string, relative: string): string | null {
  return resolveFlowFile(workspace, relative)?.abs ?? null;
}

function getFlowEnvPaths(flow: ResolvedFlowFile): {
  readPaths: string[];
  localPath: string;
  writePaths: string[];
} {
  const activePaths = resolveFlowEnvSidecarPaths(flow.abs);
  const activeLocal = activePaths[activePaths.length - 1]!;
  const mirrorPaths = flow.root.envSourceFlow
    ? resolveFlowEnvSidecarPaths(flow.root.envSourceFlow)
    : [];
  const mirrorLocal = mirrorPaths[mirrorPaths.length - 1];
  return {
    readPaths: uniquePaths([...activePaths, ...mirrorPaths]),
    localPath: mirrorLocal ?? activeLocal,
    writePaths: uniquePaths([activeLocal, ...(mirrorLocal ? [mirrorLocal] : [])]),
  };
}

async function readFlowEnv(flow: ResolvedFlowFile): Promise<{
  variables: Record<string, VariableValue>;
  path: string;
  paths: string[];
}> {
  const paths = getFlowEnvPaths(flow);
  const sidecar = loadFlowEnvSidecars(paths.readPaths);
  return {
    variables: {
      ...(sidecar.variables ?? {}),
      ...(sidecar.secrets ?? {}),
    },
    path: paths.localPath,
    paths: paths.readPaths,
  };
}

async function writeFlowEnv(
  flow: ResolvedFlowFile,
  variablesInput: Record<string, VariableValue>,
): Promise<string[]> {
  const paths = getFlowEnvPaths(flow);
  const variables = sortRecord(variablesInput);
  for (const target of paths.writePaths) {
    await writeFlowEnvSidecar(target, variables);
  }
  return paths.writePaths;
}

async function writeFlowEnvSidecar(
  target: string,
  variables: Record<string, VariableValue>,
): Promise<void> {
  const existing = await readJsonObject(target);
  const next: Record<string, unknown> = existing ? { ...existing } : {};
  next.variables = variables;
  delete next.secrets;
  delete next.secretNames;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const body = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, target);
}

async function readJsonObject(target: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = stripJsonBom(await fs.readFile(target, "utf8"));
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

function parseVariablesPayload(body: unknown): Record<string, VariableValue> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("body must be a JSON object");
  }
  const variables = (body as { variables?: unknown }).variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    throw new Error("body.variables must be a JSON object");
  }
  return assertVariableRecord(variables);
}

function assertVariableRecord(input: object): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isVariableValue(value)) {
      throw new Error(`body.variables.${key} must be JSON-compatible`);
    }
    out[key] = value;
  }
  return out;
}

function isVariableValue(value: unknown): value is VariableValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isVariableValue);
  if (typeof value !== "object") return false;
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (!isVariableValue(item)) return false;
  }
  return true;
}

function sortRecord<T>(input: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
    out[key] = input[key]!;
  }
  return out;
}

function uniquePaths(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function isNotFound(cause: unknown): boolean {
  return Boolean(cause) &&
    typeof cause === "object" &&
    (cause as { code?: unknown }).code === "ENOENT";
}

function stripJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function applyCors(request: Request, headers: Headers): void {
  const origin = request.headers.get("origin");
  if (cors === "*") {
    headers.set("access-control-allow-origin", "*");
  } else if (origin && cors.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-methods", "GET,PUT,OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type,accept,if-match,if-none-match",
  );
}

function jsonResponse(
  request: Request,
  status: number,
  body: unknown,
): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  applyCors(request, headers);
  return new Response(JSON.stringify(body), { status, headers });
}

async function walkFlows(
  workspace: string,
  rootAbs: string,
  out: FlowsListItem[],
): Promise<void> {
  // Walk depth-first so users can organise starters into nested folders
  // (e.g. flows/starters/basic/hello-agent.json) and have the explorer
  // tree mirror that exactly. Symlinks are followed but hidden /
  // dot-prefixed dirs are skipped to dodge `.git` style accidents if
  // someone drops the repo into a flow root.
  let entries;
  try {
    entries = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch {
    return;
  }
  // Stable order so the explorer tree is deterministic.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(rootAbs, entry.name);
    if (entry.isDirectory()) {
      // `walkFlows` is given a workspace-rooted abs already; recurse with
      // an inner helper that keeps the workspace constant.
      await walkFlowsInner(workspace, rootAbs, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isFlowGraphJson(entry.name)) continue;
    const rel = path
      .relative(rootAbs, abs)
      .split(path.sep)
      .join("/");
    try {
      const raw = await fs.readFile(abs, "utf8");
      out.push({
        workspace,
        root: rootAbs,
        file: rel,
        graph: JSON.parse(raw),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      // eslint-disable-next-line no-console
      console.warn(`[studio-sidecar] skipping ${workspace}/${rel}: ${msg}`);
    }
  }
}

async function walkFlowsInner(
  workspace: string,
  rootAbs: string,
  dirAbs: string,
  out: FlowsListItem[],
): Promise<void> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await walkFlowsInner(workspace, rootAbs, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isFlowGraphJson(entry.name)) continue;
    const rel = path
      .relative(rootAbs, abs)
      .split(path.sep)
      .join("/");
    try {
      const raw = await fs.readFile(abs, "utf8");
      out.push({
        workspace,
        root: rootAbs,
        file: rel,
        graph: JSON.parse(raw),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      // eslint-disable-next-line no-console
      console.warn(`[studio-sidecar] skipping ${workspace}/${rel}: ${msg}`);
    }
  }
}

async function handleStudioRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/studio/")) return null;
  const method = request.method.toUpperCase();

  // Always answer CORS preflight under /studio/ ourselves.
  if (method === "OPTIONS") {
    const headers = new Headers();
    applyCors(request, headers);
    return new Response(null, { status: 204, headers });
  }

  // GET /studio/workspace -> manifest + node pack summary
  if (url.pathname === "/studio/workspace" && method === "GET") {
    return jsonResponse(request, 200, {
      source: manifest.source,
      rootDir: manifest.rootDir,
      flowDirs: flowRoots.map((r) => ({ name: r.name, abs: r.abs })),
      nodePacks: packs.map((p) => ({
        name: p.entry.name,
        entry: p.entry.entry,
        nodeCount: p.nodes.length,
      })),
    });
  }

  // GET /studio/nodes/list -> every NodeTypeDefinition the runtime knows
  if (url.pathname === "/studio/nodes/list" && method === "GET") {
    // The browser already imports `getBuiltinNodeDefinitions()` from
    // `@ai-native-flow/runtime/builtin-definitions`. We only need to
    // surface the *custom* defs loaded from `nodePacks[]` here, but to
    // keep the front-end simple we return both halves and let it dedupe
    // on `(type, typeVersion)`.
    const customDefs: NodeTypeDefinition[] = allCustomNodes.map(
      (n) => n.definition,
    );
    return jsonResponse(request, 200, {
      definitions: customDefs,
      packs: packs.map((p) => ({
        name: p.entry.name,
        nodeTypes: p.nodes.map((n) => n.definition.type),
      })),
    });
  }

  // GET /studio/flows/list -> enumerate every flow root (recursively)
  if (url.pathname === "/studio/flows/list" && method === "GET") {
    try {
      const items: FlowsListItem[] = [];
      for (const root of flowRoots) {
        await fs.mkdir(root.abs, { recursive: true });
        await walkFlows(root.name, root.abs, items);
      }
      return jsonResponse(request, 200, {
        // Keep `dir` in the response for backwards compatibility with
        // older Studio builds that key off it. New clients should use
        // the per-item `root` instead.
        dir: flowRoots[0]?.abs ?? null,
        roots: flowRoots.map((r) => ({ name: r.name, abs: r.abs })),
        items,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 500, {
        error: { code: "studio.flows.list_failed", message: msg },
      });
    }
  }

  // GET /studio/flows/file?ws=samples&path=hello.json -> read one file
  // Backwards-compat: if `ws` is omitted, treat path as "<ws>/<rest>" or
  // fall back to the first root.
  if (url.pathname === "/studio/flows/file" && method === "GET") {
    const rel = url.searchParams.get("path") ?? "";
    const ws = url.searchParams.get("ws") ?? "auto";
    const abs = resolveFlowPath(ws, rel);
    if (!abs) {
      return jsonResponse(request, 400, {
        error: {
          code: "studio.flows.invalid_path",
          message: `Invalid path: ws=${ws} path=${rel}`,
        },
      });
    }
    try {
      const raw = await fs.readFile(abs, "utf8");
      const headers = new Headers({
        "content-type": "application/json; charset=utf-8",
      });
      applyCors(request, headers);
      return new Response(raw, { status: 200, headers });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 404, {
        error: { code: "studio.flows.read_failed", message: msg },
      });
    }
  }

  // GET /studio/flows/env?path=<ws>/<flow>.json  -> read merged sidecar vars.
  if (url.pathname === "/studio/flows/env" && method === "GET") {
    const rel = url.searchParams.get("path") ?? "";
    const ws = url.searchParams.get("ws") ?? "auto";
    const flow = resolveFlowFile(ws, rel);
    if (!flow) {
      return jsonResponse(request, 400, {
        error: {
          code: "studio.flows.invalid_path",
          message: `Invalid path: ws=${ws} path=${rel}`,
        },
      });
    }
    try {
      const env = await readFlowEnv(flow);
      return jsonResponse(request, 200, {
        variables: env.variables,
        path: env.path,
        paths: env.paths,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 500, {
        error: { code: "studio.flows.env_read_failed", message: msg },
      });
    }
  }

  // PUT /studio/flows/env?path=<ws>/<flow>.json  -> write .local.env.json.
  if (url.pathname === "/studio/flows/env" && method === "PUT") {
    const rel = url.searchParams.get("path") ?? "";
    const ws = url.searchParams.get("ws") ?? "auto";
    const flow = resolveFlowFile(ws, rel);
    if (!flow) {
      return jsonResponse(request, 400, {
        error: {
          code: "studio.flows.invalid_path",
          message: `Invalid path: ws=${ws} path=${rel}`,
        },
      });
    }
    let variablesInput: Record<string, VariableValue>;
    try {
      variablesInput = parseVariablesPayload(await request.json());
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 400, {
        error: { code: "studio.flows.invalid_env_json", message: msg },
      });
    }
    try {
      const paths = await writeFlowEnv(flow, variablesInput);
      return jsonResponse(request, 200, { ok: true, paths });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 500, {
        error: { code: "studio.flows.env_write_failed", message: msg },
      });
    }
  }

  // PUT /studio/flows/file?ws=samples&path=hello.json -> atomic-ish write-back
  if (url.pathname === "/studio/flows/file" && method === "PUT") {
    const rel = url.searchParams.get("path") ?? "";
    const ws = url.searchParams.get("ws") ?? "auto";
    const abs = resolveFlowPath(ws, rel);
    if (!abs) {
      return jsonResponse(request, 400, {
        error: {
          code: "studio.flows.invalid_path",
          message: `Invalid path: ws=${ws} path=${rel}`,
        },
      });
    }
    let body: string;
    try {
      body = await request.text();
      // Validate JSON shape so we never overwrite a file with garbage.
      JSON.parse(body);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 400, {
        error: { code: "studio.flows.invalid_json", message: msg },
      });
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // Write to a sibling tmp file then rename so a concurrent reader
      // never sees a half-written graph.
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, abs);
      return jsonResponse(request, 200, { ok: true, file: path.basename(abs) });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return jsonResponse(request, 500, {
        error: { code: "studio.flows.write_failed", message: msg },
      });
    }
  }

  return jsonResponse(request, 404, {
    error: { code: "studio.not_found", message: `No route for ${method} ${url.pathname}` },
  });
}

const server = createServer(async (req, res) => {
  try {
    const fetchRequest = toFetchRequest(req);
    const studioResponse = await handleStudioRequest(fetchRequest);
    const response = studioResponse ?? (await handleRequest(fetchRequest));
    await writeFetchResponse(response, res);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "sidecar.internal", message } }));
  }
});

server.listen(port, hostname, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  // eslint-disable-next-line no-console
  console.log(`[studio-sidecar] listening on http://${hostname}:${actualPort}`);
  // eslint-disable-next-line no-console
  console.log(`[studio-sidecar] CORS: ${corsRaw}`);
  // eslint-disable-next-line no-console
  console.log(
    `[studio-sidecar] workspace: ${manifest.source ?? `(apps discovery at ${manifest.rootDir})`}`,
  );
  for (const root of flowRoots) {
    // eslint-disable-next-line no-console
    console.log(`[studio-sidecar] flow root: ${root.name} -> ${root.abs}`);
  }
  for (const pack of packs) {
    // eslint-disable-next-line no-console
    console.log(
      `[studio-sidecar] node pack: ${pack.entry.name} (${pack.nodes.length} nodes) <- ${pack.entry.entry}`,
    );
  }
  for (const env of flowEnv.sidecars) {
    // eslint-disable-next-line no-console
    console.log(
      `[studio-sidecar] flow env: ${env.entries} variable(s) <- ${env.paths.join(", ")}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    "[studio-sidecar] llmProvider: AiSdkOpenAICompatibleLlmProvider (config-only; baseUrl/apiKey/model must come from the node)",
  );
});

function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `${hostname}:${port}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function writeFetchResponse(response: Response, res: ServerResponse) {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (!response.body) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
}

function shutdown() {
  // eslint-disable-next-line no-console
  console.log("[studio-sidecar] shutting down");
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
