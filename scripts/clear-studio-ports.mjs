import { killPort, probePort } from "@ai-native-flow/net-utils";

const ports = [3000, 5173];

for (const port of ports) {
  killPort(port, { prefix: "clear-studio-ports" });
  // probe after killing so a still-unbindable port (WinNAT/Hyper-V reserved
  // range) is surfaced early rather than crashing the dev server at listen().
  if (!(await probePort(port))) {
    console.warn(
      `[clear-studio-ports] port ${port} still not bindable after kill ` +
        `(likely reserved by WinNAT/Hyper-V); the service should fall forward ` +
        `to the next free port`,
    );
  }
}
