import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { runBuilder } from "../src/index.js";

function makeFlow() {
  const flow = defineFlow({
    id: "runner_test_flow",
    version: "1.2.3",
  });
  const s = flow.node("start", { id: "node_start_01" });
  const e = flow.node("end", { id: "node_end_01" });
  flow.connect(s.out("out"), e.in("in"));
  return flow;
}

function makeConfigFlow() {
  const flow = defineFlow({
    id: "runner_config_flow",
    version: "1.2.3",
  });
  const s = flow.node("start", {
    id: "node_start_01",
    config: { keepDefault: "new", mode: "fresh" },
  });
  const e = flow.node("end", { id: "node_end_01" });
  flow.connect(s.out("out"), e.in("in"));
  return flow;
}

function makeSecretRefFlow() {
  const flow = defineFlow({
    id: "runner_secret_ref_flow",
    version: "1.2.3",
  });
  const s = flow.node("start", {
    id: "node_start_01",
    config: {
      apiKey: { $secret: "API_KEY" },
      model: { $var: "MODEL" },
    },
  });
  const e = flow.node("end", { id: "node_end_01" });
  flow.connect(s.out("out"), e.in("in"));
  return flow;
}

describe("builder-runner / runBuilder", () => {
  it("writes the artifact under <root>/<flowId>/<version>.flow.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "anf-runner-"));
    try {
      const result = await runBuilder(makeFlow(), { artifactRoot: root });
      expect(result.path).toBe(join(root, "runner_test_flow", "1.2.3.flow.json"));
      const onDisk = await readFile(result.path!, "utf8");
      expect(onDisk).toBe(result.json);
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dryRun does not touch the filesystem", async () => {
    const r = await runBuilder(makeFlow(), { dryRun: true });
    expect(r.path).toBeUndefined();
    expect(r.json.length).toBeGreaterThan(0);
  });

  it("produces a stable contentHash for the same builder", async () => {
    const a = await runBuilder(makeFlow(), { dryRun: true });
    const b = await runBuilder(makeFlow(), { dryRun: true });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("preserves existing config values for matching nodes and keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "anf-runner-"));
    try {
      const first = await runBuilder(makeConfigFlow(), { artifactRoot: root });
      const previous = JSON.parse(first.json);
      const start = previous.nodes.find((node: { id: string }) => node.id === "node_start_01");
      start.config.mode = "edited";
      start.config.retired = "old";
      await writeFile(first.path!, JSON.stringify(previous, null, 2), "utf8");

      const second = await runBuilder(makeConfigFlow(), {
        artifactRoot: root,
        preserveExistingConfig: true,
      });

      const regenerated = JSON.parse(second.json);
      const regeneratedStart = regenerated.nodes.find(
        (node: { id: string }) => node.id === "node_start_01",
      );
      expect(second.preservedConfigValueCount).toBe(2);
      expect(regeneratedStart.config).toEqual({
        keepDefault: "new",
        mode: "edited",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not preserve a stale ref when the ref kind changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "anf-runner-"));
    try {
      const first = await runBuilder(makeSecretRefFlow(), { artifactRoot: root });
      const previous = JSON.parse(first.json);
      const start = previous.nodes.find((node: { id: string }) => node.id === "node_start_01");
      start.config.apiKey = { $var: "OLD_API_KEY" };
      start.config.model = { $var: "OLD_MODEL" };
      await writeFile(first.path!, JSON.stringify(previous, null, 2), "utf8");

      const second = await runBuilder(makeSecretRefFlow(), {
        artifactRoot: root,
        preserveExistingConfig: true,
      });

      const regenerated = JSON.parse(second.json);
      const regeneratedStart = regenerated.nodes.find(
        (node: { id: string }) => node.id === "node_start_01",
      );
      expect(second.preservedConfigValueCount).toBe(1);
      expect(regeneratedStart.config).toEqual({
        apiKey: { $secret: "API_KEY" },
        model: { $var: "OLD_MODEL" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
