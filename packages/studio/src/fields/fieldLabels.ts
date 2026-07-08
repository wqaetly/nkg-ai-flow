import type { FieldDescriptor } from "@ai-native-flow/flow-ir";

export type StudioFieldLocale = "zh-CN" | "en-US";

export interface StudioFieldLabelDictionary {
  locale: StudioFieldLocale;
  /**
   * Reusable labels keyed by the raw config field name. These are used
   * when a node-specific override is not present.
   */
  common: Record<string, string>;
  /**
   * Node-specific labels keyed by node type, then raw config field name.
   * These take precedence over `common` labels.
   */
  nodes: Record<string, Record<string, string>>;
}

export const DEFAULT_STUDIO_FIELD_LOCALE: StudioFieldLocale = "zh-CN";

export const STUDIO_FIELD_LABEL_DICTIONARIES: Record<
  StudioFieldLocale,
  StudioFieldLabelDictionary
> = {
  "en-US": {
    locale: "en-US",
    common: {},
    nodes: {},
  },
  "zh-CN": {
    locale: "zh-CN",
    common: {
      apiKey: "API 密钥",
      api_key: "API 密钥",
      allowBash: "允许执行 Bash",
      allowedTools: "允许使用的工具",
      baseUrl: "服务地址",
      base_url: "服务地址",
      body: "请求体",
      batchSize: "批大小",
      case1: "匹配值 1",
      case2: "匹配值 2",
      case3: "匹配值 3",
      case4: "匹配值 4",
      branchCount: "分支数量",
      capacity: "容量",
      checkMode: "检查时机",
      concurrency: "并发数",
      condition: "继续条件",
      default_name: "默认名称",
      defaultValue: "默认值",
      deadlineAt: "截止时间",
      description: "描述",
      durationMs: "等待时长（毫秒）",
      end: "结束值",
      expected: "期望值",
      expression: "表达式",
      event: "事件",
      failureThreshold: "失败阈值",
      flow_version: "流程版本",
      flowId: "流程 ID",
      flowVersion: "流程版本",
      failOnError: "失败时中断",
      graceMs: "宽限时间（毫秒）",
      headers: "请求头",
      inputMode: "输入模式",
      inputValue: "静态输入",
      label: "标签",
      lint_sources: "校验源码",
      limit: "额度上限",
      baseDelayMs: "基础等待毫秒",
      max_body_length: "正文长度上限",
      max_concurrency: "最大并发数",
      max_retries: "重试次数",
      maxOutputChars: "最大输出字符数",
      maxAttempts: "最大尝试次数",
      maxDelayMs: "最大等待毫秒",
      maxItems: "最大项数",
      maxAgeMs: "最大窗口时长（毫秒）",
      maxIterations: "最大循环次数",
      maxSteps: "最大步骤数",
      maxTokens: "最大输出 Token",
      max_tokens: "最大输出 Token",
      max_steps: "最多步骤数",
      method: "请求方法",
      min_steps: "最少步骤数",
      mode: "模式",
      model: "模型",
      multiplier: "倍率",
      namespace: "命名空间",
      owner: "持有者",
      package_scope: "包作用域",
      payload: "载荷",
      path: "字段路径",
      prompt: "提示词",
      resetTimeoutMs: "重置等待毫秒",
      separator: "分隔符",
      strict: "严格模式",
      start: "起始值",
      step: "步长",
      stream: "流式输出",
      systemPrompt: "系统提示词",
      temperature: "温度",
      template: "模板",
      tool: "工具名称",
      timeoutMs: "超时时间",
      ttlMs: "TTL（毫秒）",
      url: "请求地址",
      value: "值",
      windowMs: "窗口时长（毫秒）",
      workingDir: "工作目录",
    },
    nodes: {
      agent: {
        baseUrl: "服务地址",
        apiKey: "API 密钥",
        model: "模型",
        temperature: "温度",
        maxTokens: "最大输出 Token",
        maxSteps: "最大执行步数",
        workingDir: "工作目录",
        allowedTools: "允许使用的工具",
        allowBash: "允许执行 Bash",
        timeoutMs: "超时时间（毫秒）",
        maxOutputChars: "最大输出字符数",
        systemPrompt: "系统提示词",
      },
      approval: {
        name: "审批状态名",
        mode: "模式",
        title: "审批标题",
        assignee: "审批人",
        decision: "审批决定",
        comment: "审批意见",
        timeoutMs: "超时时间（毫秒）",
      },
      audit_log: {
        name: "审计日志名",
        mode: "模式",
        type: "事件类型",
        actor: "参与者",
        message: "事件消息",
        maxEntries: "最大保留条目",
        limit: "读取数量",
      },
      code_synthesizer: {
        base_url: "服务地址",
        api_key: "API 密钥",
        model: "模型",
        temperature: "温度",
        max_tokens: "最大输出 Token",
        max_concurrency: "最大并发数",
        max_retries: "JSON 重试次数",
        package_scope: "生成包作用域",
        flow_version: "流程版本",
      },
      batch_window: {
        name: "批窗口状态名",
        maxItems: "最大项数",
        maxAgeMs: "最大窗口时长（毫秒）",
        mode: "模式",
      },
      cache: {
        namespace: "命名空间",
        key: "缓存键",
        mode: "模式",
        ttlMs: "TTL（毫秒）",
        value: "静态缓存值",
      },
      condition: {
        expression: "条件表达式",
      },
      deadline: {
        deadlineAt: "截止时间",
        durationMs: "相对时长（毫秒）",
        graceMs: "宽限时间（毫秒）",
      },
      dead_letter: {
        name: "死信队列名",
        mode: "模式",
        reason: "原因",
        maxItems: "最大保留条目",
      },
      circuit_breaker: {
        name: "熔断状态名",
        failureThreshold: "失败阈值",
        resetTimeoutMs: "重置等待毫秒",
        mode: "模式",
      },
      checkpoint: {
        name: "检查点名",
        mode: "模式",
        snapshot: "静态快照",
        label: "标签",
        ttlMs: "TTL（毫秒）",
      },
      compensation: {
        name: "补偿栈名",
        mode: "模式",
        action: "补偿动作",
        payload: "静态载荷",
      },
      delay: {
        durationMs: "等待时长（毫秒）",
      },
      event_trigger: {
        event: "触发事件",
      },
      feature_flag: {
        name: "开关状态名",
        mode: "模式",
        enabled: "是否启用",
        rolloutPercent: "灰度比例",
        key: "静态灰度键",
        description: "描述",
      },
      filter_items: {
        condition: "过滤条件",
      },
      for_begin: {
        start: "起始值",
        end: "结束值",
        step: "步长",
      },
      foreach_begin: {
        mode: "执行模式",
        concurrency: "并发数",
        batchSize: "批大小",
      },
      flow_validator: {
        strict: "严格模式",
        lint_sources: "校验生成源码",
      },
      http: {
        url: "请求地址",
        method: "请求方法",
        headers: "请求头",
        body: "请求体",
      },
      idempotency_key: {
        namespace: "命名空间",
        key: "幂等键",
        mode: "模式",
        ttlMs: "TTL（毫秒）",
      },
      llm: {
        baseUrl: "服务地址",
        apiKey: "API 密钥",
        model: "模型",
        prompt: "提示词",
        temperature: "温度",
        maxTokens: "最大输出 Token",
        stream: "流式输出",
      },
      map_items: {
        template: "映射模板",
      },
      metric: {
        name: "指标名",
        mode: "模式",
        value: "指标值",
        maxSamples: "最大样本数",
      },
      loop_begin: {
        maxIterations: "最大循环次数",
        checkMode: "检查时机",
      },
      loop_end: {
        condition: "继续条件",
      },
      node_designer: {
        base_url: "服务地址",
        api_key: "API 密钥",
        model: "模型",
        temperature: "温度",
        max_tokens: "最大输出 Token",
        max_concurrency: "最大并发数",
        max_retries: "JSON 重试次数",
      },
      parallel: {
        branchCount: "分支数量",
      },
      policy_gate: {
        mode: "匹配模式",
        rules: "策略规则",
        reason: "拒绝原因",
      },
      queue: {
        name: "队列状态名",
        mode: "模式",
        maxItems: "最大保留项数",
        count: "取出数量",
      },
      mutex: {
        name: "锁状态名",
        owner: "持有者",
        ttlMs: "TTL（毫秒）",
        mode: "模式",
      },
      rate_limit: {
        name: "限流状态名",
        limit: "额度上限",
        windowMs: "窗口时长（毫秒）",
        cost: "本次消耗额度",
      },
      reduce_items: {
        mode: "汇总模式",
        path: "字段路径",
        separator: "分隔符",
      },
      retry_policy: {
        maxAttempts: "最大尝试次数",
        baseDelayMs: "基础等待毫秒",
        multiplier: "退避倍率",
        maxDelayMs: "最大等待毫秒",
        retryableOnly: "仅重试可重试错误",
      },
      schedule_window: {
        startTime: "开始时间",
        endTime: "结束时间",
        days: "允许星期",
        timezoneOffsetMinutes: "时区偏移分钟",
      },
      schema_guard: {
        schema: "校验 Schema",
      },
      semaphore: {
        name: "信号量状态名",
        owner: "持有者",
        capacity: "容量",
        ttlMs: "TTL（毫秒）",
        mode: "模式",
      },
      subflow: {
        flowId: "流程 ID",
        flowVersion: "流程版本",
        inputMode: "输入模式",
        inputValue: "静态输入",
        failOnError: "失败时中断",
      },
      switch_case: {
        path: "匹配字段路径",
        case1: "匹配值 1",
        case2: "匹配值 2",
        case3: "匹配值 3",
        case4: "匹配值 4",
      },
      skill_parser: {
        default_name: "默认 Skill 名称",
        max_body_length: "正文长度上限（字节）",
      },
      skill_planner: {
        base_url: "服务地址",
        api_key: "API 密钥",
        model: "模型",
        temperature: "温度",
        max_tokens: "最大输出 Token",
        min_steps: "最少步骤数",
        max_steps: "最多步骤数",
        max_retries: "JSON 校验失败重试次数",
      },
      send_event: {
        event: "发送事件",
      },
      state_get: {
        name: "状态名",
        defaultValue: "默认值",
      },
      state_set: {
        name: "状态名",
        value: "静态值",
        description: "状态描述",
      },
      text_input: {
        value: "输入文本",
      },
      tool: {
        tool: "工具名称",
      },
      transform: {
        template: "模板",
        expression: "表达式",
        value: "静态值",
      },
      wait_signal: {
        name: "等待状态名",
        expected: "期望信号",
        timeoutMs: "超时时间（毫秒）",
      },
    },
  },
};

export function resolveFieldDisplayLabel(
  nodeType: string,
  fieldName: string,
  fallback: string | undefined,
  locale: StudioFieldLocale = DEFAULT_STUDIO_FIELD_LOCALE,
): string {
  const dictionary = STUDIO_FIELD_LABEL_DICTIONARIES[locale];
  const nodeLabel = dictionary.nodes[nodeType]?.[fieldName];
  return nodeLabel ?? dictionary.common[fieldName] ?? fallback ?? fieldName;
}

export function localizeFieldDescriptor(
  nodeType: string,
  field: FieldDescriptor,
  locale: StudioFieldLocale = DEFAULT_STUDIO_FIELD_LOCALE,
): FieldDescriptor {
  return {
    ...field,
    label: resolveFieldDisplayLabel(nodeType, field.name, field.label, locale),
  };
}
