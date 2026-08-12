/**
 * Flow contract
 * - flow_id: advisor_demo_primary
 * - purpose: demonstrate a normal business Flow supervised outside its graph
 * - caller_input: { operation, riskLevel }
 * - final_output: protected action result including received guidance count
 * - must_not_do: embed advisor/reviewer nodes into the business topology
 * - acceptance_checks: high risk suspends before protected_action; resume completes
 */
import { defineFlow } from "@ai-native-flow/flow-builder";
import { createBrowserRuntime } from "@ai-native-flow/runtime";
import { advisorDemoNodes } from "./nodes/index.js";

const runtime = createBrowserRuntime({ nodes: advisorDemoNodes });

export const primaryFlow = defineFlow({
  id: "advisor_demo_primary",
  version: "1.0.0",
  label: "Advisor 受监督业务流",
  description:
    "业务图只包含风险探针和受保护动作；Advisor 作为 Run 级附加能力旁路观察并在边界干预。",
  inputSchema: {
    type: "object",
    required: ["operation", "riskLevel"],
    properties: {
      operation: { type: "string" },
      riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["executed", "operation", "receivedGuidance"],
    properties: {
      executed: { type: "boolean" },
      operation: { type: "string" },
      receivedGuidance: { type: "number" },
    },
  },
  registry: runtime.nodeTypeRegistry,
});

const start = primaryFlow.node("start", {
  id: "start",
  position: { x: 40, y: 120 },
});
const probe = primaryFlow.node("advisor_demo_risk_probe", {
  id: "risk_probe",
  label: "生成风险事实",
  position: { x: 260, y: 120 },
});
const action = primaryFlow.node("advisor_demo_protected_action", {
  id: "protected_action",
  label: "执行受保护动作",
  position: { x: 500, y: 120 },
});
const end = primaryFlow.node("end", {
  id: "end",
  position: { x: 740, y: 120 },
});

primaryFlow.connect(start.out("out"), probe.in("in"));
primaryFlow.connect(start.out("runInput"), probe.in("request"));
primaryFlow.connect(probe.out("out"), action.in("in"));
primaryFlow.connect(probe.out("assessment"), action.in("assessment"));
primaryFlow.connect(action.out("out"), end.in("in"));

export default primaryFlow;
