import { readFile } from "node:fs/promises";
import type { Runtime } from "@ai-native-flow/runtime";
import { createFlowSdkClient } from "@ai-native-flow/transport-sdk";
import { createFlowCli, type CliIo, type FlowCliResult } from "./index.js";

export interface FlowCliBootstrapOptions {
  runtime: Runtime;
  argv?: readonly string[];
  io?: Partial<CliIo>;
}

export async function runFlowCli(
  options: FlowCliBootstrapOptions,
): Promise<FlowCliResult> {
  const io = createDefaultIo(options.io);
  const cli = createFlowCli({
    client: createFlowSdkClient({ runtime: options.runtime }),
    io,
  });
  return cli.run(options.argv ?? process.argv.slice(2));
}

function createDefaultIo(overrides: Partial<CliIo> = {}): CliIo {
  return {
    stdout: overrides.stdout ?? {
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    },
    stderr: overrides.stderr ?? {
      write: (chunk) => {
        process.stderr.write(chunk);
      },
    },
    readFile: overrides.readFile ?? ((path) => readFile(path, "utf8")),
  };
}
