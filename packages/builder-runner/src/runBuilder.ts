/**
 * Builder Runner.
 *
 * Phase 0 responsibility:
 *   1. Import a Builder module by URL or path.
 *   2. Resolve a `FlowBuilder` instance from the module (default export, or
 *      an exported `flow` symbol).
 *   3. Validate and dump the flow.
 *   4. Write the canonical JSON to a versioned artifact path under an
 *      artifact root directory.
 *
 * The runner is intentionally Node-compatible (uses `node:fs`, `node:path`,
 * `node:url`, `node:crypto`) so the same implementation works under both
 * Node. It does not call into any Sandbox; that is Phase 3.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  RuntimeErrorException,
  createRuntimeError,
  type FlowGraph,
} from "@ai-native-flow/flow-ir";
import { validateFlow } from "@ai-native-flow/flow-validator";
import type { FlowBuilder } from "@ai-native-flow/flow-builder";
import { stringifyFlow } from "@ai-native-flow/flow-builder";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface RunBuilderOptions {
  /**
   * Root directory where flow artifacts are written. Layout:
   *   <root>/<flowId>/<flowVersion>.flow.json
   * Defaults to "<cwd>/artifacts/flows".
   */
  artifactRoot?: string;
  /**
   * Optional override of the file name part. Useful in tests.
   */
  artifactFileName?: string;
  /** When true, do not write to disk; only return the artifact in memory. */
  dryRun?: boolean;
  /**
   * When true, read the existing artifact at the target path before writing
   * and carry over user-edited node config values where the node identity and
   * config keys still exist in the regenerated flow.
   */
  preserveExistingConfig?: boolean;
  /**
   * Additional Flow JSON files to consult after the target artifact path when
   * preserving config. The first valid matching flow contributes values.
   */
  existingFlowPaths?: string[];
}

export interface FlowArtifact {
  flow: FlowGraph;
  /** Canonical JSON string (the bytes that were written). */
  json: string;
  /** Hex-encoded SHA-256 hash of the JSON bytes. */
  contentHash: string;
  /** Number of config field values copied from the previous artifact. */
  preservedConfigValueCount: number;
  /**
   * Path the artifact was written to. `undefined` in `dryRun` mode.
   */
  path: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a Flow Builder module from a file path or URL and write the artifact.
 *
 * The module is expected to either:
 *   - have a default export that is a `FlowBuilder`, or
 *   - have a named export `flow` of type `FlowBuilder`.
 *
 * Both shapes are accepted because early app builders use the named export
 * style and AI-generated modules tend to use `export default`.
 */
export async function runBuilderModule(
  modulePath: string,
  options: RunBuilderOptions = {},
): Promise<FlowArtifact> {
  const absolute = resolve(modulePath);
  const url = pathToFileURL(absolute).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (cause) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "builder.module_load_failed",
        kind: "internal",
        category: "author",
        message: `failed to load builder module ${modulePath}`,
        source: { module: "builder" },
        context: { modulePath },
        cause,
      }),
    );
  }

  const builder = resolveBuilder(mod, modulePath);
  return runBuilder(builder, options);
}

/**
 * Run an already-instantiated builder. Useful for in-process tests and for
 * app builder scripts under `apps/`.
 */
export async function runBuilder(
  builder: FlowBuilder,
  options: RunBuilderOptions = {},
): Promise<FlowArtifact> {
  const root = options.artifactRoot ?? join(process.cwd(), "artifacts", "flows");
  const fileName = options.artifactFileName ?? `${builder.version}.flow.json`;
  const artifactPath = join(root, builder.id, fileName);

  const flow = builder.toFlowGraph();
  let preservedConfigValueCount = 0;
  if (options.preserveExistingConfig) {
    const existingCandidates = [
      artifactPath,
      ...(options.existingFlowPaths ?? []),
    ];
    for (const existingPath of uniquePaths(existingCandidates)) {
      const existing = await readExistingFlow(existingPath);
      if (!existing || !isSameFlowIdentity(flow, existing)) continue;
      preservedConfigValueCount = preserveNodeConfigValues(flow, existing);
      break;
    }
  }

  const json = stringifyFlow(flow);

  // Defence-in-depth: validate the dumped artifact even though Builder
  // already validated. This catches bugs in `dump()` that round-trip into
  // an invalid shape.
  const recheck = validateFlow(JSON.parse(json));
  if (!recheck.flow) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "builder.dump_invalid",
        kind: "internal",
        category: "system",
        message: `dump() produced an invalid Flow JSON for ${flow.id}@${flow.version}`,
        source: { module: "builder", flowId: flow.id, flowVersion: flow.version },
        context: { errors: recheck.result.errors },
      }),
    );
  }

  const contentHash = sha256Hex(json);

  let path: string | undefined;
  if (!options.dryRun) {
    path = artifactPath;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, "utf8");
  }

  return { flow, json, contentHash, path, preservedConfigValueCount };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function resolveBuilder(
  mod: Record<string, unknown>,
  modulePath: string,
): FlowBuilder {
  const candidate =
    isBuilder(mod.default) ? (mod.default as FlowBuilder)
    : isBuilder(mod.flow) ? (mod.flow as FlowBuilder)
    : undefined;
  if (!candidate) {
    throw new RuntimeErrorException(
      createRuntimeError({
        code: "builder.module_no_export",
        kind: "validation",
        category: "author",
        message: `builder module ${modulePath} must export a FlowBuilder as default or named "flow"`,
        source: { module: "builder" },
        context: { modulePath },
      }),
    );
  }
  return candidate;
}

function isBuilder(value: unknown): value is FlowBuilder {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<FlowBuilder>;
  return (
    typeof v.id === "string" &&
    typeof v.version === "string" &&
    typeof v.dump === "function" &&
    typeof v.toFlowGraph === "function"
  );
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function readExistingFlow(path: string): Promise<FlowGraph | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (isFileNotFound(cause)) return undefined;
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const checked = validateFlow(parsed);
  return checked.flow;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function preserveNodeConfigValues(next: FlowGraph, existing: FlowGraph): number {
  if (!isSameFlowIdentity(next, existing)) {
    return 0;
  }

  const existingById = new Map(existing.nodes.map((node) => [node.id, node]));
  let preserved = 0;
  for (const nextNode of next.nodes) {
    const existingNode = existingById.get(nextNode.id);
    if (
      !existingNode ||
      existingNode.type !== nextNode.type ||
      existingNode.typeVersion !== nextNode.typeVersion
    ) {
      continue;
    }

    const nextConfig = nextNode.config ?? {};
    const existingConfig = existingNode.config ?? {};
    for (const key of Object.keys(nextConfig)) {
      if (Object.prototype.hasOwnProperty.call(existingConfig, key)) {
        if (!canPreserveConfigValue(nextConfig[key], existingConfig[key])) {
          continue;
        }
        nextConfig[key] = existingConfig[key];
        preserved += 1;
      }
    }
  }

  return preserved;
}

function canPreserveConfigValue(nextValue: unknown, existingValue: unknown): boolean {
  const nextRefKind = refKind(nextValue);
  const existingRefKind = refKind(existingValue);
  if (nextRefKind || existingRefKind) {
    return nextRefKind === existingRefKind;
  }
  return true;
}

function refKind(value: unknown): "$var" | "$secret" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "$var") return "$var";
  if (keys[0] === "$secret") return "$secret";
  return undefined;
}

function isSameFlowIdentity(next: FlowGraph, existing: FlowGraph): boolean {
  return (
    next.id === existing.id &&
    next.version === existing.version &&
    next.schemaVersion === existing.schemaVersion
  );
}

function isFileNotFound(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT",
  );
}
