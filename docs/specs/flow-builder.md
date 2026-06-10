# Flow Builder

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

### 2.2 Flow Builder First

Flow 的权威存储结果是 JSON，但 Flow 的创建过程不应要求 AI 直接手写 JSON。

推荐引入 `FlowBuilder` / `GraphBuilder` API：

```ts
import { defineFlow } from "@ai-native-flow/flow-builder";

const flow = defineFlow({
  id: "research-flow",
  version: "1.0.0",
  inputSchema: {
    topic: "string"
  }
});

const start = flow.node("start", {
  id: "node_start_01",
  label: "Start",
  position: { x: 80, y: 160 }
});

const plan = flow.node("llm", {
  id: "node_plan_01",
  label: "Plan",
  position: { x: 360, y: 120 },
  config: {
    prompt: "Create a research plan for {{input.topic}}"
  }
});

const search = flow.node("tool", {
  id: "node_search_01",
  label: "Search",
  position: { x: 680, y: 120 },
  config: {
    tool: "web.search"
  }
});

flow.connect(start.out("out"), plan.in("in"));
flow.connect(start.out("topic"), plan.in("topic"));
flow.connect(plan.out("out"), search.in("in"));
flow.connect(plan.out("plan"), search.in("query"));

export default flow.dump();
```

这个模式的关键价值：

- **减少 JSON 幻觉**：AI 不需要记住完整 JSON 结构、嵌套层级和字段拼写。
- **端口类型安全**：`connect()` 可以检查输出端口是否连接到输入端口。
- **节点 ID 稳定**：Builder 可以要求显式 ID，也可以提供确定性 ID 生成策略。
- **端口存在性检查**：`plan.out("plan")` 如果端口不存在，应在构建阶段报错。
- **Schema 兼容性检查**：数据端口连接时可提前检查 JSON Schema / Zod Schema 是否兼容。
- **边唯一性检查**：Builder 可以避免重复边、非法自环、非法多重连接。
- **统一导出格式**：只有 `dump()` 负责生成最终 Flow JSON，减少多个生成源导致的不一致。
- **更适合 AI 自修复**：构建错误可以反馈给 AI，让 AI 修改 Builder 逻辑，而不是人工排查大段 JSON。

推荐将 Flow 修改入口分为三层：

```text
AI / Developer Intent
        ↓
Flow Builder Code / Graph Operations
        ↓
validate() + dump()
        ↓
Flow JSON Artifact
        ↓
Runtime Validator / Registry
```

因此，`Flow JSON` 是运行时契约，`FlowBuilder` 是创作时契约。AI 主要面向创作时契约编程，运行时只消费 Builder 导出的稳定 JSON。


### 5.4 Flow Builder Runtime Contract

`FlowBuilder` 属于创作时 API，不属于最终执行引擎的一部分。它的职责是把人类、AI 或可视化编辑器的编辑行为转成合法的 Flow Graph，并导出稳定 JSON。

建议核心接口：

```ts
interface FlowBuilder {
  node(type: string, options: CreateNodeOptions): NodeHandle;
  connect(from: OutputPortHandle, to: InputPortHandle, options?: ConnectOptions): EdgeHandle;
  removeNode(nodeId: string): void;
  removeEdge(edgeId: string): void;
  validate(): ValidationResult;
  dump(): FlowGraphJson;
}

interface NodeHandle {
  id: string;
  in(portId: string): InputPortHandle;
  out(portId: string): OutputPortHandle;
  setConfig(config: Record<string, unknown>): void;
}
```

`dump()` 前必须完成：

- 节点实例 ID 唯一性检查。
- 节点类型存在性检查。
- 端口存在性检查。
- 输入输出方向检查。
- 端口类型兼容检查。
- 数据 Schema 兼容检查。
- 必填端口连接检查。
- 孤立节点检查。
- 条件分支覆盖检查。
- 图结构合法性检查。

这样可以确保 AI 生成的是“可执行的构建逻辑”，而不是脆弱的大段 JSON 文本。


