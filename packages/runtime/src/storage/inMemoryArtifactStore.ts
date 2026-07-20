import type { ArtifactStore } from "./artifactStoreContract.js";
import { sha256HexPortable } from "./hash.js";

export interface InMemoryArtifactStoreOptions {
  hashText?: (input: string) => Promise<string>;
}

/** Browser-safe artifact store used until the host injects SQLite/native persistence. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly flows = new Map<string, string>();
  private readonly hashText: (input: string) => Promise<string>;

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.hashText = options.hashText ?? sha256HexPortable;
  }

  async putFlow(
    flowId: string,
    version: string,
    json: string,
  ): Promise<{ path: string; hash: string }> {
    this.flows.set(key(flowId, version), json);
    return {
      path: `memory://flows/${encodeURIComponent(flowId)}/${encodeURIComponent(version)}`,
      hash: await this.hashText(json),
    };
  }

  async getFlowJson(
    flowId: string,
    version: string,
    expectedHash?: string,
  ): Promise<string> {
    const json = this.flows.get(key(flowId, version));
    if (json === undefined) {
      throw new Error(`flow artifact ${flowId}@${version} not found`);
    }
    if (expectedHash !== undefined) {
      const actual = await this.hashText(json);
      if (actual !== expectedHash) {
        throw new Error(
          `flow artifact ${flowId}@${version} hash mismatch (expected ${expectedHash}, got ${actual})`,
        );
      }
    }
    return json;
  }
}

function key(flowId: string, version: string): string {
  return `${flowId}\0${version}`;
}
