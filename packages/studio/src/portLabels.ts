import type { PortDefinition } from "@ai-native-flow/flow-ir";
import type { StudioFieldLocale } from "./fields/fieldLabels.js";

export interface StudioPortLabelDictionary {
  locale: StudioFieldLocale;
  common: Record<string, string>;
  nodes: Record<string, Record<string, string>>;
}

export const STUDIO_PORT_LABEL_DICTIONARIES: Record<
  StudioFieldLocale,
  StudioPortLabelDictionary
> = {
  "en-US": {
    locale: "en-US",
    common: {},
    nodes: {},
  },
  "zh-CN": {
    locale: "zh-CN",
    common: {
      artifact: "Flow 产物",
      changed_files: "变更文件",
      context: "上下文",
      error: "错误",
      event: "事件",
      false: "条件为假",
      body: "循环体",
      body_done: "循环体完成",
      batchSize: "批大小",
      checkMode: "检查时机",
      concurrency: "并发数",
      count: "总数",
      done: "完成",
      empty: "空集合",
      errors: "错误列表",
      finalState: "最终状态",
      in: "输入",
      input: "输入",
      index: "索引",
      initialState: "初始状态",
      item: "当前项",
      items: "数组",
      iteration: "轮次",
      maxed: "达到上限",
      nextState: "下一状态",
      node_specs: "节点规格",
      out: "输出",
      output: "输出",
      package: "生成包",
      plan: "执行计划",
      response: "响应",
      result: "结果",
      results: "结果数组",
      runInput: "运行输入",
      skill_def: "Skill 定义",
      state: "当前状态",
      summary: "摘要",
      task: "任务",
      text: "文本",
      tool_log: "工具日志",
      triggeredRuns: "触发运行数",
      true: "条件为真",
      working_dir: "工作目录",
    },
    nodes: {
      agent: {
        task: "任务",
        context: "上下文",
        working_dir: "工作目录",
        summary: "摘要",
        changed_files: "变更文件",
        tool_log: "工具日志",
      },
      code_synthesizer: {
        skill_def: "Skill 定义",
        plan: "执行计划",
        node_specs: "节点规格",
        package: "生成包",
      },
      condition: {
        true: "条件为真",
        false: "条件为假",
      },
      event_trigger: {
        event: "事件",
      },
      for_begin: {
        body: "循环体",
        index: "索引",
        count: "总数",
      },
      for_end: {
        body_done: "循环体完成",
        done: "完成",
        result: "单次结果",
        results: "结果数组",
      },
      foreach_begin: {
        body: "循环体",
        items: "数组",
        item: "当前项",
        index: "索引",
        count: "总数",
      },
      foreach_end: {
        body_done: "循环体完成",
        done: "完成",
        result: "单次结果",
        results: "结果数组",
        errors: "错误列表",
      },
      flow_validator: {
        package: "生成包",
        node_specs: "节点规格",
        artifact: "Flow 产物",
      },
      http: {
        response: "响应",
      },
      llm: {
        result: "结果",
      },
      loop_begin: {
        body: "循环体",
        initialState: "初始状态",
        state: "当前状态",
        iteration: "轮次",
      },
      loop_end: {
        body_done: "循环体完成",
        done: "完成",
        maxed: "达到上限",
        nextState: "下一状态",
        finalState: "最终状态",
      },
      node_designer: {
        skill_def: "Skill 定义",
        plan: "执行计划",
        node_specs: "节点规格",
      },
      skill_parser: {
        skill_def: "Skill 定义",
      },
      skill_planner: {
        skill_def: "Skill 定义",
        plan: "执行计划",
      },
      send_event: {
        event: "事件",
        triggeredRuns: "触发运行数",
      },
      start: {
        runInput: "运行输入",
      },
      text_input: {
        text: "文本",
      },
      tool: {
        result: "结果",
      },
      transform: {
        input: "输入",
        output: "输出",
      },
    },
  },
};

export function resolvePortDisplayLabel(
  nodeType: string,
  portId: string,
  fallback: string | undefined,
  locale: StudioFieldLocale,
): string {
  const dictionary = STUDIO_PORT_LABEL_DICTIONARIES[locale];
  return (
    dictionary.nodes[nodeType]?.[portId] ??
    dictionary.common[portId] ??
    fallback ??
    portId
  );
}

export function localizePortDefinition(
  nodeType: string,
  port: PortDefinition,
  locale: StudioFieldLocale,
): PortDefinition {
  return {
    ...port,
    label: resolvePortDisplayLabel(nodeType, port.id, port.label, locale),
  };
}
