/**
 * Public entry point for `@ai-native-flow/node-sdk`.
 *
 * Authors should only ever need three symbols:
 *
 *   - `defineNode`         : declare a node with Zod-typed config / input / output.
 *   - `defineNodeFactory`  : same, but bind external dependencies via a factory.
 *   - `installNode(s)`     : register a `DefinedNode` into a runtime target.
 *
 * Re-export the full type surface so authoring tools can build types
 * without import gymnastics.
 */

export { defineNode } from "./defineNode.js";
export {
  defineNodeFactory,
  isNodeFactory,
} from "./defineNodeFactory.js";
export {
  installNode,
  installNodes,
  type InstallTarget,
} from "./installNode.js";
export {
  describeZodFields,
  mergeFieldMeta,
} from "./describeZodFields.js";
export type {
  DefinedNode,
  DefineNodeSpec,
  NodeFactory,
  SdkInternalRunner,
  SdkNodeContext,
  SdkNodeResult,
  SdkRunArgs,
  SdkRunFn,
} from "./types.js";
