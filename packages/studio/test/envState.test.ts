/**
 * Tests for the workbench's two-layer environment storage.
 *
 * Covers:
 *  - v1 → v2 localStorage migration (flat array → `{ global, apps }`)
 *  - flow-private buckets shadowing global on key collision
 *  - secret/variable kind switching across layers (no leakage)
 *  - picker projection only surfacing the active flow's bucket
 *  - `setRowsForScope` cleaning up empty flow buckets
 *  - `deriveFlowScopeId` normalizing sidecarPath
 */

import { describe, expect, test } from "vitest";
import {
  ENV_STORAGE_KEY,
  ENV_STORAGE_KEY_V1,
  GLOBAL_SCOPE,
  buildPickerEntries,
  countEffectiveKeys,
  deriveFlowScopeId,
  loadEnvState,
  mergeEnvOverrides,
  setRowsForScope,
  type EnvState,
} from "../src/envState.js";

/** Tiny in-memory `Storage` stub. */
function fakeStorage(seed: Record<string, string> = {}): Pick<Storage, "getItem"> {
  return {
    getItem(key: string): string | null {
      return seed[key] ?? null;
    },
  };
}

describe("deriveFlowScopeId", () => {
  test("returns the normalized sidecarPath", () => {
    expect(deriveFlowScopeId("code-review-iwiki/code-review-iwiki.json")).toBe(
      "code-review-iwiki/code-review-iwiki.json",
    );
    expect(deriveFlowScopeId("samples/hello-flow.json")).toBe("samples/hello-flow.json");
  });

  test("returns undefined for missing or empty paths", () => {
    expect(deriveFlowScopeId(undefined)).toBeUndefined();
    expect(deriveFlowScopeId("")).toBeUndefined();
    expect(deriveFlowScopeId("/")).toBeUndefined();
  });

  test("keeps nested paths and normalizes slashes", () => {
    expect(deriveFlowScopeId("code-review-iwiki\\sub\\dir\\x.json")).toBe(
      "code-review-iwiki/sub/dir/x.json",
    );
    expect(deriveFlowScopeId("/leading.json")).toBe("leading.json");
  });
});

describe("loadEnvState", () => {
  test("returns empty state when storage is absent", () => {
    expect(loadEnvState(null)).toEqual({ global: [], apps: {} });
  });

  test("returns empty state when neither v1 nor v2 is present", () => {
    expect(loadEnvState(fakeStorage())).toEqual({ global: [], apps: {} });
  });

  test("migrates v1 flat array into the global bucket", () => {
    const v1 = JSON.stringify([
      { id: "a", key: "LLM_BASE_URL", value: "https://x.test/v1", secret: false },
      { id: "b", key: "LLM_API_KEY", value: "sk-test", secret: true },
    ]);
    const state = loadEnvState(fakeStorage({ [ENV_STORAGE_KEY_V1]: v1 }));
    expect(state.apps).toEqual({});
    expect(state.global).toHaveLength(2);
    expect(state.global[0]?.key).toBe("LLM_BASE_URL");
    expect(state.global[1]?.secret).toBe(true);
  });

  test("loads v2 with flow buckets and ignores v1 when both exist", () => {
    const v2 = JSON.stringify({
      version: 2,
      global: [{ id: "g1", key: "G_KEY", value: "gv", secret: false }],
      apps: {
        "code-review-iwiki": [
          { id: "a1", key: "IWIKI_TOKEN", value: "secret-x", secret: true },
        ],
        empty: [], // empty buckets are dropped
      },
    });
    const v1 = JSON.stringify([
      { id: "old", key: "STALE", value: "should-not-load", secret: false },
    ]);
    const state = loadEnvState(
      fakeStorage({ [ENV_STORAGE_KEY]: v2, [ENV_STORAGE_KEY_V1]: v1 }),
    );
    expect(state.global).toEqual([
      { id: "g1", key: "G_KEY", value: "gv", secret: false },
    ]);
    expect(Object.keys(state.apps)).toEqual(["code-review-iwiki"]);
    expect(state.apps["code-review-iwiki"]).toHaveLength(1);
  });

  test("falls back to empty when v2 is corrupt JSON", () => {
    const state = loadEnvState(fakeStorage({ [ENV_STORAGE_KEY]: "{not json" }));
    expect(state).toEqual({ global: [], apps: {} });
  });

  test("re-issues missing ids when migrating v1", () => {
    const v1 = JSON.stringify([{ key: "K", value: "V", secret: false }]);
    const state = loadEnvState(fakeStorage({ [ENV_STORAGE_KEY_V1]: v1 }));
    expect(state.global[0]?.id).toMatch(/^env_/);
  });
});

describe("mergeEnvOverrides", () => {
  const base: EnvState = {
    global: [
      { id: "g1", key: "LLM_BASE_URL", value: "https://global.test/v1", secret: false },
      { id: "g2", key: "SHARED_TOKEN", value: "global-token", secret: true },
      { id: "g3", key: "ONLY_GLOBAL", value: "only", secret: false },
    ],
    apps: {
      "code-review-iwiki": [
        { id: "a1", key: "LLM_BASE_URL", value: "https://app.test/v1", secret: false },
        { id: "a2", key: "IWIKI_TOKEN", value: "iwiki-secret", secret: true },
      ],
    },
  };

  test("returns an empty object when state is empty", () => {
    expect(mergeEnvOverrides({ global: [], apps: {} }, undefined)).toEqual({});
  });

  test("returns global only when active flow scope is undefined", () => {
    const out = mergeEnvOverrides(base, undefined);
    expect(out.variables).toEqual({
      LLM_BASE_URL: "https://global.test/v1",
      ONLY_GLOBAL: "only",
      SHARED_TOKEN: "global-token",
    });
  });

  test("flow bucket shadows global on key collision", () => {
    const out = mergeEnvOverrides(base, "code-review-iwiki");
    expect(out.variables?.LLM_BASE_URL).toBe("https://app.test/v1");
    // Global-only entries survive.
    expect(out.variables?.ONLY_GLOBAL).toBe("only");
    expect(out.variables?.IWIKI_TOKEN).toBe("iwiki-secret");
    expect(out.variables?.SHARED_TOKEN).toBe("global-token");
  });

  test("higher-priority rows shadow lower-priority rows regardless of UI secret flag", () => {
    const state: EnvState = {
      global: [{ id: "g", key: "K", value: "plain", secret: false }],
      apps: { my: [{ id: "a", key: "K", value: "secret-val", secret: true }] },
    };
    const out = mergeEnvOverrides(state, "my");
    expect(out).toEqual({ variables: { K: "secret-val" } });
  });

  test("ignores rows with empty/whitespace keys", () => {
    const state: EnvState = {
      global: [
        { id: "g1", key: "  ", value: "x", secret: false },
        { id: "g2", key: "K", value: "v", secret: false },
      ],
      apps: {},
    };
    expect(mergeEnvOverrides(state, undefined)).toEqual({ variables: { K: "v" } });
  });

  test("unrelated flow bucket has no effect", () => {
    const out = mergeEnvOverrides(base, "samples");
    // No `samples` bucket -> identical to global-only merge.
    expect(out).toEqual(mergeEnvOverrides(base, undefined));
  });
});

describe("buildPickerEntries", () => {
  const base: EnvState = {
    global: [
      { id: "g1", key: "LLM_BASE_URL", value: "https://g/v1", secret: false },
      { id: "g2", key: "SHARED", value: "g-shared", secret: false },
    ],
    apps: {
      "code-review-iwiki": [
        { id: "a1", key: "LLM_BASE_URL", value: "https://a/v1", secret: false },
        { id: "a2", key: "IWIKI_TOKEN", value: "tok", secret: true },
      ],
      other: [{ id: "o1", key: "OTHER", value: "x", secret: false }],
    },
  };

  test("global-only when no active flow", () => {
    const out = buildPickerEntries(base, undefined);
    expect(out.map((e) => e.key)).toEqual(["LLM_BASE_URL", "SHARED"]);
    expect(out.every((e) => e.scope === "global")).toBe(true);
  });

  test("active flow entries shadow global same-name keys and tag scope", () => {
    const out = buildPickerEntries(base, "code-review-iwiki");
    expect(out.find((e) => e.key === "LLM_BASE_URL")).toMatchObject({
      scope: "flow",
      flowLabel: "code-review-iwiki",
      value: "https://a/v1",
    });
    // SHARED only in global → scope global.
    expect(out.find((e) => e.key === "SHARED")?.scope).toBe("global");
  });

  test("does not surface other flow buckets", () => {
    const out = buildPickerEntries(base, "code-review-iwiki");
    expect(out.find((e) => e.key === "OTHER")).toBeUndefined();
  });

  test("dedupes by key — each key appears at most once", () => {
    const out = buildPickerEntries(base, "code-review-iwiki");
    const keys = out.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("drops empty/whitespace keys", () => {
    const state: EnvState = {
      global: [
        { id: "g1", key: "", value: "v", secret: false },
        { id: "g2", key: " ", value: "v", secret: false },
        { id: "g3", key: "K", value: "v", secret: false },
      ],
      apps: {},
    };
    expect(buildPickerEntries(state, undefined).map((e) => e.key)).toEqual(["K"]);
  });
});

describe("countEffectiveKeys", () => {
  test("counts unique merged keys (app shadows global)", () => {
    const state: EnvState = {
      global: [
        { id: "g1", key: "A", value: "1", secret: false },
        { id: "g2", key: "B", value: "1", secret: false },
      ],
      apps: {
        my: [
          { id: "a1", key: "A", value: "2", secret: false }, // duplicate key
          { id: "a2", key: "C", value: "3", secret: false },
        ],
      },
    };
    expect(countEffectiveKeys(state, "my")).toBe(3); // A, B, C
    expect(countEffectiveKeys(state, undefined)).toBe(2); // A, B
  });
});

describe("setRowsForScope", () => {
  const seed: EnvState = {
    global: [{ id: "g", key: "G", value: "v", secret: false }],
    apps: { my: [{ id: "a", key: "K", value: "v", secret: false }] },
  };

  test("updates the global bucket without touching apps", () => {
    const next = setRowsForScope(seed, GLOBAL_SCOPE, (rows) =>
      rows.concat({ id: "g2", key: "G2", value: "v2", secret: false }),
    );
    expect(next.global).toHaveLength(2);
    expect(next.apps).toBe(seed.apps); // identity preserved
  });

  test("creates a new flow bucket when none exists", () => {
    const next = setRowsForScope(seed, "code-review-iwiki", (rows) =>
      rows.concat({ id: "n", key: "TOKEN", value: "x", secret: true }),
    );
    expect(next.apps["code-review-iwiki"]).toHaveLength(1);
    expect(next.apps.my).toBe(seed.apps.my);
  });

  test("drops a flow bucket entirely when emptied", () => {
    const next = setRowsForScope(seed, "my", () => []);
    expect("my" in next.apps).toBe(false);
  });

  test("returns the same state object when emptying an already-absent bucket", () => {
    const next = setRowsForScope(seed, "ghost", () => []);
    expect(next).toBe(seed);
  });
});
