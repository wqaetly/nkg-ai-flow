import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";

const assessmentSchema = z.object({
  operation: z.string(),
  riskLevel: z.enum(["low", "medium", "high"]),
  requiresReview: z.boolean(),
});

export const protectedActionNode = defineNode({
  type: "advisor_demo_protected_action",
  typeVersion: "1.0.0",
  title: "受保护动作",
  description: "在 Advisor gate 被恢复后执行，并记录节点边界收到的 guidance。",
  input: z.object({ assessment: assessmentSchema }),
  output: z.object({
    result: z.object({
      executed: z.boolean(),
      operation: z.string(),
      receivedGuidance: z.number().int().nonnegative(),
    }),
  }),
  ports: [
    { id: "assessment", direction: "input", kind: "data", label: "Assessment" },
    { id: "result", direction: "output", kind: "data", label: "Result" },
  ],
  run({ input, ctx }) {
    const result = {
      executed: true,
      operation: input.assessment.operation,
      receivedGuidance: ctx.guidance?.length ?? 0,
    };
    return {
      kind: "success",
      outputs: { out: result, result },
    };
  },
});
