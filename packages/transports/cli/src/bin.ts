#!/usr/bin/env -S node --import tsx
import type { Runtime } from "@ai-native-flow/runtime";
import { runFlowCli } from "./bootstrap.js";

const runtimeModulePath = process.env.AI_NATIVE_FLOW_RUNTIME;
if (!runtimeModulePath) {
  process.stderr.write(
    "Missing AI_NATIVE_FLOW_RUNTIME. Set it to a module exporting `runtime` or `createRuntime`.\n",
  );
  process.exit(1);
}

try {
  const mod = await import(runtimeModulePath);
  const runtime = await resolveRuntime(mod);
  const result = await runFlowCli({ runtime });
  process.exit(result.exitCode);
} catch (error) {
  process.stderr.write(`${renderError(error)}\n`);
  process.exit(1);
}

async function resolveRuntime(mod: Record<string, unknown>): Promise<Runtime> {
  const runtime = mod.runtime;
  if (runtime) return runtime as Runtime;

  const createRuntime = mod.createRuntime;
  if (typeof createRuntime === "function") {
    return await createRuntime();
  }

  throw new Error(
    "Runtime module must export `runtime` or an async/sync `createRuntime` function.",
  );
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
