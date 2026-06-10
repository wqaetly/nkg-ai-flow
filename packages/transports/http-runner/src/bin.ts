/**
 * Standalone bin: boot the workspace-driven HTTP runner.
 *
 * Discovers this repository's built-in apps, optionally loads host apps
 * from the nearest `anf.apps.json`, registers every declared flow, and
 * starts the Node `http.Server`. Used as the default `npm run serve` for
 * any app that ships flows in this repository.
 *
 * Environment knobs:
 *   - `ANF_HTTP_PORT`  / `PORT`      — listen port (default 8787)
 *   - `ANF_HTTP_HOST`                — bind host (default 127.0.0.1)
 * Exits non-zero on any boot-time error (duplicate flow id, malformed
 * graph, etc.) so process supervisors can restart the process or surface
 * the failure.
 */

import { startHttpRunner } from "./runner.js";

async function main(): Promise<void> {
  const handle = await startHttpRunner({
    onRegister: (flow) => {
      // eslint-disable-next-line no-console
      console.log(
        `[http-runner] registered flow ${flow.flowId}@${flow.flowVersion} ` +
          `(${flow.workspace}/${flow.file})`,
      );
    },
  });
  // eslint-disable-next-line no-console
  console.log(
    `[http-runner] listening on ${handle.url} ` +
      `(manifest: ${handle.manifest.source ?? "(default)"}, flows: ${handle.flows.length})`,
  );

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log("[http-runner] shutting down");
    handle
      .stop()
      .then(() => process.exit(0))
      .catch((cause) => {
        // eslint-disable-next-line no-console
        console.error("[http-runner] failed to stop cleanly", cause);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((cause) => {
  // eslint-disable-next-line no-console
  console.error("[http-runner] startup failed:", cause);
  process.exit(1);
});
