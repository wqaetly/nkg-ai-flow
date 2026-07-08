import type { StudioFieldLocale } from "./fields/fieldLabels.js";

export interface StudioNodeDisplayLabels {
  title: string;
  description?: string;
}

export interface StudioNodeLabelDictionary {
  locale: StudioFieldLocale;
  nodes: Record<string, StudioNodeDisplayLabels>;
}

export const STUDIO_NODE_LABEL_DICTIONARIES: Record<
  StudioFieldLocale,
  StudioNodeLabelDictionary
> = {
  "en-US": {
    locale: "en-US",
    nodes: {},
  },
  "zh-CN": {
    locale: "zh-CN",
    nodes: {
      agent: {
        title: "智能体",
        description: "通过大模型循环调用文件、搜索、编辑和命令工具。",
      },
      code_synthesizer: {
        title: "代码合成器（LLM 并行）",
        description: "并行生成节点代码，并组装 FlowGraph、构建脚本和运行时文件。",
      },
      condition: {
        title: "条件分支",
        description: "根据布尔表达式把流程路由到 true / false 分支。",
      },
      delay: {
        title: "延迟等待",
        description: "等待指定毫秒数后继续流程。",
      },
      end: {
        title: "结束",
        description: "流程出口节点，用于聚合最终输出。",
      },
      event_trigger: {
        title: "事件触发",
        description: "收到匹配的字符串事件时启动流程。",
      },
      for_begin: {
        title: "For 开始",
        description: "固定范围循环块入口，输出当前索引和总数。",
      },
      for_end: {
        title: "For 结束",
        description: "固定范围循环块出口，收集每轮结果。",
      },
      foreach_begin: {
        title: "ForEach 开始",
        description: "数组循环块入口，输出当前项、索引和总数。",
      },
      foreach_end: {
        title: "ForEach 结束",
        description: "数组循环块出口，聚合循环体输出。",
      },
      flow_validator: {
        title: "Flow 验证器",
        description: "校验生成的 FlowGraph，并对生成的 TS 源码做基础检查。",
      },
      http: {
        title: "HTTP 请求",
        description: "调用外部 HTTP API。",
      },
      join: {
        title: "汇合",
        description: "等待所有输入分支到达，并聚合多路数据。",
      },
      llm: {
        title: "大模型调用",
        description: "使用提示词模板调用模型，并可选择流式输出。",
      },
      loop_begin: {
        title: "Loop 开始",
        description: "While / Until 循环块入口，输出状态和轮次。",
      },
      loop_break: {
        title: "跳出循环",
        description: "在循环体内提前结束 foreach / for / loop 块。",
      },
      loop_continue: {
        title: "继续下一轮",
        description: "跳过当前迭代剩余步骤并继续下一轮循环。",
      },
      loop_end: {
        title: "Loop 结束",
        description: "While / Until 循环块出口，输出最终状态或上限分支。",
      },
      node_designer: {
        title: "节点设计器（LLM 并发）",
        description: "针对执行计划的每个步骤并发设计 NodeSpec。",
      },
      parallel: {
        title: "并行分支",
        description: "把流程扇出到多个命名分支。",
      },
      skill_parser: {
        title: "Skill 解析器",
        description: "解析 SKILL.md 的 frontmatter 和正文，输出结构化定义。",
      },
      skill_planner: {
        title: "Skill 规划器（LLM）",
        description: "使用 LLM 把 Skill 分解成有向无环执行计划。",
      },
      send_event: {
        title: "发送事件",
        description: "发送字符串事件以触发匹配的 active flow。",
      },
      start: {
        title: "开始",
        description: "流程入口节点。",
      },
      text_input: {
        title: "文本输入",
        description: "在画布上输入静态文本，并输出到数据端口。",
      },
      tool: {
        title: "工具调用",
        description: "调用内置工具、MCP 工具或外部工具。",
      },
      transform: {
        title: "数据转换",
        description: "使用模板、表达式或静态值进行数据转换。",
      },
    },
  },
};

export function resolveNodeDisplayLabels(
  nodeType: string,
  fallbackTitle: string,
  fallbackDescription: string | undefined,
  locale: StudioFieldLocale,
): StudioNodeDisplayLabels {
  const label = STUDIO_NODE_LABEL_DICTIONARIES[locale].nodes[nodeType];
  return {
    title: label?.title ?? fallbackTitle,
    description: label?.description ?? fallbackDescription,
  };
}
