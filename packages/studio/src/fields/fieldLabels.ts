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
      branchCount: "分支数量",
      checkMode: "检查时机",
      concurrency: "并发数",
      condition: "继续条件",
      default_name: "默认名称",
      durationMs: "等待时长（毫秒）",
      end: "结束值",
      expression: "表达式",
      event: "事件",
      flow_version: "流程版本",
      headers: "请求头",
      lint_sources: "校验源码",
      max_body_length: "正文长度上限",
      max_concurrency: "最大并发数",
      max_retries: "重试次数",
      maxOutputChars: "最大输出字符数",
      maxIterations: "最大循环次数",
      maxSteps: "最大步骤数",
      maxTokens: "最大输出 Token",
      max_tokens: "最大输出 Token",
      max_steps: "最多步骤数",
      method: "请求方法",
      min_steps: "最少步骤数",
      model: "模型",
      package_scope: "包作用域",
      prompt: "提示词",
      strict: "严格模式",
      start: "起始值",
      step: "步长",
      stream: "流式输出",
      systemPrompt: "系统提示词",
      temperature: "温度",
      template: "模板",
      tool: "工具名称",
      timeoutMs: "超时时间",
      url: "请求地址",
      value: "值",
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
      condition: {
        expression: "条件表达式",
      },
      delay: {
        durationMs: "等待时长（毫秒）",
      },
      event_trigger: {
        event: "触发事件",
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
      llm: {
        baseUrl: "服务地址",
        apiKey: "API 密钥",
        model: "模型",
        prompt: "提示词",
        temperature: "温度",
        maxTokens: "最大输出 Token",
        stream: "流式输出",
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
