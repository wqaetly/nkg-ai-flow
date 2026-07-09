# Workflow Runtime Coverage

> 收敛说明：本文档记录通用 workflow runtime 的当前覆盖范围，用于停止无边界扩展，后续只处理影响主流 Flow 应用场景的缺口。

## 覆盖目标

当前 runtime 的目标不再是补齐所有可能的企业级编排边角，而是满足大部分工具流、AI Agent 流、批处理流和业务状态流：

- 可表达常见控制流：条件、循环、并发、汇聚、失败分支。
- 可组织大型流程：subflow、template、局部变量、输入/输出契约、版本固定、深度限制。
- 可处理长生命周期：timer、signal、approval、checkpoint、resume point、event trigger。
- 可处理失败恢复：retry、retry state、circuit breaker、fallback、dead letter、compensation、rollback、idempotency。
- 可完成常用数据加工：map、filter、reduce、batch、window、sort、group、schema transform、expression eval。

## 能力矩阵

| 能力域 | 代表节点/机制 | 收敛判断 |
| --- | --- | --- |
| 循环 | `foreach_begin/end`, `for_begin/end`, `loop_begin/end`, `loop_break`, `loop_continue` | 已覆盖顺序/并行 foreach、batchSize、动态策略、break/continue、嵌套 foreach、iteration scope、错误策略、timeout 和 max iteration。 |
| 并发与 Join | `parallel`, `join`, `all_success`, `any_success`, `race`, `quorum`, `fail_fast`, `partial_success`, `branch_timeout`, `mutex`, `semaphore` | 已覆盖 fan-out、显式并发节点、汇聚策略、race/quorum、fail-fast、partial success、分支超时和并发上限。 |
| Retry / Timeout / Circuit Breaker | runtime `runtimeRetry`, `deadline`, `retry_policy`, `retry_state`, `circuit_breaker`, `fallback`, `first_success`, `idempotency_key` | 已覆盖节点级重试、指数退避、jitter、retry-after、retryable/error code 判断、幂等要求、持久 retry state 和熔断器开闭/半开。 |
| Subflow / 函数化流程 | `subflow`, `subflow_template`, local variables, schema contracts | 已覆盖子流程调用、动态 flow/version、模板注册、输入/输出契约、局部变量隔离、直接递归阻止和 maxDepth。 |
| 异步等待与恢复 | `delay`, `cron_schedule`, `schedule_window`, `wait_timer`, `wait_signal`, `signal_resume`, `approval`, `event_trigger`, `send_event`, `checkpoint`, `resume_point` | 已覆盖即时 delay、计划窗口、timer checkpoint、外部 signal resume、human approval、事件触发、checkpoint save/load/touch/clear 和从 resume point 恢复。 |
| 补偿与事务语义 | `compensation`, `rollback`, `dead_letter`, `audit_log`, `checkpoint`, `resume_point`, `idempotency_key` | 已覆盖补偿动作注册/清理/反序 drain、rollback plan/summarize 成功/部分/失败/未完成、dead-letter enqueue/drain/clear、幂等 key 和恢复点。 |
| 数据流算子 | `map_items`, `filter_items`, `reduce_items`, `batch_items`, `batch_window`, `window_items`, `sort_items`, `group_items`, `schema_transform`, `expression_eval`, path/json helpers | 已覆盖主流数组、窗口、分组、排序、schema 映射、表达式和 JSON/path 变换。 |

## 当前验收基线

收敛时以以下验证作为 baseline：

```powershell
npx tsc --noEmit -p packages/runtime/tsconfig.json
git diff --check
npm test -w @ai-native-flow/runtime
npm test
npm run typecheck
```

截至本收敛点，runtime 全量测试通过 `9` 个 test files、`448` 个 tests；全仓测试通过 `42` 个 test files、`731` 个 tests。`git diff --check` 只允许出现当前 Windows 工作区的 LF/CRLF 提示，不允许 whitespace error。

## 后续只处理的缺口

后续不再因为“还能补一个边界”而继续扩展。只处理下面三类问题：

1. 主流 flow 场景无法表达或运行结果错误。
2. 已有节点的 Studio/Flow 可视化无法配置关键输入输出。
3. 当前验收基线失败，或新增功能破坏上述能力矩阵。

以下能力暂不作为当前收敛目标：

- 分布式持久调度器、跨进程 worker 协调、exactly-once 分布式事务。
- 完整 BPMN/Temporal/Cadence 等价语义。
- 全量可视化设计器的高级调试 UI、时间线回放 UI 和人工任务中心。
- 所有节点参数排列组合的穷尽测试。
