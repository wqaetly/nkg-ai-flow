# Graph Operations and AI Patch

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

### 2.5 AI Edits as Builder Logic and Graph Operations

AI 不应直接修改核心 Runtime 代码，也不建议直接手写完整 Flow JSON，而应生成以下更受控的产物：

1. **Flow Builder 逻辑**：通过类型化 API 创建节点实例、定义端口、连接边，最后调用 `dump()`。
2. **Graph Operation**：表达一次小粒度图修改，例如新增节点、删除边、修改节点配置。
3. **Sandbox Code Node**：在受限沙箱里运行的节点逻辑。
4. **Node Plugin Source**：完整 TypeScript 节点插件，需要更严格审批。

Graph Operation 示例：

```json
{
  "op": "add_node",
  "node": {
    "id": "node_summarize_01",
    "type": "llm",
    "typeVersion": "1.0.0",
    "label": "Summarize",
    "position": {
      "x": 960,
      "y": 120
    },
    "config": {
      "prompt": "Summarize the current state into a concise answer."
    }
  }
}
```

无论 AI 生成的是 Builder 逻辑还是 Graph Operation，最终都必须经过：

- Type Check / Syntax Check
- Builder Validation
- Schema Validation
- 权限检查
- Flow 图合法性检查
- `dump()` 生成标准 Flow JSON
- Dry Run
- Diff Preview
- 人工或策略审批
- 发布新版本


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


