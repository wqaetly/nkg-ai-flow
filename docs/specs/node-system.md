# Node System

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

## 6. 节点系统

### 6.1 节点类型

建议内置以下节点类型：

| 类型 | 说明 |
|---|---|
| `start` | Flow 入口伪节点，承接 Invocation 输入并触发首批节点 |
| `end` | Flow 结束伪节点，聚合最终输出并标记 Run 完成 |
| `llm` | 模型调用节点，支持 Prompt 模板、结构化输出、流式输出 |
| `tool` | 调用内置 Tool、MCP Tool 或外部 Tool |
| `http` | 调用 HTTP API |
| `condition` | 条件判断与路由 |
| `transform` | 数据转换 |
| `code` | 受限脚本节点 |
| `subflow` | 调用另一个 Flow |
| `parallel` | 并行执行多个分支 |
| `human` | 人工确认或人工输入 |
| `memory` | 读写长期记忆 |
| `rag` | 检索增强节点 |
| `eval` | 评估节点 |


### 6.3 Node Type Registry 与 Capability Discovery

Studio、Builder、Validator 和 Runtime 不能各自硬编码节点能力。所有节点类型都应注册到统一的 Node Type Registry。

Registry 至少需要提供：

- 节点类型 ID 和版本。
- 默认端口定义。
- 配置 Schema。
- 输入 / 输出 Schema。
- 是否支持 streaming、dynamic ports、subflow、human approval。
- 所需权限、Secret scope、网络访问策略和沙箱元数据。
- 运行器来源：builtin 或 plugin；当前都通过 `defineNode` / `installNode` 装入 in-process Sandbox Adapter。
- 兼容的 Runtime 版本。

建议接口：

```ts
interface NodeTypeRegistry {
  list(): Promise<NodeTypeDefinition[]>;
  get(type: string, version?: string): Promise<NodeTypeDefinition>;
  validateConfig(type: string, version: string, config: unknown): ValidationResult;
  getCapabilities(type: string, version: string): NodeCapabilities;
}

interface NodeCapabilities {
  streaming: boolean;
  dynamicPorts: boolean;
  idempotent: boolean;
  supportsCancel: boolean;
  supportsCheckpoint: boolean;
  requiredPermissions: string[];
  requiredSecrets?: string[];
}
```

Studio 的 Node Palette、Flow Builder 的 `node(type, options)`、Graph Validator 的端口校验、Runtime 的调度和 Sandbox 的权限分配，都必须以 Node Type Registry 为权威来源。

### 6.4 TypeScript Node SDK（唯一受支持的节点声明方式）

无论是内置节点还是第三方自定义节点，**都通过 `@ai-native-flow/node-sdk`
的 `defineNode` / `defineNodeFactory` 来声明**。SDK 一次性产出
`NodeTypeDefinition`（数据轨）+ `NodeRunner`（行为轨）两份信息，避免
作者忘记注册其中任意一半。除 SDK 外，Runtime 不再对外暴露裸的
`NodeRunnerRegistry` 注册接口。

最小示例（无依赖节点）：

```ts
import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";

export const extractKeywords = defineNode({
  type: "extract-keywords",
  typeVersion: "1.0.0",
  title: "Extract Keywords",
  config: z.object({ topN: z.number().default(10) }),
  input:  z.object({ text: z.string() }),
  output: z.object({ keywords: z.array(z.string()) }),
  async run({ input, config, ctx }) {
    ctx.log.debug("running extract-keywords", { topN: config.topN });
    return {
      kind: "success",
      outputs: {
        out: null,
        keywords: input.text
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, config.topN),
      },
    };
  },
});
```

需要外部依赖（如 `LlmProvider`、数据库句柄）的节点用
`defineNodeFactory<TDeps>(deps => defineNode({...}))` 显式声明依赖面：

```ts
import { defineNode, defineNodeFactory } from "@ai-native-flow/node-sdk";

export const llmNode = defineNodeFactory<{ llmProvider: LlmProvider }>(
  ({ llmProvider }) => defineNode({
    type: "llm",
    typeVersion: "1.0.0",
    title: "LLM",
    config: z.object({ prompt: z.string(), model: z.string().optional() }),
    async run({ config, ctx }) {
      const res = await llmProvider.complete({ prompt: config.prompt }, ctx);
      return { kind: "success", outputs: { out: null, result: res.text } };
    },
  }),
);
```

注册到 Runtime 用统一入口 `createRuntime({ nodes })`，自定义节点与
内置节点的装载形式完全一致：

```ts
import { createRuntime } from "@ai-native-flow/runtime";
import { extractKeywords } from "./extract-keywords.js";

const rt = createRuntime({
  nodes: [extractKeywords],   // 自定义节点；内置节点已默认装入
  llmProvider,
});
```

> Runtime 内部用 `installNode(target, definedNode)` 同时把
> `NodeTypeDefinition` 注册进共享的 `NodeTypeRegistry`（数据轨）、
> 把 runner 注册进 `NodeRunnerRegistry`（行为轨）。
> 完整背景与"基类感"设计动机见
> [decisions/runtime-hot-swap.md](../decisions/runtime-hot-swap.md) 附录 B.4。

### 6.5 节点热更新策略

节点热更新不覆盖旧逻辑，而是发布新版本。

```text
extract-keywords@v1 -> old runs
extract-keywords@v2 -> new runs
```

新 Flow Version 引用新 Node Version。

> 完整热更分档（T0~T3）、当前实现状态、推荐操作序列、Definition+Runner 双轨设计的解释，
> 见 [decisions/runtime-hot-swap.md](../decisions/runtime-hot-swap.md) 附录 A、B。
