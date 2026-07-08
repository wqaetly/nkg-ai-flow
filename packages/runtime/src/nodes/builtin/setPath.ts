/**
 * `set_path` - immutably write a nested value into structured flow data.
 *
 * Complements `select_path` by making object/array updates explicit and
 * branchable on the canvas.
 */

import { z } from "zod";
import { defineNode } from "@ai-native-flow/node-sdk";
import { controlIn } from "./_helpers.js";

type Branch = "updated" | "missing" | "skipped";

interface SetResult {
  branch: Branch;
  value: unknown;
  previous: unknown;
  exists: boolean;
  changed: boolean;
  reason: string;
}

const setPathConfig = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Dotted/bracket path to write, e.g. order.items[0].sku."),
    value: z.unknown().optional().describe("Static value used when no value input is wired."),
    createMissing: z
      .boolean()
      .default(true)
      .describe("Whether missing containers are created while writing the path."),
    overwrite: z
      .boolean()
      .default(true)
      .describe("Whether existing target values may be overwritten."),
  })
  .passthrough();

export const setPathNode = defineNode({
  type: "set_path",
  typeVersion: "1.0.0",
  title: "Set Path",
  description: "Writes a nested value into structured data without mutating the input.",
  kind: "pseudo",
  config: setPathConfig,
  fieldMeta: {
    path: {
      label: "Path",
      control: "input",
      placeholder: "order.status",
      order: 1,
    },
    value: {
      label: "Static Value",
      control: "textarea",
      order: 2,
    },
    createMissing: {
      label: "Create Missing",
      control: "switch",
      order: 3,
    },
    overwrite: {
      label: "Overwrite",
      control: "switch",
      order: 4,
    },
  },
  ports: [
    controlIn,
    { id: "source", direction: "input", kind: "data", label: "Source" },
    { id: "value", direction: "input", kind: "data", label: "Value" },
    { id: "updated", direction: "output", kind: "control", label: "Updated" },
    { id: "missing", direction: "output", kind: "control", label: "Missing" },
    { id: "skipped", direction: "output", kind: "control", label: "Skipped" },
    { id: "value", direction: "output", kind: "data", label: "Updated value" },
    { id: "source", direction: "output", kind: "data", label: "Source value" },
    { id: "assigned", direction: "output", kind: "data", label: "Assigned value" },
    { id: "previous", direction: "output", kind: "data", label: "Previous value" },
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
    const assigned = readAssigned(input, config);
    const path = String(config.path ?? "").trim();
    const result = writePath(source, path, assigned, {
      createMissing: config.createMissing !== false,
      overwrite: config.overwrite !== false,
    });

    ctx.log.debug("set_path wrote value", {
      path,
      branch: result.branch,
      exists: result.exists,
      changed: result.changed,
      reason: result.reason,
    });

    return {
      kind: "success",
      outputs: {
        [result.branch]: null,
        value: result.value,
        source,
        assigned,
        previous: result.previous,
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

function readAssigned(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): unknown {
  if (Object.prototype.hasOwnProperty.call(input, "value")) return input.value;
  if (Object.prototype.hasOwnProperty.call(config, "value")) return config.value;
  return null;
}

function writePath(
  source: unknown,
  path: string,
  assigned: unknown,
  options: { createMissing: boolean; overwrite: boolean },
): SetResult {
  if (path === "") {
    if (!options.overwrite) {
      return skipped(source, source, true, "overwrite_disabled");
    }
    return {
      branch: "updated",
      value: assigned,
      previous: source,
      exists: true,
      changed: !Object.is(source, assigned),
      reason: "replaced_source",
    };
  }

  const segments = parsePath(path);
  if (segments.length === 0) {
    return missing(source, "invalid_path");
  }

  const root = isContainer(source)
    ? source
    : options.createMissing
      ? newContainerFor(segments[0]!)
      : undefined;
  if (root === undefined) return missing(source, "source_not_container");

  const written = writeAt(root, segments, 0, assigned, options);
  if (written.branch !== "updated") return { ...written, value: source };
  return written;
}

function writeAt(
  current: unknown,
  segments: string[],
  index: number,
  assigned: unknown,
  options: { createMissing: boolean; overwrite: boolean },
): SetResult {
  const segment = segments[index]!;
  const final = index === segments.length - 1;
  const container = cloneContainer(current, segment);
  if (!container) return missing(current, "path_not_container");
  const previous = getSegment(container, segment);
  const exists = hasSegment(container, segment);

  if (final) {
    if (exists && !options.overwrite) {
      return skipped(current, previous, true, "overwrite_disabled");
    }
    setSegment(container, segment, assigned);
    return {
      branch: "updated",
      value: container,
      previous,
      exists,
      changed: !exists || !Object.is(previous, assigned),
      reason: exists ? "overwritten" : "created",
    };
  }

  let child = previous;
  if (!exists || !isContainer(child)) {
    if (!options.createMissing) {
      return missing(current, exists ? "path_not_container" : "path_missing");
    }
    child = newContainerFor(segments[index + 1]!);
  }

  const childResult = writeAt(child, segments, index + 1, assigned, options);
  if (childResult.branch !== "updated") return childResult;
  setSegment(container, segment, childResult.value);
  return {
    ...childResult,
    value: container,
  };
}

function skipped(source: unknown, previous: unknown, exists: boolean, reason: string): SetResult {
  return {
    branch: "skipped",
    value: source,
    previous,
    exists,
    changed: false,
    reason,
  };
}

function missing(source: unknown, reason: string): SetResult {
  return {
    branch: "missing",
    value: source,
    previous: undefined,
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

function cloneContainer(
  value: unknown,
  segment: string,
): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === "object") {
    return { ...(value as Record<string, unknown>) };
  }
  return newContainerFor(segment);
}

function newContainerFor(segment: string): Record<string, unknown> | unknown[] {
  return readArrayIndex(segment) === undefined ? {} : [];
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

function readArrayIndex(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}
