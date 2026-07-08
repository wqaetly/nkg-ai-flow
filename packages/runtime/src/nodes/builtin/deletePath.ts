/**
 * `delete_path` - immutably remove a nested value from structured flow data.
 *
 * Complements select_path/set_path with the third common data-edit operation:
 * deleting object fields or array entries while preserving branch semantics.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

type ArrayMode = "splice" | "unset";
type Branch = "deleted" | "missing" | "skipped";

interface DeleteResult {
  branch: Branch;
  value: unknown;
  removed: unknown;
  exists: boolean;
  changed: boolean;
  reason: string;
}

const deletePathConfig = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Dotted/bracket path to delete, e.g. order.items[0].sku."),
    arrayMode: z
      .enum(["splice", "unset"])
      .default("splice")
      .describe("How array entries are removed: splice shifts items, unset leaves a hole."),
  })
  .passthrough();

export const deletePathNode = defineNode({
  type: "delete_path",
  typeVersion: "1.0.0",
  title: "Delete Path",
  description: "Removes a nested value from structured data without mutating the input.",
  kind: "pseudo",
  config: deletePathConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "order.temp",
      order: 1,
    },
    arrayMode: {
      label: "Array Mode",
      control: "select",
      enumOptions: [
        { label: "Splice", value: "splice" },
        { label: "Unset", value: "unset" },
      ],
      order: 2,
    },
  },
  ports: [
    controlIn,
    { id: "source", direction: "input", kind: "data", label: "Source" },
    { id: "deleted", direction: "output", kind: "control", label: "Deleted" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "skipped", direction: "output", kind: "control", label: "Skipped" },
    { id: "value", direction: "output", kind: "data", label: "Updated value" },
    { id: "source", direction: "output", kind: "data", label: "Source value" },
    { id: "removed", direction: "output", kind: "data", label: "Removed value" },
    {
      id: "exists",
      direction: "output",
      kind: "data",
      label: "Previously existed",
      schema: { type: "boolean" },
    },
    {
      id: "changed",
      direction: "output",
      kind: "data",
      label: "Changed",
      schema: { type: "boolean" },
    },
    {
      id: "path",
      direction: "output",
      kind: "data",
      label: "Path",
      schema: { type: "string" },
    },
    {
      id: "reason",
      direction: "output",
      kind: "data",
      label: "Reason",
      schema: { type: "string" },
    },
  ],
  validateInput: false,
  run({ input, config, ctx }) {
    const source = readSource(input);
    const path = String(config.path ?? "").trim();
    const arrayMode = readArrayMode(config.arrayMode);
    const result = deletePath(source, path, arrayMode);

    ctx.log.debug("delete_path removed value", {
      path,
      branch: result.branch,
      exists: result.exists,
      changed: result.changed,
      reason: result.reason,
      arrayMode,
    });

    return {
      kind: "success",
      outputs: {
        [result.branch]: null,
        value: result.value,
        source,
        removed: result.removed,
        exists: result.exists,
        changed: result.changed,
        path,
        reason: result.reason,
      },
    };
  },
});

function readSource(input: Record<string, unknown>): unknown {
  return input.source ?? input.input ?? input.in ?? input.__runInput__ ?? {};
}

function readArrayMode(value: unknown): ArrayMode {
  return value === "unset" ? "unset" : "splice";
}

function deletePath(source: unknown, path: string, arrayMode: ArrayMode): DeleteResult {
  if (path === "") return skipped(source, "empty_path");
  const segments = parsePath(path);
  if (segments.length === 0) return skipped(source, "invalid_path");
  if (!isContainer(source)) return missing(source, "source_not_container");

  const result = deleteAt(source, segments, 0, arrayMode);
  if (result.branch !== "deleted") return { ...result, value: source };
  return result;
}

function deleteAt(
  current: unknown,
  segments: string[],
  index: number,
  arrayMode: ArrayMode,
): DeleteResult {
  const segment = segments[index]!;
  const final = index === segments.length - 1;
  const container = cloneContainer(current);
  if (!container) return missing(current, "path_not_container");

  if (!hasSegment(container, segment)) return missing(current, "path_missing");
  const existing = getSegment(container, segment);

  if (final) {
    deleteSegment(container, segment, arrayMode);
    return {
      branch: "deleted",
      value: container,
      removed: existing,
      exists: true,
      changed: true,
      reason: Array.isArray(container) ? `array_${arrayMode}` : "deleted",
    };
  }

  if (!isContainer(existing)) return missing(current, "path_not_container");
  const child = deleteAt(existing, segments, index + 1, arrayMode);
  if (child.branch !== "deleted") return child;
  setSegment(container, segment, child.value);
  return {
    ...child,
    value: container,
  };
}

function skipped(source: unknown, reason: string): DeleteResult {
  return {
    branch: "skipped",
    value: source,
    removed: undefined,
    exists: false,
    changed: false,
    reason,
  };
}

function missing(source: unknown, reason: string): DeleteResult {
  return {
    branch: "missing",
    value: source,
    removed: undefined,
    exists: false,
    changed: false,
    reason,
  };
}

function parsePath(path: string): string[] {
  const segments: string[] = [];
  const pattern = /([^[.\]]+)|\[(\d+|(["'])(.*?)\3)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    const bare = match[1];
    const bracket = match[2];
    const quoted = match[4];
    segments.push(quoted ?? bracket ?? bare ?? "");
  }
  return segments.filter((segment) => segment !== "");
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

function cloneContainer(value: unknown): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === "object") {
    return { ...(value as Record<string, unknown>) };
  }
  return undefined;
}

function hasSegment(container: Record<string, unknown> | unknown[], segment: string): boolean {
  if (Array.isArray(container)) {
    const index = readArrayIndex(segment);
    return index !== undefined && index >= 0 && index < container.length;
  }
  return Object.prototype.hasOwnProperty.call(container, segment);
}

function getSegment(container: Record<string, unknown> | unknown[], segment: string): unknown {
  if (Array.isArray(container)) {
    const index = readArrayIndex(segment);
    return index === undefined ? undefined : container[index];
  }
  return container[segment];
}

function setSegment(
  container: Record<string, unknown> | unknown[],
  segment: string,
  value: unknown,
): void {
  if (Array.isArray(container)) {
    const index = readArrayIndex(segment);
    if (index !== undefined) container[index] = value;
    return;
  }
  container[segment] = value;
}

function deleteSegment(
  container: Record<string, unknown> | unknown[],
  segment: string,
  arrayMode: ArrayMode,
): void {
  if (Array.isArray(container)) {
    const index = readArrayIndex(segment);
    if (index === undefined) return;
    if (arrayMode === "splice") {
      container.splice(index, 1);
    } else {
      delete container[index];
    }
    return;
  }
  delete container[segment];
}

function readArrayIndex(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}
