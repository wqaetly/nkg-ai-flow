import { execFileSync } from "node:child_process";
import net from "node:net";

export interface KillPortOptions {
  /** Log prefix, e.g. `studio-sidecar`. */
  prefix?: string;
}

export interface FindAvailablePortOptions {
  /** Bind host used for the probe. Defaults to `127.0.0.1`. */
  host?: string;
  /** Log prefix, e.g. `http-runner`. Defaults to `net-utils`. */
  prefix?: string;
  /** How many consecutive candidate ports to scan. Defaults to `20`. */
  attempts?: number;
  /**
   * Kill any process occupying a candidate before probing it. Defaults to
   * `true`. Set to `false` when you only want to fall forward past
   * kernel-reserved ports without touching other processes.
   */
  kill?: boolean;
}

/**
 * Kill whatever process is currently LISTENING on `port`. Best-effort and
 * cross-platform (netstat+taskkill on Windows, lsof+kill elsewhere). Silently
 * does nothing when the port is free or the lookup tooling is unavailable.
 */
export function killPort(port: number, options: KillPortOptions = {}): void {
  const prefix = options.prefix ?? "net-utils";
  if (process.platform === "win32") killWindowsPort(port, prefix);
  else killUnixPort(port, prefix);
}

/**
 * Probe whether `port` can actually be bound on `host`.
 *
 * On Windows a port can be unusable even when no process owns it: WinNAT /
 * Hyper-V / WSL dynamically reserve ranges that `netstat` does not surface, and
 * binding such a port throws EACCES. EADDRINUSE means a process is still
 * holding it. Both mean "try the next one".
 */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Return the first port at/after `preferred` that is actually bindable. By
 * default it first kills any process still occupying a candidate, then probes
 * it; EACCES (kernel-reserved) or EADDRINUSE (lingering owner) fall forward to
 * the next candidate. Throws if no bindable port is found within `attempts`.
 */
export async function findAvailablePort(
  preferred: number,
  options: FindAvailablePortOptions = {},
): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const prefix = options.prefix ?? "net-utils";
  const attempts = options.attempts ?? 20;
  const kill = options.kill ?? true;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    if (port > 65535) break;
    if (kill) killPort(port, { prefix });
    if (await probePort(port, host)) {
      if (offset > 0) {
        // eslint-disable-next-line no-console
        console.log(`[${prefix}] port ${preferred} unavailable; using ${port}`);
      }
      return port;
    }
  }
  throw new Error(`[${prefix}] no bindable port found near ${preferred}`);
}

function killWindowsPort(port: number, prefix: string): void {
  let output = "";
  try {
    output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  } catch {
    return;
  }

  const pids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1] ?? "";
    const state = parts[3] ?? "";
    const pid = parts[4] ?? "";
    if (!local.endsWith(`:${port}`) || state !== "LISTENING") continue;
    if (/^\d+$/.test(pid)) pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
      // eslint-disable-next-line no-console
      console.log(`[${prefix}] killed PID ${pid} on port ${port}`);
    } catch {
      // The process may have already exited.
    }
  }
}

function killUnixPort(port: number, prefix: string): void {
  let output = "";
  try {
    output = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  } catch {
    return;
  }

  for (const pid of output.split(/\r?\n/).filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGTERM");
      // eslint-disable-next-line no-console
      console.log(`[${prefix}] killed PID ${pid} on port ${port}`);
    } catch {
      // The process may have already exited.
    }
  }
}
