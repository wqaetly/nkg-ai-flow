import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { InMemoryVariableStore } from "./inMemoryVariableStore.js";
import type {
  DefaultsInput,
  LoadFromEnvOptions,
  LoadResult,
} from "./loaders.js";
import type { VariableValue } from "./types.js";

export interface FlowEnvSidecar {
  variables?: Record<string, VariableValue>;
  /** @deprecated Use `variables`; values are loaded into the same store. */
  secrets?: Record<string, string>;
  /** @deprecated Use `envAllow`; retained as an env allow-list alias. */
  secretNames?: string[];
  envAllow?: string[];
}

export interface ResolveFlowEnvSidecarPathOptions {
  includeLocal?: boolean;
  envSuffix?: string;
  localEnvSuffix?: string;
}

export interface LoadFlowEnvSidecarsOptions {
  optional?: boolean;
}

export interface CreateFlowScopedStoresOptions {
  flowPath?: string;
  paths?: ReadonlyArray<string>;
  defaults?: DefaultsInput;
  /** @deprecated Use `envAllow` or `env.allow`. */
  secretNames?: ReadonlyArray<string>;
  envAllow?: ReadonlyArray<string>;
  env?: LoadFromEnvOptions | null;
}

export interface FlowScopedStores extends LoadResult {
  env: LoadFromEnvOptions | null;
  sidecar: FlowEnvSidecar;
  paths: string[];
}

export function resolveFlowEnvSidecarPaths(
  flowPath: string,
  options: ResolveFlowEnvSidecarPathOptions = {},
): string[] {
  const ext = extname(flowPath);
  const stem = ext ? flowPath.slice(0, -ext.length) : flowPath;
  const envSuffix = options.envSuffix ?? ".env.json";
  const localEnvSuffix = options.localEnvSuffix ?? ".local.env.json";
  const paths = [`${stem}${envSuffix}`];
  if (options.includeLocal !== false) {
    paths.push(`${stem}${localEnvSuffix}`);
  }
  return paths;
}

export function loadFlowEnvSidecars(
  paths: ReadonlyArray<string>,
  options: LoadFlowEnvSidecarsOptions = {},
): FlowEnvSidecar {
  const optional = options.optional ?? true;
  const merged: FlowEnvSidecar = {
    variables: {},
    secrets: {},
    secretNames: [],
    envAllow: [],
  };

  for (const path of paths) {
    if (!existsSync(path)) {
      if (optional) continue;
      throw new Error(`flow env sidecar not found: ${path}`);
    }
    const parsed = parseFlowEnvSidecar(path);
    Object.assign(merged.variables!, parsed.variables ?? {});
    Object.assign(merged.secrets!, parsed.secrets ?? {});
    merged.secretNames!.push(...(parsed.secretNames ?? []));
    merged.envAllow!.push(...(parsed.envAllow ?? []));
  }

  merged.secretNames = unique(merged.secretNames ?? []);
  merged.envAllow = unique(merged.envAllow ?? []);
  return merged;
}

export function createFlowScopedStores(
  options: CreateFlowScopedStoresOptions = {},
): FlowScopedStores {
  const paths = [
    ...(options.paths ?? []),
    ...(options.paths ? [] : options.flowPath ? resolveFlowEnvSidecarPaths(options.flowPath) : []),
  ];
  const sidecar = loadFlowEnvSidecars(paths);
  const variables = new InMemoryVariableStore();

  for (const [name, value] of Object.entries(options.defaults?.variables ?? {})) {
    variables.set(name, value, { source: "default" });
  }
  for (const [name, value] of Object.entries(options.defaults?.secrets ?? {})) {
    variables.set(name, value, { source: "default" });
  }
  for (const [name, value] of Object.entries(sidecar.variables ?? {})) {
    variables.set(name, value, { source: "flow-sidecar" });
  }
  for (const [name, value] of Object.entries(sidecar.secrets ?? {})) {
    variables.set(name, value, { source: "flow-sidecar" });
  }

  const secretNames = unique([
    ...(options.secretNames ?? []),
    ...(sidecar.secretNames ?? []),
    ...(options.env?.secretNames ?? []),
  ]);
  const envAllow = unique([
    ...(options.envAllow ?? []),
    ...(sidecar.envAllow ?? []),
    ...(options.env?.allow ?? []),
    ...secretNames,
  ]);
  const env: LoadFromEnvOptions | null = options.env === null
    ? null
    : {
        ...(options.env ?? {}),
        allow: envAllow,
        secretNames,
      };

  return { variables, secrets: variables, env, sidecar, paths };
}

function parseFlowEnvSidecar(path: string): FlowEnvSidecar {
  const raw = JSON.parse(stripJsonBom(readFileSync(path, "utf8"))) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`flow env sidecar must be a JSON object: ${path}`);
  }
  const value = raw as FlowEnvSidecar;
  assertRecord(value.variables, "variables", path);
  assertStringRecord(value.secrets, "secrets", path);
  assertStringArray(value.secretNames, "secretNames", path);
  assertStringArray(value.envAllow, "envAllow", path);
  return value;
}

function stripJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function assertRecord(value: unknown, field: string, path: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`flow env sidecar field "${field}" must be an object: ${path}`);
  }
}

function assertStringRecord(value: unknown, field: string, path: string): void {
  assertRecord(value, field, path);
  if (value === undefined) return;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new Error(`flow env sidecar field "${field}.${key}" must be a string: ${path}`);
    }
  }
}

function assertStringArray(value: unknown, field: string, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`flow env sidecar field "${field}" must be a string array: ${path}`);
  }
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}
