import type { FlowGraph } from "@ai-native-flow/flow-ir";
import {
  createBrowserRuntime,
  type CreateBrowserRuntimeOptions,
  type Runtime,
} from "@ai-native-flow/runtime/browser";
import {
  createHttpHandler,
  type CreateHttpHandlerOptions,
  type HttpHandler,
} from "./handler.js";

export interface CreatePortableHttpRuntimeOptions
  extends CreateBrowserRuntimeOptions {
  /** Flow artifacts registered and promoted before the handler is returned. */
  flows?: ReadonlyArray<FlowGraph | string>;
  /** HTTP transport policy owned by the embedding host. */
  http?: Omit<CreateHttpHandlerOptions, "runtime">;
}

export interface PortableHttpRuntime {
  runtime: Runtime;
  handler: HttpHandler;
}

/**
 * Complete in-process Runtime composition for browser, mobile WebView, Worker,
 * and other WHATWG Fetch hosts. It contains no Node or native-host dependency.
 */
export async function createPortableHttpRuntime(
  options: CreatePortableHttpRuntimeOptions = {},
): Promise<PortableHttpRuntime> {
  const { flows = [], http, ...runtimeOptions } = options;
  const runtime = createBrowserRuntime(runtimeOptions);

  for (const source of flows) {
    const graph = typeof source === "string"
      ? JSON.parse(source) as FlowGraph
      : source;
    const json = typeof source === "string" ? source : JSON.stringify(source);
    await runtime.registry.register({ graph, json, status: "staging" });
    await runtime.registry.promote(graph.id, graph.version);
  }

  return {
    runtime,
    handler: createHttpHandler({ runtime, ...http }),
  };
}
