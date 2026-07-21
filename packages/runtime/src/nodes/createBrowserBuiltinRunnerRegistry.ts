/**
 * Browser/mobile-safe built-in runner catalogue.
 *
 * This module deliberately does not import `agentTools.node.ts`. Agent and
 * tool contracts stay visible on every host, while a restricted injected
 * `AgentToolHost` controls execution; the fallback host grants no filesystem
 * or process access.
 */
import {
  RuntimeErrorException,
  type InMemoryNodeTypeRegistry,
  type NodeCapabilities,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import { installNode, type InstallTarget } from "@ai-native-flow/node-sdk";
import type { SandboxAdapter } from "@ai-native-flow/sandbox";
import type { NodeRunner } from "../nodeContext.js";
import { InMemoryNodeRunnerRegistry } from "../nodeRunnerRegistry.js";
import {
  agentNode,
  allSuccessNode,
  anySuccessNode,
  approvalNode,
  auditLogNode,
  batchItemsNode,
  batchWindowNode,
  branchTimeoutNode,
  cacheNode,
  checkpointNode,
  circuitBreakerNode,
  compareGateNode,
  compensationNode,
  concatItemsNode,
  conditionNode,
  cooldownGateNode,
  cronScheduleNode,
  deadlineNode,
  deadLetterNode,
  delayNode,
  deletePathNode,
  distinctUntilChangedNode,
  emptyGateNode,
  endNode,
  errorClassifierNode,
  eventTriggerNode,
  expressionEvalNode,
  failFastNode,
  fallbackNode,
  featureFlagNode,
  filterItemsNode,
  firstSuccessNode,
  flattenItemsNode,
  foreachBeginNode,
  foreachEndNode,
  forBeginNode,
  forEndNode,
  groupItemsNode,
  createHttpNode,
  idempotencyKeyNode,
  joinNode,
  llmNode,
  loopBeginNode,
  loopBreakNode,
  loopContinueNode,
  loopEndNode,
  mapItemsNode,
  mergeNode,
  mergeObjectNode,
  metricNode,
  mutexNode,
  parallelNode,
  parseJsonNode,
  partialSuccessNode,
  policyGateNode,
  queueNode,
  quorumNode,
  raceNode,
  rateLimitNode,
  reduceItemsNode,
  resumePointNode,
  retryPolicyNode,
  retryStateNode,
  rollbackNode,
  scheduleWindowNode,
  schemaGuardNode,
  schemaTransformNode,
  selectPathNode,
  semaphoreNode,
  sendEventNode,
  setPathNode,
  signalResumeNode,
  sliceItemsNode,
  sortItemsNode,
  splitTextNode,
  startNode,
  stateGetNode,
  stateSetNode,
  stringifyJsonNode,
  subflowNode,
  subflowTemplateNode,
  switchCaseNode,
  textInputNode,
  toolNode,
  transformNode,
  uniqueItemsNode,
  waitSignalNode,
  waitTimerNode,
  windowItemsNode,
} from "./builtin/index.js";
import type { AgentToolHost } from "./builtin/agent.js";
import type { LlmProvider } from "./llmProvider.js";
import { LazyAiSdkOpenAICompatibleLlmProvider } from "./lazyLlmProvider.js";

export interface CreateBrowserBuiltinRunnerRegistryOptions {
  llmProvider?: LlmProvider;
  sandboxAdapter?: SandboxAdapter;
  nodeTypeRegistry?: InMemoryNodeTypeRegistry;
  /** Native/mobile-safe tools only. Omit to install a deny-all host. */
  toolHost?: AgentToolHost;
  /** Host-owned HTTP implementation used by HTTP and the default LLM provider. */
  fetch?: typeof fetch;
}

export function createBrowserBuiltinRunnerRegistry(
  options: CreateBrowserBuiltinRunnerRegistryOptions = {},
): InMemoryNodeRunnerRegistry {
  const registry = new InMemoryNodeRunnerRegistry(
    options.sandboxAdapter ? { sandboxAdapter: options.sandboxAdapter } : {},
  );
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const llmProvider = options.llmProvider ?? new LazyAiSdkOpenAICompatibleLlmProvider({ fetchImpl });
  const toolHost: AgentToolHost = options.toolHost ?? {
    async callTool() {
      return { ok: false, error: "runtime tool host is unavailable" };
    },
  };
  const target = makeInstallTarget(registry, options.nodeTypeRegistry);

  const portableNodes = [
    startNode,
    endNode,
    allSuccessNode,
    anySuccessNode,
    errorClassifierNode,
    fallbackNode,
    transformNode,
    approvalNode,
    auditLogNode,
    batchItemsNode,
    batchWindowNode,
    branchTimeoutNode,
    cacheNode,
    checkpointNode,
    circuitBreakerNode,
    compareGateNode,
    concatItemsNode,
    compensationNode,
    conditionNode,
    cooldownGateNode,
    cronScheduleNode,
    deadlineNode,
    deadLetterNode,
    deletePathNode,
    delayNode,
    distinctUntilChangedNode,
    emptyGateNode,
    expressionEvalNode,
    failFastNode,
    filterItemsNode,
    flattenItemsNode,
    firstSuccessNode,
    groupItemsNode,
    createHttpNode(fetchImpl),
    idempotencyKeyNode,
    joinNode,
    mapItemsNode,
    mergeNode,
    mergeObjectNode,
    metricNode,
    mutexNode,
    parallelNode,
    partialSuccessNode,
    parseJsonNode,
    policyGateNode,
    queueNode,
    quorumNode,
    raceNode,
    rateLimitNode,
    reduceItemsNode,
    retryPolicyNode,
    retryStateNode,
    resumePointNode,
    rollbackNode,
    scheduleWindowNode,
    schemaGuardNode,
    schemaTransformNode,
    selectPathNode,
    semaphoreNode,
    setPathNode,
    sliceItemsNode,
    sortItemsNode,
    splitTextNode,
    subflowNode,
    subflowTemplateNode,
    switchCaseNode,
    stringifyJsonNode,
  ];
  for (const node of portableNodes) installNode(target, node);

  installNode(target, toolNode, { toolHost });

  const postToolNodes = [
    uniqueItemsNode,
    windowItemsNode,
    textInputNode,
    waitSignalNode,
    signalResumeNode,
    waitTimerNode,
  ];
  for (const node of postToolNodes) installNode(target, node);
  installNode(target, llmNode, { llmProvider });

  installNode(target, agentNode, { llmProvider, toolHost });

  const postAgentNodes = [
    eventTriggerNode,
    featureFlagNode,
    sendEventNode,
    stateGetNode,
    stateSetNode,
    foreachBeginNode,
    foreachEndNode,
    forBeginNode,
    forEndNode,
    loopBeginNode,
    loopBreakNode,
    loopContinueNode,
    loopEndNode,
  ];
  for (const node of postAgentNodes) installNode(target, node);

  return registry;
}

function makeInstallTarget(
  runners: InMemoryNodeRunnerRegistry,
  types: InMemoryNodeTypeRegistry | undefined,
): InstallTarget {
  return {
    registerType(definition: NodeTypeDefinition, capabilities?: NodeCapabilities): void {
      if (!types || types.has(definition.type, definition.typeVersion)) return;
      try {
        types.register(definition, capabilities);
      } catch (cause) {
        if (
          cause instanceof RuntimeErrorException &&
          cause.error.code === "registry.version_conflict"
        ) return;
        throw cause;
      }
    },
    registerRunner(type, typeVersion, runner): void {
      runners.register(type, typeVersion, runner as unknown as NodeRunner);
    },
  };
}
