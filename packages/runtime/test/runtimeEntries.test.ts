import { describe, expect, it } from "vitest";
import {
  InMemoryArtifactStore,
  createPortableRuntime,
  createRuntime,
} from "../src/index.js";
import {
  FsArtifactStore,
  createNodeRuntime,
} from "../src/node.js";

describe("runtime public entries", () => {
  it("keeps the package root portable by default", () => {
    const runtime = createRuntime();
    const explicitPortable = createPortableRuntime();

    expect(runtime.artifactStore).toBeInstanceOf(InMemoryArtifactStore);
    expect(explicitPortable.artifactStore).toBeInstanceOf(InMemoryArtifactStore);
  });

  it("requires an explicit Node entry for native filesystem defaults", () => {
    const runtime = createNodeRuntime();

    expect(runtime.artifactStore).toBeInstanceOf(FsArtifactStore);
  });
});
