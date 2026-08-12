import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";

const requestSchema = z.object({
  operation: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high"]),
});

export const riskProbeNode = defineNode({
  type: "advisor_demo_risk_probe",
  typeVersion: "1.0.0",
  title: "风险探针",
  description: "把调用方输入规范化成可由 Advisor 审阅的确定性风险事实。",
  input: z.object({ request: requestSchema }),
  output: z.object({
    assessment: requestSchema.extend({ requiresReview: z.boolean() }),
  }),
  ports: [
    { id: "request", direction: "input", kind: "data", label: "Request" },
    { id: "assessment", direction: "output", kind: "data", label: "Assessment" },
  ],
  run({ input }) {
    const assessment = {
      ...input.request,
      requiresReview: input.request.riskLevel !== "low",
    };
    return {
      kind: "success",
      outputs: { out: null, assessment },
    };
  },
});
