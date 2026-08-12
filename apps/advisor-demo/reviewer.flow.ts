/**
 * Flow contract
 * - flow_id: advisor_demo_reviewer
 * - purpose: review incremental NodeEvent batches from another Run
 * - caller_input: AdvisorReviewBatch
 * - final_output: AdvisorNoteInput[] from review_batch.advisories
 * - acceptance_checks: only deterministic facts create concern/blocker notes
 */
import { defineFlow } from "@ai-native-flow/flow-builder";
import { createBrowserRuntime } from "@ai-native-flow/runtime";
import { advisorDemoNodes } from "./nodes/index.js";

const runtime = createBrowserRuntime({ nodes: advisorDemoNodes });

export const reviewerFlow = defineFlow({
  id: "advisor_demo_reviewer",
  version: "1.0.0",
  label: "Advisor 审阅流",
  description:
    "作为普通 Flow Artifact 消费目标 Run 的增量事件批次，并输出结构化 advisory。",
  inputSchema: { type: "object" },
  outputSchema: { type: "array", items: { type: "object" } },
  registry: runtime.nodeTypeRegistry,
});

const start = reviewerFlow.node("start", {
  id: "start",
  position: { x: 60, y: 120 },
});
const review = reviewerFlow.node("advisor_demo_review_event_batch", {
  id: "review_batch",
  label: "审阅增量事件",
  position: { x: 320, y: 120 },
});
const end = reviewerFlow.node("end", {
  id: "end",
  position: { x: 580, y: 120 },
});

reviewerFlow.connect(start.out("out"), review.in("in"));
reviewerFlow.connect(start.out("runInput"), review.in("batch"));
reviewerFlow.connect(review.out("out"), end.in("in"));

export default reviewerFlow;
