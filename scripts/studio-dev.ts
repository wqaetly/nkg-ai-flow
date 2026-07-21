import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { findAvailablePort, killPort, probePort } from "@ai-native-flow/net-utils";

const hostname = process.env.ANF_SIDECAR_HOST?.trim() || "127.0.0.1";
const preferredSidecarPort = parsePort(
  process.env.ANF_SIDECAR_PORT,
  5173,
  "ANF_SIDECAR_PORT",
);
const frontendPort = parsePort(
  process.env.ANF_STUDIO_PORT,
  3000,
  "ANF_STUDIO_PORT",
);

// `prestudio:dev` already performs a best-effort cleanup for the defaults.
// Probe again here because custom ports and Windows reserved ranges still need
// a deterministic error before either long-running child is spawned.
killPort(frontendPort, { prefix: "studio-dev" });
if (!(await probePort(frontendPort, hostname))) {
  throw new Error(
    `[studio-dev] frontend port ${frontendPort} is not bindable on ${hostname}`,
  );
}

const sidecarPort = await findAvailablePort(preferredSidecarPort, {
  host: hostname,
  prefix: "studio-dev",
  // The pre-hook owns cleanup of the default dev ports. Candidate scanning
  // must never kill unrelated services merely because they occupy a fallback.
  kill: false,
});
const sidecarUrl = `http://${hostname}:${sidecarPort}`;
const frontendUrl = `http://${hostname}:${frontendPort}`;

console.log(`[studio-dev] frontend: ${frontendUrl}`);
console.log(`[studio-dev] sidecar: ${sidecarUrl}`);
console.log("[studio-dev] injecting the selected sidecar URL into Vite");

const children = new Set<ChildProcess>();
let stopping = false;
let exitCode = 0;

const backend = start("backend", "studio:dev:backend", {
  ANF_SIDECAR_HOST: hostname,
  ANF_SIDECAR_PORT: String(sidecarPort),
});
const frontend = start("frontend", "studio:dev:frontend", {
  ANF_STUDIO_PORT: String(frontendPort),
  VITE_ANF_SIDECAR_URL: sidecarUrl,
});

await new Promise<void>((resolve) => {
  let exited = 0;
  for (const [name, child] of [
    ["backend", backend],
    ["frontend", frontend],
  ] as const) {
    child.once("error", (cause) => {
      console.error(`[studio-dev] ${name} failed to start:`, cause);
      exitCode = 1;
      stop();
    });
    child.once("close", (code, signal) => {
      exited += 1;
      if (!stopping) {
        console.error(
          `[studio-dev] ${name} exited unexpectedly (${code ?? signal ?? "unknown"})`,
        );
        exitCode = code && code > 0 ? code : 1;
        stop();
      }
      if (exited === 2) resolve();
    });
  }

  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
});

process.exitCode = exitCode;

function start(
  name: string,
  script: string,
  extraEnv: Readonly<Record<string, string>>,
): ChildProcess {
  const windows = process.platform === "win32";
  const child = spawn(
    windows ? `npm run ${script}` : "npm",
    windows ? [] : ["run", script],
    {
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      // npm is a .cmd shim on Windows. Passing one fixed command string avoids
      // Node's deprecated shell+args path; Unix can execute npm directly.
      shell: windows,
    },
  );
  children.add(child);
  child.once("close", () => children.delete(child));
  console.log(`[studio-dev] started ${name} (pid ${child.pid ?? "unknown"})`);
  return child;
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  // npm/tsx/vite create descendant processes. Port-owned process-tree cleanup
  // prevents them from surviving Ctrl+C on Windows, where signals do not
  // propagate through .cmd shims consistently.
  killPort(sidecarPort, { prefix: "studio-dev" });
  killPort(frontendPort, { prefix: "studio-dev" });
}

function parsePort(
  raw: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`[studio-dev] ${variableName} must be an integer from 1 to 65535`);
  }
  return value;
}
