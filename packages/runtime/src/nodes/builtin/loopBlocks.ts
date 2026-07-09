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

const loopControlConfig = z
  .object({
    reason: z.string().default("").describe("Optional break/continue reason for trace and downstream data."),
  })
  .passthrough();

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
    { id: "mode", direction: "input", kind: "data", label: "执行模式", schema: { type: "string" } },
    { id: "concurrency", direction: "input", kind: "data", label: "并发数", schema: { type: "number" } },
    { id: "batchSize", direction: "input", kind: "data", label: "批大小", schema: { type: "number" } },
    { id: "onError", direction: "input", kind: "data", label: "错误策略", schema: { type: "string" } },
    { id: "timeoutMs", direction: "input", kind: "data", label: "超时毫秒", schema: { type: "number" } },
    { id: "item", direction: "output", kind: "data", label: "当前项" },
    { id: "index", direction: "output", kind: "data", label: "索引" },
    { id: "count", direction: "output", kind: "data", label: "总数" },
    { id: "iterationId", direction: "output", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "output", kind: "data", label: "迭代定位键", schema: { type: "string" } },
    { id: "iterationSequence", direction: "output", kind: "data", label: "迭代序号", schema: { type: "number" } },
    { id: "mode", direction: "output", kind: "data", label: "执行模式", schema: { type: "string" } },
    { id: "concurrency", direction: "output", kind: "data", label: "并发数", schema: { type: "number" } },
    { id: "batchSize", direction: "output", kind: "data", label: "批大小", schema: { type: "number" } },
    { id: "effectiveConcurrency", direction: "output", kind: "data", label: "有效并发数", schema: { type: "number" } },
    { id: "effectiveBatchSize", direction: "output", kind: "data", label: "有效批大小", schema: { type: "number" } },
    { id: "concurrencyLimited", direction: "output", kind: "data", label: "是否限流", schema: { type: "boolean" } },
    { id: "batchCount", direction: "output", kind: "data", label: "批次数量", schema: { type: "number" } },
    { id: "batchIndex", direction: "output", kind: "data", label: "当前批次索引", schema: { type: "number" } },
    { id: "batchStart", direction: "output", kind: "data", label: "当前批次起点", schema: { type: "number" } },
    { id: "batchEnd", direction: "output", kind: "data", label: "当前批次终点", schema: { type: "number" } },
    { id: "batchItemCount", direction: "output", kind: "data", label: "当前批次数量", schema: { type: "number" } },
    { id: "batchPartial", direction: "output", kind: "data", label: "是否部分批次", schema: { type: "boolean" } },
    { id: "batchRanges", direction: "output", kind: "data", label: "批次范围" },
    { id: "onError", direction: "output", kind: "data", label: "错误策略", schema: { type: "string" } },
    { id: "timeoutMs", direction: "output", kind: "data", label: "超时毫秒", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config }) {
    const items = Array.isArray(input.items) ? input.items : [];
    const mode = readForeachMode(input.mode ?? config.mode);
    const concurrency = Math.max(1, Math.trunc(readNumber(input.concurrency, Number(config.concurrency ?? 1))));
    const batchSize = Math.max(1, Math.trunc(readNumber(input.batchSize, Number(config.batchSize ?? 1))));
    const onError = readLoopErrorPolicyInput(input.onError ?? config.onError);
    const timeoutMs = Math.max(0, Math.trunc(readNumber(input.timeoutMs, Number(config.timeoutMs ?? 0))));
    const schedule = foreachSchedule(items.length, mode, concurrency, batchSize);
    return {
      kind: "success",
      outputs: {
        body: null,
        item: items[0] ?? null,
        index: 0,
        count: items.length,
        iterationId: "foreach_begin:0",
        iterationKey: "foreach_begin:0",
        iterationSequence: 0,
        ...foreachIterationSchedule(0, schedule),
        mode,
        concurrency,
        batchSize,
        effectiveConcurrency: schedule.effectiveConcurrency,
        effectiveBatchSize: schedule.effectiveBatchSize,
        concurrencyLimited: schedule.concurrencyLimited,
        batchCount: schedule.batchCount,
        batchRanges: schedule.batchRanges,
        onError,
        timeoutMs,
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
    { id: "iterationIds", direction: "input", kind: "data", label: "迭代 ID 列表", multiple: true },
    { id: "iterationKeys", direction: "input", kind: "data", label: "迭代定位键列表", multiple: true },
    { id: "iterationSequences", direction: "input", kind: "data", label: "迭代序号列表", multiple: true },
    { id: "errors", direction: "input", kind: "data", label: "错误列表", multiple: true },
    { id: "results", direction: "output", kind: "data", label: "结果数组" },
    { id: "iterationIds", direction: "output", kind: "data", label: "迭代 ID 列表" },
    { id: "iterationKeys", direction: "output", kind: "data", label: "迭代定位键列表" },
    { id: "iterationSequences", direction: "output", kind: "data", label: "迭代序号列表" },
    { id: "lastIterationId", direction: "output", kind: "data", label: "最后迭代 ID", schema: { type: "string" } },
    { id: "lastIterationKey", direction: "output", kind: "data", label: "最后迭代定位键" },
    { id: "lastIterationSequence", direction: "output", kind: "data", label: "最后迭代序号", schema: { type: "number" } },
    { id: "errors", direction: "output", kind: "data", label: "错误列表" },
    { id: "errorCount", direction: "output", kind: "data", label: "错误数量", schema: { type: "number" } },
    { id: "firstError", direction: "output", kind: "data", label: "首个错误" },
    { id: "status", direction: "output", kind: "data", label: "状态", schema: { type: "string" } },
    { id: "iterationCount", direction: "output", kind: "data", label: "迭代次数", schema: { type: "number" } },
    { id: "controlReason", direction: "output", kind: "data", label: "控制原因", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input.result;
    const errors = normalizeErrors(input.errors);
    const results = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const trace = readLoopTrace(input);
    return {
      kind: "success",
      outputs: {
        done: null,
        results,
        ...trace,
        errors,
        errorCount: errors.length,
        firstError: errors[0] ?? null,
        status: readLoopStatus(input.__status, "done"),
        iterationCount: readLoopIterationCount(input.__iterationCount, results.length),
        controlReason: readLoopControlReason(input.__controlReason, ""),
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
    { id: "start", direction: "input", kind: "data", label: "起始值", schema: { type: "number" } },
    { id: "end", direction: "input", kind: "data", label: "结束值", schema: { type: "number" } },
    { id: "step", direction: "input", kind: "data", label: "步长", schema: { type: "number" } },
    { id: "onError", direction: "input", kind: "data", label: "错误策略", schema: { type: "string" } },
    { id: "timeoutMs", direction: "input", kind: "data", label: "超时毫秒", schema: { type: "number" } },
    { id: "index", direction: "output", kind: "data", label: "索引" },
    { id: "count", direction: "output", kind: "data", label: "总数" },
    { id: "iterationId", direction: "output", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "output", kind: "data", label: "迭代定位键", schema: { type: "string" } },
    { id: "iterationSequence", direction: "output", kind: "data", label: "迭代序号", schema: { type: "number" } },
    { id: "rangeValues", direction: "output", kind: "data", label: "范围值" },
    { id: "firstIndex", direction: "output", kind: "data", label: "首个索引", schema: { type: "number" } },
    { id: "lastIndex", direction: "output", kind: "data", label: "最后索引", schema: { type: "number" } },
    { id: "direction", direction: "output", kind: "data", label: "方向", schema: { type: "string" } },
    { id: "remainingIterations", direction: "output", kind: "data", label: "剩余迭代数", schema: { type: "number" } },
    { id: "start", direction: "output", kind: "data", label: "起始值", schema: { type: "number" } },
    { id: "end", direction: "output", kind: "data", label: "结束值", schema: { type: "number" } },
    { id: "step", direction: "output", kind: "data", label: "步长", schema: { type: "number" } },
    { id: "onError", direction: "output", kind: "data", label: "错误策略", schema: { type: "string" } },
    { id: "timeoutMs", direction: "output", kind: "data", label: "超时毫秒", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config }) {
    const start = readNumber(input.start, Number(config.start ?? 0));
    const end = readNumber(input.end, Number(config.end ?? start));
    const step = readNumber(input.step, Number(config.step ?? 1)) || 1;
    const onError = readLoopErrorPolicyInput(input.onError ?? config.onError);
    const timeoutMs = Math.max(0, Math.trunc(readNumber(input.timeoutMs, Number(config.timeoutMs ?? 0))));
    const values = forRange(start, end, step);
    const metadata = forIterationMetadata(values, 0);
    return {
      kind: "success",
      outputs: {
        body: null,
        index: values[0] ?? start,
        count: values.length,
        iterationId: "for_begin:0",
        iterationKey: "for_begin:0",
        iterationSequence: 0,
        ...metadata,
        start,
        end,
        step,
        onError,
        timeoutMs,
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
    { id: "iterationIds", direction: "input", kind: "data", label: "迭代 ID 列表", multiple: true },
    { id: "iterationKeys", direction: "input", kind: "data", label: "迭代定位键列表", multiple: true },
    { id: "iterationSequences", direction: "input", kind: "data", label: "迭代序号列表", multiple: true },
    { id: "errors", direction: "input", kind: "data", label: "错误列表", multiple: true },
    { id: "results", direction: "output", kind: "data", label: "结果数组" },
    { id: "iterationIds", direction: "output", kind: "data", label: "迭代 ID 列表" },
    { id: "iterationKeys", direction: "output", kind: "data", label: "迭代定位键列表" },
    { id: "iterationSequences", direction: "output", kind: "data", label: "迭代序号列表" },
    { id: "lastIterationId", direction: "output", kind: "data", label: "最后迭代 ID", schema: { type: "string" } },
    { id: "lastIterationKey", direction: "output", kind: "data", label: "最后迭代定位键" },
    { id: "lastIterationSequence", direction: "output", kind: "data", label: "最后迭代序号", schema: { type: "number" } },
    { id: "errors", direction: "output", kind: "data", label: "错误列表" },
    { id: "errorCount", direction: "output", kind: "data", label: "错误数量", schema: { type: "number" } },
    { id: "firstError", direction: "output", kind: "data", label: "首个错误" },
    { id: "status", direction: "output", kind: "data", label: "状态", schema: { type: "string" } },
    { id: "iterationCount", direction: "output", kind: "data", label: "迭代次数", schema: { type: "number" } },
    { id: "controlReason", direction: "output", kind: "data", label: "控制原因", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input }) {
    const raw = input.result;
    const errors = normalizeErrors(input.errors);
    const results = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const trace = readLoopTrace(input);
    return {
      kind: "success",
      outputs: {
        done: null,
        results,
        ...trace,
        errors,
        errorCount: errors.length,
        firstError: errors[0] ?? null,
        status: readLoopStatus(input.__status, "done"),
        iterationCount: readLoopIterationCount(input.__iterationCount, results.length),
        controlReason: readLoopControlReason(input.__controlReason, ""),
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
    { id: "maxIterations", direction: "input", kind: "data", label: "最大循环次数", schema: { type: "number" } },
    { id: "checkMode", direction: "input", kind: "data", label: "检查时机", schema: { type: "string" } },
    { id: "onError", direction: "input", kind: "data", label: "错误策略", schema: { type: "string" } },
    { id: "timeoutMs", direction: "input", kind: "data", label: "超时毫秒", schema: { type: "number" } },
    { id: "state", direction: "output", kind: "data", label: "当前状态" },
    { id: "iteration", direction: "output", kind: "data", label: "轮次" },
    { id: "iterationId", direction: "output", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "output", kind: "data", label: "迭代定位键", schema: { type: "string" } },
    { id: "iterationSequence", direction: "output", kind: "data", label: "迭代序号", schema: { type: "number" } },
    { id: "maxIterations", direction: "output", kind: "data", label: "最大循环次数", schema: { type: "number" } },
    { id: "checkMode", direction: "output", kind: "data", label: "检查时机", schema: { type: "string" } },
    { id: "onError", direction: "output", kind: "data", label: "错误策略", schema: { type: "string" } },
    { id: "timeoutMs", direction: "output", kind: "data", label: "超时毫秒", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config }) {
    const maxIterations = Math.max(1, Math.trunc(readNumber(input.maxIterations, Number(config.maxIterations ?? 10))));
    const checkMode = readCheckMode(input.checkMode ?? config.checkMode);
    const onError = readLoopErrorPolicyInput(input.onError ?? config.onError);
    const timeoutMs = Math.max(0, Math.trunc(readNumber(input.timeoutMs, Number(config.timeoutMs ?? 0))));
    return {
      kind: "success",
      outputs: {
        body: null,
        state: input.initialState ?? input.input ?? null,
        iteration: 0,
        iterationId: "loop_begin:0",
        iterationKey: "loop_begin:0",
        iterationSequence: 0,
        maxIterations,
        checkMode,
        onError,
        timeoutMs,
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
    { id: "condition", direction: "input", kind: "data", label: "继续条件", schema: { type: "string" } },
    { id: "iterationIds", direction: "input", kind: "data", label: "迭代 ID 列表", multiple: true },
    { id: "iterationKeys", direction: "input", kind: "data", label: "迭代定位键列表", multiple: true },
    { id: "iterationSequences", direction: "input", kind: "data", label: "迭代序号列表", multiple: true },
    { id: "errors", direction: "input", kind: "data", label: "错误列表", multiple: true },
    { id: "finalState", direction: "output", kind: "data", label: "最终状态" },
    { id: "condition", direction: "output", kind: "data", label: "继续条件", schema: { type: "string" } },
    { id: "iterationIds", direction: "output", kind: "data", label: "迭代 ID 列表" },
    { id: "iterationKeys", direction: "output", kind: "data", label: "迭代定位键列表" },
    { id: "iterationSequences", direction: "output", kind: "data", label: "迭代序号列表" },
    { id: "lastIterationId", direction: "output", kind: "data", label: "最后迭代 ID", schema: { type: "string" } },
    { id: "lastIterationKey", direction: "output", kind: "data", label: "最后迭代定位键" },
    { id: "lastIterationSequence", direction: "output", kind: "data", label: "最后迭代序号", schema: { type: "number" } },
    { id: "errors", direction: "output", kind: "data", label: "错误列表" },
    { id: "errorCount", direction: "output", kind: "data", label: "错误数量", schema: { type: "number" } },
    { id: "firstError", direction: "output", kind: "data", label: "首个错误" },
    { id: "status", direction: "output", kind: "data", label: "状态", schema: { type: "string" } },
    { id: "iterationCount", direction: "output", kind: "data", label: "迭代次数", schema: { type: "number" } },
    { id: "controlReason", direction: "output", kind: "data", label: "控制原因", schema: { type: "string" } },
  ],
  validateInput: false,
  run({ input, config }) {
    const nextState = input.nextState ?? input.input ?? null;
    const errors = normalizeErrors(input.errors);
    const condition = String(input.condition ?? config.condition ?? "");
    const trace = readLoopTrace(input);
    const shouldContinue = evaluateCondition(condition, {
      nextState,
      input: nextState,
    });
    return {
      kind: "success",
      outputs: {
        [shouldContinue ? "maxed" : "done"]: null,
        finalState: nextState,
        condition,
        ...trace,
        errors,
        errorCount: errors.length,
        firstError: errors[0] ?? null,
        status: readLoopStatus(input.__status, shouldContinue ? "maxed" : "done"),
        iterationCount: readLoopIterationCount(input.__iterationCount, 0),
        controlReason: readLoopControlReason(input.__controlReason, ""),
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
  config: loopControlConfig,
  fieldMeta: {
    reason: {
      label: "Reason",
      control: "input",
      placeholder: "stop_when_found",
    },
  },
  ports: [
    controlIn,
    { id: "reason", direction: "input", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "iterationId", direction: "input", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "input", kind: "data", label: "迭代定位键" },
    { id: "iterationSequence", direction: "input", kind: "data", label: "迭代序号", schema: { type: "number" } },
    breakOut,
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "iterationId", direction: "output", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "output", kind: "data", label: "迭代定位键" },
    { id: "iterationSequence", direction: "output", kind: "data", label: "迭代序号", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config }) {
    const reason = readLoopControlReason(input.reason, config.reason);
    return {
      kind: "success",
      outputs: {
        break: null,
        reason,
        status: "break",
        iterationId: input.iterationId ?? null,
        iterationKey: input.iterationKey ?? null,
        iterationSequence: input.iterationSequence ?? null,
      },
    };
  },
});

export const loopContinueNode = defineNode({
  type: "loop_continue",
  typeVersion: "1.0.0",
  title: "Loop Continue",
  description: "在循环体内跳过当前迭代剩余步骤，继续下一轮。",
  kind: "pseudo",
  config: loopControlConfig,
  fieldMeta: {
    reason: {
      label: "Reason",
      control: "input",
      placeholder: "skip_current_item",
    },
  },
  ports: [
    controlIn,
    { id: "reason", direction: "input", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "iterationId", direction: "input", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "input", kind: "data", label: "迭代定位键" },
    { id: "iterationSequence", direction: "input", kind: "data", label: "迭代序号", schema: { type: "number" } },
    continueOut,
    { id: "reason", direction: "output", kind: "data", label: "Reason", schema: { type: "string" } },
    { id: "status", direction: "output", kind: "data", label: "Status", schema: { type: "string" } },
    { id: "iterationId", direction: "output", kind: "data", label: "迭代 ID", schema: { type: "string" } },
    { id: "iterationKey", direction: "output", kind: "data", label: "迭代定位键" },
    { id: "iterationSequence", direction: "output", kind: "data", label: "迭代序号", schema: { type: "number" } },
  ],
  validateInput: false,
  run({ input, config }) {
    const reason = readLoopControlReason(input.reason, config.reason);
    return {
      kind: "success",
      outputs: {
        continue: null,
        reason,
        status: "continue",
        iterationId: input.iterationId ?? null,
        iterationKey: input.iterationKey ?? null,
        iterationSequence: input.iterationSequence ?? null,
      },
    };
  },
});

function normalizeErrors(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [value];
  return value.flatMap((item) => (Array.isArray(item) ? item : [item]));
}

function readLoopTrace(input: Record<string, unknown>): {
  iterationIds: unknown[];
  iterationKeys: unknown[];
  iterationSequences: unknown[];
  lastIterationId: unknown;
  lastIterationKey: unknown;
  lastIterationSequence: unknown;
} {
  const iterationIds = normalizeTraceList(input.iterationIds);
  const iterationKeys = normalizeTraceList(input.iterationKeys);
  const iterationSequences = normalizeTraceList(input.iterationSequences);
  return {
    iterationIds,
    iterationKeys,
    iterationSequences,
    lastIterationId: lastTraceValue(iterationIds),
    lastIterationKey: lastTraceValue(iterationKeys),
    lastIterationSequence: lastTraceValue(iterationSequences),
  };
}

function normalizeTraceList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function lastTraceValue(values: unknown[]): unknown {
  return values.length > 0 ? values[values.length - 1] : null;
}

function readLoopStatus(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function readLoopIterationCount(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readLoopControlReason(inputReason: unknown, configReason: unknown): string {
  const value = inputReason ?? configReason ?? "";
  return typeof value === "string" ? value : String(value);
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readLoopErrorPolicyInput(value: unknown): string {
  return value === "continue" || value === "break" || value === "route" ? value : "terminate";
}

function readCheckMode(value: unknown): "before" | "after" {
  return value === "before" ? "before" : "after";
}

function readForeachMode(value: unknown): "sequential" | "parallel" {
  return value === "parallel" ? "parallel" : "sequential";
}

interface ForeachBatchRange {
  index: number;
  start: number;
  end: number;
  count: number;
  partial: boolean;
}

interface ForeachSchedule {
  effectiveConcurrency: number;
  effectiveBatchSize: number;
  concurrencyLimited: boolean;
  batchCount: number;
  batchRanges: ForeachBatchRange[];
}

function foreachSchedule(
  count: number,
  mode: "sequential" | "parallel",
  concurrency: number,
  batchSize: number,
): ForeachSchedule {
  const effectiveBatchSize = mode === "parallel" ? Math.max(1, batchSize) : 1;
  const effectiveConcurrency = mode === "parallel" ? Math.max(1, concurrency) : 1;
  const batchRanges: ForeachBatchRange[] = [];
  for (let start = 0; start < count; start += effectiveBatchSize) {
    const end = Math.min(count, start + effectiveBatchSize);
    batchRanges.push({
      index: batchRanges.length,
      start,
      end,
      count: end - start,
      partial: end - start < effectiveBatchSize,
    });
  }
  return {
    effectiveConcurrency,
    effectiveBatchSize,
    concurrencyLimited:
      mode === "parallel" &&
      count > 0 &&
      effectiveConcurrency < Math.min(effectiveBatchSize, count),
    batchCount: batchRanges.length,
    batchRanges,
  };
}

function foreachIterationSchedule(index: number, schedule: ForeachSchedule): Record<string, unknown> {
  const range =
    schedule.batchRanges.find((candidate) => index >= candidate.start && index < candidate.end) ??
    null;
  return {
    batchIndex: range?.index ?? -1,
    batchStart: range?.start ?? -1,
    batchEnd: range?.end ?? -1,
    batchItemCount: range?.count ?? 0,
    batchPartial: range?.partial ?? false,
  };
}

function forRange(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  if (step > 0) {
    for (let index = start; index < end; index += step) values.push(index);
  } else {
    for (let index = start; index > end; index += step) values.push(index);
  }
  return values;
}

function forIterationMetadata(values: number[], iteration: number): Record<string, unknown> {
  const firstIndex = values[0] ?? null;
  const lastIndex = values.length > 0 ? values[values.length - 1] : null;
  return {
    rangeValues: values,
    firstIndex,
    lastIndex,
    direction:
      values.length === 0
        ? "empty"
        : Number(firstIndex) <= Number(lastIndex)
          ? "ascending"
          : "descending",
    remainingIterations: Math.max(0, values.length - iteration - 1),
  };
}
