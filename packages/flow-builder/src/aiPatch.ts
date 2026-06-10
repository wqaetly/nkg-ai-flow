import {
  RuntimeErrorException,
  createRuntimeError,
  type FlowGraph,
  type NodeTypeRegistry,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";
import { validateGraph, type ValidationResult } from "@ai-native-flow/flow-validator";
import { applyOps, diffFlow, type FlowDiff, type GraphOperation } from "./graphOperation.js";

export type AiPatchSource = "ai_builder" | "ai_graph_operation" | "sandbox_code";

export interface AiPatchProposal {
  id: string;
  source: AiPatchSource;
  title: string;
  description?: string;
  author: string;
  createdAt: string;
  operations: GraphOperation[];
  requestedPermissions?: string[];
  requiredSecrets?: string[];
}

export interface AiPatchPolicy {
  /** Operation names allowed for this proposal. Defaults to all GraphOperation kinds. */
  allowedOperations?: GraphOperation["op"][];
  /** Permissions the proposer is allowed to request. Empty means no permission grants. */
  allowedPermissions?: string[];
  /** Secret names the proposer is allowed to reference. Empty means no secret access. */
  allowedSecrets?: string[];
  /** Production proposals require an approval record before they can be promoted. */
  requireApproval?: boolean;
  /** Production proposals require a dry-run marker before promotion. */
  requireDryRun?: boolean;
}

export interface AiPatchPreview {
  proposal: AiPatchProposal;
  base: FlowGraph;
  proposed: FlowGraph;
  diff: FlowDiff;
  validation: ValidationResult;
  policyErrors: RuntimeError[];
  summary: AiPatchPreviewSummary;
}

export interface AiPatchPreviewSummary {
  operationCount: number;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
  changedEdges: string[];
  requestedPermissions: string[];
  requiredSecrets: string[];
  canApply: boolean;
}

export type AiPatchApprovalDecision = "approved" | "rejected";

export interface AiPatchApprovalRecord {
  proposalId: string;
  decision: AiPatchApprovalDecision;
  reviewer: string;
  decidedAt: string;
  reason?: string;
  dryRunId?: string;
}

export interface AiPatchPromotionOptions {
  approval?: AiPatchApprovalRecord;
  dryRunId?: string;
  production?: boolean;
}

export function previewAiPatch(
  base: FlowGraph,
  proposal: AiPatchProposal,
  policy: AiPatchPolicy = {},
  options: { registry?: NodeTypeRegistry } = {},
): AiPatchPreview {
  const policyErrors = validatePolicy(proposal, policy);
  const proposed = applyOps(base, proposal.operations, { registry: options.registry, validate: false });
  const validation = validateGraph(proposed, { registry: options.registry });
  const diff = diffFlow(base, proposed);

  return {
    proposal,
    base,
    proposed,
    diff,
    validation,
    policyErrors,
    summary: summarizePreview(proposal, diff, validation, policyErrors),
  };
}

export function assertAiPatchPromotable(
  preview: AiPatchPreview,
  policy: AiPatchPolicy = {},
  options: AiPatchPromotionOptions = {},
): void {
  if (!preview.validation.ok) {
    throw aiPatchError("builder.ai_patch_invalid_graph", "AI patch produced an invalid flow", {
      proposalId: preview.proposal.id,
      errors: preview.validation.errors,
    });
  }

  if (preview.policyErrors.length > 0) {
    throw aiPatchError("builder.ai_patch_policy_denied", "AI patch violates policy constraints", {
      proposalId: preview.proposal.id,
      errors: preview.policyErrors,
    });
  }

  if (options.production && policy.requireDryRun !== false && !options.dryRunId && !options.approval?.dryRunId) {
    throw aiPatchError("builder.ai_patch_missing_dry_run", "production AI patch promotion requires a dry run", {
      proposalId: preview.proposal.id,
    });
  }

  if (options.production && policy.requireApproval !== false) {
    if (!options.approval || options.approval.decision !== "approved" || options.approval.proposalId !== preview.proposal.id) {
      throw aiPatchError("builder.ai_patch_not_approved", "production AI patch promotion requires approval", {
        proposalId: preview.proposal.id,
      });
    }
  }
}

export function createAiPatchApprovalRecord(input: AiPatchApprovalRecord): AiPatchApprovalRecord {
  return { ...input };
}

function validatePolicy(proposal: AiPatchProposal, policy: AiPatchPolicy): RuntimeError[] {
  const errors: RuntimeError[] = [];
  const allowedOperations = policy.allowedOperations ? new Set(policy.allowedOperations) : undefined;
  const allowedPermissions = new Set(policy.allowedPermissions ?? []);
  const allowedSecrets = new Set(policy.allowedSecrets ?? []);

  proposal.operations.forEach((operation, index) => {
    if (allowedOperations && !allowedOperations.has(operation.op)) {
      errors.push(policyError("builder.ai_patch_forbidden_operation", `operation ${operation.op} is not allowed`, {
        proposalId: proposal.id,
        operation: operation.op,
        index,
      }));
    }
  });

  for (const permission of proposal.requestedPermissions ?? []) {
    if (!allowedPermissions.has(permission)) {
      errors.push(policyError("builder.ai_patch_forbidden_permission", `permission ${permission} is not allowed`, {
        proposalId: proposal.id,
        permission,
      }));
    }
  }

  for (const secret of proposal.requiredSecrets ?? []) {
    if (!allowedSecrets.has(secret)) {
      errors.push(policyError("builder.ai_patch_forbidden_secret", `secret ${secret} is not allowed`, {
        proposalId: proposal.id,
        secret,
      }));
    }
  }

  return errors;
}

function summarizePreview(
  proposal: AiPatchProposal,
  diff: FlowDiff,
  validation: ValidationResult,
  policyErrors: RuntimeError[],
): AiPatchPreviewSummary {
  return {
    operationCount: proposal.operations.length,
    addedNodes: diff.addedNodes.map((node) => node.id),
    removedNodes: diff.removedNodes.map((node) => node.id),
    changedNodes: diff.changedNodes.map((node) => node.nodeId),
    addedEdges: diff.addedEdges.map((edge) => edge.id),
    removedEdges: diff.removedEdges.map((edge) => edge.id),
    changedEdges: diff.changedEdges.map((edge) => edge.edgeId),
    requestedPermissions: [...(proposal.requestedPermissions ?? [])],
    requiredSecrets: [...(proposal.requiredSecrets ?? [])],
    canApply: validation.ok && policyErrors.length === 0,
  };
}

function policyError(code: string, message: string, context: Record<string, unknown>): RuntimeError {
  return createRuntimeError({
    code,
    kind: "permission",
    category: "author",
    message,
    source: { module: "builder" },
    context,
  });
}

function aiPatchError(code: string, message: string, context: Record<string, unknown>): RuntimeErrorException {
  return new RuntimeErrorException(
    createRuntimeError({
      code,
      kind: "validation",
      category: "author",
      message,
      source: { module: "builder" },
      context,
    }),
  );
}
