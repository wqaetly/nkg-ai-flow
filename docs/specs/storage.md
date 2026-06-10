# Storage

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

## 10. 存储设计

### 10.1 核心数据

需要存储：

- Flow definition
- Flow artifact
- Node artifact metadata
- Active version pointer
- Run record
- Run event stream
- Trace
- Checkpoint
- Approval record
- Audit log

### 10.2 推荐存储

MVP：

- SQLite
- 文件系统 Artifact Store

生产：

- PostgreSQL
- 对象存储 / Artifact Store
- Redis / NATS / BullMQ 用于队列和事件分发

### 10.3 Run Event、Trace 与 Checkpoint 边界

这三类数据容易重复，建议明确边界：

| 数据 | 定位 | 写入方式 | 用途 |
|---|---|---|---|
| Run Event Store | 事实事件流，append-only | Runtime 同步写入 | SSE cursor、Replay、Audit、Studio Timeline |
| Trace Store | 从事件流派生的查询视图 | 异步投影 / OpenTelemetry exporter | 链路分析、性能、成本、错误定位 |
| Checkpoint Store | 可恢复状态快照 | 策略触发或关键节点后写入 | Resume、Replay、Migration、故障恢复 |

约束：

- Runtime 必须先写 Run Event Store，再向外部分发事件。
- Trace Store 可以延迟，但不能成为执行正确性的依赖。
- Checkpoint 必须引用 event cursor 和 artifact refs，避免快照与事件流不一致。
- Replay 应优先基于 Run Event Store 和 Checkpoint，而不是依赖临时内存状态。

### 10.4 单机与分布式部署

MVP 可以采用单进程 Runtime，但架构边界必须允许迁移到分布式部署。

| 能力 | MVP | Production |
|---|---|---|
| Registry | 进程内索引 + SQLite | PostgreSQL 事务表 / etcd-style pointer |
| Artifact Store | 本地文件系统 | 对象存储 + hash 校验 + retention policy |
| Run Event Bus | 内存 fanout + SQLite event log | PostgreSQL append-only log + Redis / NATS fanout |
| Scheduler | 单进程调度 | Worker lease / queue / heartbeat |
| Node Runner | Worker / child process | Worker pool / container / remote runner |
| Studio 实时更新 | SSE / WebSocket | SSE / WebSocket + fanout broker |

分布式一致性要求：

- Promote active version 必须是原子操作。
- Run 创建和 Flow Version pinning 必须在同一事务边界内完成。
- Worker 执行节点前需要获得 lease，超时后可由其他 Worker 接管。
- Event 写入必须具备全局有序 cursor，至少保证单 Run 内严格有序。
- 节点完成事件与输出状态写入需要事务性或可恢复的 outbox 机制。
- 新版本发布后，各 Runtime 实例通过订阅或短轮询刷新 Registry cache。

---


