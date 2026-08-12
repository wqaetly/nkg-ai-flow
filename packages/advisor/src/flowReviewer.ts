import type { Runtime } from "@ai-native-flow/runtime";
import type {
  AdvisorNoteInput,
  AdvisorReviewBatch,
  AdvisorReviewer,
} from "./types.js";

export interface CreateFlowAdvisorReviewerOptions {
  runtime: Pick<Runtime, "invocationRouter" | "runManager">;
  flowId: string;
  nodeId: string;
  flowVersion?: string;
}

/**
 * Adapt a normal registered Flow node into an Advisor reviewer.
 *
 * The selected sink node receives the complete `AdvisorReviewBatch` as its Run
 * input and must expose an `advisories` array (or a single advisory) as its
 * primary data output. The child reviewer Run has its own runId/event stream,
 * so it never contaminates the target Run transcript.
 */
export function createFlowAdvisorReviewer(
  options: CreateFlowAdvisorReviewerOptions,
): AdvisorReviewer {
  return async (batch, signal) => {
    const started = await options.runtime.invocationRouter.startNode({
      flowId: options.flowId,
      ...(options.flowVersion ? { flowVersion: options.flowVersion } : {}),
      nodeId: options.nodeId,
      input: batch,
      ...(batch.target.traceId ? { traceId: batch.target.traceId } : {}),
    });
    const cancel = () => {
      void options.runtime.runManager
        .cancel(started.runRecord.runId, "advisor review aborted")
        .catch(() => {});
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    const result = await started.completed.finally(() =>
      signal.removeEventListener("abort", cancel),
    );
    if (!result.succeeded) {
      throw new Error(
        `advisor flow ${options.flowId}/${options.nodeId} failed: ${result.error?.message ?? "unknown error"}`,
      );
    }
    return parseAdvisorFlowOutput(result.output);
  };
}

function parseAdvisorFlowOutput(output: unknown): AdvisorNoteInput[] {
  const value =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>).advisories ?? output
      : output;
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map(parseNote);
}

function parseNote(value: unknown): AdvisorNoteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("advisor flow output must contain advisory objects");
  }
  const record = value as Record<string, unknown>;
  const code = stringField(record, "code");
  const message = stringField(record, "message");
  const severity = record.severity;
  if (
    severity !== undefined &&
    severity !== "nit" &&
    severity !== "concern" &&
    severity !== "blocker"
  ) {
    throw new Error(`unsupported advisor severity: ${String(severity)}`);
  }
  return {
    code,
    message,
    ...(severity ? { severity } : {}),
    ...(typeof record.suggestion === "string"
      ? { suggestion: record.suggestion }
      : {}),
    ...(record.evidence !== undefined ? { evidence: record.evidence } : {}),
    ...(typeof record.dedupeKey === "string"
      ? { dedupeKey: record.dedupeKey }
      : {}),
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`advisor flow output requires non-empty ${key}`);
  }
  return value;
}
