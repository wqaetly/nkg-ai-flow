import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const result = await build({
  root,
  configFile: false,
  logLevel: "warn",
  build: {
    target: "es2022",
    write: false,
    minify: false,
    lib: {
      entry: resolve(root, "scripts/browser-runtime-entry.ts"),
      formats: ["es"],
      fileName: "browser-runtime",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  plugins: [{
    name: "reject-node-builtins",
    enforce: "pre",
    resolveId(source, importer) {
      if (builtins.has(source)) {
        this.error(
          `browser runtime imported Node builtin '${source}' from '${importer ?? "entry"}'`,
        );
      }
      return null;
    },
  }],
});

const outputs = Array.isArray(result) ? result : [result];
for (const output of outputs) {
  for (const item of output.output) {
    if (item.type !== "chunk") continue;
    for (const builtin of builtins) {
      if (
        item.code.includes(`from \"${builtin}\"`) ||
        item.code.includes(`from '${builtin}'`) ||
        item.code.includes(`import(\"${builtin}\")`) ||
        item.code.includes(`import('${builtin}')`)
      ) {
        throw new Error(`browser bundle still references Node builtin '${builtin}'`);
      }
    }
  }
}

console.log("browser runtime bundle verified: no Node builtin imports");
