# Security

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

## 11. 安全模型

AI 可以参与生成 Flow，但必须严格限制执行边界。

### 11.1 权限分级

| 等级 | 能力 | 风险 | 默认生产策略 |
|---|---|---|---|
| L0 | 组合已有节点 | 低 | 允许 |
| L1 | 修改 Prompt / Config / 条件表达式 | 较低 | 允许但需校验 |
| L2 | 生成受限脚本节点 | 中 | 沙箱执行 |
| L3 | 生成完整 TS 插件 | 高 | 需要审批 |
| L4 | 修改核心 Runtime | 极高 | 禁止 |

### 11.2 沙箱限制

对于 AI 生成代码，建议至少限制：

- 文件系统访问
- 网络访问
- 环境变量访问
- 子进程创建
- CPU 时间
- 内存
- 可调用 Tool 白名单
- 最大输出大小
- 执行超时

### 11.3 Secret 与 Credential Model

Agent Harness 会频繁访问模型 Key、MCP Token、代码仓库凭据、云服务凭据和企业内部 API。Secret 必须作为一等安全对象，而不是普通环境变量。

原则：

- Secret 不进入 Flow JSON、Node Config、Run State、Trace payload 或 Studio 明文视图。
- 节点只能通过 `ctx.secrets.get(name)` 获取被授权的 Secret。
- Node Type Manifest 必须声明 `requiredSecrets` 和最小权限 scope。
- AI 生成代码默认不能访问 `process.env`，只能通过受控 Secret API。
- Event、Trace、日志和错误栈在持久化前必须做脱敏。
- Studio 只能展示 redacted value，修改 Secret 需要单独权限。
- 不同 Workspace / Project / Flow 的 Secret scope 必须隔离。

建议接口：

```ts
interface SecretProvider {
  get(name: string, scope: SecretScope): Promise<SecretValue>;
  list(scope: SecretScope): Promise<SecretMetadata[]>;
  rotate(name: string, scope: SecretScope): Promise<void>;
}

interface SecretScope {
  workspaceId: string;
  projectId?: string;
  flowId?: string;
  nodeId?: string;
}
```

### 11.4 发布前检查

发布新 Flow 或 Node 前必须执行：

- Schema Validation
- Graph Validation
- Permission Check
- Static Analysis
- Dry Run
- Regression Test
- Policy Check
- Approval Gate

---


