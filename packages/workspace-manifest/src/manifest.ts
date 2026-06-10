/**
 * Workspace app manifest loader for the AI Native Flow Runtime.
 *
 * The loader always discovers this repository's built-in
 * `apps/<app>/anf.app.json` manifests. When a host project provides a root
 * `anf.apps.json`, that file only registers host-owned apps; submodule
 * apps do not need to be listed by the host.
 *
 * Validation is structural and dependency-free so this module can be
 * pulled in early during process bootstrap before the runtime is wired
 * up.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** A flow root: a directory the runner will scan for `*.json` graphs. */
export interface FlowDirEntry {
  /** Logical name used as a workspace prefix on the wire and in logs. */
  name: string;
  /** Absolute path on disk. */
  abs: string;
  /**
   * Optional source flow JSON used as the canonical env sidecar mirror for
   * generated/artifact flow roots.
   */
  envSourceFlow?: string;
}

/** A node pack: a TS/JS module exporting `defineNode` definitions. */
export interface NodePackEntry {
  /** Logical name shown in the palette / logs. */
  name: string;
  /** Absolute path to the entry module (.ts / .js / .mjs). */
  entry: string;
}

export interface WorkspaceManifest {
  /** Absolute path of host `anf.apps.json`, or null when none was found. */
  source: string | null;
  /** Host registry directory when present; otherwise the built-in app root. */
  rootDir: string;
  flowDirs: FlowDirEntry[];
  nodePacks: NodePackEntry[];
}

interface RawAppRegistry {
  apps?: unknown;
}

interface RawFlowDir {
  name?: unknown;
  path?: unknown;
  envSourceFlow?: unknown;
}

interface RawNodePack {
  name?: unknown;
  entry?: unknown;
}

interface RawAppManifest {
  name?: unknown;
  flowDirs?: unknown;
  nodePacks?: unknown;
}

const APP_MANIFEST_FILENAME = "anf.app.json";
const APP_REGISTRY_FILENAME = "anf.apps.json";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function findAppRegistryUpwards(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  for (let i = 0; i < 32; i++) {
    const candidate = path.join(current, APP_REGISTRY_FILENAME);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // no registry at this level, keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFlowDirs(
  raw: unknown,
  manifestDir: string,
  options: { context?: string; defaultName?: string } = {},
): FlowDirEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${options.context ?? "'flowDirs'"} must be an array (got ${typeof raw})`);
  }
  const out: FlowDirEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const rawItem = raw[i];
    const item = typeof rawItem === "string"
      ? ({ path: rawItem } satisfies RawFlowDir)
      : rawItem as RawFlowDir | undefined;
    if (!isPlainObject(item)) {
      throw new Error(`${options.context ?? "flowDirs"}[${i}] must be an object or path string`);
    }
    const name = item.name ?? options.defaultName;
    const p = item.path;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`${options.context ?? "flowDirs"}[${i}].name must be a non-empty string`);
    }
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new Error(`${options.context ?? "flowDirs"}[${i}].path must be a non-empty string`);
    }
    if (seen.has(name)) {
      throw new Error(`${options.context ?? "flowDirs"}: duplicate name '${name}'`);
    }
    const envSourceFlow = item.envSourceFlow;
    if (envSourceFlow !== undefined && (
      typeof envSourceFlow !== "string" ||
      envSourceFlow.trim().length === 0
    )) {
      throw new Error(`${options.context ?? "flowDirs"}[${i}].envSourceFlow must be a non-empty string when present`);
    }
    seen.add(name);
    const entry: FlowDirEntry = {
      name,
      abs: path.resolve(manifestDir, p),
    };
    if (typeof envSourceFlow === "string") {
      entry.envSourceFlow = path.resolve(manifestDir, envSourceFlow);
    }
    out.push(entry);
  }
  return out;
}

function parseNodePacks(
  raw: unknown,
  manifestDir: string,
  options: { context?: string; defaultName?: string } = {},
): NodePackEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${options.context ?? "'nodePacks'"} must be an array (got ${typeof raw})`);
  }
  const out: NodePackEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const rawItem = raw[i];
    const item = typeof rawItem === "string"
      ? ({ entry: rawItem } satisfies RawNodePack)
      : rawItem as RawNodePack | undefined;
    if (!isPlainObject(item)) {
      throw new Error(`${options.context ?? "nodePacks"}[${i}] must be an object or entry string`);
    }
    const name = item.name ?? options.defaultName;
    const entry = item.entry;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`${options.context ?? "nodePacks"}[${i}].name must be a non-empty string`);
    }
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${options.context ?? "nodePacks"}[${i}].entry must be a non-empty string`);
    }
    if (seen.has(name)) {
      throw new Error(`${options.context ?? "nodePacks"}: duplicate name '${name}'`);
    }
    seen.add(name);
    out.push({
      name,
      entry: path.resolve(manifestDir, entry),
    });
  }
  return out;
}

async function loadHostRegisteredApps(
  registryPath: string,
): Promise<{ rootDir: string; flowDirs: FlowDirEntry[]; nodePacks: NodePackEntry[] }> {
  const rootDir = path.dirname(registryPath);
  const registry = await readAppRegistry(registryPath);
  const flowDirs: FlowDirEntry[] = [];
  const nodePacks: NodePackEntry[] = [];
  for (const rel of registry.apps) {
    const appDir = path.resolve(rootDir, rel);
    const app = await loadRegisteredApp(appDir, path.basename(appDir));
    flowDirs.push(...app.flowDirs);
    nodePacks.push(...app.nodePacks);
  }
  return { rootDir, flowDirs, nodePacks };
}

async function loadRegisteredApp(
  appDir: string,
  fallbackName: string,
): Promise<{ flowDirs: FlowDirEntry[]; nodePacks: NodePackEntry[] }> {
  const appManifestPath = path.join(appDir, APP_MANIFEST_FILENAME);
  const raw = await readOptionalJsonObject(appManifestPath);
  if (!raw) {
    throw new Error(`Registered app is missing ${APP_MANIFEST_FILENAME}: ${appDir}`);
  }
  const appName = readAppName(raw?.name, fallbackName, appManifestPath);

  const flowDirs = raw?.flowDirs !== undefined
    ? parseFlowDirs(raw.flowDirs, appDir, {
      context: `${APP_MANIFEST_FILENAME}:${appName}.flowDirs`,
      defaultName: appName,
    })
    : [];

  const nodePacks = raw?.nodePacks !== undefined
    ? parseNodePacks(raw.nodePacks, appDir, {
      context: `${APP_MANIFEST_FILENAME}:${appName}.nodePacks`,
      defaultName: appName,
    })
    : [];

  return { flowDirs, nodePacks };
}

async function discoverApps(
  rootDir: string,
): Promise<{ flowDirs: FlowDirEntry[]; nodePacks: NodePackEntry[] }> {
  const appsDir = path.resolve(rootDir, "apps");
  let entries;
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch {
    return { flowDirs: [], nodePacks: [] };
  }

  const flowDirs: FlowDirEntry[] = [];
  const nodePacks: NodePackEntry[] = [];
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const appDir = path.join(appsDir, entry.name);
    const app = await discoverOneApp(appDir, entry.name);
    flowDirs.push(...app.flowDirs);
    nodePacks.push(...app.nodePacks);
  }
  return { flowDirs, nodePacks };
}

async function discoverOneApp(
  appDir: string,
  fallbackName: string,
): Promise<{ flowDirs: FlowDirEntry[]; nodePacks: NodePackEntry[] }> {
  const appManifestPath = path.join(appDir, APP_MANIFEST_FILENAME);
  const raw = await readOptionalJsonObject(appManifestPath);
  if (!raw) return { flowDirs: [], nodePacks: [] };
  const appName = readAppName(raw?.name, fallbackName, appManifestPath);

  const flowDirs = raw?.flowDirs !== undefined
    ? parseFlowDirs(raw.flowDirs, appDir, {
      context: `${APP_MANIFEST_FILENAME}:${appName}.flowDirs`,
      defaultName: appName,
    })
    : [];

  const nodePacks = raw?.nodePacks !== undefined
    ? parseNodePacks(raw.nodePacks, appDir, {
      context: `${APP_MANIFEST_FILENAME}:${appName}.nodePacks`,
      defaultName: appName,
    })
    : [];

  return { flowDirs, nodePacks };
}

async function readAppRegistry(file: string): Promise<{ apps: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Cannot read ${file}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid JSON in ${file}: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${file} must contain a JSON object at the root`);
  }
  const registry = parsed as RawAppRegistry;
  if ("imports" in registry) {
    throw new Error(`${file}: 'imports' is not supported; host registries should only list host apps[]`);
  }
  return {
    apps: parseStringList(registry.apps, file, "apps", "app directory paths"),
  };
}

function parseStringList(
  raw: unknown,
  file: string,
  field: "apps",
  description: string,
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${file}: '${field}' must be an array of ${description}`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${file}: ${field}[${i}] must be a non-empty string`);
    }
    const normalized = item.trim();
    if (seen.has(normalized)) {
      throw new Error(`${file}: duplicate ${field.slice(0, -1)} path '${normalized}'`);
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function readOptionalJsonObject(file: string): Promise<RawAppManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return null;
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Cannot read ${file}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid JSON in ${file}: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${file} must contain a JSON object at the root`);
  }
  return parsed as RawAppManifest;
}

function readAppName(raw: unknown, fallback: string, source: string): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${source}: 'name' must be a non-empty string when present`);
  }
  return raw;
}

function dedupeFlowDirs(entries: FlowDirEntry[]): FlowDirEntry[] {
  const out: FlowDirEntry[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    const key = pathKey(entry.abs);
    if (seenPaths.has(key)) continue;
    if (seenNames.has(entry.name)) {
      throw new Error(`flowDirs: duplicate name '${entry.name}' from app discovery`);
    }
    seenNames.add(entry.name);
    seenPaths.add(key);
    out.push(entry);
  }
  return out;
}

function dedupeNodePacks(entries: NodePackEntry[]): NodePackEntry[] {
  const out: NodePackEntry[] = [];
  const seenNames = new Set<string>();
  const seenEntries = new Set<string>();
  for (const entry of entries) {
    const key = pathKey(entry.entry);
    if (seenEntries.has(key)) continue;
    if (seenNames.has(entry.name)) {
      throw new Error(`nodePacks: duplicate name '${entry.name}' from app discovery`);
    }
    seenNames.add(entry.name);
    seenEntries.add(key);
    out.push(entry);
  }
  return out;
}

function pathKey(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNotFound(cause: unknown): boolean {
  return Boolean(cause) &&
    typeof cause === "object" &&
    (cause as { code?: unknown }).code === "ENOENT";
}

async function findBuiltInAppsRoot(): Promise<string | null> {
  let current = MODULE_DIR;
  for (let i = 0; i < 32; i++) {
    const appsDir = path.join(current, "apps");
    const packageDir = path.join(current, "packages", "workspace-manifest");
    try {
      const [appsStat, packageStat] = await Promise.all([
        fs.stat(appsDir),
        fs.stat(packageDir),
      ]);
      if (appsStat.isDirectory() && packageStat.isDirectory()) return current;
    } catch {
      // keep walking; this package may be executed from source or a linked checkout
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export interface LoadWorkspaceOptions {
  /**
   * Directory to start the upward search from. Defaults to `process.cwd()`.
   */
  startDir?: string;
  /**
   * Built-in app root. Defaults to this repository root; pass null to
   * disable built-in discovery in tests.
   */
  builtinRootDir?: string | null;
  /** Default flow directory used when no app manifests provide flows. Absolute path. */
  defaultFlowDir?: { name: string; abs: string };
}

/**
 * Discover built-in app manifests and optionally merge host-registered apps.
 */
export async function loadWorkspaceManifest(
  opts: LoadWorkspaceOptions = {},
): Promise<WorkspaceManifest> {
  const startDir = opts.startDir ?? process.cwd();
  const builtinRootDir = opts.builtinRootDir === undefined
    ? await findBuiltInAppsRoot()
    : opts.builtinRootDir;
  const registryPath = await findAppRegistryUpwards(startDir);

  const builtIn = builtinRootDir
    ? await discoverApps(builtinRootDir)
    : { flowDirs: [], nodePacks: [] };
  const host = registryPath
    ? await loadHostRegisteredApps(registryPath)
    : { rootDir: builtinRootDir ?? startDir, flowDirs: [], nodePacks: [] };

  const flowDirs = dedupeFlowDirs([...builtIn.flowDirs, ...host.flowDirs]);
  const nodePacks = dedupeNodePacks([...builtIn.nodePacks, ...host.nodePacks]);

  if (flowDirs.length === 0 && opts.defaultFlowDir) {
    flowDirs.push({
      name: opts.defaultFlowDir.name,
      abs: opts.defaultFlowDir.abs,
    });
  }

  return {
    source: registryPath,
    rootDir: registryPath ? host.rootDir : builtinRootDir ?? startDir,
    flowDirs,
    nodePacks,
  };
}

