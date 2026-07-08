/**
 * Node Type Registry MVP for Phase 0.
 *
 * Per `docs/specs/node-system.md`, Builder, Validator and Studio must read
 * node capabilities from a single source. The Phase 0 registry is in-memory
 * only; later phases promote it to an internal module of `runtime`.
 *
 * IR-level catalogue is intentionally minimal: only the pseudo-nodes
 * (`start` / `end`) live here because they don't have a `defineNode`
 * counterpart — they are flow-control markers the engine understands
 * directly, and have no `config`. Every *real* built-in (`text_input`,
 * `llm`, `http`, `tool`, `condition`, `transform`, …) is authored via
 * `defineNode` in the `runtime` package and reaches the
 * `NodeTypeRegistry` through `createRuntime()` / `installNode`. That
 * way author-supplied nodes and built-ins go through the exact same
 * pipeline (and therefore inherit the same Field Inspector reflection,
 * same validation, same versioning).
 */

import type {
  NodeCapabilities,
  NodeTypeDefinition,
  PortDefinition,
} from "./types.js";
import {
  createRuntimeError,
  RuntimeErrorException,
  type RuntimeError,
} from "./errors.js";

/** Read-only registry contract. */
export interface NodeTypeRegistry {
  has(type: string, version?: string): boolean;
  get(type: string, version?: string): NodeTypeDefinition;
  tryGet(type: string, version?: string): NodeTypeDefinition | undefined;
  list(): NodeTypeDefinition[];
  getCapabilities(type: string, version?: string): NodeCapabilities;
}

interface RegistryEntry {
  definition: NodeTypeDefinition;
  capabilities: NodeCapabilities;
}

/** In-memory implementation used by Builder / Validator / examples. */
export class InMemoryNodeTypeRegistry implements NodeTypeRegistry {
  /** Map<type, Map<version, entry>> */
  private readonly entries = new Map<string, Map<string, RegistryEntry>>();
  /** Latest version per type, in registration order. */
  private readonly latest = new Map<string, string>();

  register(definition: NodeTypeDefinition, capabilities?: NodeCapabilities): void {
    let perType = this.entries.get(definition.type);
    if (!perType) {
      perType = new Map();
      this.entries.set(definition.type, perType);
    }
    if (perType.has(definition.typeVersion)) {
      throw new RuntimeErrorException(
        createRuntimeError({
          code: "registry.version_conflict",
          kind: "conflict",
          category: "author",
          message: `node type ${definition.type}@${definition.typeVersion} already registered`,
          source: { module: "registry" },
          context: { type: definition.type, typeVersion: definition.typeVersion },
        }),
      );
    }
    perType.set(definition.typeVersion, {
      definition,
      capabilities: capabilities ?? defaultCapabilities(),
    });
    this.latest.set(definition.type, definition.typeVersion);
  }

  has(type: string, version?: string): boolean {
    return this.tryGet(type, version) !== undefined;
  }

  tryGet(type: string, version?: string): NodeTypeDefinition | undefined {
    const perType = this.entries.get(type);
    if (!perType) return undefined;
    const v = version ?? this.latest.get(type);
    if (!v) return undefined;
    return perType.get(v)?.definition;
  }

  get(type: string, version?: string): NodeTypeDefinition {
    const found = this.tryGet(type, version);
    if (!found) {
      throw new RuntimeErrorException(notFound(type, version));
    }
    return found;
  }

  list(): NodeTypeDefinition[] {
    const out: NodeTypeDefinition[] = [];
    for (const perType of this.entries.values()) {
      for (const entry of perType.values()) {
        out.push(entry.definition);
      }
    }
    return out;
  }

  getCapabilities(type: string, version?: string): NodeCapabilities {
    const perType = this.entries.get(type);
    const v = version ?? this.latest.get(type);
    const entry = perType && v ? perType.get(v) : undefined;
    if (!entry) {
      throw new RuntimeErrorException(notFound(type, version));
    }
    return entry.capabilities;
  }
}

function notFound(type: string, version?: string): RuntimeError {
  return createRuntimeError({
    code: "registry.version_not_found",
    kind: "not_found",
    category: "author",
    message: version
      ? `node type ${type}@${version} not found`
      : `node type ${type} not found`,
    source: { module: "registry" },
    context: { type, typeVersion: version },
  });
}

function defaultCapabilities(): NodeCapabilities {
  return {
    streaming: false,
    dynamicPorts: false,
    idempotent: true,
    supportsCancel: true,
    supportsCheckpoint: false,
    requiredPermissions: [],
  };
}

/**
 * Construct a registry pre-populated only with the IR-level pseudo
 * nodes (`start`, `end`). The `runtime` package layers the real
 * built-ins on top via `installNode` so they take the exact same
 * pipeline as third-party nodes — no special-casing.
 */
export function createDefaultRegistry(): InMemoryNodeTypeRegistry {
  const r = new InMemoryNodeTypeRegistry();
  for (const def of BUILTIN_NODE_TYPES) {
    r.register(def);
  }
  return r;
}

/* -------------------------------------------------------------------------- */
/* Built-in pseudo-node catalogue                                              */
/*                                                                             */
/* Only `start` / `end` live here. They are flow-control markers — they have  */
/* no runner, no config and no Field Inspector contribution. Every other      */
/* built-in is authored via `defineNode` in `@ai-native-flow/runtime` and     */
/* registered into the `NodeTypeRegistry` by `createRuntime()`.               */
/* -------------------------------------------------------------------------- */

const controlIn: PortDefinition = {
  id: "in",
  direction: "input",
  kind: "control",
  label: "运行",
};
const controlOut: PortDefinition = {
  id: "out",
  direction: "output",
  kind: "control",
  label: "下一步",
};
const runInputOut: PortDefinition = {
  id: "runInput",
  direction: "output",
  kind: "data",
  label: "运行输入",
};

export const BUILTIN_START: NodeTypeDefinition = {
  type: "start",
  typeVersion: "1.0.0",
  title: "开始",
  description: "流程入口伪节点。",
  defaultPorts: [controlOut, runInputOut],
  runtime: "builtin",
};

export const BUILTIN_END: NodeTypeDefinition = {
  type: "end",
  typeVersion: "1.0.0",
  title: "结束",
  description: "流程出口伪节点；汇总最终输出。",
  defaultPorts: [controlIn],
  runtime: "builtin",
};

export const BUILTIN_NODE_TYPES: readonly NodeTypeDefinition[] = Object.freeze([
  BUILTIN_START,
  BUILTIN_END,
]);
