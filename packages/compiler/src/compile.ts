/**
 * `compileDefinedNode` — turn a `DefinedNode` (the runtime bundle
 * returned by `defineNode`) into a content-addressed
 * `NodeLogicArtifact` ready to be persisted, diffed by Studio, and
 * loaded back by the in-process sandbox adapter.
 *
 * The pipeline is deliberately minimal:
 *
 *   1. Stringify the runner via `Function.prototype.toString()`. This
 *      establishes a single "self-contained source" contract: runners
 *      must not capture closure variables.
 *   2. Snapshot the definition (data track) into a plain JSON object so
 *      Studio / Validator can read the artifact without instantiating
 *      Zod schemas.
 *   3. Compute `hash = sha256Hex(canonicalJSON({ type, typeVersion,
 *      runnerSrc, definition }))`. Same input → same hash, byte-for-byte.
 *
 * The output is JSON-serialisable end-to-end, so writing one to disk is
 * just `JSON.stringify(artifact)`.
 */

import type { DefinedNode } from "@ai-native-flow/node-sdk";
import { canonicalJSON, sha256Hex } from "./hash.js";

/**
 * The on-disk / in-memory shape of a compiled node logic artifact.
 *
 * The in-process sandbox loader rehydrates the runner by evaluating
 * `runnerSrc` directly; future loaders may instead resolve a separate
 * compiled bundle by `hash`. Either way, the `definition` half is the
 * runtime-stable Studio / Validator view.
 */
export interface NodeLogicArtifact {
  /** Stable schema version of the artifact format itself. */
  readonly schemaVersion: 1;
  readonly type: string;
  readonly typeVersion: string;
  /** Runtime data-track definition (ports, config schema, etc.). */
  readonly definition: Record<string, unknown>;
  /** The runner stringified via `Function.prototype.toString()`. */
  readonly runnerSrc: string;
  /**
   * Hex-encoded SHA-256 of `canonicalJSON({type, typeVersion, definition,
   * runnerSrc})`. The artifact's identity field — callers can use it to
   * verify integrity before evaluating the source.
   */
  readonly hash: string;
}

export interface CompileOptions {
  /**
   * Optional hook to scrub or transform the `definition` snapshot
   * before hashing. Default: drop entries whose values aren't JSON
   * (functions, undefined) so the canonicaliser doesn't throw.
   */
  readonly sanitiseDefinition?: (
    raw: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * Stringify a runner. Exported so callers (loader, tests, Studio diff
 * tools) share the exact same "self-contained, closure-free function
 * source" contract.
 */
export function serialiseRunner(runner: unknown): string {
  if (typeof runner !== "function") {
    throw new TypeError(
      `serialiseRunner: expected a function, got ${typeof runner}`,
    );
  }
  return runner.toString();
}

/** Compile a `DefinedNode` into a `NodeLogicArtifact`. */
export async function compileDefinedNode(
  node: DefinedNode,
  options: CompileOptions = {},
): Promise<NodeLogicArtifact> {
  const definitionRaw = node.definition as unknown as Record<string, unknown>;
  const sanitiser = options.sanitiseDefinition ?? defaultSanitiseDefinition;
  const definition = sanitiser({ ...definitionRaw });
  const runnerSrc = serialiseRunner(node.runner);

  const type = String(definitionRaw.type ?? "");
  const typeVersion = String(definitionRaw.typeVersion ?? "");
  if (!type || !typeVersion) {
    throw new Error(
      "compileDefinedNode: DefinedNode.definition must carry both `type` and `typeVersion`",
    );
  }

  const hashable = { type, typeVersion, definition, runnerSrc };
  const hash = await sha256Hex(canonicalJSON(hashable));

  return {
    schemaVersion: 1,
    type,
    typeVersion,
    definition,
    runnerSrc,
    hash,
  };
}

/**
 * Drops keys whose values JSON cannot represent. We don't recurse into
 * arrays / nested objects — the SDK already produces JSON-safe shapes
 * for ports / configSchema / metadata, and a deep walk would risk
 * stripping fields the author intentionally put there.
 */
function defaultSanitiseDefinition(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
