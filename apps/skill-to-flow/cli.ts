/**
 * CLI entrypoint for the skill-to-flow conversion pipeline.
 *
 * Usage:
 *   tsx cli.ts run skill_to_flow --input '{"skill_content":"...","skill_path":"..."}'
 *   tsx cli.ts stream skill_to_flow --input @./input.json
 *   tsx cli.ts inspect <runId>
 *   tsx cli.ts replay <runId>
 *   tsx cli.ts cancel <runId>
 */

import { runFlowCli } from "@ai-native-flow/transport-cli/bootstrap";

import { createSkillToFlowRuntime } from "./runtime.js";

const runtime = await createSkillToFlowRuntime();
const result = await runFlowCli({ runtime });
process.exit(result.exitCode);
