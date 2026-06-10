/**
 * Type contracts shared by the skill→flow conversion pipeline.
 *
 *   SKILL.md
 *     ▼
 *   [skill_parser]      rules            → SkillDefinition
 *     ▼
 *   [skill_planner]     LLM              → ExecutionPlan
 *     ▼
 *   [node_designer]     LLM (parallel)   → NodeSpec[]
 *     ▼
 *   [code_synthesizer]  LLM (parallel)   → GeneratedFlowPackage
 *     ▼
 *   [flow_validator]    rules            → FlowArtifact
 *     ▼
 *   [package_materializer] agent          → files + verification
 *
 * All LLM-bearing nodes consume a strict zod schema for their JSON
 * outputs, so any drift / hallucination is caught at parse time and
 * surfaced as a node-level validation error rather than poisoning the
 * downstream stages.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Skill definition (parsed from SKILL.md)                                    */
/* -------------------------------------------------------------------------- */

/**
 * YAML frontmatter subset we care about. Anything else the SKILL author
 * dumps in there is preserved on `extra` so prompts can still reason
 * about it. Field names follow CodeBuddy's SKILL.md spec verbatim
 * (kebab-case with quotes in TS).
 */
export const skillFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    "allowed-tools": z.string().optional(),
    "disable-model-invocation": z.boolean().optional(),
    "user-invocable": z.boolean().optional(),
    context: z.enum(["fork", "default"]).optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    hooks: z.unknown().optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface SkillDefinition {
  /** Source path or virtual identifier of the skill. */
  sourcePath: string;
  /** Resolved skill name (frontmatter.name → directory basename → fallback). */
  name: string;
  /** Resolved one-line description. */
  description: string;
  /** Raw frontmatter (may contain extra fields). */
  frontmatter: SkillFrontmatter;
  /** Markdown body after the frontmatter delimiter. */
  body: string;
  /** Parsed allowed-tools list (deduped, trimmed). */
  allowedTools: string[];
}

/* -------------------------------------------------------------------------- */
/* Execution plan (skill_planner → ...)                                        */
/* -------------------------------------------------------------------------- */

export const planStepKind = z.enum([
  "input", // Accept / validate user input
  "analyze", // Pure analysis / classification
  "execute", // Invoke an external tool / MCP / shell
  "transform", // Deterministic data transformation
  "llm_call", // Single-shot LLM call with a prompt
  "validate", // Validate prior output / quality gate
  "report", // Produce final user-facing output
]);
export type PlanStepKind = z.infer<typeof planStepKind>;

export const planStepIoSchema = z
  .object({
    name: z.string().min(1),
    /** Human description of the field's semantic. */
    description: z.string().default(""),
    /** Coarse type — fed back to node_designer for port shape. */
    dataType: z
      .enum(["string", "number", "boolean", "object", "array", "any"])
      .default("any"),
  })
  .passthrough();
export type PlanStepIo = z.infer<typeof planStepIoSchema>;

export const planStepSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, "step id must be lower_snake_case"),
    label: z.string().min(1),
    kind: planStepKind,
    description: z.string().min(1),
    /** What this step achieves, in plain English (1-3 sentences). */
    intent: z.string().min(1),
    /** Subset of SkillDefinition.allowedTools this step needs (may be []). */
    requiredTools: z.array(z.string()).default([]),
    /** Step ids this step waits on. Empty = root (depends on start). */
    dependencies: z.array(z.string()).default([]),
    /** Logical inputs (matched to upstream outputs by name where possible). */
    inputs: z.array(planStepIoSchema).default([]),
    /** Logical outputs (consumed by downstream steps). */
    outputs: z.array(planStepIoSchema).default([]),
  })
  .passthrough();
export type PlanStep = z.infer<typeof planStepSchema>;

export const skillRequirementsSchema = z
  .object({
    /** What the generated flow must accomplish. */
    goals: z.array(z.string()).default([]),
    /** Expected caller inputs at the flow boundary. */
    inputContract: z.array(planStepIoSchema).default([]),
    /** Expected final outputs / user-facing result shape. */
    outputContract: z.array(planStepIoSchema).default([]),
    /** Observable checks the generated package should satisfy. */
    acceptanceCriteria: z.array(z.string()).default([]),
    /** Hard constraints from the source SKILL.md / allowed tools. */
    constraints: z.array(z.string()).default([]),
    /** How cumulative context should move through the generated flow. */
    contextHandoff: z.string().default(""),
  })
  .passthrough();
export type SkillRequirements = z.infer<typeof skillRequirementsSchema>;

export const executionPlanSchema = z
  .object({
    skillName: z.string().min(1),
    summary: z.string().min(1),
    /**
     * Structured requirements extracted from the original SKILL. Optional for
     * backward compatibility; skill_planner normalises missing values.
     */
    requirements: skillRequirementsSchema.optional(),
    steps: z.array(planStepSchema).min(1),
    /** Optional grouping hint (parallelizable step ids). */
    parallelGroups: z.array(z.array(z.string())).default([]),
  })
  .passthrough();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

/* -------------------------------------------------------------------------- */
/* Node spec (node_designer → ...)                                             */
/* -------------------------------------------------------------------------- */

export const configFieldSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "array", "object"]),
    required: z.boolean().default(false),
    /** Optional default value (any JSON-serialisable). */
    default: z.unknown().optional(),
    description: z.string().default(""),
  })
  .passthrough();
export type ConfigField = z.infer<typeof configFieldSchema>;

export const portSpecSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, "port id must be lower_snake_case"),
    kind: z.enum(["control", "data", "error"]),
    direction: z.enum(["input", "output"]),
    label: z.string().default(""),
    dataType: z
      .enum(["string", "number", "boolean", "object", "array", "any"])
      .default("any"),
    /** When true, the runtime aggregates multiple inbound edges into an array. */
    multiple: z.boolean().optional(),
  })
  .passthrough();
export type PortSpec = z.infer<typeof portSpecSchema>;

export const nodeImplStrategy = z.enum([
  "llm_prompt", // run() renders a prompt and calls chat()
  "transform", // run() does deterministic data plumbing only
  "external_call", // run() calls an external tool / HTTP / MCP
]);
export type NodeImplStrategy = z.infer<typeof nodeImplStrategy>;

export const nodeImplementationSchema = z
  .object({
    strategy: nodeImplStrategy,
    /** Required when strategy === "llm_prompt". */
    promptTemplate: z.string().optional(),
    /** Required when strategy === "llm_prompt"; "text" or "json". */
    responseFormat: z.enum(["text", "json"]).optional(),
    /** Required when strategy === "transform". */
    transformLogic: z.string().optional(),
    /** Required when strategy === "external_call". */
    tool: z.string().optional(),
    /** Free-form description of the call (HTTP / MCP / shell). */
    callDescription: z.string().optional(),
  })
  .passthrough();
export type NodeImplementation = z.infer<typeof nodeImplementationSchema>;

export const nodeSpecSchema = z
  .object({
    stepId: z.string().min(1),
    nodeType: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "nodeType must be lower_snake_case (used as runtime type id)",
      ),
    typeVersion: z.string().default("1.0.0"),
    title: z.string().min(1),
    description: z.string().default(""),
    configFields: z.array(configFieldSchema).default([]),
    inputPorts: z.array(portSpecSchema).default([]),
    outputPorts: z.array(portSpecSchema).default([]),
    implementation: nodeImplementationSchema,
    /** Step-by-step pseudocode for the run() function (for the synthesizer). */
    pseudocode: z.string().min(1),
    /** Whether this node needs the shared LLM helper bundled into the package. */
    requiresLlm: z.boolean().default(false),
  })
  .passthrough();
export type NodeSpec = z.infer<typeof nodeSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Synthesised package (code_synthesizer → ...)                                */
/* -------------------------------------------------------------------------- */

/** A single source file that the synthesizer wants to drop on disk. */
export interface GeneratedFile {
  /** Relative path from the generated package root. */
  path: string;
  contents: string;
}

/** Per-node TS source generated by the LLM. */
export interface GeneratedNodeCode extends GeneratedFile {
  nodeType: string;
}

/** Output of the code_synthesizer node. */
export interface GeneratedFlowPackage {
  skillName: string;
  flowId: string;
  flowVersion: string;
  /** Planner-extracted requirement contract, preserved for generated-package audit. */
  requirements?: SkillRequirements;
  /** Synthesised TS sources, one per custom node + shared helpers. */
  files: GeneratedFile[];
  /** The `nodes/index.ts` entry that re-exports every node. */
  nodesIndex: GeneratedFile;
  /** `build.ts` source for the generated package. */
  buildScript: GeneratedFile;
  /** `runtime.ts` source for the generated package. */
  runtimeScript: GeneratedFile;
  /** `cli.ts` source for running the generated flow from a terminal. */
  cliScript: GeneratedFile;
  /** `package.json` for the generated runnable app package. */
  packageJson: GeneratedFile;
  /** `tsconfig.json` for generated TypeScript validation. */
  tsconfig: GeneratedFile;
  /** `flows/<id>.json` — pre-built FlowGraph in-memory. */
  flowJsonFile: GeneratedFile;
  /** Parsed FlowGraph object kept in-memory for the validator. */
  flowGraph: unknown; // kept loosely typed: validator imports flow-ir for the strict shape
  /** A short README summarising the generated package. */
  readme: GeneratedFile;
}

/* -------------------------------------------------------------------------- */
/* Flow artifact (flow_validator → caller)                                     */
/* -------------------------------------------------------------------------- */

export interface MaterializationFileRef {
  /** Human-readable role for the generated file. */
  role: string;
  /** Resolved package-relative path, useful for inspection and final summaries. */
  path: string;
  /** Context ref that resolves to the file path for agent edit_file.path_ref. */
  pathRef: string;
  /** Context ref that resolves to file contents for agent edit_file.new_text_ref. */
  contentsRef: string;
}

export interface MaterializationPlan {
  /** Ordered checklist for the package materializer agent. */
  files: MaterializationFileRef[];
  /** Lightweight verification commands the agent may run after writing files. */
  verifyCommands: string[];
}

export type PackageFileIssueKind =
  | "unsafe_file_path"
  | "non_posix_file_path"
  | "directory_file_path"
  | "duplicate_file_path";

export interface PackageFileIssue {
  kind: PackageFileIssueKind;
  path: string;
  /** Context ref that resolves to the original generated path. */
  pathRef: string;
  /** Context ref that resolves to the original generated contents. */
  contentsRef: string;
  message: string;
}

export interface FlowArtifact {
  skillName: string;
  flowId: string;
  flowVersion: string;
  /** Planner-extracted requirement contract passed through for downstream agents. */
  requirements?: SkillRequirements;
  nodeCount: number;
  edgeCount: number;
  isValid: boolean;
  /** Structural errors from `validateGraph` (empty when valid). */
  errors: string[];
  /** Soft warnings from `validateGraph` + lint hints from synthesised TS. */
  warnings: string[];
  /** Structured generated-package file path issues for agent repair. */
  fileIssues: PackageFileIssue[];
  /** Echo of the synthesised package — caller writes this to disk. */
  package: GeneratedFlowPackage;
  /** Structured context for the package_materializer agent. */
  materializationPlan: MaterializationPlan;
}
