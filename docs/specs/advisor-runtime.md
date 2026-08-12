# Advisor Runtime

## 1. 定位

Advisor 是挂在 **Run** 上的可选监督能力，不是必须嵌入每张业务图的固定节点。

分层边界：

- `@ai-native-flow/runtime`：只提供通用 `RunGuidanceInbox`、安全节点边界暂停/恢复以及事件类型；不依赖 LLM，也不理解具体审阅规则。
- `@ai-native-flow/advisor`：订阅目标 Run 的增量 `NodeEvent`，调用 reviewer，完成去重、投递、backlog 和 gate 策略。
- Advisor Flow：普通、可版本化、可热更新的 Flow Artifact；由 `createFlowAdvisorReviewer()` 适配为 reviewer。
- 业务 Flow：可以完全不知道 Advisor 的存在；需要响应建议的 Agent/自定义节点可读取 `ctx.guidance`。

## 2. 数据流

```text
Primary Run
  -> EventStore (先持久化)
  -> AdvisorSession (按目标 runId 订阅)
  -> AdvisorReviewer / Advisor Flow child Run
  -> run_advisory
  -> RunGuidanceInbox (steer/gate)
  -> RunPauseGate (gate + blocker)
```

Reviewer child Run 有独立 `runId` 和事件流。Advisor 只订阅目标 `runId`，并过滤
`run_advisory`，因此不会递归审阅自己的建议。

## 3. 模式

| 模式 | 审阅 | 写入 `run_advisory` | 注入 `ctx.guidance` | `blocker` 暂停 |
|---|---:|---:|---:|---:|
| `off` | 否 | 否 | 否 | 否 |
| `observe` | 是 | 是 | 否 | 否 |
| `steer` | 是 | 是 | `concern` / `blocker` | 否 |
| `gate` | 是 | 是 | `concern` / `blocker` | 是 |

`observe` 默认异步，不让 reviewer 延迟主 Run。可用 `syncBacklog: 1 | 3 | 5`
配置有界追赶；等待由 `maxReviewWaitMs` 封顶。`steer` / `gate` 在审阅触发边界等待
本轮 reviewer，以保证 advice 能在下一个节点启动前进入 inbox。

## 4. Advice 合同

```ts
interface AdvisorNoteInput {
  severity?: "nit" | "concern" | "blocker";
  code: string;
  message: string;
  suggestion?: string;
  evidence?: unknown;
  dedupeKey?: string;
}
```

Runtime 接收后补齐 `id`、`advisorId`、`sourceEventId` 和 `createdAt`。同一 Advisor
Session 内会执行 NFKC/小写/非字母数字折叠后的精确去重；每个 review update 最多接受
一条有效建议；`done`、`lgtm`、`nothing to add` 等无信息短语会被静默过滤。

## 5. 暂停语义

`RunManager.pause(runId, reason)` 将 RunRecord 更新为 `suspended`，写入
`run_suspended`，并关闭后续节点的启动闸门；已经在执行的节点会完成。`resume()` 写入
`run_resumed` 后放行节点。

当前暂停是 **进程内安全边界暂停**：RunRecord 和事件会持久化，但调度栈还在当前进程内。
进程重启后的 crash-durable 恢复仍应由未来的持久 Scheduler + Checkpoint cursor 完成，不能
把当前 `suspended` 宣称成跨进程恢复。

可能产生 blocker 的 `gate` 调用方应使用 `AdvisorRuntime.start()`，监听 `run_suspended` 后
经人工或外部策略调用返回句柄的 `resume()`；直接使用 `invoke()` 会按语义等待 Run 恢复并完成。

## 6. 失败与安全

- Reviewer 失败默认 fail-open，不让监督器把业务 Run 变成失败。
- 连续失败达到 `maxConsecutiveFailures`（默认 3）后，本 Session 停止继续审阅。
- `gate` 只在非终态事件批次上执行暂停；对迟到的 terminal advice 只记录。
- Advisor Flow 不获得目标节点的 `NodeContext`、VariableStore 或工具权限；能力来自它自己注册的节点包。
- `evidence` 进入事件前必须由 reviewer 控制大小和敏感信息。后续应接入统一 Secret Obfuscator 与 Run Artifact spill。

## 7. 示例

完整示例位于 `apps/advisor-demo`：

- `primary.flow.ts`：不含 Advisor 节点的业务图；
- `reviewer.flow.ts`：普通审阅 Flow；
- `runtime.ts`：以 `gate` 模式绑定两条 Flow；
- 高风险输入在 `risk_probe` 完成后产生 blocker，`protected_action` 启动前暂停；
- 调用 `resume()` 后，`protected_action` 从 `ctx.guidance` 看到一条建议并完成。

```bash
npm run build -w @ai-native-flow/advisor-demo
npm run app:advisor-demo -- high
```

## 8. 验收不变量

- Advisor 关闭时与普通 `InvocationRouter` 行为一致。
- `observe` 的慢 reviewer 不进入普通 EventBus 订阅的同步关键路径。
- Advice 先以 `run_advisory` 持久化，再进入 guidance/gate。
- `blocker` 不会中断已经在执行的节点，只阻止新节点启动。
- Reviewer child Run 不会被目标 AdvisorSession 递归观察。
- 所有 transport 从同一个 EventStore 看到 `run_advisory`、`run_suspended`、`run_resumed`。
