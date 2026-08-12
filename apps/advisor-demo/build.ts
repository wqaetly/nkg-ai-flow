import { runBuilderModule } from "@ai-native-flow/builder-runner";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const artifactRoot = join(here, "artifacts", "flows");

for (const source of ["primary.flow.ts", "reviewer.flow.ts"]) {
  const artifact = await runBuilderModule(join(here, source), { artifactRoot });
  console.log(
    `${artifact.flow.id}@${artifact.flow.version} -> ${artifact.path ?? "<dry-run>"}`,
  );
}
