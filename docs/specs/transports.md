# Transports

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

## 8. 调用入口设计

同一个 Flow 应统一暴露为 Tool-like Invocation。

### 8.1 HTTP

建议接口：

```text
POST /flows/:flowId/invoke
POST /flows/:flowId/stream
GET  /runs/:runId
GET  /runs/:runId/events
GET  /runs/:runId/events?cursor=:eventId
POST /runs/:runId/cancel
POST /runs/:runId/replay
```

`POST /flows/:flowId/stream` 和 `GET /runs/:runId/events` 都应从 Runtime Event Bus 输出标准 `NodeEvent`，不要直接读取节点进程的 `stdout` / `stderr`。

#### Invoke 请求体

`POST /flows/:flowId/invoke`、`/stream` 以及 `/flows/:flowId/nodes/:nodeId/{invoke,stream}` 共用同一个请求体形状：

```jsonc
{
  "input": { /* 任意 JSON，按 inputSchema 校验 */ },
  "flowVersion": "1.0.0",        // 可选，默认 active
  "traceId": "trace_xxx",         // 可选

  // 可选：仅本次调用生效的环境变量 / 密钥覆盖
  "envOverrides": {
    "variables": { "FOO": "bar" },
    "secrets":   { "API_KEY": "..." }
  },

  // 可选：按节点 ID 透传 config 覆盖（等价于 Langflow 的 tweaks）
  // 仅本次调用生效；底层会基于基准版本派生一个内容寻址的临时
  // Flow Version（version 形如 "1.0.0+ov.<hash>.<rand>"），register
  // 但绝不 promote。多个并发请求互不干扰，原始 active 指针不被
  // 修改；Run 创建时已固化 (flowId, version, artifactHash) 与图，
  // 临时版本即使被 GC 也不影响进行中的 Run。
  "nodeOverrides": {
    "<nodeId>": {
      "config":   { /* 浅合并到节点 config */ },
      "label":    "可选的新 label",
      "position": { "x": 0, "y": 0 }
    }
  }
}
```

未知 `nodeId` 会被立即拒绝（HTTP 400 / `transport.node_overrides.unknown_node`）；克隆出来的图会重新走 `validateFlow`，所以非法 config 也会作为 400 返回，不会污染后续运行。

### 8.2 CLI

示例：

```bash
flow run research-flow --input input.json
flow stream research-flow --input input.json
flow inspect run_123
flow replay run_123 --from checkpoint_456
```

CLI 只负责渲染 Runtime Event Bus，例如 token 增量、tool call、artifact、usage 和错误事件；子进程的 `stdout` / `stderr` 应显示为诊断日志，而不是语义流。

### 8.3 MCP

每个 Flow 可以自动暴露为 MCP Tool。

示例映射：

```text
research-flow -> mcp tool: research_flow
coding-agent  -> mcp tool: coding_agent
```

MCP Tool Schema 来自 Flow Input Schema。

MCP 入口应复用同一套 `NodeEvent`，并将模型输出、进度、artifact 和错误映射为 MCP 支持的 progress、content 或 resource update。即使 MCP 使用 stdio transport，也不应把内部节点进程的 `stdout` 透传为协议流。

### 8.4 SDK

示例：

```ts
const result = await client.invoke("research-flow", {
  topic: "AI-native runtime hot update"
});
```

SDK 还应提供流式调用接口：

```ts
for await (const event of client.stream("research-flow", input)) {
  // event is a normalized NodeEvent
}
```

---


