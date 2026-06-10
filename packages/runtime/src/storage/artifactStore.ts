/**
 * Filesystem-backed Artifact Store for Flow JSON snapshots.
 *
 * Phase 1 keeps Flow Artifacts (the canonical JSON produced by `dump()`)
 * on disk and references them from `RunRecord.flowArtifactHash`. Storing
 * the full JSON inline in the Run row would balloon the SQLite file once
 * Run history accumulates and would also duplicate every Run that ran on
 * the same Flow Version.
 *
 * Layout:
 *   <root>/<flowId>/<flowVersion>.flow.json
 *
 * Hash check (`assertHash`) protects against on-disk corruption: when the
 * hash recorded in the Registry no longer matches the file content, the
 * loader refuses to start a Run on that artifact.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export interface ArtifactStore {
  putFlow(flowId: string, version: string, json: string): Promise<{ path: string; hash: string }>;
  getFlowJson(flowId: string, version: string, expectedHash?: string): Promise<string>;
}

export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async putFlow(
    flowId: string,
    version: string,
    json: string,
  ): Promise<{ path: string; hash: string }> {
    const path = this.flowPath(flowId, version);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, "utf8");
    return { path, hash: sha256Hex(json) };
  }

  async getFlowJson(
    flowId: string,
    version: string,
    expectedHash?: string,
  ): Promise<string> {
    const path = this.flowPath(flowId, version);
    const json = await readFile(path, "utf8");
    if (expectedHash !== undefined) {
      const actual = sha256Hex(json);
      if (actual !== expectedHash) {
        throw new Error(
          `flow artifact ${flowId}@${version} hash mismatch (expected ${expectedHash}, got ${actual})`,
        );
      }
    }
    return json;
  }

  private flowPath(flowId: string, version: string): string {
    return join(this.root, flowId, `${version}.flow.json`);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
