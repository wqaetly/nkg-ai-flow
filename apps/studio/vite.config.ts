import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function pkgEntry(name: string): string {
  return resolve(repoRoot, "packages", name, "src/index.ts");
}

function pkgRoot(name: string): string {
  return resolve(repoRoot, "packages", name, "src");
}

function pkgFile(name: string, file: string): string {
  return resolve(pkgRoot(name), file);
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@ai-native-flow\/studio\/(.*)$/, replacement: `${pkgRoot("studio")}/$1` },
      { find: "@ai-native-flow/studio", replacement: pkgEntry("studio") },
      { find: "@ai-native-flow/flow-ir", replacement: pkgEntry("flow-ir") },
      { find: "@ai-native-flow/flow-validator", replacement: pkgEntry("flow-validator") },
      { find: "@ai-native-flow/flow-builder", replacement: pkgEntry("flow-builder") },
      { find: "@ai-native-flow/event-bus", replacement: pkgEntry("event-bus") },
      // The `runtime` package's `package.json` exports map
      // `./builtin-definitions` to `src/builtinDefinitions.ts` (note the
      // camelCase filename vs. kebab-case subpath). Mirror that mapping
      // explicitly so Vite can resolve the browser-safe palette entry
      // without dragging the full Node-only Runtime barrel.
      {
        find: "@ai-native-flow/runtime/builtin-definitions",
        replacement: `${pkgRoot("runtime")}/builtinDefinitions.ts`,
      },
      { find: "@ai-native-flow/runtime/portable", replacement: pkgFile("runtime", "portable.ts") },
      { find: "@ai-native-flow/runtime/browser", replacement: pkgFile("runtime", "browser.ts") },
      { find: "@ai-native-flow/runtime/node", replacement: pkgFile("runtime", "node.ts") },
      { find: "@ai-native-flow/runtime", replacement: pkgEntry("runtime") },
      // Transitive deps pulled in by builtinDefinitions.ts ->
      // ./nodes/builtin/* and ./nodes/llmProvider.ts. They aren't
      // imported directly from `main.tsx`, but Vite still resolves them
      // via the same alias table.
      { find: "@ai-native-flow/node-sdk", replacement: pkgEntry("node-sdk") },
      { find: "@ai-native-flow/ai-stream", replacement: pkgEntry("ai-stream") },
      {
        find: /^@ai-native-flow\/variable-store\/browser$/,
        replacement: pkgFile("variable-store", "browser.ts"),
      },
      {
        find: "@ai-native-flow/variable-store",
        replacement: pkgFile("variable-store", "browser.ts"),
      },
      { find: "@ai-native-flow/sandbox", replacement: pkgEntry("sandbox") },
    ],
  },
  server: {
    host: true,
    // Vite dev server runs on 3000; the AI-Native-Flow Node sidecar
    // listens on 5173 by default.
    port: 3000,
    strictPort: true,
  },
});
