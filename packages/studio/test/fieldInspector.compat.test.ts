/**
 * Compatibility checks for the Node Field Inspector pipeline:
 *
 *   - A node type whose `configSchema` only carries the legacy
 *     `{ "x-zod": true, typeName }` shape MUST yield no `configFields`
 *     and the canvas must still render fine.
 *   - Nodes WITH the new `fields[]` shape must propagate descriptors
 *     all the way through `viewModel → reactFlowAdapter`.
 */

import { describe, expect, test } from "vitest";
import type { FlowGraph, NodeTypeDefinition } from "@ai-native-flow/flow-ir";
import { createStudioState, createStudioViewModel } from "../src/viewModel.js";
import { toReactFlowGraph } from "../src/reactFlowAdapter.js";

function makeGraph(typeName: string): FlowGraph {
  return {
    id: "demo",
    version: "1.0.0",
    schemaVersion: "flow.graph.v1",
    nodes: [
      {
        id: "n1",
        type: typeName,
        typeVersion: "1.0.0",
        position: { x: 0, y: 0 },
        ports: [
          { id: "in", direction: "input", kind: "control" },
          { id: "out", direction: "output", kind: "control" },
        ],
        config: {},
      },
    ],
    edges: [],
  };
}

describe("Node Field Inspector — compatibility", () => {
  test("legacy configSchema shape produces no configFields", () => {
    const legacyType: NodeTypeDefinition = {
      type: "legacy",
      typeVersion: "1.0.0",
      title: "Legacy",
      defaultPorts: [],
      runtime: "builtin",
      configSchema: { "x-zod": true, typeName: "ZodObject" },
    };
    const state = createStudioState({
      graph: makeGraph("legacy"),
      palette: [legacyType],
    });
    const view = createStudioViewModel(state);
    const item = view.palette.find((p) => p.type === "legacy");
    expect(item?.configFields).toBeUndefined();
    const rf = toReactFlowGraph(view);
    expect(rf.nodes[0]?.data.configFields).toEqual([]);
  });

  test("new fields[] shape flows through palette → react-flow data", () => {
    const modernType: NodeTypeDefinition = {
      type: "modern",
      typeVersion: "1.0.0",
      title: "Modern",
      defaultPorts: [],
      runtime: "builtin",
      configSchema: {
        "x-zod": true,
        typeName: "ZodObject",
        fields: [
          {
            name: "url",
            kind: "string",
            optional: false,
            nullable: false,
            label: "URL",
            placeholder: "https://...",
          },
          {
            name: "method",
            kind: "enum",
            optional: false,
            nullable: false,
            enumOptions: [
              { label: "GET", value: "GET" },
              { label: "POST", value: "POST" },
            ],
          },
        ],
      },
    };
    const state = createStudioState({
      graph: makeGraph("modern"),
      palette: [modernType],
    });
    const view = createStudioViewModel(state);
    const item = view.palette.find((p) => p.type === "modern");
    expect(item?.configFields?.length).toBe(2);
    const rf = toReactFlowGraph(view);
    const fields = rf.nodes[0]?.data.configFields ?? [];
    expect(fields.map((f) => f.name)).toEqual(["url", "method"]);
    expect(fields[0]?.label).toBe("请求地址");
    expect(fields[0]?.placeholder).toBe("https://...");
    expect(fields[1]?.enumOptions?.[0]?.value).toBe("GET");
  });

  test("field labels are localized by nodeType + fieldName mapping", () => {
    const textInputType: NodeTypeDefinition = {
      type: "text_input",
      typeVersion: "1.0.0",
      title: "Text Input",
      defaultPorts: [],
      runtime: "builtin",
      configSchema: {
        fields: [
          {
            name: "value",
            kind: "string",
            optional: false,
            nullable: false,
            label: "Input text",
          },
        ],
      },
    };
    const state = createStudioState({
      graph: makeGraph("text_input"),
      palette: [textInputType],
    });
    expect(state.palette[0]?.title).toBe("文本输入");
    const rf = toReactFlowGraph(createStudioViewModel(state));
    const fields = rf.nodes[0]?.data.configFields ?? [];
    const inputs = rf.nodes[0]?.data.inputs ?? [];
    expect(fields[0]?.label).toBe("输入文本");
    expect(inputs.find((p) => p.id === "value")?.label).toBe("输入文本");
  });

  test("tool node fields and ports use runtime tool-call labels", () => {
    const toolType: NodeTypeDefinition = {
      type: "tool",
      typeVersion: "1.0.0",
      title: "Tool",
      description: "Invokes a built-in runtime tool with structured arguments.",
      defaultPorts: [
        { id: "in", direction: "input", kind: "control", label: "Input" },
        { id: "args", direction: "input", kind: "data", label: "Arguments" },
        { id: "context", direction: "input", kind: "data", label: "Context" },
        { id: "workingDir", direction: "input", kind: "data", label: "Working directory" },
        { id: "success", direction: "output", kind: "control", label: "Success" },
        { id: "failed", direction: "output", kind: "control", label: "Failed" },
        { id: "result", direction: "output", kind: "data", label: "Result" },
        { id: "ok", direction: "output", kind: "data", label: "OK" },
        { id: "errorMessage", direction: "output", kind: "data", label: "Error message" },
        { id: "changedFiles", direction: "output", kind: "data", label: "Changed files" },
        { id: "error", direction: "output", kind: "error", label: "Error" },
      ],
      runtime: "builtin",
      configSchema: {
        fields: [
          { name: "tool", kind: "string", optional: false, nullable: false, label: "Tool" },
          { name: "args", kind: "unknown", optional: true, nullable: false, label: "Arguments" },
          { name: "workingDir", kind: "string", optional: false, nullable: false, label: "Working directory" },
          { name: "allowedTools", kind: "string[]", optional: false, nullable: false, label: "Allowed tools" },
          { name: "allowBash", kind: "boolean", optional: false, nullable: false, label: "Allow bash" },
          { name: "timeoutMs", kind: "number", optional: false, nullable: false, label: "Timeout (ms)" },
          { name: "maxOutputChars", kind: "number", optional: false, nullable: false, label: "Max output chars" },
          { name: "failOnError", kind: "boolean", optional: false, nullable: false, label: "Fail on error" },
        ],
      },
    };
    const graph: FlowGraph = {
      id: "demo",
      version: "1.0.0",
      schemaVersion: "flow.graph.v1",
      nodes: [
        {
          id: "tool_1",
          type: "tool",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: toolType.defaultPorts.map((port) => ({ ...port })),
          config: {},
        },
      ],
      edges: [],
    };

    const state = createStudioState({ graph, palette: [toolType] });
    expect(state.palette[0]).toMatchObject({
      title: "工具调用",
      description: "直接调用运行时内置工具，并按成功或失败分支继续流程。",
    });

    const rf = toReactFlowGraph(createStudioViewModel(state));
    const fields = rf.nodes[0]?.data.configFields ?? [];
    const inputs = rf.nodes[0]?.data.inputs ?? [];
    const outputs = rf.nodes[0]?.data.outputs ?? [];

    expect(fields.map((field) => [field.name, field.label])).toEqual([
      ["tool", "工具名称"],
      ["args", "工具参数"],
      ["workingDir", "工作目录"],
      ["allowedTools", "允许使用的工具"],
      ["allowBash", "允许执行 Bash"],
      ["timeoutMs", "超时时间（毫秒）"],
      ["maxOutputChars", "最大输出字符数"],
      ["failOnError", "失败时中断"],
    ]);
    expect(inputs.map((port) => [port.id, port.label])).toEqual(
      expect.arrayContaining([
        ["in", "输入"],
        ["args", "工具参数"],
        ["context", "上下文"],
        ["workingDir", "工作目录"],
      ]),
    );
    expect(outputs.map((port) => [port.id, port.label])).toEqual([
      ["success", "成功"],
      ["failed", "失败"],
      ["result", "结果"],
      ["ok", "是否成功"],
      ["errorMessage", "错误信息"],
      ["changedFiles", "变更文件"],
      ["error", "错误"],
    ]);
  });

  test("en-US field locale preserves authored labels", () => {
    const textInputType: NodeTypeDefinition = {
      type: "text_input",
      typeVersion: "1.0.0",
      title: "Text Input",
      defaultPorts: [],
      runtime: "builtin",
      configSchema: {
        fields: [
          {
            name: "value",
            kind: "string",
            optional: false,
            nullable: false,
            label: "Input text",
          },
        ],
      },
    };
    const state = createStudioState({
      graph: makeGraph("text_input"),
      palette: [textInputType],
      fieldLocale: "en-US",
    });
    const fields =
      toReactFlowGraph(createStudioViewModel(state)).nodes[0]?.data
        .configFields ?? [];
    expect(fields[0]?.label).toBe("Input text");
  });

  test("port labels are localized for graph nodes and palette defaults", () => {
    const transformType: NodeTypeDefinition = {
      type: "transform",
      typeVersion: "1.0.0",
      title: "Transform",
      defaultPorts: [
        { id: "input", direction: "input", kind: "data", label: "Input" },
        { id: "output", direction: "output", kind: "data", label: "Output" },
        { id: "error", direction: "output", kind: "error", label: "Error" },
      ],
      runtime: "builtin",
    };
    const graph: FlowGraph = {
      id: "demo",
      version: "1.0.0",
      schemaVersion: "flow.graph.v1",
      nodes: [
        {
          id: "n1",
          type: "transform",
          typeVersion: "1.0.0",
          position: { x: 0, y: 0 },
          ports: transformType.defaultPorts.map((port) => ({ ...port })),
          config: {},
        },
      ],
      edges: [],
    };

    const state = createStudioState({
      graph,
      palette: [transformType],
    });
    const view = createStudioViewModel(state);

    expect(state.palette[0]?.defaultPorts.map((port) => port.label)).toEqual([
      "输入",
      "输出",
      "错误",
    ]);
    expect(view.nodes[0]?.inputs.map((port) => port.label)).toEqual(["输入"]);
    expect(view.nodes[0]?.outputs.map((port) => port.label)).toEqual([
      "输出",
      "错误",
    ]);
  });
});
