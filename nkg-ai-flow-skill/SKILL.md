---
name: nkg-ai-flow-skill
description: 指导 AI Agent 在本仓库设计、实现、验证、文档化自定义 AI Native Flow 应用。新建或修改 flow、新增自定义节点、连接 FlowBuilder 图、跨节点保留 context、编写 anf.app.json、把工作流需求落成 apps/* 下可运行包时使用。
---

# 自定义 Flow 开发规范

## 硬规矩

把 flow 当作可运行的 app,不是孤立的 JSON。下面这些做不到就别合：

- 用 TypeScript `FlowBuilder` 写图,JSON 只作为生成产物。
- 优先组合内置节点;只有真的需要复用领域逻辑、严格 schema 校验、复杂解析时才写自定义节点。
- 数据血缘必须显式:每个非根节点都要消费上游输出、累计 `context`、或显式静态配置,绝不依赖"前一个节点大概干了什么"。
- 文件读写、命令执行、迭代验证、产物落盘走内置 `agent` 节点,确定性节点不要伪装能干这些。
- **严禁造假/fallback 调用第三方依赖**:LLM、联网搜索、HTTP/工具调用、向量库、外部服务等节点,**任何环境**(开发、调试、smoke、单元测试、CI、生产)都必须走真实调用。失败就硬失败,不准 mock、stub、写死返回值、catch 后返回伪造数据。
- **环境变量读取必须走 `VariableStore` / `SecretStore`**:任何节点、runner、smoke、CLI 都禁止直接读 `process.env`、禁止自己 `dotenv.config()`、禁止在 app/scripts 目录新建 `.env*` 文件冒充配置源。
- 配置走 flow 同目录的伴生 JSON,不依赖 `.env.local`。
- 控制边表达顺序,数据边表达依赖,两者分开。
- 验收用最窄的 build / typecheck / 针对性 smoke,集成 smoke 留到最后。

## 起步参考

写代码前先看最近的本地范例,凡是已有 app 干过类似的事,扩展它的模式而不是另起炉灶：

| 需求 | 参考 |
|---|---|
| 纯内置节点 flow + build runner | `apps/hello-agent/helloagent.flow.ts` + `build.ts` |
| 自定义节点流水线 + 节点示例 | `apps/skill-to-flow/build.ts` + `apps/skill-to-flow/nodes/*.ts` |
| FlowBuilder 契约 | `docs/specs/flow-builder.md` |
| 图 schema | `docs/specs/flow-graph-schema.md` |
| 工作区/应用发现 | `docs/specs/workspace-model.md` 与现有 `anf.app.json` |

## 设计流程

**1. 写下 flow 合同**(注释或 README,关键是源文件可见):`flow_id` / `purpose` / `caller_input` / `final_output` / `must_use_tools_or_services` / `must_not_do` / `acceptance_checks`。

**2. 选 app 形态**：

| 场景 | 形态 |
|---|---|
| 单提示、转换、HTTP/工具调用、简单 agent 任务 | 纯内置节点 flow |
| 复用领域行为、严格输入输出校验、非平凡解析 | 自定义节点 flow |
| 生成文件、修代码、跑 shell、验证产物 | 含 `agent` 物化的 flow |
| 把高层 skill/工作流转成可运行包 | Planner → Designer → Synthesizer → Validator → Materializer 流水线 |

不要为普通的 prompt 模板或简单字符串/对象 reshape 写自定义节点,用 `llm` / `text_input` / `transform`。

**3. 列节点和边**(实现前用 `step_id | node_type | purpose | inputs | outputs | upstream_dependencies | validation` 表格表达)。规则：

- 根节点从 `start.runInput` 或第一个显式输入节点读取运行时输入。
- 顺序工作走控制边 `out -> in`,数据依赖走数据边 `some_output -> some_input`。
- 下游节点没有数据边可疑(除非只消费静态配置)。
- 多源推理用累计 `context` 或显式 merge / transform 节点收敛。
- ID 用稳定的 lower_snake_case 或 lower-kebab-case,不要用数组下标拼出来的 ID。

## 内置节点速查

写自定义节点前先确认这里没有合适的：

| 节点 | 用途 | 端口/配置要点 |
|---|---|---|
| `start` | flow 入口 | 输出 `out`;builder 中按需添加 `runInput` 数据输出端口 |
| `end` | 显式终点 | 输入 `in` |
| `text_input` | 静态任务/提示文本 | 输出 `text`,控制 `out` |
| `transform` | 静态值或模板映射 | 输入 `input`,输出 `output`,配置 `template`/`expression`/`value` |
| `llm` | 单次模型补全 | 接线时输入 `prompt`,输出 `result`,配置 model/baseUrl/apiKey/prompt |
| `agent` | 文件、grep、edit、write_files、bash 工具循环 | 输入 `task` / `context` / `working_dir`;输出 `summary` / `context` / `changed_files` / `tool_log` |
| `condition` | 分支 | 仅当分支语义和下游边都明确时才用 |
| `http` / `tool` | 外部确定性调用 | 调用契约已知时优先用 |

LLM/agent 配置复用 `@ai-native-flow/runtime` 的运行时默认值:`DEFAULT_LLM_BASE_URL_REF`、`DEFAULT_LLM_API_KEY_REF`、`DEFAULT_LLM_MODEL_REF`、`DEFAULT_LLM_TEMPERATURE`、`DEFAULT_LLM_MAX_TOKENS`。

## App 骨架与 manifest

自定义 flow 都放在 `apps/<app-name>/`,标准结构:`anf.app.json` + `package.json` + `tsconfig.json` + `build.ts`,需要时再加 `runtime.ts` / `cli.ts` / `flows/` / `nodes/index.ts`。纯内置 flow 可参考 `apps/hello-agent`,只用 `<name>.flow.ts` + `build.ts`。

`anf.app.json` 必须对得上真实路径:`{ "name": "...", "flowDirs": ["flows"], "nodePacks": ["nodes/index.ts"] }`。没有自定义 node pack 别写 `nodePacks`;`flowDirs` 不要指向 build 不写入的目录。

## Builder 与自定义节点

完整可运行示例直接读 `apps/skill-to-flow/build.ts` 与 `apps/skill-to-flow/nodes/*.ts`,这里只列要点：

- 用 `defineFlow({ id, version, label, description, inputSchema, outputSchema, registry })` 起一个 flow。
- registry 通过 `createDefaultRegistry()` + `getBuiltinNodeDefinitions()` + `installNode(...)` 拼装,内置节点先注册,自定义节点后注册。
- `start` 节点要数据输出时用 `start.addPort({ id: "runInput", direction: "output", kind: "data", schema })`。
- 边用 `flow.connect(upstream.out("port"), downstream.in("port"))`,控制边和数据边分开连。
- 调试用 `flow.validate()` 看错误;落盘用 `flow.dump()`(对非法图抛错,作为最终闸门)。
- 自定义节点用 `defineNode({ type, typeVersion, title, description, config, input, ports, async run() })`,`config` 和 `input` 都用 zod schema 显式声明。
- 节点的成功结果是 `{ kind: "success", outputs: { ... } }`;错误结果是 `{ kind: "error", error: { code, message, kind, category } }`,category 限定在 `user_input` / `author` / `external` / `validation`。

## 上下文契约

`context` 是契约,不是垃圾桶。推荐字段:`requirements` / `input` / `plan` / `artifacts` / `validation: { ok, errors[], warnings[] }` / `unresolved_errors[]`。

规则：

- 原始用户/调用方输入要能一路触达 final report 节点,不允许中途被某个节点替换覆盖。
- 节点细化信息时应 merge 进 context,不要整体替换。
- 校验输出固定字段名(如 `validation` 或 `validator_status`)。
- 大型生成产物以 file ref / 列表传递,不要把长源文本塞进 prompt。
- 多个上游对象需要被同一下游消费时,要么把 `context` 输入声明为 `multiple`,要么加显式 merge/transform 节点。
- 文件生成 flow 在 context 保留 `package.files[]` / `package.{buildScript,runtimeScript,cliScript,packageJson,tsconfig,nodesIndex,flowJsonFile}` / `materializationPlan.files[]` / `materializationPlan.verifyCommands[]`。

## Agent 物化

需要工具的操作走 `agent` 节点,典型用一个 `text_input` 节点把任务说明喂给 `agent.task`,`agent.context` 接上游 context,`agent.in` 接 `text_input.out`。完整接线参考 `apps/skill-to-flow` 里的 materializer 节点。配置原则：

- `workingDir` 取最窄的有用路径;不需要命令验证就别开 `allowBash`;`allowedTools` 限制到任务真正需要的几样。
- LLM 后端用 `DEFAULT_LLM_*_REF` 系列引用,不硬编码 key/URL/model。
- 传结构化 context,不要逼模型从散文里重建文件名/命令列表。
- `changed_files` / `written_files` / `verification_results` / `tool_log` 这些字段必须来自工具日志,不要让模型猜。

## LLM 节点

LLM 单步用内置 `llm` 节点。只有需要 schema 解析、重试、领域校验、provider 级逻辑时才包成自定义节点。LLM 密集型 flow 的几条惯例：

- 确定性解析放 LLM 步骤之前。
- 自定义 LLM 节点用严格 JSON schema,让下游能拿到结构化数据。
- 上次校验错误回灌进下一次 prompt。
- 输出端口名匹配语义对象,如 `plan` / `node_specs` / `package` / `report`。
- 修复/校验敏感步骤用 `temperature: 0` 或项目默认。
- 校验尽量先于物化;物化写完文件后仍要跑命令验证。

## 配置与凭据

flow 运行配置是 flow-scoped 且与 artifact 同目录的：

- 对 `src/agent-flow/hex-advisor.flow.json`,使用伴生文件:`*.flow.env.json`(可提交的默认值或非敏感占位)和 `*.flow.local.env.json`(本机真实密钥,**必须** gitignore)。
- Builder 和 Flow JSON 用 `$var.NAME` / `$secret.NAME` 引用,不硬编码 key/URL/model。
- 运行时入口、smoke、CLI 通过 `createFlowScopedStores({ flowPath })` 读伴生文件,再调 `bootstrapDefaults({ variables, secrets, variableNames, secretNames })`。
- `.env.example` 仅作文档,不是运行时输入源。
- 缺失值、占位值、伴生 JSON 非法都必须硬失败。**禁止** mock provider、空字符串默认、`.env.local` 兜底、test-only bypass。

### 严禁绕开项目环境变量模块

读配置和密钥**必须**走 `VariableStore` / `SecretStore`(节点里 `ctx.secrets.read("LLM_API_KEY")` / `ctx.variables.read("LLM_BASE_URL")`),**禁止**任何节点、runner、smoke、CLI 自己造一套进程级 env 读取。下面这些做法全是违规,无论是不是"只在测试里用一下":

- ❌ 直接读 `process.env.LLM_API_KEY` / `process.env.SEARXNG_URL`(节点代码、policy、runner、smoke 全部禁止)。
- ❌ 自己引入 `dotenv` / `dotenv-flow` / `cross-env`,在节点或 runner 里 `dotenv.config()`。
- ❌ 在 app / scripts / 节点目录里新建 `.env` / `.env.local` / `.env.dev` 当配置源(凭据请放 `*.flow.local.env.json`)。
- ❌ 在 builder/runner 写 `process.env.X ?? defaultValue`、`process.env.X || "fallback"`——绕过 `SecretStore` 脱敏与 trace,会让密钥泄漏进 Flow JSON / Run Event。
- ❌ 测试里用 `NODE_ENV === "test" ? mockKey : realKey` 这种分支选凭据。

进程环境变量只能作为启动期的输入源喂给 `bootstrapDefaults`,进入运行时后所有读取一律通过 `VariableStore` / `SecretStore`。开发、smoke、CI、生产全都一样。`SecretStore` 自动脱敏,绕过它泄漏只是时间问题;`VariableStore` 可枚举可 trace,`process.env` 是黑盒。

## 严禁伪造第三方调用

> AI agent 在调试或写测试时,经常想"先 mock 掉 LLM/联网搜索/HTTP 调用,把链路跑通再说"。**在本项目里,这是被严令禁止的行为。**

适用范围:LLM(`llm` / 自定义 LLM runner / agent 节点的 LLM 后端)、联网搜索(SearXNG / Web Search / 爬虫)、HTTP / `tool` 节点、向量库 / RAG 检索(Orama / MemOS / Pinecone / Milvus)、远程 SDK IO(MCP / Anthropic / OpenAI / LangChain providers)。

下面任何一种出现在 PR 里都算违规,review 直接拒：

- **写死返回值**:`if (NODE_ENV === "test") return { items: [...] }`、runner 里硬编码示例输出。
- **自定义 mock provider**:写一个"假 LLM"或"假搜索",在某个 flag 下被加载替换真节点。
- **try/catch 吞异常返回兜底**:`catch (e) { return { ok: true, items: [] } }` 这类伪造成功路径。
- **测试用 dummy key**:用 `sk-test-xxx`、`localhost:1234` 之类绕过真实凭据校验。
- **跳过节点的 if**:`if (!apiKey) return stub` 让 flow 在缺凭据时"看起来跑通了"。
- **smoke / eval 里 import mock**:不允许在 `scripts/agent/*-smoke.{mjs,ts}` 里用 vi.mock / jest.mock 替换真节点。
- **示例数据冒充真实结果**:在 runner 里 hardcode 一段示例 JSON 当作 LLM 响应供下游消费。

失败一律硬失败:LLM 调不通(网络、超时、429、key 失效)→ throw;搜索零结果或 5xx → throw;向量库连不上 → throw;缺凭据 → 启动期就失败,不允许"运行时检测到 key 缺失再降级"。

为什么非协商:fallback 路径会偷偷成为生产路径——一旦代码里有"key 缺失就返回空"这种分支,某次部署忘配 key、CI 环境变量没传过去,生产就在跑伪造分支,而所有监控都看不出来(因为它"成功"返回了)。这是 hex-advisor 反复修过的事故根因。

唯一允许的"省钱模式":缩 prompt / 减候选数 / 降 max_tokens / 换便宜模型 / 用自部署 SearXNG——**节点行为不变,只是成本降低**。离线 eval(`data/evals/**/*.jsonl`)只评估确定性 policy 的输出,跨过 LLM 边界就必须真调。

例外只允许故障注入测试(测 retry 逻辑本身、错误处理代码路径):mock 文件命名要一眼看出是故障注入(如 `*-fault-injection.test.mjs`),不能进 `verify` / `verify:integration` / `eval:*` 任何 gate,文件首行注释明确"仅用于测试 X 行为,绝不在生产/集成 smoke 中加载"。未走这套流程引入的 mock 一律拒。

## 验证与排错

跑能证明改动行为的最窄命令:新建/改动 app 用 `npx tsx apps/<app-name>/build.ts` + `npm run typecheck`(在 app 目录内则 `tsx build.ts` + `npm run typecheck --if-present`);改了共享包跑目标 Vitest + `npm run typecheck`;改了本 skill 跑 `python C:\Users\developli\.codex\skills\.system\skill-creator\scripts\quick_validate.py nkg-ai-flow-skill`。校验失败时改 builder 源、节点定义、端口、registry,不要直接 patch 生成的 JSON。

常见故障：

| 现象 | 根因 | 修法 |
|---|---|---|
| `unknown node type` | 自定义节点没装进 registry,或 `nodePacks` 配错 | 注册内置 + 自定义节点;改 `anf.app.json` |
| `unknown port` | builder 连了未声明的端口 | 检查节点定义,加自定义端口或改对端口名 |
| 端口 kind 不匹配 | 数据边接到控制边或反过来 | 拆成独立的控制边和数据边 |
| 下游节点输入为空 | 缺数据边 | 补上 upstream→downstream 的数据边 |
| Agent 不干活 | task 模糊或 context 全是散文 | 传结构化 `task` / `context` / `working_dir` |
| JSON artifact 非法 | 直接编辑 JSON 或 build 产物过期 | 改 builder 源重新生成 |
| Studio 找不到 flow | manifest 和 build 输出目录不一致 | 对齐 `anf.app.json.flowDirs` 和 build 输出 |

## Flow 自审(五子系统)

> 骨架借鉴 [walkinglabs/learn-harness-engineering · skills/harness-creator](https://github.com/walkinglabs/learn-harness-engineering/tree/main/skills/harness-creator) 的 Instructions / State / Verification / Boundaries / Handoff 模型,题目全部重写为 flow-specific。每条都应能在 PR diff 或节点代码里被 grep / lint 验证。

提交前对照打勾,任何一条不通过都视作 flow 设计未完成。

**Instructions(自我说明)**
- [ ] flow 在 `defineFlow(...)` 的 `description` / 顶部注释里写清:目的、调用者、输入/输出契约、必用工具、禁止行为、验收项。
- [ ] flow 合同(`flow_id` / `purpose` / `caller_input` / `final_output` / `acceptance_checks`)在 builder 源文件可一眼读到。
- [ ] 看到 flow JSON 的下游(Studio、HTTP runner、调用方)能从 `inputSchema` / `outputSchema` 推断怎么调用,无需读业务代码。

**State(节点间状态流动)**
- [ ] `context` 有稳定 schema(zod 或 TS interface),不是 `Record<string, unknown>` 漫游。
- [ ] 原始输入能从 `start` 一路到 final report,不被中途节点覆盖。
- [ ] 多源汇入要么有显式 merge/transform 节点,要么 `context` 输入声明 `multiple`,无隐式依赖。
- [ ] 数据依赖走 data edge,不靠控制边顺序碰巧让数据先到位。
- [ ] 大型产物以 file ref / 列表传递,不复制原文进 prompt。

**Verification(成败如何识别)**
- [ ] 每个 LLM 节点有 acceptance check:schema 校验 / 字段非空 / 输出在候选集内 / 调用方期望字段齐全。
- [ ] formal 路径关键节点失败必须 throw,不返回兜底假内容;装饰性节点可 self-skip 但要在 context 记录 `skipped_reason`。
- [ ] LLM 失败有重试 + 错误回灌,不是无脑 retry。
- [ ] **没有任何 mock / stub / 写死返回值替换 LLM、搜索、HTTP、向量库**;smoke / eval / CI 全部走真实调用。
- [ ] **配置/密钥读取都走 `VariableStore` / `SecretStore`**;PR diff 里 grep `process.env` / `dotenv` / `\.env\.local` 必须只命中 `bootstrapDefaults` 入口和 `.gitignore`。
- [ ] 验收命令可在 5 分钟内本机跑完,不存在"只能在生产灰度看效果"的节点。
- [ ] 部署侧产物 vs 本地构建产物的边界明确(进 git / 手动 SCP / 服务器禁跑)。

**Boundaries(节点拆分)**
- [ ] 每个自定义节点单一职责,无"既检索又评分又渲染"的胖节点。
- [ ] 确定性逻辑(候选生成、过滤、打分、prompt 拼装)和 LLM 调用分文件:`*-policy.{ts,mjs}` 纯函数无 LLM,`*-runner.{ts,mjs}` 编排 LLM + 重试 + 解析。
- [ ] 节点 `input` / `config` 用 zod schema,不裸 `z.unknown()` 兜底。
- [ ] 节点代码、policy、prompt 模板里没有硬编码业务实体名(英雄/技能/SKU/客户)的 if/switch。
- [ ] LLM 是判官 + 写手,不是推荐引擎。

**Handoff(交付)**
- [ ] 最终输出节点消费结构化 context,不是把中间产物拼成 prose。
- [ ] 文件生成类 flow 在 context 保留 `package.files[]` / `materializationPlan.files[]` / `verifyCommands[]`,materialize agent 只负责落盘和验证。
- [ ] flow 运行后的 trace / event / log 足以让另一个 coding agent 在新会话续接:`flow_id` + `runId` + 末态 `context` 三者就能复原"干到哪了、还差什么"。

## Flow 质量模式

从真实业务 flow(hex-advisor)和反复 review 沉淀的复用规则,补充自审清单的"为什么"。

**LLM 是判官,不是推荐引擎**:候选由确定性 policy 产出,LLM 只在候选集内打分/筛选/改写。prompt 里出现"推荐 N 个 X"而下游没候选集约束 → 在制造幻觉项,把它拆成"候选生成(确定性)+ 候选打分(LLM)+ 答案撰写(LLM)"。

**formal 路径硬失败,装饰路径自跳过**:判别方法是"砍掉这个节点 final answer 还能不能交付"。能 → 装饰,允许 self-skip 并记录原因;不能 → formal,失败必须 throw,绝不返回 stub。

**两阶段判官必须证明自己值钱**:再确认型节点(post-evidence judge / critic / verifier)要有审计——多大比例的运行下真改了上游结论?长期 < 5% 就该去掉,或改成"仅当上游置信度低/证据冲突时才启动"。

**Re-rank 节点不创造候选**:review/re-rank 只能从给定候选选/排,不能发明新条目。上游 `items` 为空时 review 应 inactive 跳过。input schema 限制为 `candidates: NonEmptyArray<Candidate>` + 上游列表 enum 约束;校验失败就 self-skip,不进 LLM。

**业务实体名只能在数据文件**:英雄、技能、SKU、客户这类名字只允许出现在 `data/**`、`*.json`、`*.csv`。代码里看到 `if (champion === "暗裔剑魔")` 一律改成数据驱动:数据文件里给该实体加 trait,policy 读 trait。verify gate 用 grep + allowlist lint 强制。

**宽 fan-in 是异味**:节点 input 边超过 6 条通常意味着缺 reduce / context-merge 抽象。在 fan-in 节点前插显式 merge/transform 收敛成单 bundle,下游回到 1~2 条边。v2 的 linear spine 是这条规则的极端版。

**改 context 字段是 breaking change**:改某字段的语义/类型/位置等同于改 API,所有 reader 节点同步改。新增字段兼容,删除/重命名/改类型不兼容。要改先在所有 reader 完成迁移再删旧字段,不留"两个字段同时存在"的中间态超过一个 PR。

**最窄层先验证**:改 policy 打分公式 → 跑该 policy 的单元/离线 eval。改 runner prompt → 跑该 runner 的 smoke。集成 smoke 留最后(贵 + 慢)。集成 smoke 没挂只能证明"没炸",不能证明"做对了"。
