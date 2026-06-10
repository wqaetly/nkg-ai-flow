/**
 * Walk every discovered `flowDirs[]` root, parse each
 * `*.json` graph and register it with the runtime's registry so the
 * fetch handler returned by `@ai-native-flow/transport-http` can route
 * `/flows/:flowId/...` to it without any further setup.
 *
 * Flow identity rule (per project decision):
 *
 *   - `flowId` always comes from the graph's own `flow.id` field.
 *   - The on-disk path (`<workspace>/<file>`) is *only* used to disambig-
 *     uate filenames inside an editor; two graphs that resolve to the
 *     same `flow.id` are treated as a workspace error and rejected at
 *     boot, so flowId collisions can never happen at runtime.
 *
 * The function never auto-creates flow directories. A missing directory
 * is treated as "no flows here" rather than an error so partially-
 * provisioned workspaces still come up.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { FlowGraph } from "@ai-native-flow/flow-ir";
import type { Runtime } from "@ai-native-flow/runtime";
import type { FlowDirEntry } from "@ai-native-flow/workspace-manifest";

/** A single registered flow, bookkeeping for the `/` listing route. */
export interface RegisteredFlow {
  /** Graph id (== `flow.id`). */
  flowId: string;
  /** Graph version that was promoted to `active`. */
  flowVersion: string;
  /** Workspace name from the manifest (e.g. `code-review-iwiki`). */
  workspace: string;
  /** Path relative to the workspace root, POSIX separators. */
  file: string;
  /** Absolute path on disk (handy for diagnostics). */
  abs: string;
}

/**
 * Recursively enumerate every `*.json` file under `rootAbs`. Returns
 * an empty array when the root simply doesn't exist; only re-throws on
 * unexpected IO errors. Stable ordering keeps boot logs deterministic.
 */
async function listGraphFiles(rootAbs: string): Promise<string[]> {
  let stat;
  try {
    stat = await fs.stat(rootAbs);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const out: string[] = [];
  await walk(rootAbs, out);
  out.sort();
  return out;

  async function walk(dir: string, acc: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Skip dot-prefixed dirs/files (e.g. `.git`) which can sneak in
      // when a workspace happens to live alongside a repo checkout.
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, acc);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isFlowGraphJson(entry.name)) continue;
      acc.push(abs);
    }
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

/**
 * Treat a workspace-relative POSIX path as the human-facing "file"
 * field on the wire. We always normalise to forward slashes so the
 * value is stable across Windows / *nix.
 */
function toPosixRel(rootAbs: string, abs: string): string {
  return path
    .relative(rootAbs, abs)
    .split(path.sep)
    .join("/");
}

interface RawGraphLike {
  id?: unknown;
  version?: unknown;
}

/**
 * Read + JSON-parse one graph file. Returns a tagged failure object
 * (rather than throwing) so the caller can aggregate every problem in
 * the workspace into a single error report. Failing fast on the first
 * bad file would punish authors who have a typo in one pack but want
 * to see *everything* that's wrong.
 */
async function readGraph(absPath: string): Promise<
  | { ok: true; raw: string; graph: FlowGraph }
  | { ok: false; reason: string }
> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (cause) {
    return {
      ok: false,
      reason: `cannot read file: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      reason: `invalid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as RawGraphLike).id !== "string" ||
    typeof (parsed as RawGraphLike).version !== "string"
  ) {
    return {
      ok: false,
      reason: "graph is missing required string fields 'id' / 'version'",
    };
  }
  return { ok: true, raw, graph: parsed as FlowGraph };
}

export interface RegisterFlowsFromManifestOptions {
  runtime: Runtime;
  flowDirs: readonly FlowDirEntry[];
  /**
   * Optional logger hook. Called once per successful registration so
   * embedders (e.g. the CLI bin) can mirror progress to stdout. The
   * default is a no-op so library callers stay quiet.
   */
  onRegister?: (flow: RegisteredFlow) => void;
}

/**
 * Walk every flow root in the manifest, register each graph with
 * `runtime.registry` and promote it to active.
 *
 * Throws an aggregated `Error` if any of:
 *   - a `*.json` file fails to read / parse / validate;
 *   - two graphs resolve to the same `flow.id` (collision);
 *   - the runtime's registry rejects a registration / promotion.
 *
 * On success returns the full list in the order they were registered.
 */
export async function registerFlowsFromManifest(
  options: RegisterFlowsFromManifestOptions,
): Promise<RegisteredFlow[]> {
  const { runtime, flowDirs, onRegister } = options;

  const registered: RegisteredFlow[] = [];
  const errors: string[] = [];
  // Map flowId -> first source that registered it, so the duplicate
  // error message can point both files out.
  const seen = new Map<string, RegisteredFlow>();

  for (const root of flowDirs) {
    const files = await listGraphFiles(root.abs);
    for (const abs of files) {
      const rel = toPosixRel(root.abs, abs);
      const display = `${root.name}/${rel}`;
      const result = await readGraph(abs);
      if (!result.ok) {
        errors.push(`[${display}] ${result.reason}`);
        continue;
      }
      const graph = result.graph;
      const previous = seen.get(graph.id);
      if (previous) {
        errors.push(
          `duplicate flow id '${graph.id}': '${previous.workspace}/${previous.file}' vs '${display}'`,
        );
        continue;
      }
      try {
        await runtime.registry.register({
          graph,
          json: result.raw,
          status: "staging",
        });
        await runtime.registry.promote(graph.id, graph.version);
      } catch (cause) {
        errors.push(
          `[${display}] registry refused graph: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        continue;
      }
      const entry: RegisteredFlow = {
        flowId: graph.id,
        flowVersion: graph.version,
        workspace: root.name,
        file: rel,
        abs,
      };
      seen.set(graph.id, entry);
      registered.push(entry);
      onRegister?.(entry);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to bootstrap workspace flows:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return registered;
}
