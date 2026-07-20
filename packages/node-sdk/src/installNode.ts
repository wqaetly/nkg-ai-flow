/**
 * `installNode` registers a `DefinedNode` (or a `NodeFactory` once its
 * deps are bound) into the runtime's two registries in a single call.
 *
 * The SDK deliberately does **not** depend on `@ai-native-flow/runtime`.
 * Instead `installNode` accepts a structurally-typed `InstallTarget`
 * that any registry pair can satisfy. The runtime exposes a one-line
 * helper that produces such a target from a `RuntimeRegistry` +
 * `NodeRunnerRegistry` pair.
 */

import type { NodeCapabilities, NodeTypeDefinition } from "@ai-native-flow/flow-ir";
import type {
  DefinedNode,
  NodeFactory,
  SdkInternalRunner,
} from "./types.js";

/**
 * The minimum surface a registry pair must expose for the SDK to
 * register a node into it. Every method is intentionally narrow so the
 * runtime can satisfy it without exposing its internal `register*` APIs.
 */
export interface InstallTarget {
  /**
   * Register the node-type metadata (data track). Most runtimes will
   * forward this to `RuntimeRegistry.registerNodeType()`.
   */
  registerType(definition: NodeTypeDefinition, capabilities?: NodeCapabilities): void;

  /**
   * Register the runner (behaviour track). Forwards to
   * `NodeRunnerRegistry.register(type, version, runner)`.
   */
  registerRunner(
    type: string,
    typeVersion: string,
    runner: SdkInternalRunner,
  ): void;
}

/**
 * Register a `DefinedNode` (or factory + deps) into the supplied target.
 *
 * Overloads keep the call ergonomic:
 *
 *   ```ts
 *   installNode(target, myNode);                  // already-resolved
 *   installNode(target, llmNodeFactory, deps);    // factory + deps
 *   installNode(target, llmNodeFactory(deps));    // also fine
 *   ```
 */
export function installNode(target: InstallTarget, node: DefinedNode): void;
export function installNode<TDeps>(
  target: InstallTarget,
  factory: NodeFactory<TDeps>,
  deps: TDeps,
): void;
export function installNode<TDeps>(
  target: InstallTarget,
  nodeOrFactory: DefinedNode | NodeFactory<TDeps>,
  deps?: TDeps,
): void {
  const resolved =
    typeof nodeOrFactory === "function"
      ? (nodeOrFactory as NodeFactory<TDeps>)(deps as TDeps)
      : nodeOrFactory;

  target.registerType(resolved.definition, resolved.capabilities);
  target.registerRunner(
    resolved.definition.type,
    resolved.definition.typeVersion,
    resolved.runner,
  );
}

/** Convenience: install many at once. */
export function installNodes(
  target: InstallTarget,
  nodes: ReadonlyArray<DefinedNode>,
): void {
  for (const n of nodes) installNode(target, n);
}
