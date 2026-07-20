import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeErrorException } from "@ai-native-flow/flow-ir";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
  bootstrapDefaults,
  chainSecretStores,
  chainVariableStores,
  overlayVariableStore,
  collectRefs,
  createFlowScopedStores,
  getDefaultVariableStore,
  isSecretRef,
  isVariableRef,
  loadFlowEnvSidecars,
  loadFromDefaults,
  loadFromEnv,
  parseDotenv,
  resetDefaults,
  resolveFlowEnvSidecarPaths,
  resolveRefs,
} from "../src/index.js";

describe("variable-store / InMemoryVariableStore", () => {
  it("stores and reads back values with metadata", () => {
    const s = new InMemoryVariableStore();
    s.set("MODEL", "deepseek-v4-pro");
    expect(s.get("MODEL")).toBe("deepseek-v4-pro");
    expect(s.has("MODEL")).toBe(true);
    expect(s.describe("MODEL")?.metadata?.updatedAt).toBeDefined();
  });

  it("getRequired throws RuntimeErrorException with variable.not_found", () => {
    const s = new InMemoryVariableStore();
    try {
      s.getRequired("MISSING");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof RuntimeErrorException).toBe(true);
      expect((e as RuntimeErrorException).error.code).toBe("variable.not_found");
    }
  });

  it("coerces strings via getNumber / getBoolean", () => {
    const s = new InMemoryVariableStore();
    s.set("PORT", "8080");
    s.set("DEBUG", "true");
    expect(s.getNumber("PORT")).toBe(8080);
    expect(s.getBoolean("DEBUG")).toBe(true);
  });

  it("getString throws on type mismatch", () => {
    const s = new InMemoryVariableStore();
    s.set("N", 42);
    expect(() => s.getString("N")).toThrow(RuntimeErrorException);
  });
});

describe("variable-store / legacy InMemorySecretStore alias", () => {
  it("stores and reads ordinary variable values", () => {
    const s = new InMemorySecretStore();
    s.set("API_KEY", "sk-very-secret");
    const v = s.getRequired("API_KEY");
    expect(v).toBe("sk-very-secret");
  });

  it("list exposes the same entries as a variable store", () => {
    const s = new InMemorySecretStore();
    s.set("API_KEY", "sk-very-secret", { description: "the LLM key" });
    const list = s.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("API_KEY");
    expect(JSON.stringify(list)).toContain("sk-very-secret");
  });
});

describe("variable-store / chain", () => {
  it("first layer wins, falls through to subsequent layers", () => {
    const top = new InMemoryVariableStore([{ name: "MODEL", value: "override" }]);
    const bottom = new InMemoryVariableStore([
      { name: "MODEL", value: "default" },
      { name: "BASE", value: "https://api.example.com" },
    ]);
    const chain = chainVariableStores(top, bottom);
    expect(chain.get("MODEL")).toBe("override");
    expect(chain.get("BASE")).toBe("https://api.example.com");
    expect(chain.list().map((e) => e.name).sort()).toEqual(["BASE", "MODEL"]);
  });

  it("keeps request overrides ephemeral while persisting mutations to the writable base", () => {
    const request = new InMemoryVariableStore([
      { name: "LLM_API_KEY", value: "request-only" },
    ]);
    const durable = new InMemoryVariableStore([
      { name: "MODEL", value: "default" },
    ]);
    const overlay = overlayVariableStore(request, durable);

    overlay.set("checkpoint:order", { version: 1 });

    expect(overlay.get("LLM_API_KEY")).toBe("request-only");
    expect(durable.has("LLM_API_KEY")).toBe(false);
    expect(durable.get("checkpoint:order")).toEqual({ version: 1 });
  });

  it("legacy secret chain is the variable chain", () => {
    const a = new InMemorySecretStore([{ name: "K", value: "from-a" }]);
    const b = new InMemorySecretStore([
      { name: "K", value: "from-b" },
      { name: "OTHER", value: "x" },
    ]);
    const chain = chainSecretStores(a, b);
    expect(chain.getRequired("K")).toBe("from-a");
    expect(chain.getRequired("OTHER")).toBe("x");
  });
});

describe("variable-store / loaders", () => {
  it("loadFromEnv keeps secretNames as VariableStore values", () => {
    const { variables, secrets } = loadFromEnv({
      source: {
        LLM_BASE_URL: "https://api.lfzxb.top/v1",
        LLM_DEFAULT_MODEL: "deepseek-v4-pro",
        LLM_API_KEY: "sk-secret",
        UNRELATED: "ignore-me",
      },
      allow: ["LLM_BASE_URL", "LLM_DEFAULT_MODEL", "LLM_API_KEY"],
      secretNames: ["LLM_API_KEY"],
    });
    expect(variables.get("LLM_BASE_URL")).toBe("https://api.lfzxb.top/v1");
    expect(variables.get("LLM_DEFAULT_MODEL")).toBe("deepseek-v4-pro");
    expect(variables.get("LLM_API_KEY")).toBe("sk-secret");
    expect(variables.has("UNRELATED")).toBe(false);
    expect(secrets).toBe(variables);
    expect(secrets.get("LLM_API_KEY")).toBe("sk-secret");
  });

  it("coerces typed env values", () => {
    const { variables } = loadFromEnv({
      source: { PORT: "8080", DEBUG: "true", NAME: "node" },
      allow: ["PORT", "DEBUG", "NAME"],
    });
    expect(variables.get("PORT")).toBe(8080);
    expect(variables.get("DEBUG")).toBe(true);
    expect(variables.get("NAME")).toBe("node");
  });

  it("parseDotenv handles comments, blanks and quoted values", () => {
    const text = `
# comment line
FOO=bar
QUOTED="hello world"
SINGLE='abc'
EMPTY=
`;
    const m = parseDotenv(text);
    expect(m.FOO).toBe("bar");
    expect(m.QUOTED).toBe("hello world");
    expect(m.SINGLE).toBe("abc");
    expect(m.EMPTY).toBe("");
  });
});

describe("variable-store / refs and resolution", () => {
  it("isVariableRef / isSecretRef detect the wire forms", () => {
    expect(isVariableRef({ $var: "X" })).toBe(true);
    expect(isVariableRef({ $var: "X", extra: 1 })).toBe(false);
    expect(isSecretRef({ $secret: "Y" })).toBe(true);
  });

  it("resolveRefs walks arbitrary structures and replaces refs", () => {
    const variables = new InMemoryVariableStore([
      { name: "MODEL", value: "deepseek-v4-pro" },
      { name: "TIMEOUT", value: 30 },
      { name: "API_KEY", value: "sk-1" },
    ]);
    const secrets = new InMemorySecretStore();
    const cfg = {
      model: { $var: "MODEL" },
      timeoutMs: { $var: "TIMEOUT" },
      auth: { apiKey: { $secret: "API_KEY" } },
      list: [{ $var: "MODEL" }, "literal"],
    };
    const resolved = resolveRefs(cfg, { variables, secrets }) as Record<string, unknown>;
    expect(resolved.model).toBe("deepseek-v4-pro");
    expect(resolved.timeoutMs).toBe(30);
    const auth = resolved.auth as { apiKey: string };
    expect(auth.apiKey).toBe("sk-1");
    expect(resolved.list).toEqual(["deepseek-v4-pro", "literal"]);
  });

  it("missing references throw structured RuntimeError by default", () => {
    const variables = new InMemoryVariableStore();
    const secrets = new InMemorySecretStore();
    try {
      resolveRefs({ x: { $var: "NOPE" } }, { variables, secrets });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof RuntimeErrorException).toBe(true);
      expect((e as RuntimeErrorException).error.code).toBe("variable.not_found");
    }
  });

  it("allowMissing returns undefined for missing refs", () => {
    const out = resolveRefs(
      { x: { $var: "NOPE" } },
      {
        variables: new InMemoryVariableStore(),
        secrets: new InMemorySecretStore(),
      },
      { allowMissing: true },
    ) as { x: unknown };
    expect(out.x).toBeUndefined();
  });

  it("collectRefs reports legacy $secret refs as variables", () => {
    const refs = collectRefs({
      a: { $var: "A" },
      b: [{ $secret: "S" }, { $var: "A" }, { $var: "B" }],
    });
    expect(refs.variables.sort()).toEqual(["A", "B", "S"]);
    expect(refs.secrets).toEqual([]);
  });
});

describe("variable-store / process-wide defaults", () => {
  it("bootstrapDefaults builds a chain that any logic can use", () => {
    resetDefaults();
    bootstrapDefaults({
      env: {
        source: {
          LLM_BASE_URL: "https://api.lfzxb.top/v1",
          LLM_API_KEY: "sk-secret",
        },
        allow: ["LLM_BASE_URL", "LLM_API_KEY"],
        secretNames: ["LLM_API_KEY"],
      },
    });
    const variables = getDefaultVariableStore();
    expect(variables.get("LLM_BASE_URL")).toBe("https://api.lfzxb.top/v1");
    expect(variables.get("LLM_API_KEY")).toBe("sk-secret");
    resetDefaults();
  });

  it("loadFromDefaults treats legacy secrets as variables", () => {
    const { variables, secrets } = loadFromDefaults({
      variables: { MODEL: "deepseek-v4-pro" },
      secrets: { API_KEY: "sk-1" },
    });
    expect(variables.get("MODEL")).toBe("deepseek-v4-pro");
    expect(variables.get("API_KEY")).toBe("sk-1");
    expect(secrets).toBe(variables);
    expect(secrets.get("API_KEY")).toBe("sk-1");
  });
});

describe("variable-store / flow env sidecars", () => {
  it("resolves commit-safe and local sidecar paths from a flow path", () => {
    expect(resolveFlowEnvSidecarPaths("flows/demo.flow.json")).toEqual([
      "flows/demo.flow.env.json",
      "flows/demo.flow.local.env.json",
    ]);
  });

  it("merges defaults, sidecars, local overrides, and env secret allow-list", () => {
    const dir = mkdtempSync(join(tmpdir(), "anf-flow-env-"));
    const flowPath = join(dir, "demo.flow.json");
    const envPath = join(dir, "demo.flow.env.json");
    const localEnvPath = join(dir, "demo.flow.local.env.json");
    writeFileSync(flowPath, "{}\n", "utf8");
    writeFileSync(envPath, JSON.stringify({
      variables: {
        MODEL: "base-model",
        TIMEOUT_MS: 3000,
      },
      secretNames: ["API_KEY"],
      envAllow: ["EXTRA_FLAG"],
    }), "utf8");
    writeFileSync(localEnvPath, JSON.stringify({
      variables: {
        MODEL: "local-model",
      },
      secrets: {
        LOCAL_TOKEN: "local-secret",
      },
    }), "utf8");

    const scoped = createFlowScopedStores({
      flowPath,
      defaults: {
        variables: {
          MODEL: "default-model",
          BASE_URL: "https://example.test/v1",
        },
      },
      env: {
        source: {
          API_KEY: "env-secret",
          EXTRA_FLAG: "true",
          IGNORED: "nope",
        },
      },
    });
    bootstrapDefaults({
      env: scoped.env,
      overrides: {
        variables: scoped.variables,
        secrets: scoped.secrets,
      },
    });

    expect(getDefaultVariableStore().get("MODEL")).toBe("local-model");
    expect(getDefaultVariableStore().get("BASE_URL")).toBe("https://example.test/v1");
    expect(getDefaultVariableStore().get("TIMEOUT_MS")).toBe(3000);
    expect(getDefaultVariableStore().get("EXTRA_FLAG")).toBe(true);
    expect(getDefaultVariableStore().has("IGNORED")).toBe(false);
    expect(getDefaultVariableStore().get("API_KEY")).toBe("env-secret");
    expect(getDefaultVariableStore().get("LOCAL_TOKEN")).toBe("local-secret");
    resetDefaults();
  });

  it("rejects malformed sidecar shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "anf-flow-env-bad-"));
    const envPath = join(dir, "bad.flow.env.json");
    writeFileSync(envPath, JSON.stringify({ secretNames: "API_KEY" }), "utf8");
    expect(() => loadFlowEnvSidecars([envPath])).toThrow(/secretNames/);
  });
});
