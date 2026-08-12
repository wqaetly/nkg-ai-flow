import {
  AdvisorRuntime,
  createFlowAdvisorReviewer,
} from "@ai-native-flow/advisor";
import { createBrowserRuntime } from "@ai-native-flow/runtime";
import { advisorDemoNodes } from "./nodes/index.js";
import { primaryFlow } from "./primary.flow.js";
import { reviewerFlow } from "./reviewer.flow.js";

let sequence = 0;
const runtime = createBrowserRuntime({
  nodes: advisorDemoNodes,
  generateRunId: () => `advisor_demo_${++sequence}`,
});
for (const flow of [primaryFlow, reviewerFlow]) {
  const graph = JSON.parse(flow.dump());
  await runtime.registry.register({ graph });
  await runtime.registry.promote(graph.id, graph.version);
}

const reviewer = createFlowAdvisorReviewer({
  runtime,
  flowId: reviewerFlow.id,
  nodeId: "review_batch",
});
const advisor = new AdvisorRuntime(runtime, {
  advisorId: "demo-risk-advisor",
  reviewer,
  mode: "gate",
  triggerKinds: ["node_finished", "node_error", "run_failed"],
});

const riskLevel = readRiskLevel(process.argv[2]);
const started = await advisor.start({
  flowId: primaryFlow.id,
  input: { operation: "publish_release", riskLevel },
});

if (riskLevel === "high") {
  await waitFor(async () =>
    (await runtime.runManager.get(started.runRecord.runId))?.status === "suspended",
  );
  console.log("Run suspended by Advisor:");
  console.log(JSON.stringify(started.listAdvisories(), null, 2));
  await started.resume("demo operator acknowledged the blocker");
}

const result = await started.completed;
const events = await runtime.eventBus.store.read(started.runRecord.runId);
console.log(JSON.stringify({
  runId: result.runRecord.runId,
  status: result.runRecord.status,
  output: result.output,
  advisories: result.advisories,
  lifecycle: events
    .filter((event) => event.kind.startsWith("run_"))
    .map((event) => event.kind),
}, null, 2));

function readRiskLevel(value: string | undefined): "low" | "medium" | "high" {
  if (value === undefined) return "high";
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error("risk level must be low, medium, or high");
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach suspended state");
}
