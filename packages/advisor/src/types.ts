import type { NodeEvent, NodeEventKind } from "@ai-native-flow/event-bus";
import type {
  ExecuteResult,
  InvokeArgs,
  RunGuidance,
  RunGuidanceSeverity,
  RunRecord,
} from "@ai-native-flow/runtime";

export type AdvisorMode = "off" | "observe" | "steer" | "gate";
export type AdvisorSyncBacklog = "off" | 1 | 3 | 5;

export interface AdvisorReviewBatch {
  advisorId: string;
  target: {
    runId: string;
    flowId: string;
    flowVersion: string;
    traceId?: string;
  };
  fromEventId?: string;
  toEventId: string;
  events: NodeEvent[];
}

export interface AdvisorNoteInput {
  severity?: RunGuidanceSeverity;
  code: string;
  message: string;
  suggestion?: string;
  evidence?: unknown;
  dedupeKey?: string;
}

export interface AdvisorNote extends RunGuidance {
  advisorId: string;
  dedupeKey: string;
  sourceEventId: string;
}

export type AdvisorReviewer = (
  batch: AdvisorReviewBatch,
  signal: AbortSignal,
) => Promise<AdvisorNoteInput | AdvisorNoteInput[] | undefined>;

export interface AdvisorRuntimeOptions {
  advisorId: string;
  reviewer: AdvisorReviewer;
  mode?: AdvisorMode;
  triggerKinds?: readonly NodeEventKind[];
  syncBacklog?: AdvisorSyncBacklog;
  maxReviewWaitMs?: number;
  maxConsecutiveFailures?: number;
  onError?: (error: unknown, batch: AdvisorReviewBatch) => void;
}

export interface AdvisorStartedRun {
  runRecord: RunRecord;
  completed: Promise<AdvisedExecuteResult>;
  listAdvisories(): readonly AdvisorNote[];
  resume(reason?: string): Promise<RunRecord>;
  dispose(): void;
}

export interface AdvisedExecuteResult extends ExecuteResult {
  advisories: readonly AdvisorNote[];
}

export interface AdvisorRuntimeApi {
  start(args: InvokeArgs): Promise<AdvisorStartedRun>;
  invoke(args: InvokeArgs): Promise<AdvisedExecuteResult>;
}
