/**
 * Tiny helper used by the example scripts to dump an entire Run (record +
 * every event + final output / error) to disk so a human can review what
 * happened end-to-end.
 *
 * Two files are written per run:
 *   - logs/<flowId>/<runId>.log.json  - structured, machine-readable
 *   - logs/<flowId>/<runId>.log.txt   - human-friendly trace
 *
 * The helper is example-only (lives outside the runtime package) because
 * the runtime itself stays IO-free; logs are a transport-layer concern.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecuteResult, Runtime } from "@ai-native-flow/runtime";

export interface WriteRunLogResult {
  jsonPath: string;
  textPath: string;
}

export async function writeRunLog(
  runtime: Runtime,
  result: ExecuteResult,
  options: { logsDir?: string } = {},
): Promise<WriteRunLogResult> {
  const logsDir = options.logsDir ?? "logs";
  const runId = result.runRecord.runId;
  const flowId = result.runRecord.flowId;
  const events = await runtime.eventBus.store.read(runId);

  const jsonPath = join(logsDir, flowId, `${runId}.log.json`);
  const textPath = join(logsDir, flowId, `${runId}.log.txt`);
  await mkdir(dirname(jsonPath), { recursive: true });

  const payload = {
    runRecord: result.runRecord,
    succeeded: result.succeeded,
    cancelled: result.cancelled,
    output: result.output ?? null,
    error: result.error ?? null,
    events,
  };
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(textPath, formatTrace(payload), "utf8");

  return { jsonPath, textPath };
}

/** Render a compact, line-oriented trace that a human can scan quickly. */
function formatTrace(payload: {
  runRecord: { runId: string; flowId: string; flowVersion: string; status: string; createdAt: string; finishedAt?: string };
  succeeded: boolean;
  cancelled: boolean;
  output: unknown;
  error: unknown;
  events: ReadonlyArray<{
    eventId: string;
    timestamp: string;
    kind: string;
    nodeId?: string;
    nodeVersion?: string;
    attempt?: number;
    seq: number;
    payload?: unknown;
  }>;
}): string {
  const lines: string[] = [];
  const r = payload.runRecord;
  lines.push(`# Run ${r.runId}`);
  lines.push(`flow:        ${r.flowId}@${r.flowVersion}`);
  lines.push(`status:      ${r.status}`);
  lines.push(`succeeded:   ${payload.succeeded}`);
  lines.push(`cancelled:   ${payload.cancelled}`);
  lines.push(`createdAt:   ${r.createdAt}`);
  if (r.finishedAt) lines.push(`finishedAt:  ${r.finishedAt}`);
  lines.push("");
  lines.push("## Output");
  lines.push(stringify(payload.output));
  if (payload.error) {
    lines.push("");
    lines.push("## Error");
    lines.push(stringify(payload.error));
  }
  lines.push("");
  lines.push("## Events");
  for (const e of payload.events) {
    const head = `${e.timestamp}  ${e.kind.padEnd(15)}  ${e.nodeId ?? "-"}`;
    lines.push(head);
    if (e.payload !== undefined && e.payload !== null) {
      const body = stringify(e.payload).split("\n").map((l) => `    ${l}`).join("\n");
      lines.push(body);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
