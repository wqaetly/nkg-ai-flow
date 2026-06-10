# Streaming and Node Communication

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

### 6.6 节点通信与 AI 流输出

节点通信和 AI 流输出必须作为 Runtime 的一等模块设计，而不是让每个节点自行处理 `stdout`、`stderr`、管道、SDK 回调或 WebSocket。

核心原则：

- **语义流不是日志流**：模型 token、tool call、代码补丁、usage、thinking、artifact 等必须进入标准事件通道，而不是混在 `stdout` 日志里。
- **不要把 `stdio` 当成可靠流协议**：`stdout` / `stderr` 可以用于诊断日志采集，但不应作为 AI token stream 的主通道。
- **跨平台优先**：当前 in-process 节点直接通过 `ctx.emit()` / `ctx.stream()` 写入事件通道；未来接入子进程、容器或 Python sidecar 时，也必须通过统一协议接入。
- **Runtime 统一分发**：HTTP SSE、WebSocket、CLI、MCP、SDK、Studio 都从同一个 Run Event Stream 读取事件。
- **流式输出必须可追踪、可回放、可取消**：每个 chunk 都应有 `runId`、`nodeId`、`streamId`、`seq`、`timestamp` 和 `traceId`。

推荐链路：

```text
AI Vendor SDK / AI Coding IDE SDK
        ↓
AI Stream Adapter
        ↓
Node Event Channel
        ↓
Runtime Event Bus
        ↓
Run Event Store / Trace Store
        ↓
HTTP SSE / WebSocket / CLI / MCP / SDK / Studio
```

#### Node Event

所有节点生命周期、流式输出、工具调用、错误和诊断信息都应归一化为 `NodeEvent`。

```ts
type NodeEventKind =
  | "node_started"
  | "node_progress"
  | "stream_open"
  | "stream_delta"
  | "stream_artifact"
  | "stream_usage"
  | "stream_close"
  | "tool_call_started"
  | "tool_call_delta"
  | "tool_call_finished"
  | "node_log"
  | "node_warning"
  | "node_error"
  | "transport_error"
  | "node_finished";

interface NodeEvent {
  eventId: string;
  runId: string;
  flowId: string;
  flowVersion: string;
  nodeId: string;
  nodeVersion: string;
  attempt: number;
  seq: number;
  timestamp: string;
  kind: NodeEventKind;
  portId?: string;
  streamId?: string;
  traceId?: string;
  parentEventId?: string;
  payload: unknown;
}
```

关键约束：

- `eventId` 是 Run Event Stream 的全局 cursor，由 Runtime 持久化事件时生成，用于断线续传和回放。
- `seq` 在单个节点执行尝试内单调递增，用于检测节点内部乱序、重复或丢帧。
- `streamId` 用于区分同一节点的多个并发输出流，例如 `answer`、`tool_calls`、`patches`。
- `portId` 必须对应节点定义中的 `stream`、`event`、`data` 或 `error` 输出端口。
- Runtime 接收到事件后先写入 Run Event Store，再分发给外部客户端，避免客户端断线导致事件丢失。
- `node_finished` 只能表示节点执行完成，不能替代 `stream_close`。一个节点可以有多个 stream，每个 stream 必须独立关闭。

#### Node SDK 流接口

节点作者不应直接操作底层管道，而应通过 `ctx.emit()` 和 `ctx.stream()` 输出事件。

```ts
export default defineNode({
  id: "ai-coding-ide-agent",
  async run(ctx, input) {
    const stream = ctx.stream("answer", {
      contentType: "text/markdown"
    });

    for await (const event of ctx.adapters.aiCodingIde.stream(input.prompt)) {
      if (event.type === "text_delta") {
        await stream.write({ text: event.text });
      }

      if (event.type === "file_patch") {
        await ctx.emit({
          kind: "stream_artifact",
          portId: "patches",
          payload: event.patch
        });
      }
    }

    await stream.close();

    return {
      status: "completed"
    };
  }
});
```

建议 Node SDK 提供：

```ts
interface NodeContext {
  signal: AbortSignal;
  emit(
    event: Omit<
      NodeEvent,
      | "eventId"
      | "runId"
      | "flowId"
      | "flowVersion"
      | "nodeId"
      | "nodeVersion"
      | "attempt"
      | "seq"
      | "timestamp"
    >
  ): Promise<void>;
  stream(portId: string, options?: StreamOptions): NodeOutputStream;
  adapters: NodeAdapterRegistry;
}

interface NodeOutputStream {
  id: string;
  write(chunk: unknown): Promise<void>;
  close(finalPayload?: unknown): Promise<void>;
  fail(error: unknown): Promise<void>;
}
```

#### AI Stream Adapter

不同 AI SDK 的流式事件格式差异很大，尤其是 AI Coding IDE 厂商 SDK，可能同时输出文本、工具调用、文件变更、终端命令、诊断和 usage。必须通过 Adapter 层归一化。

```text
OpenAI Stream        ┐
Anthropic Stream     ├─> AI Stream Adapter ─> NodeEvent
Gemini Stream        │
AI Coding IDE SDK    │
Local CLI Agent      ┘
```

Adapter 应负责：

- 将厂商事件转换为标准 `NodeEvent`。
- 合并碎片化 token 或保留原始 delta，策略由 Runtime 配置决定。
- 识别 tool call start / delta / finish。
- 识别文件补丁、代码块、引用、诊断、终端输出等 artifact。
- 标准化 usage、cost、latency、model、provider metadata。
- 将 provider 原始事件作为可选 `raw` 字段保留，便于排障。
- 支持取消、超时、重试和恢复。

`AI Stream Adapter`、`Runtime Event Bus` 和传输适配器的职责应分开：

| 模块 | 职责 |
|---|---|
| AI Stream Adapter | 对接具体 provider / SDK / CLI，把原始事件转换成标准 `NodeEvent` |
| Node Event Channel | 同进程节点事件入口，负责为 `ctx.emit()` / `ctx.stream()` 分配序号、校验端口并写入 Runtime Event Bus |
| Runtime Event Bus | 在 Runtime 内部根据 `runId`、`nodeId`、`portId`、`streamId` 排序、持久化、广播、回放和限流事件 |
| Transport Adapter | 将 `NodeEvent` 映射为 SSE、WebSocket、CLI renderer、MCP progress 或 SDK AsyncIterable |

#### 未来跨进程与跨语言通信

当前运行时只交付 in-process 节点执行。若未来节点运行在 Worker、子进程、容器或 Python sidecar 中，应使用明确的控制面和数据面协议。

推荐优先级：

| 场景 | 推荐通信方式 | 说明 |
|---|---|---|
| 同进程内置 / 插件节点 | `ctx.emit()` / `ctx.stream()` / AsyncIterable / Web Streams | 当前默认路径，直接产生 `NodeEvent` |
| Worker / 子进程节点 | MessagePort 或 framed IPC over dedicated channel | 仅在重新引入强隔离或 sidecar 时考虑，不解析普通日志 |
| Python / 非 TS sidecar | Loopback WebSocket / HTTP chunked / gRPC | Windows 下比直接依赖 shell pipe 更可控 |
| 容器节点 | WebSocket / gRPC / NATS | 仅适合远程隔离和生产部署场景 |
| 诊断日志 | stdout / stderr capture | 只作为 `node_log`，不承载语义 token stream |

不推荐：

- 让 AI token stream 直接写 `stdout`，再由父进程按行解析。
- 依赖 `print()`、缓冲刷新、换行符或 shell 编码作为协议边界。
- 在 Windows 上把复杂双向语义流建立在临时命名管道或继承管道细节上。
- 把 `stderr` 既当错误通道又当进度通道。

子进程通信建议采用帧协议：

```text
Control Plane:
  start_node
  cancel_node
  heartbeat
  ack
  pause
  resume

Data Plane:
  node_event_frame(seq, kind, streamId, payload)
  stream_delta_frame(seq, streamId, payload)
  stream_close_frame(seq, streamId)
  error_frame(seq, error)
```

每个帧必须包含：

- `protocolVersion`
- `runId`
- `nodeId`
- `attempt`
- `seq`
- `kind`
- `payloadLength` 或等价边界信息
- `payload`

#### 背压、取消与恢复

流输出必须有背压控制，否则高频 token、日志或工具调用会拖垮 Studio 和 Trace Store。

建议机制：

- Runtime 为每个 node stream 设置 `highWaterMark`。
- 下游积压时，Runtime 向节点通信层发送 `pause`。
- 下游恢复后发送 `resume`。
- 节点必须监听 `ctx.signal`，支持取消 AI SDK 请求。
- 语义事件默认不丢弃；诊断日志可以按策略采样、折叠或截断。
- 每个客户端使用 cursor 读取 Run Event Stream，断线后可以从最后一个 `eventId` 继续。
- 对于不支持暂停的外部 SDK，Adapter 应做本地缓冲并设置最大内存限制。

#### 面向调用入口的输出分发

所有入口都应消费同一条 Runtime Event Bus，而不是各自对接节点进程。

```text
Node Event Channel
        ↓
Runtime Event Bus
        ├─ HTTP SSE / WebSocket
        ├─ CLI renderer
        ├─ MCP progress / resource update
        ├─ TypeScript SDK AsyncIterable
        ├─ Studio timeline
        └─ Trace / Replay storage
```

这样可以保证：

- HTTP、CLI、MCP、SDK 看到的事件顺序一致。
- Studio 可以完整回放 token、tool call、artifact 和错误。
- MCP stdio transport 不需要直接承载子节点的原始 stdout。
- 子进程或 Python sidecar 的管道问题不会污染上层协议。

---


