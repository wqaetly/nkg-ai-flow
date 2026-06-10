/**
 * Structured error helpers for the Sandbox package.
 *
 * Spec: docs/specs/sandbox.md §8.
 *
 * We funnel everything through `flow-ir`'s `createRuntimeError` so the
 * sandbox seam produces the same `RuntimeError` envelope as the rest of the
 * runtime. `error-model.md` is the canonical reference.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";

/* -------------------------------------------------------------------------- */
/* Error code registry                                                         */
/* -------------------------------------------------------------------------- */

export const SANDBOX_ERROR_CODES = {
  /** Adapter cannot satisfy the permissions declared in the manifest. */
  permissionUnsatisfiable: "sandbox.permission_unsatisfiable",
  /** `inProcess` adapter received `runner: undefined`. */
  inProcessRunnerMissing: "sandbox.in_process_runner_missing",
  /** Wall-clock cap exceeded. */
  timeout: "sandbox.timeout",
  /** Caller invoked `execute()` after `drain()` completed. */
  draining: "sandbox.draining",
  /** Caller invoked `execute()` after `dispose()`. */
  disposed: "sandbox.disposed",
} as const;

export const RUNNER_REGISTRY_ERROR_CODES = {
  /** `register()` called with a `(type, version)` already taken. */
  versionConflict: "runner_registry.version_conflict",
  /** `drainNodeVersion()` exceeded its `timeoutMs`. */
  drainTimeout: "runner_registry.drain_timeout",
  /** `unregister()` called for a non-existent `(type, version)`. */
  notFound: "runner_registry.not_found",
} as const;

/* -------------------------------------------------------------------------- */
/* Factories                                                                   */
/* -------------------------------------------------------------------------- */

interface SandboxIdent {
  readonly type: string;
  readonly typeVersion: string;
  readonly tier?: string;
}

export function permissionUnsatisfiable(
  ident: SandboxIdent,
  reason: string,
): RuntimeError {
  return createRuntimeError({
    code: SANDBOX_ERROR_CODES.permissionUnsatisfiable,
    kind: "validation",
    category: "user_input",
    message: `sandbox adapter ${ident.tier ?? "?"} cannot satisfy permissions for ${ident.type}@${ident.typeVersion}: ${reason}`,
    source: { module: "sandbox" },
    context: { ...ident, reason },
  });
}

export function inProcessRunnerMissing(ident: SandboxIdent): RuntimeError {
  return createRuntimeError({
    code: SANDBOX_ERROR_CODES.inProcessRunnerMissing,
    kind: "validation",
    category: "system",
    message: `inProcess sandbox requires an explicit runner for ${ident.type}@${ident.typeVersion}`,
    source: { module: "sandbox" },
    context: { ...ident },
  });
}

export function sandboxDrainingError(ident: SandboxIdent): RuntimeError {
  return createRuntimeError({
    code: SANDBOX_ERROR_CODES.draining,
    kind: "validation",
    category: "system",
    message: `cannot execute ${ident.type}@${ident.typeVersion}: sandbox is draining`,
    source: { module: "sandbox" },
    context: { ...ident },
  });
}

export function sandboxDisposedError(ident: SandboxIdent): RuntimeError {
  return createRuntimeError({
    code: SANDBOX_ERROR_CODES.disposed,
    kind: "validation",
    category: "system",
    message: `cannot execute ${ident.type}@${ident.typeVersion}: sandbox is disposed`,
    source: { module: "sandbox" },
    context: { ...ident },
  });
}

export function drainTimeout(
  ident: SandboxIdent,
  timeoutMs: number,
  inflight: number,
): RuntimeError {
  return createRuntimeError({
    code: RUNNER_REGISTRY_ERROR_CODES.drainTimeout,
    kind: "timeout",
    category: "system",
    message: `drain of ${ident.type}@${ident.typeVersion} timed out after ${timeoutMs}ms with ${inflight} in-flight call(s)`,
    source: { module: "registry" },
    context: { ...ident, timeoutMs, inflight },
  });
}

export function versionConflict(ident: SandboxIdent): RuntimeError {
  return createRuntimeError({
    code: RUNNER_REGISTRY_ERROR_CODES.versionConflict,
    kind: "validation",
    category: "user_input",
    message: `node runner already registered for ${ident.type}@${ident.typeVersion}`,
    source: { module: "registry" },
    context: { ...ident },
  });
}

export function runnerNotFound(ident: SandboxIdent): RuntimeError {
  return createRuntimeError({
    code: RUNNER_REGISTRY_ERROR_CODES.notFound,
    kind: "not_found",
    category: "system",
    message: `no node runner registered for ${ident.type}@${ident.typeVersion}`,
    source: { module: "registry" },
    context: { ...ident },
  });
}
/* -------------------------------------------------------------------------- */
/* Convenience: throw helpers                                                  */
/* -------------------------------------------------------------------------- */

export function throwSandboxDraining(ident: SandboxIdent): never {
  throw new RuntimeErrorException(sandboxDrainingError(ident));
}

export function throwSandboxDisposed(ident: SandboxIdent): never {
  throw new RuntimeErrorException(sandboxDisposedError(ident));
}

export function throwInProcessRunnerMissing(ident: SandboxIdent): never {
  throw new RuntimeErrorException(inProcessRunnerMissing(ident));
}

export function throwDrainTimeout(
  ident: SandboxIdent,
  timeoutMs: number,
  inflight: number,
): never {
  throw new RuntimeErrorException(drainTimeout(ident, timeoutMs, inflight));
}
