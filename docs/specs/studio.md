# Studio

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

## 9. 调试与可视化 Studio

浏览器 Studio 是本项目的核心能力之一，不应只是低代码画布。

### 9.1 核心视图

- **Flow Canvas**：展示 Flow 图，并支持拖拽节点、移动节点、删除节点、连接多端口边。
- **Node Palette**：展示可用节点类型，用户可以拖拽节点类型创建新的节点实例。
- **Property Panel**：编辑节点实例的标题、配置、Prompt、模型参数、超时、重试策略等。
- **Port Editor**：编辑动态端口，例如新增输入参数、输出字段、错误分支和条件分支。
- **Edge Inspector**：查看和编辑连线、条件表达式、数据映射和端口兼容性。
- **Graph Validation Panel**：展示节点缺失配置、端口不兼容、孤立节点、循环依赖等图校验问题。
- **Run Timeline**：展示执行时间线。
- **Node Detail**：查看节点输入、输出、错误、耗时。
- **State Diff**：查看节点执行前后的状态变化。
- **Prompt Viewer**：查看 LLM Prompt、模型参数、结构化输出。
- **Tool Call Viewer**：查看工具调用参数和结果。
- **Trace Viewer**：查看事件、日志、Token、Cost、Latency。
- **Stream Inspector**：查看每个节点的 token delta、tool call delta、artifact、usage、seq、cursor、背压状态和原始 provider event。
- **Transport Diagnostics**：查看 Worker、子进程、sidecar、WebSocket、IPC 的心跳、延迟、重连和错误。
- **Replay Panel**：从 Checkpoint 重新执行。
- **Version Diff**：比较两个 Flow Version 的差异。

### 9.2 调试能力

建议支持：

- 单步执行
- Breakpoint
- Dry Run
- Mock Tool Result
- Run Replay
- Checkpoint Resume
- Flow Version Compare
- AI Patch Preview
- Stream Replay
- Event Cursor Resume
- Transport Diagnostics

### 9.3 可视化编辑能力

Studio 不应只用于浏览 AI 生成的 Flow，而应该支持用户和 AI 共同编辑同一份 Flow Graph。

必须支持：

- 从 Node Palette 拖拽创建节点实例。
- 删除节点，并自动删除或提示处理关联边。
- 复制、粘贴、框选和批量移动节点。
- 编辑节点标题、配置、Prompt、模型参数和权限声明。
- 编辑动态端口，例如条件节点的 `true` / `false` / `fallback` 分支，或者工具节点的多个结构化输出。
- 从指定输出端口拖拽到指定输入端口创建边。
- 重连边的起点端口或终点端口。
- 对端口类型、方向和 Schema 进行实时校验。
- 支持多输入、多输出、多错误分支和流式输出端口。
- 支持自动布局，但不能依赖布局顺序作为运行时语义。
- 支持 JSON / Graph 双向同步：画布修改生成 Graph Operation，经 Builder 校验后由 `dump()` 导出 Flow JSON；JSON 修改反向更新画布。
- 支持 AI Patch Preview：AI 修改 Flow 前，用户可以在画布上预览新增节点、删除节点、端口变化和边变化。
- Run event stream
- Node event frames
- Stream cursor / ack state
- Trace
- Checkpoint

可视化编辑器内部建议采用类似 React Flow 的节点和 Handle 模型，但存储层不要直接耦合具体前端库的数据结构。推荐将 UI 适配层和 Runtime Graph Schema 分开：

```text
Runtime Graph Schema   # 稳定、可执行、可版本化
Flow Builder           # 将图编辑操作和 AI 生成逻辑转换为合法 Flow JSON
Editor View Model      # 前端画布布局、选中态、折叠态、临时交互状态
React Flow Adapter     # 将 Runtime Graph 映射到 React Flow nodes / edges / handles
```

---


