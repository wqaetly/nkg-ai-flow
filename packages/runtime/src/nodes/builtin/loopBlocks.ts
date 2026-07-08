import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import type { PortDefinition } from "@ai-native-flow/flow-ir";
import { controlIn, controlOut, evaluateCondition } from "./_helpers.js";

const bodyOut: PortDefinition = {
  id: "body",
  direction: "output",
  kind: "control",
  label: "循环体",
};

const bodyDoneIn: PortDefinition = {
  id: "body_done",
  direction: "input",
  kind: "control",
  label: "循环体完成",
};

const doneOut: PortDefinition = {
  id: "done",
  direction: "output",
  kind: "control",
  label: "完成",
};

const maxedOut: PortDefinition = {
  id: "maxed",
  direction: "output",
  kind: "control",
  label: "达到上限",
};

const timeoutOut: PortDefinition = {
  id: "timeout",
  direction: "output",
  kind: "control",
  label: "超时",
};

const loopErrorOut: PortDefinition = {
  id: "error",
  direction: "output",
  kind: "control",
  label: "错误",
};

const breakOut: PortDefinition = {
  id: "break",
  direction: "output",
  kind: "control",
  label: "跳出循环",
};

const continueOut: PortDefinition = {
  id: "continue",
  direction: "output",
  kind: "control",
  label: "继续下一轮",
};

const foreachBeginConfig = z
  .object({
    mode: z.enum(["sequential", "parallel"]).default("sequential"),
    concurrency: z.number().int().min(1).default(1),
    batchSize: z.number().int().min(1).default(1),
    onError: z
      .enum(["terminate", "continue", "break", "route"])
      .default("terminate")
      .describe("Loop-body error policy when the failing node has no local error edge."),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Maximum loop block duration in milliseconds; 0 disables timeout."),
  })
  .passthrough();

export const foreachBeginNode = defineNode({
  type: "foreach_begin",
  typeVersion: "1.0.0",
  title: "ForEach 开始",
  description: "同画布 ForEach 块入口，暴露 item / index / count 循环上下文。",
  kind: "pseudo",
  config: foreachBeginConfig,
  fieldMeta: {
    mode: {
      label: "执行模式",
      control: "select",
      enumOptions: [
        { label: "顺序", value: "sequential" },
        { label: "并行", value: "parallel" },
      ],
    },
    concurrency: {
      label: "并发数",
      control: "number",
    },
    batchSize: {
      label: "批大小",
      control: "number",
    },
    onError: {
      label: "错误策略",
      control: "select",
      enumOptions: [
        { label: "终止运行", value: "terminate" },
        { label: "跳过当前轮", value: "continue" },
        { label: "跳出循环", value: "break" },
        { label: "路由错误", value: "route" },
      ],
    },
    timeoutMs: {
      label: "Timeout (ms)",
      control: "number",
    },
  },
  ports: [
    controlIn,
    bodyOut,
    { id: "items", direction: "input", kind: "data", label: "数组" },
    { id: "item", direction: "output", kind: "data", label: "当前项" },
    { id: "index", direction: "output", kind: "data", label: "索引" },
    { id: "count", direction: "output", kind: "data", label: "总数" },
  ],
  validateInput: false,
  run({ input }) {
    const items = Array.isArray(input.items) ? input.items : [];
    return {
      kind: "success",
      outputs: {
        body: null,
        item: items[0] ?? null,
        index: 0,
        count: items.length,
      },
    };
  },
});

export const foreachEndNode = defineNode({
  type: "foreach_end",
  typeVersion: "1.0.0",
  title: "ForEach 结束",
  description: "同画布 ForEach 块出口，收集循环体结果并输出 results。",
  kind: "pseudo",
  ports: [
    bodyDoneIn,
    doneOut,
    timeoutOut,
    loopErrorOut,
    { id: "result", direction: "input", kind: "data", label: "单次结果", multiple: true },
    { id: "errors", direction: "input", kind: "data", label: "错误列表", multiple: true },
    { id: "results", direction: "output", kind: "data", label: "结果数组" },
    { id: "errors", direction: "output", kind: "data", label: "错误列表" },
    { id: "errorCount", direction: "output", kind: "data", label: "错误数量", schema: { type: "number" } },
    { id: "firstError", direction: "output", kind: "data", label: "首个错误" },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input.result;
    const errors = normalizeErrors(input.errors);
    return {
      kind: "success",
      outputs: {
        done: null,
        results: raw === undefined ? [] : Array.isArray(raw) ? raw : [raw],
        errors,
        errorCount: errors.length,
        firstError: errors[0] ?? null,
      },
    };
  },
});

const forBeginConfig = z
  .object({
    start: z.number().int().default(0),
    end: z.number().int().default(3),
    step: z.number().int().default(1),
    onError: z
      .enum(["terminate", "continue", "break", "route"])
      .default("terminate")
      .describe("Loop-body error policy when the failing node has no local error edge."),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Maximum loop block duration in milliseconds; 0 disables timeout."),
  })
  .passthrough();

export const forBeginNode = defineNode({
  type: "for_begin",
  typeVersion: "1.0.0",
  title: "For 开始",
  description: "固定范围循环块入口，按 start / end / step 暴露 index。",
  kind: "pseudo",
  config: forBeginConfig,
  fieldMeta: {
    start: { label: "起始值", control: "number" },
    end: { label: "结束值", control: "number" },
    step: { label: "步长", control: "number" },
    onError: {
      label: "错误策略",
      control: "select",
      enumOptions: [
        { label: "终止运行", value: "terminate" },
        { label: "跳过当前轮", value: "continue" },
        { label: "跳出循环", value: "break" },
        { label: "路由错误", value: "route" },
      ],
    },
    timeoutMs: { label: "Timeout (ms)", control: "number" },
  },
  ports: [
    controlIn,
    bodyOut,
    { id: "index", direction: "output", kind: "data", label: "索引" },
    { id: "count", direction: "output", kind: "data", label: "总数" },
  ],
  validateInput: false,
  run({ config }) {
    const start = Number(config.start ?? 0);
    const end = Number(config.end ?? start);
    const step = Number(config.step ?? 1) || 1;
    const count = Math.max(0, Math.ceil((end - start) / step));
    return {
      kind: "success",
      outputs: {
        body: null,
        index: start,
        count,
      },
    };
  },
});

export const forEndNode = defineNode({
  type: "for_end",
  typeVersion: "1.0.0",
  title: "For 结束",
  description: "固定范围循环块出口，收集每轮结果。",
  kind: "pseudo",
  ports: [
    bodyDoneIn,
    doneOut,
    timeoutOut,
    loopErrorOut,
    { id: "result", direction: "input", kind: "data", label: "单次结果", multiple: true },
    { id: "errors", direction: "input", kind: "data", label: "错误列表", multiple: true },
    { id: "results", direction: "output", kind: "data", label: "结果数组" },
    { id: "errors", direction: "output", kind: "data", label: "错误列表" },
    { id: "errorCount", direction: "output", kind: "data", label: "错误数量", schema: { type: "number" } },
    { id: "firstError", direction: "output", kind: "data", label: "首个错误" },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input.result;
    const errors = normalizeErrors(input.errors);
    return {
      kind: "success",
      outputs: {
        done: null,
        results: raw === undefined ? [] : Array.isArray(raw) ? raw : [raw],
        errors,
        errorCount: errors.length,
        firstError: errors[0] ?? null,
      },
    };
  },
});

const loopBeginConfig = z
  .object({
    maxIterations: z.number().int().min(1).default(10),
    checkMode: z.enum(["before", "after"]).default("after"),
    onError: z
      .enum(["terminate", "continue", "break", "route"])
      .default("terminate")
      .describe("Loop-body error policy when the failing node has no local error edge."),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Maximum loop block duration in milliseconds; 0 disables timeout."),
  })
  .passthrough();

export const loopBeginNode = defineNode({
  type: "loop_begin",
  typeVersion: "1.0.0",
  title: "Loop 开始",
  description: "While / Until 风格循环块入口，暴露 state 与 iteration。",
  kind: "pseudo",
  config: loopBeginConfig,
  fieldMeta: {
    maxIterations: { label: "最大循环次数", control: "number" },
    timeoutMs: { label: "Timeout (ms)", control: "number" },
    onError: {
      label: "错误策略",
      control: "select",
      enumOptions: [
        { label: "终止运行", value: "terminate" },
        { label: "跳过当前轮", value: "continue" },
        { label: "跳出循环", value: "break" },
        { label: "路由错误", value: "route" },
      ],
    },
    checkMode: {
      label: "检查时机",
      control: "select",
      enumOptions: [
        { label: "进入前", value: "before" },
        { label: "执行后", value: "after" },
      ],
    },
  },
  ports: [
    controlIn,
    bodyOut,
    { id: "initialState", direction: "input", kind: "data", label: "初始状态" },
    { id: "state", direction: "output", kind: "data", label: "当前状态" },
    { id: "iteration", direction: "output", kind: "data", label: "轮次" },
  ],
  validateInput: false,
  run({ input }) {
    return {
      kind: "success",
      outputs: {
        body: null,
        state: input.initialState ?? input.input ?? null,
        iteration: 0,
      },
    };
  },
});

const loopEndConfig = z
  .object({
    condition: z.string().default("nextState.continue == \"true\""),
  })
  .passthrough();

export const loopEndNode = defineNode({
  type: "loop_end",
  typeVersion: "1.0.0",
  title: "Loop 结束",
  description: "While / Until 风格循环块出口，根据 condition 决定完成或达到上限。",
  kind: "pseudo",
  config: loopEndConfig,
  fieldMeta: {
    condition: {
      label: "继续条件",
      control: "input",
      placeholder: "nextState.continue == \"true\"",
    },
  },
  ports: [
    bodyDoneIn,
    doneOut,
    maxedOut,
    timeoutOut,
    loopErrorOut,
    { id: "nextState", direction: "input", kind: "data", label: "下一状态" },
    { id: "errors", direction: "input", kind: "data", label: "错误列表", multiple: true },
    { id: "finalState", direction: "output", kind: "data", label: "最终状态" },
    { id: "errors", direction: "output", kind: "data", label: "错误列表" },
    { id: "errorCount", direction: "output", kind: "data", label: "错误数量", schema: { type: "number" } },
    { id: "firstError", direction: "output", kind: "data", label: "首个错误" },
  ],
  validateInput: false,
  run({ input, config }) {
    const nextState = input.nextState ?? input.input ?? null;
    const errors = normalizeErrors(input.errors);
    const shouldContinue = evaluateCondition(config.condition ?? "", {
      nextState,
      input: nextState,
    });
    return {
      kind: "success",
      outputs: {
        [shouldContinue ? "maxed" : "done"]: null,
        finalState: nextState,
        errors,
        errorCount: errors.length,
        firstError: errors[0] ?? null,
      },
    };
  },
});

export const loopBreakNode = defineNode({
  type: "loop_break",
  typeVersion: "1.0.0",
  title: "Loop Break",
  description: "在循环体内提前结束 foreach / for / loop 块。",
  kind: "pseudo",
  ports: [controlIn, breakOut],
  validateInput: false,
  run() {
    return {
      kind: "success",
      outputs: { break: null },
    };
  },
});

export const loopContinueNode = defineNode({
  type: "loop_continue",
  typeVersion: "1.0.0",
  title: "Loop Continue",
  description: "在循环体内跳过当前迭代剩余步骤，继续下一轮。",
  kind: "pseudo",
  ports: [controlIn, continueOut],
  validateInput: false,
  run() {
    return {
      kind: "success",
      outputs: { continue: null },
    };
  },
});

function normalizeErrors(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [value];
  return value.flatMap((item) => (Array.isArray(item) ? item : [item]));
}
