import { execFileSync } from "node:child_process";

const ports = [3000, 5173];

function killWindowsPort(port) {
  let output = "";
  try {
    output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  } catch {
    return;
  }

  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    const state = parts[3];
    const pid = parts[4];
    if (!local.endsWith(`:${port}`) || state !== "LISTENING") continue;
    if (/^\d+$/.test(pid)) pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
      console.log(`[clear-studio-ports] killed PID ${pid} on port ${port}`);
    } catch {
      // The process may have already exited.
    }
  }
}

function killUnixPort(port) {
  let output = "";
  try {
    output = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  } catch {
    return;
  }

  for (const pid of output.split(/\r?\n/).filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`[clear-studio-ports] killed PID ${pid} on port ${port}`);
    } catch {
      // The process may have already exited.
    }
  }
}

for (const port of ports) {
  if (process.platform === "win32") killWindowsPort(port);
  else killUnixPort(port);
}
