# Error Model

> This document defines the unified error contract for AI Native Flow Runtime.
> Related specs: [Streaming and Node Communication](./streaming-and-node-communication.md), [Runtime Execution](./runtime-execution.md), [Security](./security.md).

## 1. 文档定位

Runtime、Node、Transport、Builder、Validator、Sandbox 在不同位置都会产生错误。如果每个模块各自定义错误对象，会出现：

- AI 生成节点逻辑时随手 `throw new Error("...")`，丢失分类信息。
- Transport 把 `node_error` 和 `transport_error` 当成同一个对象处理。
- Trace 与 Studio 无法稳定区分"用户输入错误"、"上游配置错误"、"系统瞬时错误"。
- Retry / Replay / Circuit Breaker 因为没有标准 `retryable` 标记而无法做策略决策。

本规范固化一个 **Runtime 全局唯一的错误对象模型**：`RuntimeError`。

所有抛出、传播、序列化、持久化、展示的错误都必须能够映射到该模型。

---

## 2. 核心原则

- **错误是数据，不是异常**：跨进程、跨语言、跨节点的错误必须是可序列化的结构化对象，不能依赖原生 `Error` 的栈帧。
- **错误必须可分类**：每个错误必须带有稳定的 `kind` 与 `code`，便于 Trace、监控、告警和策略决策。
- **错误必须可区分用户错误与系统错误**：`category` 必须明确表达是否由调用方输入造成。
- **错误必须显式声明可重试性**：`retryable` 是 Scheduler / Run Manager 决定是否触发 retry 的唯一依据。
- **错误必须脱敏**：错误 payload 必须经过 Secret Redaction 后才能进入 Run Event Store、Trace Store 或 Studio。
- **错误必须保留因果链**：使用 `cause` 字段保留底层错误，避免 wrap 后丢失原始信息。

---

## 3. RuntimeError 接口

```ts
interface RuntimeError {
  /** 稳定错误码，命名空间形式，例如 "node.timeout"、"validator.port_missing" */
  code: string;

  /** 错误大类，决定调度与展示行为 */
  kind: RuntimeErrorKind;

  /** 错误来源类别 */
  category: RuntimeErrorCategory;

  /** 是否允许 Scheduler 自动 retry */
  retryable: boolean;

  /** 面向开发者的简短英文描述，不应包含 PII / Secret */
  message: string;

  /** 面向终端用户的可展示文案，已脱敏，可选 */
  userMessage?: string;

  /** 错误产生的模块或节点 */
  source: RuntimeErrorSource;

  /** 结构化上下文，例如 nodeId / portId / runId / attempt / providerName */
  context?: Record<string, unknown>;

  /** 因果链；嵌套时禁止循环引用 */
  cause?: RuntimeError;

  /** 原始 stack（仅服务端日志保留，不进入对外事件） */
  stack?: string;

  /** 文档 / 帮助链接，可选 */
  docsUrl?: string;
}

type RuntimeErrorKind =
  | "validation"     // 输入、Schema、配置不通过
  | "permission"     // 权限、Secret scope、Sandbox policy
  | "timeout"        // 超时
  | "cancelled"      // 主动取消
  | "not_found"      // Flow / Node / Artifact / Run 不存在
  | "conflict"       // 版本冲突、并发冲突
  | "unavailable"    // 依赖暂不可用（外部服务、Provider）
  | "internal"       // Runtime 自身缺陷
  | "external"       // 外部 Provider / Tool / Sandbox 抛出
  | "transport";     // 传输层错误（SSE 断连、IPC 丢帧等）

type RuntimeErrorCategory =
  | "user_input"     // 调用方输入或配置错误
  | "author"         // Flow / Node 作者编码错误
  | "system"         // Runtime 自身或基础设施错误
  | "external"       // 第三方依赖错误
  | "policy";        // 安全 / 审批 / 配额拒绝

interface RuntimeErrorSource {
  module:
    | "builder"
    | "validator"
    | "registry"
    | "run_manager"
    | "scheduler"
    | "execution_engine"
    | "node_runner"
    | "node_logic"
    | "ai_stream_adapter"
    | "sandbox"
    | "transport"
    | "storage"
    | "studio";
  flowId?: string;
  flowVersion?: string;
  runId?: string;
  nodeId?: string;
  nodeVersion?: string;
  attempt?: number;
  streamId?: string;
}
```

### 3.1 `code` 命名空间

`code` 必须为小写、点分命名空间，前缀对应 `source.module`：

| 命名空间 | 示例 |
|---|---|
| `builder.*` | `builder.duplicate_node_id`、`builder.unknown_port` |
| `validator.*` | `validator.port_missing`、`validator.schema_incompatible` |
| `registry.*` | `registry.version_not_found`、`registry.promote_conflict` |
| `run_manager.*` | `run_manager.invalid_input`、`run_manager.run_not_found` |
| `scheduler.*` | `scheduler.dead_lock`、`scheduler.unreachable_branch` |
| `node.*` | `node.timeout`、`node.cancelled`、`node.output_invalid` |
| `tool.*` | `tool.not_found`、`tool.rate_limited` |
| `provider.*` | `provider.openai.rate_limit`、`provider.anthropic.invalid_key` |
| `sandbox.*` | `sandbox.permission_denied`、`sandbox.memory_exceeded` |
| `transport.*` | `transport.sse_disconnected`、`transport.frame_corrupt` |
| `storage.*` | `storage.checkpoint_corrupt` |
| `policy.*` | `policy.approval_required`、`policy.quota_exceeded` |

`code` 一旦发布即视为公开契约，破坏性变更必须经过决策文档。

### 3.2 `retryable` 决策

Scheduler 必须**只**根据 `retryable` 字段决定是否触发自动重试，不得根据 `kind` 推断。

| `kind` | 默认 `retryable` | 备注 |
|---|---|---|
| `validation` | `false` | 输入不变重试无意义 |
| `permission` | `false` | 需人工授权 |
| `timeout` | `true` | 节点必须显式 `idempotent: true` |
| `cancelled` | `false` | 不重试取消 |
| `not_found` | `false` |  |
| `conflict` | `false` | 由上层处理（重新解析版本） |
| `unavailable` | `true` | 外部依赖瞬时故障 |
| `internal` | `false` | 应触发告警而非重试 |
| `external` | 视情况 | 由 Adapter 决定 |
| `transport` | `true` | 由 Transport 自行重连 |

非幂等节点即使 `retryable: true` 也不得自动重试，详见 [Runtime Execution §5.6](./runtime-execution.md)。

---

## 4. 错误传播路径

```text
Node Logic / AI Stream Adapter / Sandbox
        │ throw / reject
        ▼
Node Runner ── normalizeError() ──► RuntimeError
        │
        ▼
Execution Engine
   ├─ 写 node_error 事件（NodeEvent.payload = RuntimeError）
   ├─ 触发 error 端口分支
   └─ 上报 Run Manager
        │
        ▼
Run Manager
   ├─ 决定 Run 状态：running / failed / partial
   └─ 写 run_failed 事件（如最终失败）
        │
        ▼
Runtime Event Bus
        │
        ▼
Transport Adapter ── redact() ──► 客户端
```

关键约束：

- **每一跳必须保持 `code` / `kind` / `category` / `retryable` 不变**，只能补充 `context` 或 wrap 进 `cause`。
- **禁止重新映射 `kind`**，例如 Transport 不能把 `provider.rate_limit` 改写成 `transport.rate_limit`。
- **禁止吞错**：Node Runner 捕获到的任何异常都必须 `normalizeError()` 后写入事件，不得静默 swallow。
- **禁止跨 Run 复用错误对象**，每个 attempt 必须重新构造，避免 `context.attempt` 错配。

---

## 5. 与 NodeEvent 的关系

[`NodeEvent`](./streaming-and-node-communication.md) 中下列事件类型的 `payload` 必须为 `RuntimeError`：

- `node_error`
- `node_warning`（warning 时 `kind` 不限，但结构相同）
- `transport_error`
- `tool_call_finished` 中包含错误时的 `error` 字段
- `stream_close` 异常关闭时的 `error` 字段

事件外层字段（`runId` / `nodeId` / `attempt` 等）由 Runtime 写入，`RuntimeError.context` **不应**重复存储这些字段，但允许引用 `streamId`、`portId`、`providerName` 等附加信息。

---

## 6. 与 error 端口的关系

Flow 图中的 `error` 端口承载**业务错误分支**，与 `node_error` 事件**不冲突**。

规则：

- 节点抛出错误时，Runtime **同时**：
  1. 写入 `node_error` 事件（用于 Trace、监控、Studio 展示）。
  2. 如果节点定义了 `error` 输出端口且 `kind="error"`，将 `RuntimeError` 作为该端口的输出值传递给下游节点。
- 下游错误处理节点接收到的输入类型应为 `RuntimeError`，便于做条件路由（按 `code` 或 `kind` 分支）。
- 如果节点未定义 `error` 端口，且错误不可重试，则该分支视为失败，由 Scheduler 决定是否影响整个 Run。

---

## 7. 脱敏与 Secret Redaction

错误对象在写入 Run Event Store、Trace Store、Studio 输出前，必须经过 Redaction：

- `message` / `userMessage` 中匹配 Secret 模式的子串替换为 `***`。
- `context` 中所有值递归扫描，命中 Secret Provider 已注册的值或匹配预设模式（API Key、Token、Bearer 等）必须脱敏。
- `stack` 仅服务端日志保留，**绝不**进入对外事件流或 Studio。
- `cause` 链上每一层都必须独立脱敏。

实现层应提供统一函数：

```ts
declare function redactRuntimeError(err: RuntimeError, scope: SecretScope): RuntimeError;
```

详见 [Security §11.3](./security.md)。

---

## 8. 工厂与归一化函数

Runtime 必须提供以下工具函数，禁止节点作者手写裸 `RuntimeError`：

```ts
declare function createRuntimeError(args: {
  code: string;
  kind: RuntimeErrorKind;
  category: RuntimeErrorCategory;
  message: string;
  retryable?: boolean;          // 默认按 §3.2 表推断
  source: RuntimeErrorSource;
  context?: Record<string, unknown>;
  cause?: unknown;              // 任意 throwable，会被递归 normalize
  userMessage?: string;
  docsUrl?: string;
}): RuntimeError;

declare function normalizeError(
  err: unknown,
  fallbackSource: RuntimeErrorSource
): RuntimeError;

declare function isRetryable(err: RuntimeError): boolean;

declare function serializeRuntimeError(err: RuntimeError): string;
declare function deserializeRuntimeError(json: string): RuntimeError;
```

`normalizeError` 行为：

- 如果输入已是合法 `RuntimeError`，直接返回（必要时补 `source`）。
- 如果是原生 `Error`，包装为 `kind: "internal"`、`category: "system"`、`retryable: false`，原 `Error.stack` 进入 `stack`，`message` 进入 `message`。
- 如果是 Provider SDK 错误（OpenAI / Anthropic 等），由对应 `AI Stream Adapter` 在归一化前拦截并构造 `provider.*` 错误码。
- 如果是字符串或非 Error 对象，包装为 `kind: "internal"` 并保留 `cause: { message: String(err) }`。

---

## 9. AI 实现约束

AI Agent 在生成节点逻辑、Adapter、Transport 代码时必须遵守：

- **不得**直接 `throw new Error()` 而不经 `createRuntimeError` / `normalizeError`。
- **不得**自定义新的错误对象结构与 `RuntimeError` 并行。
- **不得**在 `message` / `userMessage` 中拼接 Secret、API Key、原始 prompt 全文或大段用户数据。
- **不得**根据 `kind` 自行决定 retry，必须读取 `retryable`。
- **不得**捕获错误后只打日志而不写 `node_error` 事件。
- **不得**修改透传中的 `code` / `kind` / `category`。
- **必须**为每个新增 `code` 在本规范的命名空间表中登记，或在 PR 中显式扩展该表。

---

## 10. 测试要求

- 单元测试覆盖 `normalizeError` 对原生 Error / Provider Error / 字符串 / 已规范化对象四类输入的处理。
- 测试 `redactRuntimeError` 能对 `message` / `context` / `cause` 链递归脱敏。
- 测试 Scheduler 在 `retryable: true` 与 `retryable: false` 下的不同行为。
- 测试 `error` 端口分支与 `node_error` 事件**同时**产生且内容一致。
- 测试 `serializeRuntimeError` / `deserializeRuntimeError` 是 round-trip 安全的。
