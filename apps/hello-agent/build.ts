/**
 * Drive the builder runner against `helloagent.flow.ts` and print the resulting
 * artifact. Run with `tsx apps/hello-agent/build.ts` from the repo
 * root.
 */

import { runBuilderModule } from "@ai-native-flow/builder-runner";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const modulePath = join(here, "helloagent.flow.ts");

const artifact = await runBuilderModule(modulePath, {
  artifactRoot: join(here, "artifacts", "flows"),
});

console.log(`flow:        ${artifact.flow.id}@${artifact.flow.version}`);
console.log(`nodes:       ${artifact.flow.nodes.length}`);
console.log(`edges:       ${artifact.flow.edges.length}`);
console.log(`contentHash: ${artifact.contentHash}`);
console.log(`written to:  ${artifact.path ?? "<dry-run>"}`);
