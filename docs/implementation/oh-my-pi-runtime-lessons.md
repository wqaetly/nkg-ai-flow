# oh-my-pi 可下沉能力评估

## 1. 结论

oh-my-pi 中值得借鉴的不是终端 UI，而是多项 **Agent Harness 基础设施**。下沉到
nkg-ai-flow 时，应抽取 provider/tool/workspace 无关的机制，保持 portable Runtime 不依赖
Node 文件系统或具体 Coding Agent。

本轮已落地第一项：Advisor 的“执行面与监督面分离”、增量事件审阅、严重度投递、去重、
有界 backlog、失败放行和安全边界 gate。参考：

- [Advisor / WATCHDOG](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md)
- [Advisor Runtime](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/runtime.ts)
- [Emission Guard](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/emission-guard.ts)

## 2. 建议下沉清单

| 优先级 | oh-my-pi 机制 | nkg-ai-flow 下沉形态 | 价值 / 当前差距 |
|---|---|---|---|
| P0 | 工具审批分级 | 通用 `ToolPolicy`：`read/write/exec` tier + per-tool allow/deny/prompt | 当前 Agent 只有 allowedTools/allowBash，缺统一风险模型；参考 [approval-mode](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md) |
| P0 | Secret Obfuscation | Provider/Event/Tool 三条出站通道共享的可逆 placeholder obfuscator | 当前 VariableStore 管配置，事件只做局部 redaction，工具输出和 reviewer evidence 仍可能泄密；参考 [secrets](https://github.com/can1357/oh-my-pi/blob/main/docs/secrets.md) |
| P0 | 大输出 Artifact spill | 独立 RunArtifactStore：事件只留摘要 + content-addressed ref | token/tool/artifact 大 payload 会放大 EventStore、SSE 和 Replay；参考 [blob/artifact architecture](https://github.com/can1357/oh-my-pi/blob/main/docs/blob-artifact-architecture.md) |
| P0 | 结构化输出门禁 | Node/Agent/Subflow output 的 strict/permissive schema validation | Node SDK 当前 output schema 主要用于文档，生产链路还缺执行后强校验 |
| P1 | Hash-anchored edits | GraphOperation 增加 `expectedFlowHash` / `expectedNodeHash` 乐观并发前置条件 | 不照搬文本编辑语法，只借鉴“基于已读快照、过期不猜”的原则；参考 [edit tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/edit.md) |
| P1 | Model roles | `ModelRouter`：default/smol/slow/vision/advisor 等角色映射、fallback、预算策略 | 避免每个 LLM 节点硬编码模型选择；参考 [models](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md) |
| P1 | Tool BM25 discovery | NodeType/Tool capability index + 按需 schema materialization | 内置节点继续增长后，不应把完整 catalogue 塞给每个 Agent；参考 [README](https://github.com/can1357/oh-my-pi#readme) |
| P1 | Async job lifecycle | 通用 JobManager + semaphore + progress snapshot + cancel owner | Runtime 已有并行控制流，但缺独立后台任务生命周期；参考 [task tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) |
| P1 | 隔离工作区 + patch merge | Node host 的 WorkspaceIsolation Adapter | 适用于能改文件的 agent 节点；portable core 只定义接口，不引入 git/worktree；参考 [task isolation](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) |
| P2 | Append-only session tree | Run fork/replay 分支使用 parent event/run refs，而不是覆盖历史 | EventStore 已 append-only，但 Run 级 fork、分支比较和 leaf 仍未建模；参考 [session tree](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md) |
| P2 | Context compaction/handoff | 长寿命 Agent 节点的 ContextMaintainer，不进入普通确定性节点 | 只对多轮 Agent/子流有价值；参考 [compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md) |

## 3. 不建议直接下沉

- TUI、快捷键、slash command、主题：属于具体宿主产品。
- oh-my-pi 的 hashline 文本协议：我们需要的是 GraphOperation 的 CAS 前置条件，不是另一套文本 patch DSL。
- Coding Agent 专用 prompt/magic keyword：应留在上层 app/skill，不污染 Runtime。
- 默认给 Advisor/子 Agent 写文件和 bash：与本项目“生产可控”目标冲突；必须经过 ToolPolicy 与显式能力授权。
- 依赖隐藏 thinking 的审阅：provider 不稳定、敏感且不可移植；我们只审阅标准事件、工具意图/结果和 Artifact。

## 4. 推荐后续顺序

1. `ToolPolicy` + 全链路 Secret Obfuscator：先补安全边界。
2. RunArtifactStore + 大事件 spill：控制事件与上下文体积。
3. output schema 强校验：让 Advisor/Agent/Subflow 的结构化合同可执行。
4. GraphOperation hash precondition：提高 AI Patch 并发安全。
5. ModelRouter + lazy catalogue discovery：降低模型和 schema 成本。
6. JobManager / WorkspaceIsolation：等持久 Scheduler 方向明确后实施。

每项都应继续遵循相同原则：核心包只定义 portable seam；Node/desktop host 提供强能力实现；
所有入口继续消费同一 Runtime API 与 EventStore。
