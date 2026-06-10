import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadWorkspaceManifest } from "../src/manifest.js";

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "anf-workspace-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function touch(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "", "utf8");
}

afterEach(async () => {
  const roots = tempRoots.splice(0);
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("loadWorkspaceManifest app discovery", () => {
  test("discovers built-in app manifests when no host registry exists", async () => {
    const root = await makeWorkspace();
    await writeJson(path.join(root, "apps", "alpha", "anf.app.json"), {
      name: "alpha",
      flowDirs: ["flows"],
      nodePacks: ["nodes/index.ts"],
    });
    await touch(path.join(root, "apps", "alpha", "nodes", "index.ts"));

    const manifest = await loadWorkspaceManifest({
      startDir: root,
      builtinRootDir: root,
    });

    expect(manifest.source).toBeNull();
    expect(manifest.rootDir).toBe(root);
    expect(manifest.flowDirs).toEqual([
      { name: "alpha", abs: path.join(root, "apps", "alpha", "flows") },
    ]);
    expect(manifest.nodePacks).toEqual([
      { name: "alpha", entry: path.join(root, "apps", "alpha", "nodes", "index.ts") },
    ]);
  });

  test("skips built-in apps without anf.app.json", async () => {
    const root = await makeWorkspace();
    await touch(path.join(root, "apps", "alpha", "flows", "alpha.json"));
    await touch(path.join(root, "apps", "alpha", "nodes", "index.ts"));

    const manifest = await loadWorkspaceManifest({
      startDir: root,
      builtinRootDir: root,
    });

    expect(manifest.flowDirs).toEqual([]);
    expect(manifest.nodePacks).toEqual([]);
  });

  test("loads host apps from anf.apps.json in addition to built-in apps", async () => {
    const builtinRoot = await makeWorkspace();
    const hostRoot = await makeWorkspace();
    await writeJson(path.join(builtinRoot, "apps", "builtin", "anf.app.json"), {
      name: "builtin",
      flowDirs: ["flows"],
      nodePacks: ["nodes/index.ts"],
    });
    await writeJson(path.join(hostRoot, "anf.apps.json"), {
      apps: ["apps/host"],
    });
    await writeJson(path.join(hostRoot, "apps", "host", "anf.app.json"), {
      name: "host",
      flowDirs: ["flows"],
    });

    const manifest = await loadWorkspaceManifest({
      startDir: hostRoot,
      builtinRootDir: builtinRoot,
    });

    expect(manifest.source).toBe(path.join(hostRoot, "anf.apps.json"));
    expect(manifest.rootDir).toBe(hostRoot);
    expect(manifest.flowDirs).toEqual([
      { name: "builtin", abs: path.join(builtinRoot, "apps", "builtin", "flows") },
      { name: "host", abs: path.join(hostRoot, "apps", "host", "flows") },
    ]);
    expect(manifest.nodePacks).toEqual([
      {
        name: "builtin",
        entry: path.join(builtinRoot, "apps", "builtin", "nodes", "index.ts"),
      },
    ]);
  });

  test("uses app-local anf.app.json names and paths", async () => {
    const root = await makeWorkspace();
    await writeJson(path.join(root, "apps", "beta", "anf.app.json"), {
      name: "custom-beta",
      flowDirs: ["graphs"],
      nodePacks: ["custom-nodes.ts"],
    });

    const manifest = await loadWorkspaceManifest({
      startDir: root,
      builtinRootDir: root,
    });

    expect(manifest.flowDirs).toEqual([
      { name: "custom-beta", abs: path.join(root, "apps", "beta", "graphs") },
    ]);
    expect(manifest.nodePacks).toEqual([
      { name: "custom-beta", entry: path.join(root, "apps", "beta", "custom-nodes.ts") },
    ]);
  });

  test("dedupes duplicate app paths between built-in and host sources", async () => {
    const root = await makeWorkspace();
    await writeJson(path.join(root, "anf.apps.json"), {
      apps: ["apps/shared"],
    });
    await writeJson(path.join(root, "apps", "shared", "anf.app.json"), {
      name: "shared",
      flowDirs: ["flows"],
    });

    const manifest = await loadWorkspaceManifest({
      startDir: root,
      builtinRootDir: root,
    });

    expect(manifest.flowDirs).toEqual([
      { name: "shared", abs: path.join(root, "apps", "shared", "flows") },
    ]);
  });

  test("rejects duplicate app flow names across built-in and host sources", async () => {
    const builtinRoot = await makeWorkspace();
    const hostRoot = await makeWorkspace();
    await writeJson(path.join(builtinRoot, "apps", "one", "anf.app.json"), {
      name: "dup",
      flowDirs: ["flows"],
    });
    await writeJson(path.join(hostRoot, "anf.apps.json"), {
      apps: ["apps/two"],
    });
    await writeJson(path.join(hostRoot, "apps", "two", "anf.app.json"), {
      name: "dup",
      flowDirs: ["flows"],
    });

    await expect(loadWorkspaceManifest({
      startDir: hostRoot,
      builtinRootDir: builtinRoot,
    })).rejects.toThrow("duplicate name 'dup'");
  });

  test("rejects host app paths without anf.app.json", async () => {
    const hostRoot = await makeWorkspace();
    await writeJson(path.join(hostRoot, "anf.apps.json"), {
      apps: ["apps/missing-config"],
    });

    await expect(loadWorkspaceManifest({
      startDir: hostRoot,
      builtinRootDir: null,
    })).rejects.toThrow("Registered app is missing anf.app.json");
  });

  test("rejects imports in host anf.apps.json", async () => {
    const hostRoot = await makeWorkspace();
    await writeJson(path.join(hostRoot, "anf.apps.json"), {
      imports: ["vendor/nkg-ai-flow/anf.apps.json"],
      apps: [],
    });

    await expect(loadWorkspaceManifest({
      startDir: hostRoot,
      builtinRootDir: null,
    })).rejects.toThrow("'imports' is not supported");
  });
});
