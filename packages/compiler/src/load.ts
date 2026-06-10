/**
 * Load a compiled `NodeLogicArtifact` and rehydrate it into a
 * `SandboxedNodeRunner` ready to plug into a `SandboxAdapter.load()`
 * call.
 *
 * The loader simply evaluates `runnerSrc` via `new Function` under
 * `"use strict"`. The trust boundary is the caller's responsibility:
 * by the time you reach `loadArtifactFromString`, you've already
 * decided this artifact is allowed to run.
 *
 * The loader does NOT verify the artifact's `hash` field — that's the
 * caller's choice (`compileDefinedNode` produces the hash; downstream
 * orchestration may want to check it against an expected value before
 * loading). Keeping load policy-free means tests and Studio diff tools
 * can reuse the loader unchanged.
 */

import type {
  SandboxedNodeRunner,
} from "@ai-native-flow/sandbox";
import type { NodeLogicArtifact } from "./compile.js";

/**
 * Result of loading an artifact: the structurally-typed runner plus a
 * pass-through reference to the artifact metadata so callers don't have
 * to thread two values around.
 */
export interface LoadedArtifact {
  readonly artifact: NodeLogicArtifact;
  readonly runner: SandboxedNodeRunner;
}

/**
 * Evaluate `artifact.runnerSrc` and return the runner. Wraps the
 * source in `(...)` so both function declarations and arrow / async
 * forms parse as expressions. Throws a `TypeError` if the evaluated
 * value is not callable.
 */
export function loadArtifactFromString(
  artifact: NodeLogicArtifact,
): LoadedArtifact {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `"use strict"; return (${artifact.runnerSrc});`,
  ) as () => unknown;
  const fn = factory();
  if (typeof fn !== "function") {
    throw new TypeError(
      `loadArtifactFromString: artifact for ${artifact.type}@${artifact.typeVersion} did not evaluate to a function`,
    );
  }
  return { artifact, runner: fn as SandboxedNodeRunner };
}
