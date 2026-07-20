import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

function pkg(path: string): string {
  return resolve(root, path);
}

export default defineConfig({
  resolve: {
    alias: [
      { find: "@ai-native-flow/flow-ir", replacement: pkg("packages/flow-ir/src/index.ts") },
      { find: "@ai-native-flow/flow-validator", replacement: pkg("packages/flow-validator/src/index.ts") },
      { find: "@ai-native-flow/flow-builder", replacement: pkg("packages/flow-builder/src/index.ts") },
      { find: "@ai-native-flow/builder-runner", replacement: pkg("packages/builder-runner/src/index.ts") },
      { find: "@ai-native-flow/event-bus", replacement: pkg("packages/event-bus/src/index.ts") },
      { find: "@ai-native-flow/variable-store/browser", replacement: pkg("packages/variable-store/src/browser.ts") },
      { find: "@ai-native-flow/variable-store", replacement: pkg("packages/variable-store/src/index.ts") },
      { find: "@ai-native-flow/node-sdk", replacement: pkg("packages/node-sdk/src/index.ts") },
      { find: "@ai-native-flow/ai-stream", replacement: pkg("packages/ai-stream/src/index.ts") },
      { find: "@ai-native-flow/sandbox", replacement: pkg("packages/sandbox/src/index.ts") },
      { find: "@ai-native-flow/runtime/browser", replacement: pkg("packages/runtime/src/browser.ts") },
      { find: "@ai-native-flow/runtime", replacement: pkg("packages/runtime/src/index.ts") },
      { find: "@ai-native-flow/transport-http/portable", replacement: pkg("packages/transport-http/src/portableRuntime.ts") },
      { find: "@ai-native-flow/transport-http", replacement: pkg("packages/transport-http/src/index.ts") },
      { find: "@ai-native-flow/transport-sdk", replacement: pkg("packages/transports/sdk/src/index.ts") },
      { find: "@ai-native-flow/transport-cli", replacement: pkg("packages/transports/cli/src/index.ts") },
      { find: "@ai-native-flow/transport-mcp", replacement: pkg("packages/transports/mcp/src/index.ts") },
      { find: "@ai-native-flow/studio", replacement: pkg("packages/studio/src/index.ts") },
    ],
  },
});
