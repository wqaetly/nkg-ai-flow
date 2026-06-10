/**
 * Subset of the unified `RuntimeError` model defined in
 * `docs/specs/error-model.md` that Phase 0 actually needs.
 *
 * Only `builder.*` and `validator.*` codes are produced from this file; the
 * Runtime, Sandbox, Provider and Transport namespaces are added in later
 * phases. Keeping the definition here (in `flow-ir`) avoids each downstream
 * package redefining its own error shape, which the AI Implementation Guide
 * explicitly forbids.
 */

export type RuntimeErrorKind =
  | "validation"
  | "permission"
  | "timeout"
  | "cancelled"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal"
  | "external"
  | "transport";

export type RuntimeErrorCategory =
  | "user_input"
  | "author"
  | "system"
  | "external"
  | "policy";

export type RuntimeErrorSourceModule =
  | "builder"
  | "validator"
  | "registry"
  | "run_manager"
  | "scheduler"
  | "execution_engine"
  | "invocation_router"
  | "node_runner"
  | "node_logic"
  | "ai_stream_adapter"
  | "sandbox"
  | "transport"
  | "storage"
  | "studio";

export interface RuntimeErrorSource {
  module: RuntimeErrorSourceModule;
  flowId?: string;
  flowVersion?: string;
  runId?: string;
  nodeId?: string;
  nodeVersion?: string;
  attempt?: number;
  streamId?: string;
}

export interface RuntimeError {
  code: string;
  kind: RuntimeErrorKind;
  category: RuntimeErrorCategory;
  retryable: boolean;
  message: string;
  userMessage?: string;
  source: RuntimeErrorSource;
  context?: Record<string, unknown>;
  cause?: RuntimeError;
  stack?: string;
  docsUrl?: string;
}

/**
 * Default `retryable` per `kind`, taken from
 * `docs/specs/error-model.md §3.2`. Phase 0 only emits validation errors,
 * but exposing the table keeps later phases consistent.
 */
const DEFAULT_RETRYABLE: Record<RuntimeErrorKind, boolean> = {
  validation: false,
  permission: false,
  timeout: true,
  cancelled: false,
  not_found: false,
  conflict: false,
  unavailable: true,
  internal: false,
  external: false,
  transport: true,
};

export interface CreateRuntimeErrorArgs {
  code: string;
  kind: RuntimeErrorKind;
  category: RuntimeErrorCategory;
  message: string;
  retryable?: boolean;
  source: RuntimeErrorSource;
  context?: Record<string, unknown>;
  cause?: unknown;
  userMessage?: string;
  docsUrl?: string;
}

export function createRuntimeError(args: CreateRuntimeErrorArgs): RuntimeError {
  const err: RuntimeError = {
    code: args.code,
    kind: args.kind,
    category: args.category,
    retryable: args.retryable ?? DEFAULT_RETRYABLE[args.kind],
    message: args.message,
    source: args.source,
  };
  if (args.userMessage !== undefined) {
    err.userMessage = args.userMessage;
  }
  if (args.docsUrl !== undefined) {
    err.docsUrl = args.docsUrl;
  }
  if (args.context !== undefined) {
    err.context = args.context;
  }
  if (args.cause !== undefined) {
    err.cause = normalizeError(args.cause, args.source);
  }
  return err;
}

/**
 * Coerce an unknown thrown value into a `RuntimeError`. Any caller that
 * receives an unstructured throwable (Provider SDK, user code, foreign
 * library) must run it through this function before persisting or emitting.
 */
export function normalizeError(
  err: unknown,
  fallbackSource: RuntimeErrorSource,
): RuntimeError {
  if (isRuntimeError(err)) {
    if (!err.source) {
      return { ...err, source: fallbackSource };
    }
    return err;
  }
  if (err instanceof Error) {
    const out: RuntimeError = {
      code: "internal.unknown",
      kind: "internal",
      category: "system",
      retryable: false,
      message: err.message || "unknown error",
      source: fallbackSource,
    };
    if (err.stack) {
      out.stack = err.stack;
    }
    return out;
  }
  return {
    code: "internal.unknown",
    kind: "internal",
    category: "system",
    retryable: false,
    message: typeof err === "string" ? err : "unknown error",
    source: fallbackSource,
    context: { rawType: typeof err },
  };
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<RuntimeError>;
  return (
    typeof v.code === "string" &&
    typeof v.kind === "string" &&
    typeof v.category === "string" &&
    typeof v.retryable === "boolean" &&
    typeof v.message === "string" &&
    typeof v.source === "object" &&
    v.source !== null
  );
}

export function isRetryable(err: RuntimeError): boolean {
  return err.retryable;
}

/**
 * Throwable wrapper, used by Builder and Validator at the boundaries where
 * an Error must propagate through the standard `throw` channel (e.g. inside
 * a `try/catch`). The structured `error` is preserved on the instance.
 */
export class RuntimeErrorException extends Error {
  readonly error: RuntimeError;
  constructor(error: RuntimeError) {
    super(`${error.code}: ${error.message}`);
    this.name = "RuntimeErrorException";
    this.error = error;
  }
}
