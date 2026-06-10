import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { defineFlow } from "@ai-native-flow/flow-builder";
import { createDefaultRegistry } from "@ai-native-flow/flow-ir";
import { getBuiltinNodeDefinitions } from "@ai-native-flow/runtime";
import {
  InMemorySecretStore,
  InMemoryVariableStore,
} from "@ai-native-flow/variable-store";

import { buildSkillToFlowFlow } from "../build.js";
import { createSkillToFlowRuntime } from "../runtime.js";
import {
  __testing as codeSynthesizerTesting,
  codeSynthesizerNode,
} from "./codeSynthesizer.js";
import {
  __testing as flowValidatorTesting,
  flowValidatorNode,
} from "./flowValidator.js";
import { __testing as nodeDesignerTesting } from "./nodeDesigner.js";
import {
  __testing as skillPlannerTesting,
  skillPlannerNode,
} from "./skillPlanner.js";
import type {
  ExecutionPlan,
  GeneratedFlowPackage,
  NodeSpec,
  PlanStep,
  SkillDefinition,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface TestEdge {
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
}

interface TestGraph {
  nodes: Array<{
    id: string;
    ports: Array<{ id: string; direction: string; multiple?: boolean }>;
  }>;
  edges: TestEdge[];
}

describe("skill-to-flow context handoff", () => {
  it("builds the conversion pipeline with an agent materializer stage", () => {
    const graph = JSON.parse(buildSkillToFlowFlow().dump()) as {
      nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
      edges: TestEdge[];
    };

    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "package_materializer",
        type: "agent",
      }),
    );
    expect(
      graph.nodes.find((node) => node.id === "package_materializer")?.config
        ?.workingDir,
    ).toBe("./generated/skill-to-flow-output");
    expect(
      graph.nodes.find((node) => node.id === "package_materializer")?.config
        ?.allowedTools,
    ).toEqual([
      "list_files",
      "read_file",
      "grep",
      "edit_file",
      "write_files",
      "run_bash",
    ]);
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "materialize_task",
        type: "text_input",
      }),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "output_dir",
        type: "transform",
        config: expect.objectContaining({
          template: "${input.output_dir}",
        }),
      }),
    );
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain('write_files call with files_ref="materializationPlan.files"');
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("lint.directory_file_path");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("context.materializationPlan.files");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("context.errors/context.warnings");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("context.fileIssues");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("context.requirements");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("acceptance criteria");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("context handoff policy");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("context.fileIssues is non-empty");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("unresolved_errors");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("validator_status");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("verification_results");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("only include model-owned repair notes");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("Do not guess or hand-write changed_files");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("the runtime agent fills those fields from real tool logs");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("the input FlowArtifact");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("never rename verification_results to verification");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("npm run typecheck --if-present");
    expect(
      graph.nodes.find((node) => node.id === "materialize_task")?.config?.value,
    ).toContain("run each command in context.materializationPlan.verifyCommands in order");
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: { nodeId: "node_start", portId: "runInput" },
          to: { nodeId: "output_dir", portId: "input" },
        }),
        expect.objectContaining({
          from: { nodeId: "flow_validator", portId: "artifact" },
          to: { nodeId: "package_materializer", portId: "context" },
        }),
        expect.objectContaining({
          from: { nodeId: "materialize_task", portId: "text" },
          to: { nodeId: "package_materializer", portId: "task" },
        }),
        expect.objectContaining({
          from: { nodeId: "output_dir", portId: "output" },
          to: { nodeId: "package_materializer", portId: "working_dir" },
        }),
        expect.objectContaining({
          from: { nodeId: "flow_validator", portId: "out" },
          to: { nodeId: "materialize_task", portId: "in" },
        }),
        expect.objectContaining({
          from: { nodeId: "materialize_task", portId: "out" },
          to: { nodeId: "package_materializer", portId: "in" },
        }),
        expect.objectContaining({
          from: { nodeId: "package_materializer", portId: "out" },
          to: { nodeId: "node_end", portId: "in" },
        }),
      ]),
    );
  });

  it("rejects plans with broken context/tool/group contracts", () => {
    const plan: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Broken plan.",
      parallelGroups: [["missing_step", "answer", "answer"]],
      steps: [
        planStep({
          id: "intake",
          dependencies: [],
          outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
        }),
        planStep({
          id: "answer",
          kind: "llm_call",
          dependencies: ["intake"],
          requiredTools: ["shell"],
          inputs: [
            {
              name: "unrelated",
              description: "Does not match upstream output",
              dataType: "object",
            },
          ],
          outputs: [{ name: "answer", description: "Answer", dataType: "string" }],
        }),
        planStep({
          id: "orphan_consumer",
          dependencies: ["intake"],
          inputs: [],
          outputs: [{ name: "result", description: "Result", dataType: "string" }],
        }),
      ],
    };

    const errors = skillPlannerTesting.validatePlanIntegrity(plan, {
      allowedTools: ["read"],
    });

    expect(errors).toContain('step "answer" requires undeclared tool "shell"');
    expect(errors).toContain(
      'step "answer" inputs do not match outputs from dependencies',
    );
    expect(errors).toContain(
      'step "orphan_consumer" depends on upstream steps but declares no inputs',
    );
    expect(errors).toContain('parallelGroups references unknown step id "missing_step"');
    expect(errors).toContain('parallelGroups contains duplicate step id "answer"');
  });

  it("rejects impossible or overlapping parallel groups", () => {
    const plan: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Invalid parallel groups.",
      parallelGroups: [["draft", "refine"], ["review", "draft"]],
      steps: [
        planStep({
          id: "draft",
          outputs: [{ name: "context", description: "Draft context", dataType: "object" }],
        }),
        planStep({
          id: "refine",
          dependencies: ["draft"],
          inputs: [{ name: "context", description: "Draft context", dataType: "object" }],
          outputs: [{ name: "refined", description: "Refined result", dataType: "string" }],
        }),
        planStep({
          id: "review",
          outputs: [{ name: "rubric", description: "Review rubric", dataType: "object" }],
        }),
      ],
    };

    const errors = skillPlannerTesting.validatePlanIntegrity(plan, {
      allowedTools: [],
    });

    expect(errors).toContain(
      'parallelGroups groups dependent steps "draft" and "refine"',
    );
    expect(errors).toContain(
      'parallelGroups contains step id "draft" in multiple groups',
    );
  });

  it("rejects invalid or duplicate plan IO names before NodeSpec auto-fill", () => {
    const plan: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Invalid IO names.",
      parallelGroups: [],
      steps: [
        planStep({
          id: "intake",
          inputs: [
            { name: "User Request", description: "Bad input", dataType: "object" },
            { name: "user_request", description: "Good input", dataType: "object" },
            { name: "user_request", description: "Duplicate input", dataType: "object" },
          ],
          outputs: [
            { name: "Context", description: "Bad output", dataType: "object" },
            { name: "context", description: "Good output", dataType: "object" },
            { name: "context", description: "Duplicate output", dataType: "object" },
          ],
        }),
      ],
    };

    const errors = skillPlannerTesting.validatePlanIntegrity(plan, {
      allowedTools: [],
    });

    expect(errors).toContain(
      'step "intake" input "User Request" is not a valid lower_snake_case port id',
    );
    expect(errors).toContain('step "intake" declares duplicate input "user_request"');
    expect(errors).toContain(
      'step "intake" output "Context" is not a valid lower_snake_case port id',
    );
    expect(errors).toContain('step "intake" declares duplicate output "context"');
  });

  it("rejects multi-dependency steps that ignore one dependency output", () => {
    const plan: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Partially wired dependency.",
      parallelGroups: [["extract_a", "extract_b"]],
      steps: [
        planStep({
          id: "extract_a",
          outputs: [{ name: "alpha", description: "First finding", dataType: "object" }],
        }),
        planStep({
          id: "extract_b",
          outputs: [{ name: "beta", description: "Second finding", dataType: "object" }],
        }),
        planStep({
          id: "merge_answer",
          kind: "llm_call",
          dependencies: ["extract_a", "extract_b"],
          inputs: [{ name: "alpha", description: "Only first finding", dataType: "object" }],
          outputs: [{ name: "answer", description: "Merged answer", dataType: "string" }],
        }),
      ],
    };

    const errors = skillPlannerTesting.validatePlanIntegrity(plan, {
      allowedTools: [],
    });

    expect(errors).toContain(
      'step "merge_answer" does not consume any output from dependency "extract_b"',
    );
  });

  it("rejects plans outside the configured step-count range", () => {
    const tooSmall: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Too small.",
      parallelGroups: [],
      steps: [planStep({ id: "only_step" })],
    };
    const tooLarge: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Too large.",
      parallelGroups: [],
      steps: [
        planStep({ id: "first_step" }),
        planStep({ id: "second_step" }),
      ],
    };

    expect(
      skillPlannerTesting.validatePlanIntegrity(
        tooSmall,
        { allowedTools: [] },
        { minSteps: 2, maxSteps: 4 },
      ),
    ).toContain("plan has 1 steps, below min_steps 2");
    expect(
      skillPlannerTesting.validatePlanIntegrity(
        tooLarge,
        { allowedTools: [] },
        { minSteps: 1, maxSteps: 1 },
      ),
    ).toContain("plan has 2 steps, above max_steps 1");
  });

  it("rejects inconsistent planner step range config before calling the LLM", async () => {
    const result = await skillPlannerNode.runner(
      {
        __config__: { min_steps: 5, max_steps: 2 },
        skill_def: skillDefinition(),
      },
      fakeNodeContext(),
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error.code).toBe("node.skill_planner.invalid_step_range");
    }
  });

  it("normalizes root NodeSpecs to read runtime input instead of fake data ports", () => {
    const step = planStep({
      id: "read_request",
      kind: "llm_call",
      dependencies: [],
      inputs: [{ name: "request", description: "Caller request", dataType: "object" }],
      outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
    });
    const spec = nodeSpec({
      stepId: "model_rewrote_this",
      nodeType: "demo_read_request",
      inputPorts: [
        {
          id: "request",
          kind: "data",
          direction: "input",
          label: "Request",
          dataType: "object",
        },
      ],
      outputPorts: [],
      implementation: {
        strategy: "llm_prompt",
        promptTemplate: "Read ${input.request}",
        responseFormat: "json",
      },
      requiresLlm: false,
    });

    const normalized = nodeDesignerTesting.normalizeDesignedSpec(spec, step);

    expect(normalized.stepId).toBe("read_request");
    expect(normalized.requiresLlm).toBe(true);
    expect(normalized.inputPorts).toEqual([]);
    expect(normalized.outputPorts.some((p) => p.id === "context")).toBe(true);
    expect(normalized.pseudocode).toContain("raw.__runInput__");
    expect(normalized.implementation.promptTemplate).toContain("__runInput__");
  });

  it("forces judgment-heavy plan steps to remain LLM prompt nodes", () => {
    const step = planStep({
      id: "validate_answer",
      kind: "validate",
      dependencies: ["draft_answer"],
      intent: "Validate that the draft answer follows the skill instructions.",
      inputs: [{ name: "context", description: "Draft context", dataType: "object" }],
      outputs: [{ name: "validation", description: "Validation result", dataType: "object" }],
    });
    const spec = nodeSpec({
      stepId: "validate_answer",
      nodeType: "demo_validate_answer",
      inputPorts: [],
      outputPorts: [],
      implementation: {
        strategy: "transform",
        transformLogic: "Return the input unchanged.",
      },
      requiresLlm: false,
    });

    const normalized = nodeDesignerTesting.normalizeDesignedSpec(spec, step);

    expect(normalized.implementation.strategy).toBe("llm_prompt");
    expect(normalized.implementation.responseFormat).toBe("json");
    expect(normalized.implementation.promptTemplate).toContain("${input.context}");
    expect(normalized.requiresLlm).toBe(true);
    expect(normalized.pseudocode).toContain("judgment-heavy");
  });

  it("adds missing plan inputs to non-root LLM prompt templates", () => {
    const step = planStep({
      id: "write_answer",
      kind: "llm_call",
      dependencies: ["draft_answer"],
      inputs: [
        { name: "context", description: "Shared context", dataType: "object" },
        { name: "draft", description: "Draft answer", dataType: "string" },
      ],
      outputs: [{ name: "answer", description: "Final answer", dataType: "string" }],
    });
    const spec = nodeSpec({
      stepId: "write_answer",
      nodeType: "demo_write_answer",
      inputPorts: [
        {
          id: "context",
          kind: "data",
          direction: "input",
          label: "Context",
          dataType: "object",
        },
      ],
      outputPorts: [],
      implementation: {
        strategy: "llm_prompt",
        promptTemplate: "Use context: ${input.context}",
        responseFormat: "text",
      },
      requiresLlm: true,
    });

    const normalized = nodeDesignerTesting.normalizeDesignedSpec(spec, step);

    expect(normalized.implementation.promptTemplate).toContain("${input.context}");
    expect(normalized.implementation.promptTemplate).toContain("${input.draft}");
    expect(normalized.inputPorts.some((p) => p.id === "draft")).toBe(true);
  });

  it("marks multi-dependency context inputs as multiple", () => {
    const step = planStep({
      id: "merge_context",
      dependencies: ["collect_a", "collect_b"],
      inputs: [{ name: "context", description: "Upstream contexts", dataType: "object" }],
      outputs: [{ name: "context", description: "Merged context", dataType: "object" }],
    });
    const spec = nodeSpec({
      stepId: "merge_context",
      nodeType: "demo_merge_context",
      inputPorts: [
        {
          id: "context",
          kind: "data",
          direction: "input",
          label: "Context",
          dataType: "object",
        },
      ],
      outputPorts: [],
    });

    const normalized = nodeDesignerTesting.normalizeDesignedSpec(spec, step);
    const contextInput = normalized.inputPorts.find((p) => p.id === "context");

    expect(contextInput?.multiple).toBe(true);
    expect(normalized.pseudocode).toContain("raw.context is an array");
  });

  it("fills missing NodeSpec data ports from the plan IO contract", () => {
    const step = planStep({
      id: "write_answer",
      kind: "llm_call",
      dependencies: ["draft"],
      inputs: [{ name: "draft", description: "Draft context", dataType: "object" }],
      outputs: [{ name: "answer", description: "Final answer", dataType: "string" }],
    });
    const spec = nodeSpec({
      stepId: "write_answer",
      nodeType: "demo_write_answer",
      inputPorts: [],
      outputPorts: [],
    });

    const normalized = nodeDesignerTesting.normalizeDesignedSpec(spec, step);

    expect(normalized.inputPorts).toContainEqual(
      expect.objectContaining({
        id: "draft",
        direction: "input",
        kind: "data",
        dataType: "object",
      }),
    );
    expect(normalized.outputPorts).toContainEqual(
      expect.objectContaining({
        id: "answer",
        direction: "output",
        kind: "data",
        dataType: "string",
      }),
    );
    expect(normalized.pseudocode).toContain('Read plan-declared input port "draft"');
    expect(normalized.pseudocode).toContain('Emit plan-declared output port "answer"');
  });

  it("prevents generated custom nodes from reusing runtime built-in node types", () => {
    const prompt = nodeDesignerTesting.buildSystemPrompt();
    expect([...nodeDesignerTesting.runtimeBuiltinNodeTypes]).toEqual(
      getBuiltinNodeDefinitions().map((definition) => definition.type),
    );
    expect(prompt).toContain("Do not use runtime built-in node type names");
    expect(prompt).toContain("text_input");
    expect(prompt).toContain("agent");

    const error = nodeDesignerTesting.validateDesignedSpecs([
      nodeSpec({ stepId: "materialize", nodeType: "agent" }),
    ]);
    expect(error).toEqual({
      code: "node.node_designer.reserved_node_type",
      message:
        'node_designer: nodeType "agent" is a runtime built-in. The model must pick a skill-scoped custom lower_snake_case id instead.',
    });
  });

  it("passes structured requirements from planning into design and synthesis prompts", () => {
    const plannerPrompt = skillPlannerTesting.buildSystemPrompt(3, 12);
    expect(plannerPrompt).toContain('"requirements"');
    expect(plannerPrompt).toContain('"acceptanceCriteria"');
    expect(skillPlannerTesting.normalizeRequirements(undefined)).toEqual({
      goals: [],
      inputContract: [],
      outputContract: [],
      acceptanceCriteria: [],
      constraints: [],
      contextHandoff: "",
    });

    const derived = skillPlannerTesting.normalizeRequirements(undefined, {
      summary: "Answer the user's request.",
      steps: [
        planStep({
          id: "read_request",
          dependencies: [],
          inputs: [
            { name: "request", description: "Caller request", dataType: "object" },
          ],
          outputs: [
            { name: "context", description: "Shared context", dataType: "object" },
          ],
        }),
        planStep({
          id: "write_answer",
          dependencies: ["read_request"],
          inputs: [
            { name: "context", description: "Shared context", dataType: "object" },
          ],
          outputs: [
            { name: "answer", description: "Final answer", dataType: "string" },
          ],
        }),
      ],
    });
    expect(derived.goals).toEqual(["Answer the user's request."]);
    expect(derived.inputContract).toEqual([
      { name: "request", description: "Caller request", dataType: "object" },
    ]);
    expect(derived.outputContract).toEqual([
      { name: "answer", description: "Final answer", dataType: "string" },
    ]);
    expect(derived.acceptanceCriteria).toEqual([
      "The generated flow validates successfully and produces the declared output contract.",
    ]);
    expect(derived.contextHandoff).toContain("__runInput__");

    const skill = skillDefinition();
    const step = planStep({
      id: "answer",
      kind: "llm_call",
      dependencies: [],
      outputs: [{ name: "answer", description: "Final answer", dataType: "string" }],
    });
    const plan: ExecutionPlan = {
      skillName: skill.name,
      summary: "Demo requirements handoff.",
      requirements: {
        goals: ["Answer the user's request with traceable reasoning."],
        inputContract: [
          { name: "request", description: "Caller request", dataType: "object" },
        ],
        outputContract: [
          { name: "answer", description: "Final answer", dataType: "string" },
        ],
        acceptanceCriteria: ["The generated flow returns an answer string."],
        constraints: ["Use only declared tools."],
        contextHandoff: "Carry cumulative context through a context object.",
      },
      parallelGroups: [],
      steps: [step],
    };
    const designerPrompt = nodeDesignerTesting.buildUserPrompt(skill, plan, step);
    const synthesizerPrompt = codeSynthesizerTesting.buildUserPrompt(
      skill,
      plan,
      nodeSpec({ stepId: "answer", nodeType: "demo_answer" }),
      step,
    );
    const readme = codeSynthesizerTesting.renderReadme(
      skill,
      plan,
      [nodeSpec({ stepId: "answer", nodeType: "demo_answer" })],
      "demo_skill",
    );

    for (const prompt of [designerPrompt, synthesizerPrompt]) {
      expect(prompt).toContain("# REQUIREMENTS");
      expect(prompt).toContain("Answer the user's request with traceable reasoning.");
      expect(prompt).toContain("The generated flow returns an answer string.");
      expect(prompt).toContain("Carry cumulative context through a context object.");
    }

    expect(readme).toContain("## Requirements");
    expect(readme).toContain("### Acceptance Criteria");
    expect(readme).toContain("- The generated flow returns an answer string.");
    expect(readme).toContain("### Context Handoff");
    expect(readme).toContain("Carry cumulative context through a context object.");
  });

  it("wires upstream context into a differently named downstream data input", () => {
    const plan: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Demo context handoff.",
      parallelGroups: [],
      steps: [
        planStep({
          id: "intake",
          kind: "llm_call",
          dependencies: [],
          outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
        }),
        planStep({
          id: "answer",
          kind: "llm_call",
          dependencies: ["intake"],
          inputs: [
            {
              name: "analysis_input",
              description: "Input deliberately named differently",
              dataType: "object",
            },
          ],
          outputs: [{ name: "answer", description: "Final answer", dataType: "string" }],
        }),
      ],
    };
    const specs = [
      nodeSpec({
        stepId: "intake",
        nodeType: "demo_intake",
        outputPorts: [
          {
            id: "context",
            kind: "data",
            direction: "output",
            label: "Context",
            dataType: "object",
          },
        ],
      }),
      nodeSpec({
        stepId: "answer",
        nodeType: "demo_answer",
        inputPorts: [
          {
            id: "analysis_input",
            kind: "data",
            direction: "input",
            label: "Analysis input",
            dataType: "object",
          },
        ],
        outputPorts: [
          {
            id: "answer",
            kind: "data",
            direction: "output",
            label: "Answer",
            dataType: "string",
          },
        ],
      }),
    ];

    const graph = codeSynthesizerTesting.assembleFlowGraph(
      skillDefinition(),
      plan,
      specs,
      "1.0.0",
    ).graph as TestGraph;

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: { nodeId: "intake", portId: "context" },
        to: { nodeId: "answer", portId: "analysis_input" },
      }),
    );
  });

  it("fans multiple upstream contexts into a multiple context input", () => {
    const plan: ExecutionPlan = {
      skillName: "demo-skill",
      summary: "Demo multi-dependency context handoff.",
      parallelGroups: [["collect_a", "collect_b"]],
      steps: [
        planStep({
          id: "collect_a",
          dependencies: [],
          outputs: [{ name: "context", description: "A context", dataType: "object" }],
        }),
        planStep({
          id: "collect_b",
          dependencies: [],
          outputs: [{ name: "context", description: "B context", dataType: "object" }],
        }),
        planStep({
          id: "merge",
          kind: "llm_call",
          dependencies: ["collect_a", "collect_b"],
          inputs: [{ name: "context", description: "Merged context", dataType: "object" }],
          outputs: [{ name: "answer", description: "Answer", dataType: "string" }],
        }),
      ],
    };
    const specs = [
      contextProducer("collect_a", "demo_collect_a"),
      contextProducer("collect_b", "demo_collect_b"),
      nodeSpec({
        stepId: "merge",
        nodeType: "demo_merge",
        inputPorts: [
          {
            id: "context",
            kind: "data",
            direction: "input",
            label: "Context",
            dataType: "object",
            multiple: true,
          },
        ],
        outputPorts: [
          {
            id: "answer",
            kind: "data",
            direction: "output",
            label: "Answer",
            dataType: "string",
          },
        ],
      }),
    ];

    const graph = codeSynthesizerTesting.assembleFlowGraph(
      skillDefinition(),
      plan,
      specs,
      "1.0.0",
    ).graph as TestGraph;

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: { nodeId: "collect_a", portId: "context" },
        to: { nodeId: "merge", portId: "context" },
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: { nodeId: "collect_b", portId: "context" },
        to: { nodeId: "merge", portId: "context" },
      }),
    );
    expect(
      graph.nodes
        .find((n) => n.id === "merge")
        ?.ports.find((p) => p.id === "context" && p.direction === "input")
        ?.multiple,
    ).toBe(true);
  });

  it("warns when generated source drops a multiple context port", () => {
    const spec = nodeSpec({
      stepId: "merge",
      nodeType: "demo_merge",
      inputPorts: [
        {
          id: "context",
          kind: "data",
          direction: "input",
          label: "Context",
          dataType: "object",
          multiple: true,
        },
      ],
      outputPorts: [],
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      export const demoMergeNode = defineNode({
        type: "demo_merge",
        typeVersion: "1.0.0",
        title: "Demo merge",
        ports: [
          { id: "context", direction: "input", kind: "data", label: "Context" }
        ],
        run() { return { kind: "success", outputs: { out: null } }; }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      'lint.multiple_port_missing: nodes/demoMerge.ts does not preserve multiple: true for port "context"',
    );
    expect(warnings.some((w) => w.startsWith("lint.missing_source"))).toBe(false);
  });

  it("warns when generated source keeps multiple context but does not merge arrays", () => {
    const spec = nodeSpec({
      stepId: "merge",
      nodeType: "demo_merge",
      inputPorts: [
        {
          id: "context",
          kind: "data",
          direction: "input",
          label: "Context",
          dataType: "object",
          multiple: true,
        },
      ],
      outputPorts: [],
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      export const demoMergeNode = defineNode({
        type: "demo_merge",
        typeVersion: "1.0.0",
        title: "Demo merge",
        ports: [
          { id: "context", direction: "input", kind: "data", label: "Context", multiple: true }
        ],
        run({ input }) {
          const raw = input as Record<string, unknown>;
          const context = raw.context ?? {};
          return { kind: "success", outputs: { out: null, context } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      "lint.context_array_merge_missing: nodes/demoMerge.ts does not handle array-valued raw.context for multiple context input",
    );
    expect(warnings.some((w) => w.startsWith("lint.multiple_port_missing"))).toBe(false);
  });

  it("warns when generated source declares an output port but does not return it", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      outputPorts: [
        {
          id: "answer",
          kind: "data",
          direction: "output",
          label: "Answer",
          dataType: "string",
        },
      ],
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "answer", direction: "output", kind: "data", label: "Answer" }
        ],
        run() {
          return { kind: "success", outputs: { out: null } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      'lint.output_not_returned: nodes/demoMerge.ts does not return output port "answer" from run()',
    );
  });

  it("warns when generated LLM node does not call the LLM helper", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      outputPorts: [
        {
          id: "answer",
          kind: "data",
          direction: "output",
          label: "Answer",
          dataType: "string",
        },
      ],
      implementation: {
        strategy: "llm_prompt",
        promptTemplate: "Answer the request.",
        responseFormat: "text",
      },
      requiresLlm: true,
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "answer", direction: "output", kind: "data", label: "Answer" }
        ],
        run() {
          return { kind: "success", outputs: { out: null, answer: "static" } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      "lint.llm_call_missing: nodes/demoMerge.ts is an LLM node but does not call chat/chatJson from ./_llm.js",
    );
  });

  it("does not warn when generated LLM node calls the LLM helper", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      outputPorts: [
        {
          id: "answer",
          kind: "data",
          direction: "output",
          label: "Answer",
          dataType: "string",
        },
      ],
      implementation: {
        strategy: "llm_prompt",
        promptTemplate: "Answer the request.",
        responseFormat: "text",
      },
      requiresLlm: true,
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      import { chat } from "./_llm.js";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "answer", direction: "output", kind: "data", label: "Answer" }
        ],
        async run({ ctx }) {
          const answer = await chat({ ctx, user: "Answer." });
          return { kind: "success", outputs: { out: null, answer } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).not.toContain(
      "lint.llm_call_missing: nodes/demoMerge.ts is an LLM node but does not call chat/chatJson from ./_llm.js",
    );
    expect(warnings).not.toContain(
      "lint.llm_ctx_missing: nodes/demoMerge.ts calls chat/chatJson but does not pass ctx, so run-scoped variables may be lost",
    );
  });

  it("warns when generated LLM node calls the helper without passing ctx", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      outputPorts: [
        {
          id: "answer",
          kind: "data",
          direction: "output",
          label: "Answer",
          dataType: "string",
        },
      ],
      implementation: {
        strategy: "llm_prompt",
        promptTemplate: "Answer the request.",
        responseFormat: "text",
      },
      requiresLlm: true,
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      import { chat } from "./_llm.js";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "answer", direction: "output", kind: "data", label: "Answer" }
        ],
        async run() {
          const answer = await chat({ user: "Answer." });
          return { kind: "success", outputs: { out: null, answer } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      "lint.llm_ctx_missing: nodes/demoMerge.ts calls chat/chatJson but does not pass ctx, so run-scoped variables may be lost",
    );
  });

  it("warns when generated LLM node passes ctx without binding it from run context", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      outputPorts: [
        {
          id: "answer",
          kind: "data",
          direction: "output",
          label: "Answer",
          dataType: "string",
        },
      ],
      implementation: {
        strategy: "llm_prompt",
        promptTemplate: "Answer the request.",
        responseFormat: "text",
      },
      requiresLlm: true,
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      import { chat } from "./_llm.js";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "answer", direction: "output", kind: "data", label: "Answer" }
        ],
        async run() {
          const answer = await chat({ ctx, user: "Answer." });
          return { kind: "success", outputs: { out: null, answer } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      "lint.llm_ctx_unbound: nodes/demoMerge.ts passes ctx to chat/chatJson but run() does not bind ctx from the runtime node context",
    );
  });

  it("bundles an LLM helper that delegates through the runtime LlmProvider boundary", () => {
    const source = codeSynthesizerTesting.bundledLlmSource;

    expectTypescriptSourceTranspiles(source, "nodes/_llm.ts");
    expect(source).toContain("AiSdkOpenAICompatibleLlmProvider");
    expect(source).toContain("type LlmCompletionRequest");
    expect(source).toContain("ctx: unknown");
    expect(source).toContain("provider.complete(request");
    expect(source).not.toContain("getDefaultVariableStore");
    expect(source).not.toContain("new AbortController");
    expect(source).not.toContain("providerContext");
    expect(source).not.toContain("resolveModel");
    expect(source).not.toContain("@ai-sdk/openai-compatible");
    expect(source).not.toContain("generateText");
  });

  it("keeps the app LLM helper behind the runtime LlmProvider boundary", async () => {
    const source = await readFile(new URL("./_llm.ts", import.meta.url), "utf8");

    expectTypescriptSourceTranspiles(source, "nodes/_llm.ts");
    expect(source).toContain("AiSdkOpenAICompatibleLlmProvider");
    expect(source).toContain("type LlmCompletionRequest");
    expect(source).toContain("ctx: unknown");
    expect(source).toContain("provider.complete(request");
    expect(source).not.toContain("getDefaultVariableStore");
    expect(source).not.toContain("new AbortController");
    expect(source).not.toContain("providerContext");
    expect(source).not.toContain("resolveModel");
    expect(source).not.toContain("@ai-sdk/openai-compatible");
    expect(source).not.toContain("generateText");
    expect(source).not.toContain("streamText");
  });

  it("renders a build script that validates the bundled Flow JSON", () => {
    const spec = contextProducer("intake", "demo_intake");
    const source = codeSynthesizerTesting.renderBuildTs(
      skillDefinition(),
      "demo_skill",
      "1.0.0",
      [spec],
    );

    expectTypescriptSourceTranspiles(source, "build.ts");
    expect(source).toContain('import { validateGraph } from "@ai-native-flow/flow-validator"');
    expect(source).toContain(
      'import { getBuiltinNodeDefinitions } from "@ai-native-flow/runtime"',
    );
    expect(source).toContain("const graph = JSON.parse(json) as FlowGraph");
    expect(source).toContain("for (const def of getBuiltinNodeDefinitions())");
    expect(source).toContain("const builtinTypes = new Set<string>()");
    expect(source).toContain("builtinTypes.has(def.type)");
    expect(source).toContain("conflicts with a runtime built-in node");
    expect(source).toContain("validateGraph(graph, { registry: buildRegistry() })");
    expect(source).toContain("process.exitCode = 1");
  });

  it("fails flow assembly when a generated custom node reuses a built-in type name", () => {
    const step = planStep({
      id: "materialize",
      outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
    });
    const spec = nodeSpec({
      stepId: "materialize",
      nodeType: "agent",
      typeVersion: "2.0.0",
    });

    expect(() =>
      codeSynthesizerTesting.assembleFlowGraph(
        skillDefinition(),
        {
          skillName: "demo-skill",
          summary: "Demo collision.",
          parallelGroups: [],
          steps: [step],
        },
        [spec],
        "1.0.0",
      ),
    ).toThrow(
      'generated nodeType "agent"@2.0.0 conflicts with a runtime built-in node; use a skill-scoped custom nodeType instead',
    );
  });

  it("rejects invalid NodeSpecs before calling the code synthesis LLM", async () => {
    const step = planStep({
      id: "materialize",
      outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
    });
    const result = await codeSynthesizerNode.runner(
      {
        __config__: {},
        skill_def: skillDefinition(),
        plan: {
          skillName: "demo-skill",
          summary: "Demo collision.",
          parallelGroups: [],
          steps: [step],
        },
        node_specs: [
          nodeSpec({
            stepId: "materialize",
            nodeType: "agent",
            typeVersion: "2.0.0",
          }),
        ],
      },
      fakeNodeContext(),
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.code).toBe("node.code_synthesizer.invalid_node_specs");
    expect(result.error.message).toContain(
      'generated nodeType "agent"@2.0.0 conflicts with a runtime built-in node',
    );
  });

  it("renders runnable package metadata and CLI shim", () => {
    const cliSource = codeSynthesizerTesting.renderCliTs("demo_skill");
    const packageJsonSource = codeSynthesizerTesting.renderPackageJson(
      skillDefinition(),
      "demo_skill",
    );
    const tsconfigSource = codeSynthesizerTesting.renderTsconfigJson();
    const packageJson = JSON.parse(packageJsonSource) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const tsconfig = JSON.parse(tsconfigSource) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };

    expectTypescriptSourceTranspiles(cliSource, "cli.ts");
    expect(cliSource).toContain(
      'import { runFlowCli } from "@ai-native-flow/transport-cli/bootstrap"',
    );
    expect(cliSource).toContain('import { createRuntime } from "./runtime.js"');
    expect(packageJson.name).toBe("generated-demo-skill");
    expect(packageJson.scripts.build).toBe("tsx build.ts");
    expect(packageJson.scripts.run).toBe("tsx cli.ts run demo_skill --input '{}'");
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit -p tsconfig.json");
    expect(packageJson.dependencies["@ai-native-flow/runtime"]).toBe("0.0.1");
    expect(packageJson.dependencies["@ai-native-flow/transport-cli"]).toBe("0.0.1");
    expect(packageJson.devDependencies["@types/node"]).toBe("^20.12.7");
    expect(packageJson.devDependencies.tsx).toBe("^4.20.4");
    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.include).toEqual(["*.ts", "nodes/**/*.ts"]);
  });

  it(
    "writes a minimal generated package whose verification commands pass",
    async () => {
      const dir = await mkdtemp(path.join(process.cwd(), ".tmp-stf-generated-pkg-"));
      try {
      const skill = skillDefinition();
      const step = planStep({
        id: "intake",
        outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
      });
      const spec = contextProducer("intake", "demo_intake");
      const assembled = codeSynthesizerTesting.assembleFlowGraph(
        skill,
        {
          skillName: skill.name,
          summary: "Demo generated package.",
          parallelGroups: [],
          steps: [step],
        },
        [spec],
        "1.0.0",
      );
      const files = [
        {
          path: "nodes/demoIntake.ts",
          contents: [
            `import { defineNode } from "@ai-native-flow/node-sdk";`,
            ``,
            `export const demoIntakeNode = defineNode({`,
            `  type: "demo_intake",`,
            `  typeVersion: "1.0.0",`,
            `  title: "Demo intake",`,
            `  ports: [`,
            `    { id: "context", direction: "output", kind: "data", label: "Context" },`,
            `  ],`,
            `  validateInput: false,`,
            `  run({ input }) {`,
            `    return { kind: "success", outputs: { out: null, context: input.__runInput__ ?? {} } };`,
            `  },`,
            `});`,
            ``,
          ].join("\n"),
        },
        {
          path: "nodes/index.ts",
          contents: `export { demoIntakeNode } from "./demoIntake.js";\n`,
        },
        {
          path: "build.ts",
          contents: codeSynthesizerTesting.renderBuildTs(skill, "demo_skill", "1.0.0", [
            spec,
          ]),
        },
        {
          path: "runtime.ts",
          contents: codeSynthesizerTesting.renderRuntimeTs(skill, "demo_skill", "1.0.0", [
            spec,
          ]),
        },
        { path: "cli.ts", contents: codeSynthesizerTesting.renderCliTs("demo_skill") },
        {
          path: "package.json",
          contents: codeSynthesizerTesting.renderPackageJson(skill, "demo_skill"),
        },
        { path: "tsconfig.json", contents: codeSynthesizerTesting.renderTsconfigJson() },
        {
          path: "flows/demo_skill.json",
          contents: `${JSON.stringify(assembled.graph, null, 2)}\n`,
        },
      ];

      for (const file of files) {
        const target = path.join(dir, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.contents, "utf8");
      }

      await runCommand("npx tsx build.ts", dir);
      await runCommand("npm run typecheck --if-present", dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("renders generated runtime without implicit LLM config defaults", () => {
    const source = codeSynthesizerTesting.renderRuntimeTs(
      skillDefinition(),
      "demo_skill",
      "1.0.0",
      [contextProducer("intake", "demo_intake")],
    );

    expectTypescriptSourceTranspiles(source, "runtime.ts");
    expect(source).toContain("import type { SecretStore, VariableStore }");
    expect(source).toContain("secrets?: SecretStore");
    expect(source).toContain("variables: options.variables");
    expect(source).toContain("secrets: options.secrets");
    expect(source).toContain("Missing LLM config is not synthesized here");
    expect(source).not.toContain("setDefaults");
    expect(source).not.toContain("bootstrapDefaults");
    expect(source).not.toContain("getDefaultVariableStore");
    expect(source).not.toContain('allow: ["LLM_BASE_URL", "LLM_DEFAULT_MODEL", "LLM_API_KEY"]');
  });

  it("wires explicit variable and legacy secret stores into runtime config", async () => {
    const variables = new InMemoryVariableStore([
      { name: "LLM_DEFAULT_MODEL", value: "model-from-variables" },
    ]);
    const secrets = new InMemorySecretStore([
      { name: "LLM_API_KEY", value: "sk-from-secrets" },
    ]);
    const runtime = await createSkillToFlowRuntime({
      skipFlowRegistration: true,
      variables,
      secrets,
    });

    expect(runtime.variables.getString("LLM_DEFAULT_MODEL")).toBe("model-from-variables");
    expect(runtime.variables.getString("LLM_API_KEY")).toBe("sk-from-secrets");
    expect(runtime.secrets.getString("LLM_API_KEY")).toBe("sk-from-secrets");
  });

  it("warns when generated source declares context input but does not read it", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      inputPorts: [
        {
          id: "context",
          kind: "data",
          direction: "input",
          label: "Context",
          dataType: "object",
        },
      ],
      outputPorts: [],
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "context", direction: "input", kind: "data", label: "Context" }
        ],
        run() {
          return { kind: "success", outputs: { out: null } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).toContain(
      "lint.context_input_unused: nodes/demoMerge.ts declares context input but does not read raw.context",
    );
  });

  it("does not warn when generated source destructures context input", () => {
    const spec = nodeSpec({
      stepId: "answer",
      nodeType: "demo_answer",
      inputPorts: [
        {
          id: "context",
          kind: "data",
          direction: "input",
          label: "Context",
          dataType: "object",
        },
      ],
      outputPorts: [],
    });
    const pkg = generatedPackageWithSource(`
      import { defineNode } from "@ai-native-flow/node-sdk";
      export const demoAnswerNode = defineNode({
        type: "demo_answer",
        typeVersion: "1.0.0",
        title: "Demo answer",
        ports: [
          { id: "context", direction: "input", kind: "data", label: "Context" }
        ],
        run({ input }) {
          const { context } = input;
          return { kind: "success", outputs: { out: context ?? null } };
        }
      });
    `);

    const warnings = flowValidatorTesting.lintGeneratedSources(pkg, [spec]);

    expect(warnings).not.toContain(
      "lint.context_input_unused: nodes/demoMerge.ts declares context input but does not read raw.context",
    );
  });

  it("builds structured materialization refs for the agent file-write stage", () => {
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.files.push({
      path: "nodes/_llm.ts",
      contents: "export async function chat() {}",
    });

    const plan = flowValidatorTesting.buildMaterializationPlan(pkg);

    expect(plan.verifyCommands).toEqual([
      "npx tsx build.ts",
      "npm run typecheck --if-present",
    ]);
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "node_source",
          path: "nodes/demoMerge.ts",
          pathRef: "package.files.0.path",
          contentsRef: "package.files.0.contents",
        }),
        expect.objectContaining({
          role: "llm_helper",
          path: "nodes/_llm.ts",
          pathRef: "package.files.1.path",
          contentsRef: "package.files.1.contents",
        }),
        expect.objectContaining({
          role: "build_script",
          pathRef: "package.buildScript.path",
          contentsRef: "package.buildScript.contents",
        }),
        expect.objectContaining({
          role: "cli_script",
          path: "cli.ts",
          pathRef: "package.cliScript.path",
          contentsRef: "package.cliScript.contents",
        }),
        expect.objectContaining({
          role: "package_json",
          path: "package.json",
          pathRef: "package.packageJson.path",
          contentsRef: "package.packageJson.contents",
        }),
        expect.objectContaining({
          role: "tsconfig",
          path: "tsconfig.json",
          pathRef: "package.tsconfig.path",
          contentsRef: "package.tsconfig.contents",
        }),
        expect.objectContaining({
          role: "flow_json",
          pathRef: "package.flowJsonFile.path",
          contentsRef: "package.flowJsonFile.contents",
        }),
      ]),
    );
  });

  it("preserves planner requirements in the generated package and validator artifact", async () => {
    const skill = skillDefinition();
    const step = planStep({
      id: "intake",
      outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
    });
    const requirements = {
      goals: ["Keep the generated flow aligned with the original skill."],
      inputContract: [
        { name: "request", description: "Caller request", dataType: "object" },
      ],
      outputContract: [
        { name: "context", description: "Accumulated context", dataType: "object" },
      ],
      acceptanceCriteria: ["Generated files can be written and verified by agent."],
      constraints: ["Use the runtime LlmProvider boundary."],
      contextHandoff: "Pass structured context forward without flattening it.",
    } satisfies NonNullable<ExecutionPlan["requirements"]>;
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.requirements = requirements;
    pkg.flowGraph = codeSynthesizerTesting.assembleFlowGraph(
      skill,
      {
        skillName: skill.name,
        summary: "Demo requirements artifact.",
        requirements,
        parallelGroups: [],
        steps: [step],
      },
      [contextProducer("intake", "demo_intake")],
      "1.0.0",
    ).graph;

    const result = await flowValidatorNode.runner(
      {
        __config__: { strict: false, lint_sources: false },
        package: pkg,
        node_specs: [contextProducer("intake", "demo_intake")],
      },
      fakeNodeContext(),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const artifact = result.outputs.artifact as {
      requirements?: typeof requirements;
      package: { requirements?: typeof requirements };
    };
    expect(artifact.requirements).toEqual(requirements);
    expect(artifact.package.requirements).toEqual(requirements);
  });

  it("warns before materialization when package file paths are unsafe or duplicated", () => {
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.files.push(
      {
        path: "nodes/demoMerge.ts",
        contents: "export const duplicate = true;",
      },
      {
        path: "../escape.ts",
        contents: "export const unsafe = true;",
      },
    );

    const warnings = flowValidatorTesting.lintGeneratedPackageFiles(pkg);

    expect(warnings).toContain(
      'lint.duplicate_file_path: generated package contains duplicate file path "nodes/demoMerge.ts"',
    );
    expect(warnings).toContain(
      'lint.unsafe_file_path: generated package file path "../escape.ts" must be relative and stay inside the output directory',
    );
  });

  it("exposes package file path issues as structured validator context", () => {
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.files.push(
      {
        path: "../escape.ts",
        contents: "export const unsafe = true;",
      },
      {
        path: "nodes\\windows.ts",
        contents: "export const windows = true;",
      },
      {
        path: "nodes/directory/",
        contents: "export const directory = true;",
      },
      {
        path: "nodes/demoMerge.ts",
        contents: "export const duplicate = true;",
      },
    );

    const issues = flowValidatorTesting.collectGeneratedPackageFileIssues(pkg);

    expect(issues).toContainEqual({
      kind: "unsafe_file_path",
      path: "../escape.ts",
      pathRef: "package.files.1.path",
      contentsRef: "package.files.1.contents",
      message:
        'generated package file path "../escape.ts" must be relative and stay inside the output directory',
    });
    expect(issues).toContainEqual({
      kind: "non_posix_file_path",
      path: "nodes\\windows.ts",
      pathRef: "package.files.2.path",
      contentsRef: "package.files.2.contents",
      message: 'generated package file path "nodes\\windows.ts" should use "/" separators',
    });
    expect(issues).toContainEqual({
      kind: "directory_file_path",
      path: "nodes/directory/",
      pathRef: "package.files.3.path",
      contentsRef: "package.files.3.contents",
      message:
        'generated package file path "nodes/directory/" must point to a file, not a directory',
    });
    expect(issues).toContainEqual({
      kind: "duplicate_file_path",
      path: "nodes/demoMerge.ts",
      pathRef: "package.files.4.path",
      contentsRef: "package.files.4.contents",
      message: 'generated package contains duplicate file path "nodes/demoMerge.ts"',
    });
  });

  it("emits fileIssues from the flow_validator artifact even when source lint is disabled", async () => {
    const step = planStep({
      id: "intake",
      outputs: [{ name: "context", description: "Shared context", dataType: "object" }],
    });
    const spec = contextProducer("intake", "demo_intake");
    const assembled = codeSynthesizerTesting.assembleFlowGraph(
      skillDefinition(),
      {
        skillName: "demo-skill",
        summary: "Demo validation flow.",
        parallelGroups: [],
        steps: [step],
      },
      [spec],
      "1.0.0",
    );
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.flowGraph = assembled.graph;
    pkg.files[0] = {
      path: "../escape.ts",
      contents: pkg.files[0]?.contents ?? "export const demo = 1;",
    };

    const result = await flowValidatorNode.runner(
      {
        __config__: { lint_sources: false },
        package: pkg,
        node_specs: [spec],
      },
      fakeNodeContext(),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const artifact = result.outputs.artifact as {
      warnings: string[];
      fileIssues: Array<{
        kind: string;
        path: string;
        pathRef: string;
        contentsRef: string;
        message: string;
      }>;
    };
    expect(artifact.fileIssues).toContainEqual({
      kind: "unsafe_file_path",
      path: "../escape.ts",
      pathRef: "package.files.0.path",
      contentsRef: "package.files.0.contents",
      message:
        'generated package file path "../escape.ts" must be relative and stay inside the output directory',
    });
    expect(artifact.warnings).toContain(
      'lint.unsafe_file_path: generated package file path "../escape.ts" must be relative and stay inside the output directory',
    );
  });

  it("validates generated flow graphs that reuse runtime built-in nodes", async () => {
    const registry = createDefaultRegistry();
    for (const def of getBuiltinNodeDefinitions()) {
      if (!registry.has(def.type, def.typeVersion)) registry.register(def);
    }
    const flow = defineFlow({
      id: "demo_builtin",
      version: "1.0.0",
      registry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const text = flow.node("text_input", {
      id: "task",
      position: { x: 100, y: 0 },
      config: { value: "hello" },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(start.out("out"), text.in("in"));
    flow.connect(text.out("out"), end.in("in"));

    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.flowId = "demo_builtin";
    pkg.flowGraph = JSON.parse(flow.dump());

    const result = await flowValidatorNode.runner(
      {
        __config__: { lint_sources: false },
        package: pkg,
        node_specs: [],
      },
      fakeNodeContext(),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const artifact = result.outputs.artifact as { isValid: boolean; errors: string[] };
    expect(artifact.isValid).toBe(true);
    expect(artifact.errors).toEqual([]);
  });

  it("reports generated NodeSpec collisions with runtime built-in node types", async () => {
    const registry = createDefaultRegistry();
    const flow = defineFlow({
      id: "demo_collision",
      version: "1.0.0",
      registry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const end = flow.node("end", { id: "end", position: { x: 100, y: 0 } });
    flow.connect(start.out("out"), end.in("in"));

    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.flowId = "demo_collision";
    pkg.flowGraph = JSON.parse(flow.dump());

    const result = await flowValidatorNode.runner(
      {
        __config__: { lint_sources: false },
        package: pkg,
        node_specs: [
          nodeSpec({
            stepId: "materialize",
            nodeType: "agent",
            typeVersion: "2.0.0",
          }),
        ],
      },
      fakeNodeContext(),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const artifact = result.outputs.artifact as { isValid: boolean; errors: string[] };
    expect(artifact.isValid).toBe(false);
    expect(artifact.errors).toContain(
      'node_spec.builtin_type_collision: nodeType "agent"@2.0.0 conflicts with a runtime built-in node; use a skill-scoped custom nodeType instead',
    );
  });

  it("warns on case-insensitive duplicate package file paths", () => {
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.files.push({
      path: "nodes/DemoMerge.ts",
      contents: "export const duplicate = true;",
    });

    const warnings = flowValidatorTesting.lintGeneratedPackageFiles(pkg);

    expect(warnings).toContain(
      'lint.duplicate_file_path: generated package contains duplicate file path "nodes/DemoMerge.ts"',
    );
  });

  it("warns on slash-normalized duplicate package file paths", () => {
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.files.push({
      path: "nodes\\DemoMerge.ts",
      contents: "export const duplicate = true;",
    });

    const warnings = flowValidatorTesting.lintGeneratedPackageFiles(pkg);

    expect(warnings).toContain(
      'lint.duplicate_file_path: generated package contains duplicate file path "nodes\\DemoMerge.ts"',
    );
    expect(warnings).toContain(
      'lint.non_posix_file_path: generated package file path "nodes\\DemoMerge.ts" should use "/" separators',
    );
  });

  it("warns when generated package file paths point to directories", () => {
    const pkg = generatedPackageWithSource("export const demo = 1;");
    pkg.files.push({
      path: "nodes/generated/",
      contents: "export const directoryLike = true;",
    });

    const warnings = flowValidatorTesting.lintGeneratedPackageFiles(pkg);

    expect(warnings).toContain(
      'lint.directory_file_path: generated package file path "nodes/generated/" must point to a file, not a directory',
    );
  });
});

function skillDefinition(): SkillDefinition {
  return {
    sourcePath: "virtual/SKILL.md",
    name: "demo-skill",
    description: "Demo skill",
    frontmatter: {},
    body: "Demo body",
    allowedTools: [],
  };
}

function planStep(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    kind: overrides.kind ?? "analyze",
    description: overrides.description ?? overrides.id,
    intent: overrides.intent ?? `Run ${overrides.id}.`,
    requiredTools: overrides.requiredTools ?? [],
    dependencies: overrides.dependencies ?? [],
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
  };
}

function contextProducer(stepId: string, nodeType: string): NodeSpec {
  return nodeSpec({
    stepId,
    nodeType,
    outputPorts: [
      {
        id: "context",
        kind: "data",
        direction: "output",
        label: "Context",
        dataType: "object",
      },
    ],
  });
}

function nodeSpec(overrides: Partial<NodeSpec> & { stepId: string; nodeType: string }): NodeSpec {
  return {
    stepId: overrides.stepId,
    nodeType: overrides.nodeType,
    typeVersion: overrides.typeVersion ?? "1.0.0",
    title: overrides.title ?? overrides.nodeType,
    description: overrides.description ?? overrides.nodeType,
    configFields: overrides.configFields ?? [],
    inputPorts: overrides.inputPorts ?? [],
    outputPorts: overrides.outputPorts ?? [],
    implementation:
      overrides.implementation ??
      {
        strategy: "transform",
        transformLogic: "Pass input through.",
      },
    pseudocode: overrides.pseudocode ?? "Pass through.",
    requiresLlm: overrides.requiresLlm ?? false,
  };
}

function generatedPackageWithSource(source: string): GeneratedFlowPackage {
  return {
    skillName: "demo-skill",
    flowId: "demo_skill",
    flowVersion: "1.0.0",
    files: [{ path: "nodes/demoMerge.ts", contents: source }],
    nodesIndex: { path: "nodes/index.ts", contents: "" },
    buildScript: { path: "build.ts", contents: "" },
    runtimeScript: { path: "runtime.ts", contents: "" },
    cliScript: { path: "cli.ts", contents: "" },
    packageJson: { path: "package.json", contents: "{}" },
    tsconfig: { path: "tsconfig.json", contents: "{}" },
    flowJsonFile: { path: "flows/demo_skill.json", contents: "{}" },
    flowGraph: {},
    readme: { path: "README.md", contents: "" },
  };
}

function fakeNodeContext() {
  return {
    runId: "run_test",
    flowId: "skill_to_flow",
    flowVersion: "1.0.0",
    nodeId: "skill_planner",
    nodeType: "skill_planner",
    nodeVersion: "1.0.0",
    attempt: 1,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signal: new AbortController().signal,
    emit: () => undefined,
    stream: () => ({
      write: () => undefined,
      close: () => undefined,
    }),
  } as any;
}

async function runCommand(command: string, cwd: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
      cwd,
    });
    return;
  }
  await execFileAsync("/bin/sh", ["-c", command], { cwd });
}

function expectTypescriptSourceTranspiles(source: string, fileName: string): void {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
    },
  });
  const diagnostics = result.diagnostics ?? [];
  expect(
    diagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    ),
  ).toEqual([]);
}
