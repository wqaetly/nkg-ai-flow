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
      elapsedMs: "实际等待毫秒",
      false: "条件为假",
      body: "循环体",
      body_done: "循环体完成",
      branch1: "分支 1",
      branch2: "分支 2",
      branch3: "分支 3",
      branch4: "分支 4",
      break: "跳出循环",
      batchSize: "批大小",
      checkMode: "检查时机",
      concurrency: "并发数",
      continue: "继续下一轮",
      count: "总数",
      case1: "分支 1",
      case2: "分支 2",
      case3: "分支 3",
      case4: "分支 4",
      default: "默认分支",
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
      values: "多路数据",
      maxed: "达到上限",
      nextState: "下一状态",
      node_specs: "节点规格",
      out: "输出",
      output: "输出",
      package: "生成包",
      plan: "执行计划",
      response: "响应",
      rejected: "剔除项",
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
      value: "值",
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
      delay: {
        elapsedMs: "实际等待毫秒",
      },
      event_trigger: {
        event: "事件",
      },
      filter_items: {
        items: "保留项",
        rejected: "剔除项",
        count: "保留数量",
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
      join: {
        in: "输入分支",
        out: "继续",
        values: "多路数据",
        count: "数量",
      },
      map_items: {
        items: "映射项",
        count: "数量",
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
      loop_break: {
        break: "跳出循环",
      },
      loop_continue: {
        continue: "继续下一轮",
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
      parallel: {
        in: "输入",
        input: "输入数据",
        branch1: "分支 1",
        branch2: "分支 2",
        branch3: "分支 3",
        branch4: "分支 4",
        value: "透传数据",
      },
      reduce_items: {
        items: "数组",
        result: "汇总结果",
        count: "数量",
      },
      switch_case: {
        in: "输入",
        value: "匹配数据",
        case1: "分支 1",
        case2: "分支 2",
        case3: "分支 3",
        case4: "分支 4",
        default: "默认分支",
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
