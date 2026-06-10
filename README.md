<p align="center">
  <img src="./docs/assets/readme-cover.png" alt="NKG AI Flow cover" width="100%" />
</p>

<h1 align="center">NKG AI Flow</h1>

<p align="center">
  <a href="https://www.lfzxb.top/aigc-ai-native-flow/">技术博客：AI Native Flow</a>
</p>

> 面向 AI Agent 的可热更新 **Flow Runtime / Agent Harness**：让 AI 通过 `Flow Builder` 或
> `Graph Operation` 生成、修改、调试和热更新可控的 Agent Flow。

本文档作为项目入口，只覆盖 **项目目标 / 主要功能 / 安装与运行指引**；详细架构、规格和决策请看
[ARCHITECTURE.md](./ARCHITECTURE.md) 和 [docs/](./docs)。

---

## 一、项目目标

在保证 **生产可控** 的前提下，让 AI 安全地参与 Agent 工作流的构建与演进。核心要解决：

- **Flow 与节点逻辑可热更新**：版本化 Artifact + Registry 原子 Promote + Run Version Pinning，旧 Run 用旧 Artifact，新 Run 用新 Artifact，不依赖 runtime HMR。
- **多入口调用归一**：同一份 Flow 可通过 **HTTP / CLI / MCP / SDK / Studio** 调用，全部消费同一条 Runtime Event Bus。
- **稳定流式输出**：AI SDK / IDE SDK / 外部 CLI / sidecar 的输出统一归一为 `NodeEvent` 事件流，不用 `stdout` / `stderr` 承载语义 token。
- **AI 安全参与开发**：AI 可生成 Builder 逻辑、Graph Operation 或受限节点代码，但不能直接修改核心 Runtime；执行通过 Sandbox Adapter 受控。
- **配置与凭据双轨**：`VariableStore` 可枚举、可进入 Trace；`SecretStore` 自动脱敏，永不写入 Flow JSON / Run Event。
- **可视化协作编辑**：Studio 不只是浏览器，还支持拖拽、增删节点和多端口连边，编辑动作以 `GraphOperation` 记录。

---

## 二、主要功能

项目核心能力包括：

- **Flow 建模与校验**：提供 Flow IR、Schema、Validator 和类型化 Builder，保证 AI 生成或修改的图结构可验证、可落盘、可复现。
- **Runtime 执行与热更新**：通过 Run Manager、Scheduler、Registry 和 Event Bus 执行 Flow，支持版本化 Artifact、运行中版本固定和新版本 promote。
- **节点扩展机制**：业务节点通过 `defineNode` / `defineNodeFactory` 声明，node pack 可随 app 注册动态加载。
- **多入口调用**：同一份 Flow 可通过 HTTP / CLI / MCP / SDK / Studio 调用，并共享 Runtime API 与事件流。
- **配置与凭据管理**：内置 `VariableStore` / `SecretStore`，支持 `$var` / `$secret` 引用、敏感信息脱敏和运行级覆盖。
- **Studio 可视化编辑**：提供 React + React Flow 编辑器，用于浏览、编辑、调试和观察 Flow 运行事件。
- **app 注册**：本项目自带 apps 自动发现；宿主项目可通过根 `anf.apps.json` 注册宿主自己的 apps。

各 Phase 的交付状态见 [ARCHITECTURE.md 第 7 节](./ARCHITECTURE.md#7-推荐实现路线)。

---

## 三、技术栈

- **Language / Module**：TypeScript + ESM
- **Package manager**：npm workspaces（`packages/*` / `packages/transports/*` / `apps/*`）
- **Schema**：Zod
- **HTTP**：Web Fetch `(Request) => Response` handler + SSE
- **Studio**：React 19 + React Flow + Vite
- **Test**：Vitest
- **存储 MVP**：SQLite + 本地文件系统
- **Runtime**：Node-compatible TypeScript，不绑定 runtime-only API

---

## 四、环境要求

- Node.js `>=20.11.0`（见 `package.json` 的 `engines`）
- npm（使用 workspaces，无需额外安装 pnpm / yarn）

---

## 五、安装与推荐集成方式

### 5.1 直接开发本项目

直接修改 Runtime、Studio 或本项目自带 apps 时，在本仓库内安装依赖：

```bash
npm install
```

### 5.2 宿主项目推荐作为 submodule 使用

外部业务项目推荐把本项目作为 Git submodule 放在宿主仓库根目录，例如 `nkg-ai-flow/`：

```bash
git submodule add https://github.com/wqaetly/nkg-ai-flow nkg-ai-flow
git submodule update --init --recursive
```

宿主项目通过 `file:` 依赖引用需要的包，只引入实际用到的模块：

```json
{
  "dependencies": {
    "@ai-native-flow/builder-runner": "file:nkg-ai-flow/packages/builder-runner",
    "@ai-native-flow/flow-builder": "file:nkg-ai-flow/packages/flow-builder",
    "@ai-native-flow/runtime": "file:nkg-ai-flow/packages/runtime",
    "@ai-native-flow/node-sdk": "file:nkg-ai-flow/packages/node-sdk",
    "@ai-native-flow/variable-store": "file:nkg-ai-flow/packages/variable-store"
  }
}
```

然后在宿主项目根目录执行：

```bash
npm install
```

这种方式适合业务项目保持自己的源码、脚本、数据和部署结构，同时复用本项目的 Flow Builder、Runtime、节点注册与配置模块。

---

## 六、配置（内置环境变量模块）

项目使用内置环境变量模块管理运行时配置，不把 `.env` / `.env.local` 作为运行期配置模型：

- `VariableStore` 管理普通变量，可枚举、可追踪；
- `SecretStore` 管理敏感凭据，自动脱敏，不写入 Flow JSON / Run Event / Trace；
- 各 app / test 通过 `bootstrapDefaults(...)` 声明允许注入的变量与密钥名；
- Flow / node config 通过 `$var` / `$secret` 引用运行时变量，而不是直接读取外部 env 文件。

进程环境变量只作为启动时输入源；进入运行时后，变量读取都通过 `VariableStore` / `SecretStore` 完成。`secretNames` 中列出的条目会被路由到 `SecretStore`，不会回流到 `VariableStore`。

---

## 七、运行示例

### 7.1 Hello Agent

构建一个最小 `text_input -> agent` Flow，用于展示 agent 对自然语言任务的意图理解，以及通过文件工具完成桌面文件写入的链路：

```bash
npm run app:helloagent
```

对应入口为 [`apps/hello-agent/build.ts`](./apps/hello-agent/build.ts)，同目录的 `invoke.ts` 可运行一个自包含的 agent 文件写入示例。

### 7.2 Studio Browser

同时启动后端 sidecar（HTTP transport）和前端 Vite dev server：

```bash
npm run studio:dev
```

- 前端：<http://127.0.0.1:3000>
- 后端：<http://127.0.0.1:8787>

也可以分开启动：

```bash
npm run studio:dev:backend
npm run studio:dev:frontend
```

### 7.3 通用 HTTP 服务

仓库内只需一条命令即可启动面向多 Flow 的通用 HTTP 服务：

```bash
npx tsx packages/transports/http-runner/src/bin.ts
```

`http-runner` 启动时会：

1. 自动扫描本项目自带的 `apps/*/anf.app.json`；
2. 如果从 CWD 向上找到宿主 `anf.apps.json`，再读取其中的宿主 `apps[]`；
3. 合并两类 app 来源并去重；
4. 对每个已注册 app 读取 `anf.app.json`；
5. 动态 `import()` 每个 node pack，并装入 Runtime 的 `NodeTypeRegistry`；
6. 递归扫描每个 flow root 下的 `*.json`，按 graph 自身的 `flow.id` 注册并 promote 到 `runtime.registry`；
7. 如果不同 graph 出现重复 `flow.id`，启动时报错并退出。

启动成功后会打印已注册的 flow，示例：

```text
AI Native Flow HTTP runner listening on http://127.0.0.1:8787
Registered flows:
- skill_to_flow (/flows/skill_to_flow/invoke)
```

服务端暴露的主要端点：

| 端点 | 用途 |
|---|---|
| `GET /` | 列出 manifest 中所有已注册 Flow 与端点 |
| `POST /flows/:flowId/invoke` | 同步执行，返回 `{ runId, status, output }` |
| `GET /flows/:flowId/stream` | SSE 流式执行 |
| `POST /flows/:flowId/nodes/:nodeId/invoke` | 子图同步执行 |
| `GET /runs/:runId` | 查询 RunRecord |
| `GET /runs/:runId/events` | 查询 NodeEvent 列表，支持 `cursor=` / `limit=` |
| `GET /runs/:runId/replay` | SSE 回放历史事件 |
| `POST /runs/:runId/cancel` | 取消 Run |

最简单的同步调用：

```bash
curl -s http://127.0.0.1:8787/flows/skill_to_flow/invoke \
  -H "content-type: application/json" \
  -d '{"input":{"skill_content":"---\nname: demo\ndescription: Demo skill\n---\n# 工作流\n1. 接收输入\n2. 输出结果"}}'
```

带 `nodeOverrides` 透传节点 config（等价于 Langflow `tweaks`，仅本次调用生效）：

```bash
curl -s http://127.0.0.1:8787/flows/skill_to_flow/invoke \
  -H "content-type: application/json" \
  -d '{
    "input": {"skill_content": "---\nname: demo\ndescription: Demo skill\n---\n# 工作流\n1. 接收输入\n2. 输出结果"},
    "nodeOverrides": {
      "skill_planner": { "config": { "model": "gpt-4o-mini" } }
    }
  }'
```

订阅 SSE 实时事件：

```bash
curl -N "http://127.0.0.1:8787/flows/skill_to_flow/stream?input=%7B%7D"
```

查询历史 Run 与事件：

```bash
curl -s http://127.0.0.1:8787/runs/<runId>
curl -s http://127.0.0.1:8787/runs/<runId>/events
```

如果要在宿主项目中使用自己的 Flow，需要通过宿主 `anf.apps.json` 注册 app。详细规则见后文“使用方式注意事项”。

---

## 八、常用开发命令

| 命令 | 说明 |
|---|---|
| `npm install` | 安装所有 workspace 依赖 |
| `npm run build` | 构建全部 workspace（`--if-present`） |
| `npm test` | 运行 Vitest 单元 / 集成测试 |
| `npm run typecheck` | 全仓 `tsc --noEmit` 类型检查 |
| `npm run app:helloagent` | 运行 Hello Agent app |
| `npx tsx packages/transports/http-runner/src/bin.ts` | 启动通用 HTTP 服务 |

---

## 九、仓库结构导航

```text
.
├── ARCHITECTURE.md          # 架构总览与文档入口
├── README.md                # 本文档
├── apps/*/anf.app.json      # app-local 清单：声明本 app 的 flowDirs[] 与 nodePacks[]
├── packages/
│   ├── flow-ir/             # Flow 图模型与 Schema
│   ├── runtime/             # Runtime 核心
│   ├── transport-http/      # HTTP handler 与 SSE
│   └── studio/              # React + React Flow 编辑器库
├── apps/
│   ├── studio/              # Vite 前端 + Node sidecar
│   ├── skill-to-flow/       # Skill 到 Flow 的生成应用
│   └── hello-agent/         # text_input -> agent 最小 app
└── docs/
    ├── specs/               # 规格文档
    ├── decisions/           # 架构决策记录
    └── implementation/      # 实现指南与 Roadmap
```

---

## 十、文档导航

- [ARCHITECTURE.md](./ARCHITECTURE.md)：项目目标、核心原则、总体架构、模块边界
- [docs/implementation/ai-implementation-guide.md](./docs/implementation/ai-implementation-guide.md)：默认技术栈、实现顺序、AI 禁止事项
- [docs/implementation/roadmap.md](./docs/implementation/roadmap.md)：Phase 0+ 的目标与 Definition of Done
- [docs/specs/](./docs/specs)：Flow Schema / Runtime / Streaming / Studio / Sandbox / Variable & Secret 等规格
- [docs/decisions/](./docs/decisions)：Hot Swap / Event Channel / Node-first / Schema Versioning 等 ADR

---

## 十一、发布状态

Private（`package.json` 中 `"private": true`），暂未对外发布。

---

## 十二、推荐使用方式与 app 注册

### 12.1 推荐：宿主项目通过 submodule 集成

业务项目推荐参考 `kesmj` 的集成方式：

```text
host-project/
├── nkg-ai-flow/              # git submodule
├── package.json              # file:nkg-ai-flow/packages/... 依赖
├── anf.apps.json             # 注册宿主 app
├── apps/<host-app>/anf.app.json
└── src/<flow-or-nodes>/
```

宿主根目录只用 `anf.apps.json` 注册宿主自己的 app：

```json
{
  "apps": [
    "apps/host-flow"
  ]
}
```

每个宿主 app 再提供自己的 `anf.app.json`，声明 Flow JSON / Builder 产物目录和节点包：

```json
{
  "name": "host-flow",
  "flowDirs": [
    "../../src/agent-flow"
  ],
  "nodePacks": [
    "../../src/agent-flow/nodes/index.ts"
  ]
}
```

注意事项：

- `nkg-ai-flow/` 只作为 runtime/tooling submodule，不要在宿主 `anf.apps.json` 里声明 submodule 路径；
- 宿主 `apps[]` 路径相对宿主 `anf.apps.json` 所在目录解析；
- app 内 `flowDirs[]` 和 `nodePacks[]` 路径相对该 app 的 `anf.app.json` 所在目录解析；
- 从宿主项目目录或其子目录启动 runner / sidecar，确保 loader 能向上找到宿主 `anf.apps.json`；
- loader 会按规范化绝对路径去重；没有 `anf.app.json` 的目录不会注册。

宿主项目如果使用 Builder 生成 Flow artifact，可在自己的脚本里调用 `@ai-native-flow/builder-runner`，把产物写到宿主自己的 `artifacts/flows` 或源码目录；本项目不要求宿主把业务 Flow 放进 submodule。

### 12.2 直接使用本项目

直接在本仓库启动 Studio 或 HTTP runner 时，不需要根 `anf.apps.json`。loader 会自动扫描本项目自带的 `apps/*/anf.app.json`，有 `anf.app.json` 的 app 才参与注册。

新增本项目内置 app 时，把 app 放到 `apps/<app>/` 下，并在该目录提供 `anf.app.json`：

```json
{
  "name": "my-app",
  "flowDirs": ["flows"],
  "nodePacks": ["nodes/index.ts"]
}
```

这种方式主要用于开发和验证本项目自身能力；业务项目优先使用 12.1 的 submodule 集成方式。
