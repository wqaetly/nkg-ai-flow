/**
 * Public surface of `@ai-native-flow/sandbox`.
 *
 * Spec: docs/specs/sandbox.md.
 *
 * Phase 3 ships a single in-process adapter. The `SandboxAdapter`
 * interface is kept as the seam through which built-in nodes and
 * first-party plugins call into the runtime. Stronger isolation tiers are
 * deliberately NOT shipped today; see
 * `docs/decisions/sandbox-scope-in-process-only.md`.
 */

export type {
  SandboxAdapter,
  SandboxedRunner,
  SandboxLoadOptions,
  SandboxNodeContext,
  SandboxNodeInputs,
  SandboxNodeOutputs,
  SandboxNodeResult,
  SandboxPermissions,
  SandboxTier,
  SandboxedNodeRunner,
} from "./types.js";

export { InProcessSandboxAdapter } from "./inProcessSandbox.js";

export {
  SANDBOX_ERROR_CODES,
  RUNNER_REGISTRY_ERROR_CODES,
  drainTimeout,
  inProcessRunnerMissing,
  permissionUnsatisfiable,
  runnerNotFound,
  sandboxDisposedError,
  sandboxDrainingError,
  throwDrainTimeout,
  throwInProcessRunnerMissing,
  throwSandboxDisposed,
  throwSandboxDraining,
  versionConflict,
} from "./errors.js";
