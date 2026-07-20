/** Browser-safe Flow artifact persistence contract. */
export interface ArtifactStore {
  putFlow(
    flowId: string,
    version: string,
    json: string,
  ): Promise<{ path: string; hash: string }>;
  getFlowJson(
    flowId: string,
    version: string,
    expectedHash?: string,
  ): Promise<string>;
}
