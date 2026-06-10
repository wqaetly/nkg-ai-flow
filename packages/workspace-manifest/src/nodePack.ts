/**
 * Node-pack loader.
 *
 * A "node pack" is a TS/JS module that exports either:
 *
 *     export default (ctx) => DefinedNode[]    // factory
 *     export default DefinedNode[]             // already-built array
 *     export const nodes = DefinedNode[] | ((ctx) => DefinedNode[])
 *
 * The pack receives a caller-supplied `ctx` object so each integration
 * (Studio sidecar / HTTP runner / tests) can hand the pack the deps it
 * needs (e.g. an `LlmProvider`) without coupling this loader to any
 * specific runtime feature.
 */

import { pathToFileURL } from "node:url";
import type { DefinedNode } from "@ai-native-flow/node-sdk";

import type { NodePackEntry } from "./manifest.js";

interface NodePackModule {
  default?: unknown;
  nodes?: unknown;
}

export interface LoadedNodePack {
  readonly entry: NodePackEntry;
  readonly nodes: DefinedNode[];
}

/**
 * Load a single node pack and resolve it to a flat `DefinedNode[]`.
 *
 * Throws with a clear, actionable message on every failure mode so
 * misconfigured workspaces fail fast at boot instead of producing
 * mysterious runtime errors when a flow tries to use an unregistered
 * node type.
 */
export async function loadNodePack<TCtx>(
  entry: NodePackEntry,
  ctx: TCtx,
): Promise<LoadedNodePack> {
  let mod: NodePackModule;
  try {
    // `import()` follows whatever loader hooks the host installed
    // (e.g. `tsx watch`), so the entry can be a `.ts` file directly.
    mod = (await import(pathToFileURL(entry.entry).href)) as NodePackModule;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Failed to load node pack '${entry.name}' from ${entry.entry}: ${msg}`,
    );
  }

  // Accept either:
  //   export default (ctx) => DefinedNode[]
  //   export default DefinedNode[]
  //   export const nodes = DefinedNode[]
  //   export const nodes = (ctx) => DefinedNode[]
  const candidate: unknown = mod.default ?? mod.nodes;
  let resolved: unknown;
  if (typeof candidate === "function") {
    try {
      resolved = await (candidate as (ctx: TCtx) => unknown)(ctx);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Node pack '${entry.name}' factory threw: ${msg}`);
    }
  } else {
    resolved = candidate;
  }

  if (!Array.isArray(resolved)) {
    throw new Error(
      `Node pack '${entry.name}' must export a 'default' or 'nodes' value ` +
        `that is (or returns) a DefinedNode[] array (got ${typeof resolved})`,
    );
  }
  const nodes: DefinedNode[] = [];
  for (const item of resolved) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { runner?: unknown }).runner !== "function" ||
      typeof (item as { definition?: unknown }).definition !== "object"
    ) {
      throw new Error(
        `Node pack '${entry.name}' returned a non-DefinedNode entry`,
      );
    }
    nodes.push(item as DefinedNode);
  }
  return { entry, nodes };
}

/**
 * Convenience over `loadNodePack`: load every entry in `entries` in
 * declaration order, propagating the same `ctx` to each.
 */
export async function loadNodePacks<TCtx>(
  entries: readonly NodePackEntry[],
  ctx: TCtx,
): Promise<LoadedNodePack[]> {
  const out: LoadedNodePack[] = [];
  for (const entry of entries) {
    out.push(await loadNodePack(entry, ctx));
  }
  return out;
}
