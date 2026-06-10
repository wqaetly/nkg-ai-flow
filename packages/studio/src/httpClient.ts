/**
 * Browser-side HTTP/SSE client for the AI-Native-Flow runtime sidecar.
 *
 * Studio runs in a browser, so it cannot import `@ai-native-flow/runtime`
 * directly (no Node, no `fs`, no LLM credentials). Instead it speaks to a
 * locally-running `transport-http` sidecar over fetch. Streaming uses
 * `fetch + ReadableStream` instead of native `EventSource` so Studio can
 * send POST bodies containing run-scoped environment overrides.
 *
 * Endpoints consumed (mirrors `packages/transport-http/src/handler.ts`):
 *   - POST /flows/:flowId/invoke
 *   - POST /flows/:flowId/nodes/:nodeId/invoke
 *   - POST /flows/:flowId/stream                (SSE)
 *   - POST /flows/:flowId/nodes/:nodeId/stream  (SSE)
 *   - POST /runs/:runId/cancel
 *
 * The client is intentionally dependency-free — fetch + ReadableStream are
 * built into every modern browser. Cancellation goes through an AbortController
 * PLUS a runtime-level POST cancel so the sidecar's `RunManager` aborts the
 * engine; aborting only the fetch stream would let the run keep executing on
 * the server.
 *
 * Concurrency model: one active run per controller. Studio constructs a
 * controller per flow tab, so multiple tabs running in parallel each get
 * their own SSE connection without sharing event state.
 */

export interface SidecarClientOptions {
  /** Base URL of the sidecar, e.g. "http://localhost:5173". */
  baseUrl: string;
}

export interface EnvOverrides {
  variables?: Record<string, unknown>;
  /** Deprecated compatibility field. Values are treated as variables. */
  secrets?: Record<string, string>;
}

export interface FlowEnvDocument {
  variables: Record<string, unknown>;
  path?: string;
  paths?: string[];
}

/**
 * Minimal subset of `NodeEvent` shapes we render in Studio. Kept loose
 * (`Record<string, unknown>` for `payload`) so the client works against
 * any sidecar version that produces the documented `kind` set.
 */
export interface RuntimeEvent {
  eventId: string;
  runId: string;
  kind: string;
  ts: number;
  nodeId?: string;
  payload?: Record<string, unknown>;
}

export interface RunHandle {
  /** Server-assigned run id (available *after* the first event). */
  runId: () => string | undefined;
  /** Stop streaming AND cancel the underlying run on the sidecar. */
  cancel: () => Promise<void>;
}

export interface StreamCallbacks {
  onEvent: (event: RuntimeEvent) => void;
  /** Optional terminal hook; fires once on run_finished/failed/cancelled. */
  onTerminal?: (event: RuntimeEvent) => void;
  /** Network/parse errors. SSE-level reconnects bubble through here too. */
  onError?: (error: Error) => void;
}

export class SidecarClient {
  constructor(private readonly options: SidecarClientOptions) {}

  /** Update the base URL (e.g. when the user edits the sidecar field). */
  withBaseUrl(baseUrl: string): SidecarClient {
    return new SidecarClient({ ...this.options, baseUrl });
  }

  /** Synchronous full-flow invocation; resolves when the run terminates. */
  async invokeFlow(
    flowId: string,
    input: unknown,
    flowVersion?: string,
    envOverrides?: EnvOverrides,
  ): Promise<InvokeResult> {
    const res = await fetch(this.url(`/flows/${encode(flowId)}/invoke`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input,
        ...(flowVersion ? { flowVersion } : {}),
        ...(envOverrides ? { envOverrides } : {}),
      }),
    });
    return parseInvokeResponse(res);
  }

  /** Synchronous sub-graph (sink-node) invocation. */
  async invokeNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    flowVersion?: string,
    envOverrides?: EnvOverrides,
  ): Promise<InvokeResult> {
    const res = await fetch(
      this.url(`/flows/${encode(flowId)}/nodes/${encode(nodeId)}/invoke`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input,
          ...(flowVersion ? { flowVersion } : {}),
          ...(envOverrides ? { envOverrides } : {}),
        }),
      },
    );
    return parseInvokeResponse(res);
  }

  /**
   * Stream a full-flow run via SSE. Returns a handle whose `cancel()`
   * both aborts the fetch stream and posts a runtime cancel — the latter
   * matters because plain HTTP stream abortion does not interrupt the
   * server-side engine.
   */
  streamFlow(
    flowId: string,
    input: unknown,
    callbacks: StreamCallbacks,
    flowVersion?: string,
    envOverrides?: EnvOverrides,
  ): RunHandle {
    return this.openStream(
      this.url(`/flows/${encode(flowId)}/stream`),
      {
        input,
        ...(flowVersion ? { flowVersion } : {}),
        ...(envOverrides ? { envOverrides } : {}),
      },
      callbacks,
    );
  }

  /** Stream a sub-graph (sink-node) run via SSE. */
  streamNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    callbacks: StreamCallbacks,
    flowVersion?: string,
    envOverrides?: EnvOverrides,
  ): RunHandle {
    return this.openStream(
      this.url(`/flows/${encode(flowId)}/nodes/${encode(nodeId)}/stream`),
      {
        input,
        ...(flowVersion ? { flowVersion } : {}),
        ...(envOverrides ? { envOverrides } : {}),
      },
      callbacks,
    );
  }

  /** Cancel a run by id. Idempotent against terminal runs (404 swallowed). */
  async cancelRun(runId: string, reason?: string): Promise<void> {
    const res = await fetch(this.url(`/runs/${encode(runId)}/cancel`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason ? { reason } : {}),
    });
    // 404 means the run already terminated; that's a benign race here.
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cancel failed (${res.status}): ${body || res.statusText}`);
    }
  }

  /** Read the JSON env sidecar for a Sidecar-managed flow. */
  async loadFlowEnv(sidecarPath: string): Promise<FlowEnvDocument> {
    const res = await fetch(
      this.url(`/studio/flows/env?path=${encodeURIComponent(sidecarPath)}`),
      { method: "GET", headers: { accept: "application/json" } },
    );
    return parseFlowEnvResponse(res);
  }

  /** Persist variables into the flow's `.local.env.json` sidecar. */
  async saveFlowEnv(
    sidecarPath: string,
    variables: Record<string, unknown>,
  ): Promise<FlowEnvDocument> {
    const res = await fetch(
      this.url(`/studio/flows/env?path=${encodeURIComponent(sidecarPath)}`),
      {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ variables }),
      },
    );
    return parseFlowEnvResponse(res);
  }

  /* ----------------------------------------------------------------------- */

  private url(path: string): string {
    // Trim a trailing slash so we don't end up with `//flows/...` which
    // some reverse proxies treat as a redirect.
    const base = this.options.baseUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  private openStream(
    url: string,
    body: Record<string, unknown>,
    callbacks: StreamCallbacks,
  ): RunHandle {
    let runId: string | undefined;
    let closed = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`SSE request failed (${res.status}): ${text || res.statusText}`);
        }
        if (!res.body) throw new Error("SSE response has no body");
        await readSseStream(res.body, (parsed) => {
          if (!runId && parsed.runId) runId = parsed.runId;
          callbacks.onEvent(parsed);
          if (
            parsed.kind === "run_finished" ||
            parsed.kind === "run_failed" ||
            parsed.kind === "run_cancelled"
          ) {
            callbacks.onTerminal?.(parsed);
            closed = true;
            controller.abort();
          }
        });
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        callbacks.onError?.(asError(err, "SSE connection"));
      }
    })();

    return {
      runId: () => runId,
      cancel: async () => {
        closed = true;
        controller.abort();
        if (runId) {
          await this.cancelRun(runId, "studio user cancel").catch(() => {
            /* swallow: best-effort. */
          });
        }
      },
    };
  }
}

export interface InvokeResult {
  runId: string;
  flowId: string;
  flowVersion: string;
  nodeId?: string;
  status: string;
  output: unknown;
  error: unknown;
}

async function parseInvokeResponse(res: Response): Promise<InvokeResult> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Sidecar returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const code =
      typeof body.error === "object" && body.error
        ? (body.error as Record<string, unknown>).code
        : undefined;
    const message =
      typeof body.error === "object" && body.error
        ? ((body.error as Record<string, unknown>).message as string | undefined)
        : undefined;
    throw new Error(
      `Sidecar invoke failed (${res.status}${code ? ` ${code}` : ""}): ${message ?? res.statusText}`,
    );
  }
  return body as unknown as InvokeResult;
}

async function parseFlowEnvResponse(res: Response): Promise<FlowEnvDocument> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Sidecar returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const code =
      typeof body.error === "object" && body.error
        ? (body.error as Record<string, unknown>).code
        : undefined;
    const message =
      typeof body.error === "object" && body.error
        ? ((body.error as Record<string, unknown>).message as string | undefined)
        : undefined;
    throw new Error(
      `Sidecar flow env failed (${res.status}${code ? ` ${code}` : ""}): ${message ?? res.statusText}`,
    );
  }
  const variables = body.variables;
  return {
    variables:
      variables && typeof variables === "object" && !Array.isArray(variables)
        ? variables as Record<string, unknown>
        : {},
    path: typeof body.path === "string" ? body.path : undefined,
    paths: Array.isArray(body.paths) && body.paths.every((item) => typeof item === "string")
      ? body.paths
      : undefined,
  };
}

function encode(part: string): string {
  return encodeURIComponent(part);
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RuntimeEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchSseFrame(frame, onEvent);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatchSseFrame(buffer, onEvent);
  } finally {
    reader.releaseLock();
  }
}

function dispatchSseFrame(
  frame: string,
  onEvent: (event: RuntimeEvent) => void,
): void {
  const dataLines: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    if (!raw || raw.startsWith(":")) continue;
    if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  onEvent(JSON.parse(dataLines.join("\n")) as RuntimeEvent);
}

function asError(value: unknown, label: string): Error {
  if (value instanceof Error) return value;
  return new Error(`${label}: ${String(value)}`);
}
