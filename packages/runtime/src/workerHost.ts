import { createPortableRuntime, type CreatePortableRuntimeOptions } from "./portable.js";
import type { Runtime } from "./createRuntime.js";
import type { InvokeArgs, InvokeNodeArgs, StartedRun } from "./invocationRouter.js";
import { InMemoryVariableStore } from "@ai-native-flow/variable-store/browser";
import {
  RUNTIME_WORKER_PROTOCOL_VERSION,
  isRuntimeWorkerMessage,
  type CancelRunPayload,
  type ListRunsPayload,
  type PromoteFlowPayload,
  type RegisterFlowPayload,
  type RuntimeWorkerRequest,
  type RuntimeWorkerResponse,
  type WorkerEnvironmentOverrides,
} from "./workerProtocol.js";

export interface RuntimeWorkerEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface AttachRuntimeWorkerOptions extends CreatePortableRuntimeOptions {
  endpoint: RuntimeWorkerEndpoint;
  runtime?: Runtime;
}

export interface AttachedRuntimeWorker {
  runtime: Runtime;
  dispose(): void;
}

export function attachRuntimeWorker(
  options: AttachRuntimeWorkerOptions,
): AttachedRuntimeWorker {
  const { endpoint, runtime: suppliedRuntime, ...runtimeOptions } = options;
  const runtime = suppliedRuntime ?? createPortableRuntime(runtimeOptions);
  const unsubscribe = runtime.eventBus.subscribe("*", (event) => {
    endpoint.postMessage({
      protocol: RUNTIME_WORKER_PROTOCOL_VERSION,
      kind: "event",
      event: "node_event",
      value: event,
    });
  });

  const listener = (event: { data: unknown }) => {
    if (!isRuntimeWorkerMessage(event.data) || event.data.kind !== "request") return;
    void handleRequest(runtime, endpoint, event.data);
  };
  endpoint.addEventListener("message", listener);

  return {
    runtime,
    dispose() {
      unsubscribe();
      endpoint.removeEventListener?.("message", listener);
    },
  };
}

async function handleRequest(
  runtime: Runtime,
  endpoint: RuntimeWorkerEndpoint,
  request: RuntimeWorkerRequest,
): Promise<void> {
  try {
    if (request.command === "start" || request.command === "startNode") {
      const started = request.command === "start"
        ? await runtime.invocationRouter.start(toInvokeArgs(request.payload) as unknown as InvokeArgs)
        : await runtime.invocationRouter.startNode(toInvokeArgs(request.payload) as unknown as InvokeNodeArgs);
      respond(endpoint, request.requestId, true, started.runRecord);
      forwardCompletion(endpoint, started);
      return;
    }
    const value = await execute(runtime, request.command, request.payload);
    respond(endpoint, request.requestId, true, value);
  } catch (cause) {
    respond(endpoint, request.requestId, false, undefined, serializeError(cause));
  }
}

async function execute(runtime: Runtime, command: RuntimeWorkerRequest["command"], payload: unknown) {
  switch (command) {
    case "ping":
      return { protocol: RUNTIME_WORKER_PROTOCOL_VERSION };
    case "register": {
      const input = payload as RegisterFlowPayload;
      return runtime.registry.register(input);
    }
    case "promote": {
      const input = payload as PromoteFlowPayload;
      return runtime.registry.promote(input.flowId, input.flowVersion);
    }
    case "invoke":
      return runtime.invocationRouter.invoke(toInvokeArgs(payload) as unknown as InvokeArgs);
    case "invokeNode":
      return runtime.invocationRouter.invokeNode(toInvokeArgs(payload) as unknown as InvokeNodeArgs);
    case "cancel": {
      const input = payload as CancelRunPayload;
      await runtime.runManager.cancel(input.runId, input.reason);
      return undefined;
    }
    case "getRun":
      return runtime.runManager.get((payload as { runId: string }).runId);
    case "getEvents": {
      const input = payload as { runId: string; cursor?: string; limit?: number };
      return runtime.eventBus.store.read(input.runId, {
        ...(input.cursor ? { sinceEventId: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });
    }
    case "listRuns": {
      const input = payload as ListRunsPayload;
      return runtime.runStore.listByFlow(input.flowId, { limit: input.limit });
    }
    case "start":
    case "startNode":
      throw new Error(`${command} is handled by the streaming request path`);
  }
}

function toInvokeArgs(payload: unknown): Record<string, unknown> {
  const input = payload as Record<string, unknown> & {
    envOverrides?: WorkerEnvironmentOverrides;
  };
  const { envOverrides, ...args } = input;
  if (!envOverrides) return args;
  return {
    ...args,
    ...(envOverrides.variables
      ? { variables: storeFromRecord(envOverrides.variables) }
      : {}),
    ...(envOverrides.secrets
      ? { secrets: storeFromRecord(envOverrides.secrets) }
      : {}),
  };
}

function storeFromRecord(values: Record<string, unknown>): InMemoryVariableStore {
  return new InMemoryVariableStore(
    Object.entries(values).map(([name, value]) => ({
      name,
      value: value as never,
      metadata: { source: "runtime-worker-request" },
    })),
  );
}

function forwardCompletion(endpoint: RuntimeWorkerEndpoint, started: StartedRun): void {
  void started.completed.then((value) => {
    endpoint.postMessage({
      protocol: RUNTIME_WORKER_PROTOCOL_VERSION,
      kind: "event",
      event: "run_completed",
      value,
    });
  });
}

function respond(
  endpoint: RuntimeWorkerEndpoint,
  requestId: string,
  ok: boolean,
  value?: unknown,
  error?: RuntimeWorkerResponse["error"],
): void {
  endpoint.postMessage({
    protocol: RUNTIME_WORKER_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok,
    ...(value !== undefined ? { value } : {}),
    ...(error ? { error } : {}),
  } satisfies RuntimeWorkerResponse);
}

function serializeError(cause: unknown): NonNullable<RuntimeWorkerResponse["error"]> {
  if (cause instanceof Error) {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    return { name: cause.name, message: cause.message, ...(code ? { code } : {}) };
  }
  return { name: "Error", message: String(cause) };
}
