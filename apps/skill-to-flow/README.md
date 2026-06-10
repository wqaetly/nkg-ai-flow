# @ai-native-flow/skill-to-flow

把 CodeBuddy `SKILL.md` 转换为可直接运行的 AI Native Flow 包，由 **LLM 驱动**，不再硬编码。

## 设计

```text
SKILL.md
   ->
[1] skill_parser        rules            -> SkillDefinition
   ->
[2] skill_planner       LLM              -> ExecutionPlan      （严格 JSON Schema）
   ->
[3] node_designer       LLM × 并发        -> NodeSpec[]         （每 step 一次）
   ->
[4] code_synthesizer    LLM × 并发 + 规则 -> GeneratedFlowPackage
   ->
[5] flow_validator      rules            -> FlowArtifact       （@ai-native-flow/flow-validator）
   ->
[6] package_materializer agent           -> files + verification（edit_file / run_bash）
```

- 步骤 1 完全确定性，规则化更稳；
- 步骤 2 和 3 是设计性问题，必须调用 LLM。每次调用都用 zod schema 严格约束输出，失败时自动重试 2 次，并把上一轮错误回灌给模型自我修正，避免幻觉穿透；
- 步骤 4 的 **flow JSON 组装** 仍然规则化：使用 `flow-builder` + 注册器编程拼图，按依赖匹配端口名连边，避免让 LLM 直接写 graph JSON；
- 步骤 6 使用 runtime 内置 `agent` 节点把验证后的 `FlowArtifact.package` 物化到 `output_dir`：agent 接收 artifact 作为 `context`，同时读取 `requirements`、`isValid` / `errors` / `warnings` 作为需求与修复上下文，并优先用 `write_files` 一次性消费 `materializationPlan.files` 的结构化清单；随后在允许时用 `run_bash` 执行 `materializationPlan.verifyCommands` 中的轻量验证；若验证失败，agent 会利用命令 observation、validator 反馈和需求契约，通过 `edit_file` 做局部修复，直到达到 `maxSteps` 或给出未解决错误；
- 上下文传递有明确约定：根节点从运行时 `__runInput__` 读取原始输入；后续节点优先消费同名数据端口，尤其是累计状态对象 `context`；端口名不一致时，组装器会把上游主数据输出兜底接入下游第一个未填充数据输入；多依赖步骤的 `context` 输入会标记为 `multiple`，由运行时聚合为数组后交给节点合并；
- 所有 LLM 请求通过 runtime 的 **`LlmProvider`** 边界；生产 provider 再委托 Vercel AI SDK 的 OpenAI-compatible provider 通信，可对接 OpenAI / DeepSeek / vLLM / 私有反代。

## 配置

LLM 端点完全通过项目内置的 **变量 / 密钥模块** 装载，不依赖外部 env 文件，也不会在配置缺失时伪造默认值。调用方必须在创建 runtime 时传入 `VariableStore` / `SecretStore`，或在更外层启动器中显式安装 process-wide defaults。

```ts
await createSkillToFlowRuntime({
  variables,
  secrets,
});
```

`LLM_BASE_URL`、`LLM_DEFAULT_MODEL`、`LLM_API_KEY` 缺失时，runtime `LlmProvider` 会返回明确的配置错误；skill-to-flow 不会自己构造假的 `NodeContext`、默认模型或临时凭据。

兼容 OpenAI / DeepSeek / vLLM / 任意 OAI 协议反代。生成的下游包也使用同样的内置模块，必须由宿主 runtime 显式提供 LLM 配置，无需在生成目录里再放 dotenv 文件。

## 使用

### 构建外层 Flow JSON

```bash
cd apps/skill-to-flow
tsx build.ts
```

### 转换一个 Skill

inline 传入内容：

```bash
tsx cli.ts run skill_to_flow --input '{"skill_content":"---\nname: my-skill\ndescription: Demo skill\n---\n# 工作流\n1. 接收用户问题\n2. 调用 LLM 总结\n3. 输出"}'
```

或读取文件：

```bash
tsx cli.ts run skill_to_flow --input '{"skill_file_path":"./apps/my-skill/SKILL.md"}'
```

推荐提供 `output_dir`，让 `package_materializer` agent 自动写盘并执行轻量验证；未提供时会使用 `./generated/skill-to-flow-output` 作为默认目录：

```bash
tsx cli.ts run skill_to_flow --input '{"skill_file_path":"./apps/my-skill/SKILL.md","output_dir":"./apps/generated-my-skill"}'
```

`flow_validator` 输出端口 `artifact` 是 `FlowArtifact`，并会作为 `context` 传给 `package_materializer`。它包含：

- `isValid` / `errors[]` / `warnings[]`
- `requirements`：planner 从原始 `SKILL.md` 提炼出的目标、输入/输出契约、验收标准、约束和上下文交接策略
- `fileIssues[]`：结构化的生成包文件路径问题，包含 `kind` / `path` / `pathRef` / `contentsRef` / `message`
- `package.files[]`：所有需要写盘的 TS 源文件
- `package.flowJsonFile`：Flow JSON 内容
- `package.buildScript` / `package.runtimeScript` / `package.cliScript` / `package.packageJson` / `package.tsconfig` / `package.nodesIndex` / `package.readme`
- `materializationPlan.files[]`：agent 写盘清单，每项包含 `pathRef` / `contentsRef`
- `materializationPlan.verifyCommands[]`：建议的轻量验证命令

agent 会把 `package.*` 写到 `output_dir`，目录布局等同于普通业务 app。写盘时优先调用 `write_files` 并传入 `files_ref: "materializationPlan.files"`，避免 LLM 把源码内容重新复制到工具参数里；如果 `fileIssues` 非空，或 `warnings` 中包含 `lint.unsafe_file_path`、`lint.duplicate_file_path`、`lint.non_posix_file_path` 或 `lint.directory_file_path`，agent 应改用显式 `files` 数组选择安全且唯一的 POSIX-style 包内文件路径，同时继续用 `contentsRef` 引用原始内容；验证失败后的局部修复再使用 `edit_file.path_ref` / `edit_file.new_text_ref`。生成目录可直接执行：

```bash
tsx build.ts && npm run typecheck && tsx cli.ts run <flow_id>
```

完整 flow 的最终输出来自 `package_materializer` agent，结构为：

- `summary`：agent 的最终说明
- `context`：合并后的上下文，包含模型在物化过程中补充的信息，尤其是 `validator_status`、`verification_results` 和必要时的 `unresolved_errors`；其中 `validator_status` 应保留 `isValid` / `errors` / `warnings` / `fileIssues`，若模型 final context 漏填但输入 context 已带有这些字段，runtime agent 会自动补齐；runtime 会以本轮工具日志为准写入 `changed_files` / `written_files` / `verification_results`，不使用模型猜测值覆盖运行时事实；若最后一次同名验证命令仍失败，runtime agent 会把失败的 `verification_results` 追加到 `unresolved_errors`，避免后续节点只能从独立端口或 `tool_log` 读取物化结果
- `changed_files`：本次写入或修改的文件列表
- `tool_log`：agent 每一步工具调用及观察结果，失败的 bash 输出也会保留在这里供修复使用

`verification_results[]` 来自真实 `run_bash` 工具调用，每项包含 `step` / `command` / `ok` / `output` / `error`，可直接和 `tool_log[].step` 对齐。

如果 agent 达到 `maxSteps` 仍未产出 final，节点会返回结构化错误；错误的 `context` 也会保留同一套运行时事实字段（`changed_files` / `written_files` / `verification_results` / `unresolved_errors` / `validator_status` / `tool_log`），便于后续继续修复而不是只能重跑整条链路。

### 手动落盘备用脚本

当需要只取 `FlowArtifact` 而不让 agent 写盘时，可以手动落盘：

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function dump(pkg, targetDir) {
  const files = [
    ...pkg.files,
    pkg.nodesIndex,
    pkg.buildScript,
    pkg.runtimeScript,
    pkg.cliScript,
    pkg.packageJson,
    pkg.tsconfig,
    pkg.flowJsonFile,
    pkg.readme,
  ];
  for (const f of files) {
    const abs = path.join(targetDir, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, "utf8");
  }
}
```

## 节点合约

核心转换节点都通过 `defineNode`（`@ai-native-flow/node-sdk`）声明，端口、config、IO 类型都受 zod 约束。外层 flow 还使用 runtime 内置 `transform` / `text_input` / `agent` 节点完成 `output_dir` 解析、任务提示和文件物化。任意 LLM 输出失败、graph 不合法或 agent 工具失败都会以结构化 `{ kind: "error", error }` 返回，方便 Studio / CLI 显示。

## 与旧版差异

| 维度 | 旧版 | 新版 |
|---|---|---|
| YAML 解析 | 自写 200+ 行 | `yaml` 库 |
| 骨架推导 | 关键词正则 -> 7 类硬编码 | LLM 规划，严格 JSON Schema |
| 节点细化 | switch/case 写死 config/ports | LLM 并发设计每个 step |
| 代码生成 | 模板拼字符串、`run()` 全是 TODO | LLM 合成可编译 TS，带 LLM helper |
| Flow 校验 | `source.includes("defineNode")` | `validateGraph` 真校验 |
| LLM 接入 | 无 | runtime `LlmProvider`，生产实现走 Vercel AI SDK 的 OpenAI-compatible provider |

## 开发

```bash
npm install                          # 安装 yaml 等依赖
tsx build.ts                         # 重建外层 Flow JSON
tsx cli.ts inspect <runId>           # 查看 run 详情
tsx cli.ts replay  <runId>           # 重放
```
