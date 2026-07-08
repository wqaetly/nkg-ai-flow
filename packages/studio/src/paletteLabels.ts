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
      approval: {
        title: "人工审批",
        description: "创建、检查、批准、拒绝、取消或清理人工审批任务。",
      },
      audit_log: {
        title: "审计日志",
        description: "记录、读取或清空业务级审计事件轨迹。",
      },
      batch_items: {
        title: "数组分批",
        description: "把数组按固定大小切成多个批次，用于批量 API 或并行处理。",
      },
      code_synthesizer: {
        title: "代码合成器（LLM 并行）",
        description: "并行生成节点代码，并组装 FlowGraph、构建脚本和运行时文件。",
      },
      batch_window: {
        title: "批窗口",
        description: "累积输入项，并在达到数量或时间窗口后输出批次。",
      },
      branch_timeout: {
        title: "分支超时",
        description: "按分支耗时和阈值路由到准时、超时或未知分支。",
      },
      cache: {
        title: "缓存",
        description: "读取、写入、删除或清空命名空间下的缓存值。",
      },
      checkpoint: {
        title: "检查点",
        description: "保存、读取、续期或清除流程断点快照。",
      },
      circuit_breaker: {
        title: "熔断器",
        description: "根据持久化熔断状态路由到 closed / open / half-open 分支。",
      },
      compare_gate: {
        title: "比较门控",
        description: "比较两个值，并按匹配或不匹配继续流程。",
      },
      concat_items: {
        title: "合并数组",
        description: "把多个上游数组来源按顺序合并成一个项目列表。",
      },
      compensation: {
        title: "补偿动作",
        description: "登记或取出 Saga 风格的回滚补偿动作。",
      },
      condition: {
        title: "条件分支",
        description: "根据布尔表达式把流程路由到 true / false 分支。",
      },
      cooldown_gate: {
        title: "冷却门控",
        description: "放行一次后在指定时间内抑制重复触发。",
      },
      cron_schedule: {
        title: "Cron 调度",
        description: "按五段 cron 表达式判断当前是否到期，并输出下一次触发时间。",
      },
      deadline: {
        title: "截止时间",
        description: "检查 SLA 或截止时间，并路由到准时或已超时分支。",
      },
      dead_letter: {
        title: "死信队列",
        description: "记录或取出失败载荷，供重放、告警或人工处理。",
      },
      delete_path: {
        title: "路径删除",
        description: "从结构化数据中删除字段或数组项，并按删除、缺失或跳过继续流程。",
      },
      delay: {
        title: "延迟等待",
        description: "等待指定毫秒数后继续流程。",
      },
      distinct_until_changed: {
        title: "变化门控",
        description: "仅当指定值相对上次观测发生变化时继续变化分支。",
      },
      empty_gate: {
        title: "空值门控",
        description: "按数组、对象、字符串或存在性判断空/非空分支。",
      },
      expression_eval: {
        title: "表达式求值",
        description: "使用安全表达式从输入数据中计算结果和布尔值。",
      },
      fail_fast: {
        title: "快速失败",
        description: "任一分支错误率先到达时立即进入失败分支。",
      },
      end: {
        title: "结束",
        description: "流程出口节点，用于聚合最终输出。",
      },
      error_classifier: {
        title: "错误分类",
        description: "按错误码、类型、类别、可重试标记或消息内容路由错误。",
      },
      fallback: {
        title: "兜底分支",
        description: "主值不可用或存在错误时切换到备用值或备用流程。",
      },
      event_trigger: {
        title: "事件触发",
        description: "收到匹配的字符串事件时启动流程。",
      },
      feature_flag: {
        title: "功能开关",
        description: "按开关状态和稳定灰度比例路由发布分支。",
      },
      filter_items: {
        title: "过滤数组",
        description: "按条件保留数组中的部分元素。",
      },
      flatten_items: {
        title: "展平数组",
        description: "把嵌套数组或数组字段展平成一维项目列表。",
      },
      first_success: {
        title: "首个成功",
        description: "从有序候选结果中选择第一个成功值。",
      },
      group_items: {
        title: "数组分组",
        description: "按字段或完整值把数组项目分组成对象和分组列表。",
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
      idempotency_key: {
        title: "幂等键",
        description: "按业务键去重副作用流程，并复用已完成的结果。",
      },
      join: {
        title: "汇合",
        description: "等待所有输入分支到达，并聚合多路数据。",
      },
      llm: {
        title: "大模型调用",
        description: "使用提示词模板调用模型，并可选择流式输出。",
      },
      map_items: {
        title: "映射数组",
        description: "对数组每一项套用模板并输出新数组。",
      },
      merge: {
        title: "合流",
        description: "任一输入分支到达后继续流程。",
      },
      merge_object: {
        title: "合并对象",
        description: "把多个对象来源合并成一个结构化载荷。",
      },
      metric: {
        title: "指标",
        description: "更新、读取或重置流程中的业务数值指标。",
      },
      mutex: {
        title: "互斥锁",
        description: "对命名资源加锁、续租或释放，并路由到已获得、被占用或已释放分支。",
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
      partial_success: {
        title: "部分成功",
        description: "统计多分支结果，并按全成功、部分成功或失败继续流程。",
      },
      parse_json: {
        title: "解析 JSON",
        description: "把 JSON 文本解析成结构化数据，并把非法输入路由到失败分支。",
      },
      policy_gate: {
        title: "策略门禁",
        description: "按多条业务规则允许或拒绝流程继续。",
      },
      queue: {
        title: "持久队列",
        description: "把任务项入队、取出、查看或清空，用于显式缓冲和消费。",
      },
      quorum: {
        title: "阈值汇聚",
        description: "当到达值数量达到阈值后继续流程。",
      },
      race: {
        title: "竞速汇聚",
        description: "任一分支率先到达后继续，并输出第一个可用值。",
      },
      rate_limit: {
        title: "限流",
        description: "基于持久化滑动窗口配额路由到允许或限流分支。",
      },
      reduce_items: {
        title: "汇总数组",
        description: "对数组执行计数、求和或拼接汇总。",
      },
      retry_policy: {
        title: "重试策略",
        description: "根据错误、尝试次数和重试标记路由到重试或耗尽分支。",
      },
      schedule_window: {
        title: "时间窗口",
        description: "按工作日和时间段判断当前流程是否处于允许窗口。",
      },
      schema_guard: {
        title: "Schema 校验",
        description: "按 JSON Schema 子集校验数据，并路由到有效或无效分支。",
      },
      schema_transform: {
        title: "Schema 转换",
        description: "按声明式字段映射把输入数据转换成目标结构。",
      },
      select_path: {
        title: "路径取值",
        description: "从结构化数据中按路径取出字段，并把缺失路径路由到缺失分支。",
      },
      semaphore: {
        title: "信号量",
        description: "限制命名资源的最大并发持有者数量，并路由到已获得、已满或已释放分支。",
      },
      set_path: {
        title: "路径写入",
        description: "把值写入结构化数据的指定路径，并按更新、缺失或跳过继续流程。",
      },
      slice_items: {
        title: "截取数组",
        description: "按起点、终点或数量截取数组窗口，用于分页或批处理。",
      },
      sort_items: {
        title: "排序数组",
        description: "按字段、方向和类型稳定排序数组，并可限制输出数量。",
      },
      split_text: {
        title: "拆分文本",
        description: "按行、分隔符、空白或正则把文本拆成数组。",
      },
      subflow: {
        title: "子流程",
        description: "调用另一个已注册 Flow，并根据子运行状态继续流程。",
      },
      switch_case: {
        title: "多路分支",
        description: "根据输入值路由到 case 或 default 分支。",
      },
      stringify_json: {
        title: "生成 JSON",
        description: "把结构化数据序列化为 JSON 文本，并把失败路由到错误分支。",
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
      signal_resume: {
        title: "恢复信号",
        description: "向等待信号状态写入外部信号，用于 webhook、审批或事件恢复。",
      },
      state_get: {
        title: "读取状态",
        description: "从运行时状态变量读取值并输出到数据流。",
      },
      state_set: {
        title: "写入状态",
        description: "把输入或静态值写入运行时状态变量。",
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
      unique_items: {
        title: "数组去重",
        description: "按字段或完整值去除重复项，并输出重复项列表。",
      },
      window_items: {
        title: "数组窗口",
        description: "按窗口大小和步长生成滑动或滚动数组窗口。",
      },
      transform: {
        title: "数据转换",
        description: "使用模板、表达式或静态值进行数据转换。",
      },
      wait_signal: {
        title: "等待信号",
        description: "创建或检查外部等待信号，并路由到收到、等待或过期分支。",
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
