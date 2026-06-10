/**
 * Public surface of `@ai-native-flow/compiler`.
 *
 * Phase 3 MVP: compile a `DefinedNode` (the runtime bundle returned by
 * `@ai-native-flow/node-sdk`'s `defineNode`) into a content-addressed
 * `NodeLogicArtifact` for hot-swap, replay, diffing, and in-process
 * sandbox execution.
 *
 * Spec: docs/specs/sandbox.md §7 — the compiler gives us a stable,
 * hashable, persistable artifact format that replaces ad-hoc
 * `Function.prototype.toString()` calls.
 *
 * Out of scope for the MVP:
 *   - TypeScript source compilation (esbuild / tsc) — Phase 4.
 *   - Source-level rewriting — re-evaluate only if stronger isolation or
 *     sidecar execution returns to scope.
 *   - Pluggable hashing / signing — Phase 5+ when artifact provenance
 *     becomes a security concern.
 */

export {
  compileDefinedNode,
  serialiseRunner,
  type NodeLogicArtifact,
  type CompileOptions,
} from "./compile.js";

export {
  loadArtifactFromString,
  type LoadedArtifact,
} from "./load.js";

export { canonicalJSON, sha256Hex } from "./hash.js";
