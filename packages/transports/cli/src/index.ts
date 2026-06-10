import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { FlowSdkClient } from "@ai-native-flow/transport-sdk";

export interface CliIo {
  stdout: TextWriter;
  stderr: TextWriter;
  readFile(path: string): Promise<string>;
}

export interface TextWriter {
  write(chunk: string): void | Promise<void>;
}

export interface FlowCliOptions {
  client: FlowSdkClient;
  io: CliIo;
}

export interface FlowCliResult {
  exitCode: number;
  runId?: string;
}

export function createFlowCli(options: FlowCliOptions): FlowCli {
  return new FlowCli(options.client, options.io);
}

/**
 * Thin CLI transport command runner.
 *
 * The CLI owns argument parsing and rendering only. Invocation, event ordering,
 * cancellation and inspection stay delegated to the shared TypeScript SDK.
 */
export class FlowCli {
  constructor(
    private readonly client: FlowSdkClient,
    private readonly io: CliIo,
  ) {}

  async run(argv: readonly string[]): Promise<FlowCliResult> {
    const [command, ...rest] = argv;
    try {
      switch (command) {
        case "run":
          return await this.runFlow(rest);
        case "run-node":
          return await this.runNode(rest);
        case "stream":
          return await this.streamFlow(rest);
        case "stream-node":
          return await this.streamNode(rest);
        case "inspect":
          return await this.inspectRun(rest);
        case "replay":
          return await this.replayRun(rest);
        case "cancel":
          return await this.cancelRun(rest);
        case "help":
        case "--help":
        case "-h":
        case undefined:
          await this.printHelp();
          return { exitCode: 0 };
        default:
          await writeLine(this.io.stderr, `Unknown command: ${command}`);
          await this.printHelp(this.io.stderr);
          return { exitCode: 2 };
      }
    } catch (error) {
      await writeLine(this.io.stderr, renderError(error));
      return { exitCode: 1 };
    }
  }

  private async runFlow(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = await parseFlowInvocationArgs(args, this.io);
    const result = await this.client.invoke(parsed.flowId, parsed.input, {
      flowVersion: parsed.flowVersion,
      traceId: parsed.traceId,
    });
    await writeJsonLine(this.io.stdout, {
      runId: result.runRecord.runId,
      status: result.runRecord.status,
      succeeded: result.succeeded,
      cancelled: result.cancelled,
      output: result.output,
      error: result.error,
    });
    return {
      exitCode: result.succeeded ? 0 : 1,
      runId: result.runRecord.runId,
    };
  }

  /**
   * Sub-graph ("sink-node") synchronous run. Identical CLI surface to
   * `run` plus a mandatory `<nodeId>` positional argument; output is
   * the sink's primary data output instead of the flow's `end` output.
   */
  private async runNode(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = await parseFlowNodeInvocationArgs(args, this.io);
    const result = await this.client.invokeNode(
      parsed.flowId,
      parsed.nodeId,
      parsed.input,
      {
        flowVersion: parsed.flowVersion,
        traceId: parsed.traceId,
      },
    );
    await writeJsonLine(this.io.stdout, {
      runId: result.runRecord.runId,
      flowId: result.runRecord.flowId,
      flowVersion: result.runRecord.flowVersion,
      nodeId: parsed.nodeId,
      status: result.runRecord.status,
      succeeded: result.succeeded,
      cancelled: result.cancelled,
      output: result.output,
      error: result.error,
    });
    return {
      exitCode: result.succeeded ? 0 : 1,
      runId: result.runRecord.runId,
    };
  }

  private async streamFlow(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = await parseFlowInvocationArgs(args, this.io);
    let runId: string | undefined;
    let failed = false;
    for await (const event of this.client.stream(parsed.flowId, parsed.input, {
      flowVersion: parsed.flowVersion,
      traceId: parsed.traceId,
      cursor: parsed.cursor,
    })) {
      runId = event.runId;
      if (event.kind === "run_failed" || event.kind === "run_cancelled") {
        failed = true;
      }
      await writeJsonLine(this.io.stdout, event);
    }
    return { exitCode: failed ? 1 : 0, runId };
  }

  /**
   * Sub-graph variant of `streamFlow`. Streams events from a Run that
   * terminates at `<nodeId>`. Same exit-code policy.
   */
  private async streamNode(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = await parseFlowNodeInvocationArgs(args, this.io);
    let runId: string | undefined;
    let failed = false;
    for await (const event of this.client.streamNode(
      parsed.flowId,
      parsed.nodeId,
      parsed.input,
      {
        flowVersion: parsed.flowVersion,
        traceId: parsed.traceId,
        cursor: parsed.cursor,
      },
    )) {
      runId = event.runId;
      if (event.kind === "run_failed" || event.kind === "run_cancelled") {
        failed = true;
      }
      await writeJsonLine(this.io.stdout, event);
    }
    return { exitCode: failed ? 1 : 0, runId };
  }

  private async inspectRun(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = parseRunArgs(args);
    const run = await this.client.getRun(parsed.runId);
    if (!run) {
      await writeLine(this.io.stderr, `Run not found: ${parsed.runId}`);
      return { exitCode: 1, runId: parsed.runId };
    }
    const events = await this.client.events(parsed.runId, {
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
    await writeJsonLine(this.io.stdout, { run, events });
    return { exitCode: 0, runId: parsed.runId };
  }

  private async replayRun(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = parseRunArgs(args);
    const events = await this.client.replayRun(parsed.runId, {
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
    for (const event of events) {
      await writeJsonLine(this.io.stdout, event);
    }
    return { exitCode: 0, runId: parsed.runId };
  }

  private async cancelRun(args: readonly string[]): Promise<FlowCliResult> {
    const parsed = parseRunArgs(args);
    await this.client.cancel(parsed.runId, parsed.reason ?? "cli cancel requested");
    await writeJsonLine(this.io.stdout, {
      runId: parsed.runId,
      cancelled: true,
    });
    return { exitCode: 0, runId: parsed.runId };
  }

  private async printHelp(writer: CliIo["stdout"] = this.io.stdout): Promise<void> {
    await writeLine(
      writer,
      [
        "Usage:",
        "  flow run <flowId> --input <json-or-file>",
        "  flow run-node <flowId> <nodeId> --input <json-or-file>",
        "  flow stream <flowId> --input <json-or-file> [--cursor <eventId>]",
        "  flow stream-node <flowId> <nodeId> --input <json-or-file> [--cursor <eventId>]",
        "  flow inspect <runId> [--cursor <eventId>] [--limit <n>]",
        "  flow replay <runId> [--cursor <eventId>] [--limit <n>]",
        "  flow cancel <runId> [--reason <text>]",
      ].join("\n"),
    );
  }
}

interface ParsedFlowArgs {
  flowId: string;
  input: unknown;
  flowVersion?: string;
  traceId?: string;
  cursor?: string;
}

interface ParsedFlowNodeArgs extends ParsedFlowArgs {
  nodeId: string;
}

interface ParsedRunArgs {
  runId: string;
  cursor?: string;
  limit?: number;
  reason?: string;
}

async function parseFlowInvocationArgs(
  args: readonly string[],
  io: CliIo,
): Promise<ParsedFlowArgs> {
  const flowId = args[0];
  if (!flowId) throw new Error("Missing flowId");
  const flags = parseFlags(args.slice(1));
  const inputFlag = flags.get("input") ?? flags.get("i");
  if (inputFlag === undefined) throw new Error("Missing --input");
  return {
    flowId,
    input: await parseJsonInput(inputFlag, io),
    flowVersion: flags.get("flow-version") ?? flags.get("version"),
    traceId: flags.get("trace-id"),
    cursor: flags.get("cursor"),
  };
}

/**
 * Like `parseFlowInvocationArgs`, but consumes a `<nodeId>` positional
 * after `<flowId>`. Both positionals are required; flag parsing is
 * identical to the flow-level path.
 */
async function parseFlowNodeInvocationArgs(
  args: readonly string[],
  io: CliIo,
): Promise<ParsedFlowNodeArgs> {
  const flowId = args[0];
  if (!flowId) throw new Error("Missing flowId");
  const nodeId = args[1];
  if (!nodeId || nodeId.startsWith("-")) throw new Error("Missing nodeId");
  const flags = parseFlags(args.slice(2));
  const inputFlag = flags.get("input") ?? flags.get("i");
  if (inputFlag === undefined) throw new Error("Missing --input");
  return {
    flowId,
    nodeId,
    input: await parseJsonInput(inputFlag, io),
    flowVersion: flags.get("flow-version") ?? flags.get("version"),
    traceId: flags.get("trace-id"),
    cursor: flags.get("cursor"),
  };
}

function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  const runId = args[0];
  if (!runId) throw new Error("Missing runId");
  const flags = parseFlags(args.slice(1));
  const limit = flags.get("limit");
  return {
    runId,
    cursor: flags.get("cursor"),
    reason: flags.get("reason"),
    ...(limit !== undefined ? { limit: Number.parseInt(limit, 10) } : {}),
  };
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("-")) continue;
    const key = token.replace(/^-+/, "");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      flags.set(key, "true");
      continue;
    }
    flags.set(key, value);
    index += 1;
  }
  return flags;
}

async function parseJsonInput(value: string, io: CliIo): Promise<unknown> {
  const source = value.startsWith("@") ? await io.readFile(value.slice(1)) : value;
  return JSON.parse(source);
}

async function writeJsonLine(writer: CliIo["stdout"], value: unknown): Promise<void> {
  await writeLine(writer, JSON.stringify(value));
}

async function writeLine(writer: CliIo["stdout"], line: string): Promise<void> {
  await writer.write(`${line}\n`);
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type { NodeEvent };
