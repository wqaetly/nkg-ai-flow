import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";

const eventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  flowId: z.string(),
  flowVersion: z.string(),
  nodeId: z.string().optional(),
  kind: z.string(),
  payload: z.unknown(),
}).passthrough();

const batchSchema = z.object({
  advisorId: z.string(),
  target: z.object({
    runId: z.string(),
    flowId: z.string(),
    flowVersion: z.string(),
  }).passthrough(),
  toEventId: z.string(),
  events: z.array(eventSchema),
}).passthrough();

const advisorySchema = z.object({
  severity: z.enum(["nit", "concern", "blocker"]),
  code: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  evidence: z.unknown().optional(),
  dedupeKey: z.string(),
});

export const reviewEventBatchNode = defineNode({
  type: "advisor_demo_review_event_batch",
  typeVersion: "1.0.0",
  title: "审阅事件批次",
  description:
    "确定性审阅目标 Run 的增量 NodeEvent；高风险产出 blocker，中风险产出 concern。",
  input: z.object({ batch: batchSchema }),
  output: z.object({ advisories: z.array(advisorySchema) }),
  ports: [
    { id: "batch", direction: "input", kind: "data", label: "Event batch" },
    { id: "advisories", direction: "output", kind: "data", label: "Advisories" },
  ],
  run({ input }) {
    const failed = input.batch.events.find(
      (event) => event.kind === "node_error" || event.kind === "run_failed",
    );
    const assessment = findAssessment(input.batch.events);
    const advisories = failed
      ? [{
          severity: "blocker" as const,
          code: "advisor_demo.execution_failed",
          message: "目标 Run 已出现执行错误，继续调度会掩盖根因。",
          suggestion: "先检查失败事件及其 RuntimeError，再决定是否恢复。",
          evidence: { eventId: failed.eventId, nodeId: failed.nodeId },
          dedupeKey: `execution_failed:${failed.nodeId ?? "run"}`,
        }]
      : assessment?.riskLevel === "high"
        ? [{
            severity: "blocker" as const,
            code: "advisor_demo.high_risk",
            message: `高风险动作“${assessment.operation}”需要人工确认。`,
            suggestion: "确认输入与影响范围后调用 resume。",
            evidence: assessment,
            dedupeKey: `high_risk:${assessment.operation}`,
          }]
        : assessment?.riskLevel === "medium"
          ? [{
              severity: "concern" as const,
              code: "advisor_demo.medium_risk",
              message: `中风险动作“${assessment.operation}”应在后续节点中复核。`,
              suggestion: "后续节点应读取 ctx.guidance 并保留审阅证据。",
              evidence: assessment,
              dedupeKey: `medium_risk:${assessment.operation}`,
            }]
          : [];
    return {
      kind: "success",
      outputs: {
        out: { advisories },
        advisories,
      },
    };
  },
});

function findAssessment(events: z.infer<typeof eventSchema>[]): {
  operation: string;
  riskLevel: "low" | "medium" | "high";
  requiresReview: boolean;
} | undefined {
  for (const event of events) {
    if (event.kind !== "node_finished" || event.nodeId !== "risk_probe") continue;
    const payload = asRecord(event.payload);
    const output = asRecord(payload?.output);
    const assessment = asRecord(output?.assessment);
    if (
      typeof assessment?.operation === "string" &&
      (assessment.riskLevel === "low" ||
        assessment.riskLevel === "medium" ||
        assessment.riskLevel === "high")
    ) {
      return {
        operation: assessment.operation,
        riskLevel: assessment.riskLevel,
        requiresReview: assessment.requiresReview === true,
      };
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
