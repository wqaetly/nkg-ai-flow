/**
 * `skill_parser` — deterministic, rule-based first stage.
 *
 * Splits a SKILL.md into YAML frontmatter + Markdown body using the
 * battle-tested `yaml` library, then normalises the result into a
 * `SkillDefinition` for downstream LLM stages. No model calls happen
 * here on purpose: parsing structured input with a model is the
 * canonical "wrong tool for the job" failure mode.
 *
 * Accepted input shapes (any one is enough):
 *   • { skill_content: string,  skill_path?: string }
 *   • { skill_file_path: string }                — read from disk
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { defineNode } from "@ai-native-flow/node-sdk";
import YAML from "yaml";
import { z } from "zod";

import {
  type SkillDefinition,
  type SkillFrontmatter,
  skillFrontmatterSchema,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

const skillParserConfig = z
  .object({
    /** Fallback skill name if neither frontmatter nor path can supply one. */
    default_name: z.string().default("unnamed-skill"),
    /** Hard cap on body length to keep LLM prompts bounded. Default 100KB. */
    max_body_length: z.number().int().min(1).default(100_000),
  })
  .passthrough();
type SkillParserConfig = z.infer<typeof skillParserConfig>;

/* -------------------------------------------------------------------------- */
/* node                                                                       */
/* -------------------------------------------------------------------------- */

export const skillParserNode = defineNode({
  type: "skill_parser",
  typeVersion: "1.0.0",
  title: "Skill 解析器",
  description:
    "解析 SKILL.md 的 YAML frontmatter + Markdown 正文，输出结构化 SkillDefinition；纯规则化，不调 LLM。",
  config: skillParserConfig,
  fieldMeta: {
    default_name: { label: "默认 Skill 名称", order: 1 },
    max_body_length: { label: "正文长度上限（字节）", order: 2 },
  },
  ports: [
    {
      id: "skill_def",
      direction: "output",
      kind: "data",
      label: "SkillDefinition",
      schema: { type: "object" },
    },
  ],
  validateInput: false,
  async run({ input, config, ctx }) {
    const cfg = config as SkillParserConfig;
    const raw = input as Record<string, unknown>;

    const { content, sourcePath } = await loadSource(raw);

    if (!content || !content.trim()) {
      return {
        kind: "error",
        error: {
          code: "node.skill_parser.empty_content",
          message:
            "skill_parser received empty content. Provide either `skill_content` or `skill_file_path` in the input.",
          kind: "validation",
          category: "user_input",
        },
      };
    }

    const { frontmatter, body } = splitFrontmatter(content);

    const fmCheck = skillFrontmatterSchema.safeParse(frontmatter);
    if (!fmCheck.success) {
      return {
        kind: "error",
        error: {
          code: "node.skill_parser.invalid_frontmatter",
          message: `Frontmatter failed validation: ${fmCheck.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          kind: "validation",
          category: "user_input",
        },
      };
    }
    const fm = fmCheck.data;

    const name = resolveName(fm, sourcePath, cfg.default_name);
    const description = (fm.description ?? "").trim();
    const allowedTools = parseToolList(fm["allowed-tools"]);

    const trimmedBody =
      body.length > cfg.max_body_length
        ? `${body.slice(0, cfg.max_body_length)}\n\n[... truncated ${body.length - cfg.max_body_length} chars]`
        : body;

    const definition: SkillDefinition = {
      sourcePath,
      name,
      description,
      frontmatter: fm,
      body: trimmedBody,
      allowedTools,
    };

    ctx.log.info("skill_parser: parsed", {
      name,
      bodyChars: trimmedBody.length,
      allowedTools,
    });

    return {
      kind: "success",
      outputs: { out: null, skill_def: definition },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface LoadedSource {
  content: string;
  sourcePath: string;
}

async function loadSource(raw: Record<string, unknown>): Promise<LoadedSource> {
  const inlineContent =
    typeof raw.skill_content === "string" ? raw.skill_content : undefined;
  const inlinePath =
    typeof raw.skill_path === "string" ? raw.skill_path : undefined;
  const filePath =
    typeof raw.skill_file_path === "string" ? raw.skill_file_path : undefined;

  if (inlineContent !== undefined) {
    return {
      content: inlineContent,
      sourcePath: inlinePath ?? "<inline>",
    };
  }
  if (filePath) {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const content = readFileSync(abs, "utf8");
    return { content, sourcePath: abs };
  }
  return { content: "", sourcePath: "<missing>" };
}

interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a SKILL.md into frontmatter + body. Frontmatter is any YAML
 * fenced by `---` lines at the very start of the file. Anything else
 * is body. When no frontmatter is present we still return cleanly so
 * down-stream stages can treat the body as a free-form description.
 */
export function splitFrontmatter(content: string): SplitResult {
  const normalised = content.replace(/^\uFEFF/, "");
  const fenceRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const m = fenceRe.exec(normalised);
  if (!m || m.index !== 0) {
    return { frontmatter: {}, body: normalised };
  }
  const yamlBlock = m[1] ?? "";
  const body = normalised.slice(m[0].length);
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlBlock);
  } catch (cause) {
    throw new Error(
      `skill_parser: failed to parse YAML frontmatter: ${(cause as Error).message}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body };
  }
  if (typeof parsed !== "object") {
    throw new Error(
      `skill_parser: frontmatter must be a YAML mapping, got ${typeof parsed}`,
    );
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function resolveName(
  fm: SkillFrontmatter,
  sourcePath: string,
  fallback: string,
): string {
  if (fm.name && fm.name.trim()) return fm.name.trim();
  if (sourcePath && sourcePath !== "<inline>" && sourcePath !== "<missing>") {
    const base = path.basename(sourcePath, path.extname(sourcePath));
    if (base.toLowerCase() === "skill" || base.toLowerCase() === "skill.md") {
      const dir = path.basename(path.dirname(sourcePath));
      if (dir && dir !== ".") return dir;
    } else if (base) {
      return base;
    }
  }
  return fallback;
}

function parseToolList(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}
