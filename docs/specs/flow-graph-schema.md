# Flow Graph Schema

> This document was split from [ARCHITECTURE.md](../../ARCHITECTURE.md).

### 2.1 Flow as Data

Flow 本身应定义为 JSON / DSL，而不是散落在业务代码中的隐式控制流。

Flow JSON 描述：

- Flow ID 与版本
- Schema version
- 输入输出 Schema
- 节点实例列表
- 节点实例唯一 ID
- 节点类型与节点类型版本
- 节点位置、尺寸、折叠状态等可视化元数据
- 输入端口与输出端口
- 多端口连线关系
- 边与条件路由
- 节点配置
- 节点逻辑引用
- 权限声明
- 超时、重试、并发等执行策略

需要注意：**Flow JSON 不是简单的线性步骤列表，而应该是一个可视化编辑器友好的有向图模型**。节点的 `id` 必须是稳定、全局唯一的节点实例 ID，不能依赖节点名称、节点标题或数组下标。边也不能只表达为 `["a", "b"]`，而必须显式声明起点节点、起点端口、终点节点和终点端口。

同时，**Flow JSON 应作为存储、交换、版本化和运行时加载格式，而不应该作为 AI 的主要直接生成目标**。更推荐的方式是让 AI 编写一段类型化的 Flow Builder 逻辑：实例化节点实例、定义端口、连接边，然后调用 `dump()` 导出规范 JSON。这样可以把 ID 生成、端口存在性检查、方向检查、Schema 校验、重复边检查等工作前置到 Builder API，显著降低 LLM 直接拼 JSON 带来的幻觉错误。

示例：

```json
{
  "id": "research-flow",
  "version": "1.0.0",
  "schemaVersion": "flow.graph.v1",
  "inputSchema": {
    "topic": "string"
  },
  "nodes": [
    {
      "id": "node_start_01",
      "type": "start",
      "typeVersion": "1.0.0",
      "label": "Start",
      "position": {
        "x": 80,
        "y": 160
      },
      "ports": {
        "inputs": [],
        "outputs": [
          {
            "id": "out",
            "kind": "control",
            "label": "Next"
          },
          {
            "id": "topic",
            "kind": "data",
            "label": "Topic",
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    {
      "id": "node_plan_01",
      "type": "llm",
      "typeVersion": "1.0.0",
      "label": "Plan",
      "position": {
        "x": 360,
        "y": 120
      },
      "ports": {
        "inputs": [
          {
            "id": "in",
            "kind": "control",
            "label": "Run"
          },
          {
            "id": "topic",
            "kind": "data",
            "label": "Topic",
            "schema": {
              "type": "string"
            }
          }
        ],
        "outputs": [
          {
            "id": "out",
            "kind": "control",
            "label": "Next"
          },
          {
            "id": "plan",
            "kind": "data",
            "label": "Plan",
            "schema": {
              "type": "string"
            }
          },
          {
            "id": "error",
            "kind": "error",
            "label": "Error"
          }
        ]
      },
      "config": {
        "prompt": "Create a research plan for {{input.topic}}"
      }
    },
    {
      "id": "node_search_01",
      "type": "tool",
      "typeVersion": "1.0.0",
      "label": "Search",
      "position": {
        "x": 680,
        "y": 120
      },
      "ports": {
        "inputs": [
          {
            "id": "in",
            "kind": "control",
            "label": "Run"
          },
          {
            "id": "query",
            "kind": "data",
            "label": "Query",
            "schema": {
              "type": "string"
            }
          }
        ],
        "outputs": [
          {
            "id": "out",
            "kind": "control",
            "label": "Next"
          },
          {
            "id": "result",
            "kind": "data",
            "label": "Result",
            "schema": {
              "type": "object"
            }
          }
        ]
      },
      "config": {
        "tool": "web.search"
      }
    }
  ],
  "edges": [
    {
      "id": "edge_start_to_plan_control",
      "from": {
        "nodeId": "node_start_01",
        "portId": "out"
      },
      "to": {
        "nodeId": "node_plan_01",
        "portId": "in"
      }
    },
    {
      "id": "edge_start_topic_to_plan_topic",
      "from": {
        "nodeId": "node_start_01",
        "portId": "topic"
      },
      "to": {
        "nodeId": "node_plan_01",
        "portId": "topic"
      }
    },
    {
      "id": "edge_plan_to_search_control",
      "from": {
        "nodeId": "node_plan_01",
        "portId": "out"
      },
      "to": {
        "nodeId": "node_search_01",
        "portId": "in"
      }
    },
    {
      "id": "edge_plan_to_search_query",
      "from": {
        "nodeId": "node_plan_01",
        "portId": "plan"
      },
      "to": {
        "nodeId": "node_search_01",
        "portId": "query"
      }
    }
  ],
  "viewport": {
    "x": 0,
    "y": 0,
    "zoom": 1
  }
}
```

这个结构同时服务于两类使用方式：

- **AI 生成和修改 Flow**：AI 生成类型化 Flow Builder 逻辑或受控图操作，由 Builder 校验后调用 `dump()` 导出 Flow JSON。
- **用户手动编辑 Flow**：用户可以在浏览器中拖拽节点、添加节点、删除节点、移动节点、修改端口、连接多端口边。


### 6.2 节点定义、节点实例与端口

节点系统必须区分三层概念：

| 概念 | 说明 |
|---|---|
| Node Type | 可复用的节点类型定义，例如 `llm`、`tool`、`condition`、`http` |
| Node Instance | Flow 图中的一个具体节点实例，必须拥有稳定唯一的 `id` |
| Port | 节点实例上的输入/输出端口，用于表达控制流、数据流、错误流或事件流 |

#### Node Type

Node Type 是节点模板，描述一个节点类型支持什么能力、默认有哪些端口、需要什么配置、使用哪个运行器执行。

```ts
interface NodeTypeDefinition {
  type: string;
  typeVersion: string;
  title: string;
  description?: string;
  defaultPorts: PortDefinition[];
  configSchema: unknown;
  runtime: "builtin" | "plugin" | "sandbox";
}
```

#### Node Instance

Node Instance 是画布中的节点实例。用户拖拽一个 `llm` 节点到画布时，创建的是一个新的 Node Instance，而不是新的 Node Type。

```ts
interface NodeInstance {
  id: string;
  type: string;
  typeVersion: string;
  label?: string;
  position: {
    x: number;
    y: number;
  };
  size?: {
    width: number;
    height: number;
  };
  ports: PortDefinition[];
  config: Record<string, unknown>;
  ui?: Record<string, unknown>;
}
```

#### Port Definition

Port 是图编辑器和运行时之间的关键契约。多端口节点必须显式声明每个端口的 ID、方向、类型和连接约束。

```ts
interface PortDefinition {
  id: string;
  direction: "input" | "output";
  kind: "control" | "data" | "event" | "stream" | "error";
  label?: string;
  schema?: unknown;
  required?: boolean;
  multiple?: boolean;
  dynamic?: boolean;
}
```

端口设计建议：

- **`control` 端口**：表达执行顺序，例如 `in`、`out`、`true`、`false`。
- **`data` 端口**：表达结构化数据传递，需要 Schema 校验。
- **`event` 端口**：表达异步事件触发。
- **`stream` 端口**：表达流式输出，例如模型 token stream。
- **`error` 端口**：表达异常分支，便于在画布中显式设计错误处理路径。

#### Edge Definition

边必须连接具体端口，而不是只连接节点。

```ts
interface EdgeDefinition {
  id: string;
  from: {
    nodeId: string;
    portId: string;
  };
  to: {
    nodeId: string;
    portId: string;
  };
  condition?: string;
  ui?: Record<string, unknown>;
}
```

运行时需要验证：

- `nodeId` 是否存在。
- `portId` 是否存在。
- 输出端口是否只能连接输入端口。
- `control`、`data`、`event`、`stream`、`error` 端口类型是否兼容。
- `schema` 是否兼容。
- `multiple: false` 的端口是否被重复连接。
- 删除节点时是否同步删除关联边。
- 删除端口时是否同步删除或标记失效关联边。


