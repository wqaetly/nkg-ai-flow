/**
 * Zod-schema reflection used by the Node Field Inspector.
 *
 * `describeZodFields` walks the top-level shape of a `z.object({...})`
 * and produces a `FieldDescriptor[]` that the Studio uses to render
 * configuration controls (text boxes, number boxes, dropdowns, ...)
 * directly on a node card.
 *
 * Design rules:
 *   - Pure & synchronous; no React / IO.
 *   - Best-effort: unknown Zod variants degrade to `kind: "unknown"`
 *     instead of throwing.
 *   - Stays inside `node-sdk` so the Studio can read JSON-only metadata
 *     without taking a Zod runtime dependency.
 */

import type { z } from "zod";
import type {
  FieldConstraints,
  FieldDescriptor,
  FieldKind,
  FieldMeta,
} from "@ai-native-flow/flow-ir";

/** Zod internal type tags we care about (string-compared, version-tolerant). */
type ZodTypeName =
  | "ZodString"
  | "ZodNumber"
  | "ZodBigInt"
  | "ZodBoolean"
  | "ZodEnum"
  | "ZodNativeEnum"
  | "ZodArray"
  | "ZodRecord"
  | "ZodObject"
  | "ZodOptional"
  | "ZodNullable"
  | "ZodDefault"
  | "ZodEffects"
  | "ZodUnion"
  | "ZodDiscriminatedUnion"
  | "ZodLiteral"
  | "ZodAny"
  | "ZodUnknown";

interface ZodDef {
  typeName?: ZodTypeName;
  description?: string;
  checks?: ReadonlyArray<{
    kind: string;
    value?: unknown;
    regex?: { source?: string };
  }>;
  innerType?: { _def?: ZodDef };
  schema?: { _def?: ZodDef };
  defaultValue?: unknown | (() => unknown);
  values?: readonly string[];
  type?: { _def?: ZodDef };
  valueType?: { _def?: ZodDef };
  shape?: () => Record<string, { _def?: ZodDef; description?: string }>;
}

interface ZodLike {
  _def?: ZodDef;
  description?: string;
}

/**
 * Walk the top-level fields of a `z.object({...})` schema and produce
 * descriptors. Returns `[]` for any non-ZodObject input (callers treat
 * "no fields" as "no UI").
 */
export function describeZodFields(
  schema: z.ZodTypeAny | undefined,
): FieldDescriptor[] {
  if (!schema) return [];
  const root = unwrapToObject(schema as ZodLike);
  if (!root) return [];

  const shape = root._def?.shape?.();
  if (!shape) return [];

  const out: FieldDescriptor[] = [];
  for (const [name, child] of Object.entries(shape)) {
    out.push(describeField(name, child as ZodLike));
  }
  return out;
}

/**
 * Merge author-provided UI hints onto a reflected descriptor list. Hints
 * win over reflected defaults; unknown keys are ignored.
 */
export function mergeFieldMeta(
  fields: FieldDescriptor[],
  meta: Record<string, FieldMeta> | undefined,
): FieldDescriptor[] {
  if (!meta) return fields;
  return fields.map((f) => {
    const m = meta[f.name];
    if (!m) return f;
    const merged: FieldDescriptor = { ...f, ...m };
    // `enumOptions` from meta should fully replace, not shallow-merge.
    if (m.enumOptions !== undefined) merged.enumOptions = m.enumOptions;
    return merged;
  });
}

function describeField(name: string, schema: ZodLike): FieldDescriptor {
  const desc: FieldDescriptor = {
    name,
    kind: "unknown",
    optional: false,
    nullable: false,
  };

  if (schema.description) desc.description = schema.description;

  const unwrapped = unwrapWrappers(schema, desc);
  applyKindFromSchema(unwrapped, desc);
  return desc;
}

/**
 * Peel off `Optional` / `Nullable` / `Default` wrappers, recording the
 * relevant flags on the descriptor as we go.
 */
function unwrapWrappers(schema: ZodLike, desc: FieldDescriptor): ZodLike {
  let cur: ZodLike = schema;
  // Bound the loop defensively to avoid pathological wrappers.
  for (let i = 0; i < 8; i++) {
    const def = cur._def;
    if (!def) break;
    if (def.description && !desc.description) desc.description = def.description;
    switch (def.typeName) {
      case "ZodOptional":
        desc.optional = true;
        if (def.innerType) {
          cur = def.innerType as ZodLike;
          continue;
        }
        return cur;
      case "ZodNullable":
        desc.nullable = true;
        if (def.innerType) {
          cur = def.innerType as ZodLike;
          continue;
        }
        return cur;
      case "ZodDefault": {
        const dv = def.defaultValue;
        try {
          desc.default = typeof dv === "function" ? (dv as () => unknown)() : dv;
        } catch {
          desc.default = undefined;
        }
        if (def.innerType) {
          cur = def.innerType as ZodLike;
          continue;
        }
        return cur;
      }
      case "ZodEffects":
        if (def.schema) {
          cur = def.schema as ZodLike;
          continue;
        }
        return cur;
      default:
        return cur;
    }
  }
  return cur;
}

/** Strip wrappers and return the schema if it reduces to a ZodObject. */
function unwrapToObject(schema: ZodLike): ZodLike | undefined {
  let cur: ZodLike = schema;
  for (let i = 0; i < 8; i++) {
    const def = cur._def;
    if (!def) return undefined;
    if (def.typeName === "ZodObject") return cur;
    if (
      (def.typeName === "ZodOptional" ||
        def.typeName === "ZodNullable" ||
        def.typeName === "ZodDefault") &&
      def.innerType
    ) {
      cur = def.innerType as ZodLike;
      continue;
    }
    if (def.typeName === "ZodEffects" && def.schema) {
      cur = def.schema as ZodLike;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function applyKindFromSchema(schema: ZodLike, desc: FieldDescriptor): void {
  const def = schema._def;
  if (!def) {
    desc.kind = "unknown";
    return;
  }
  const tn = def.typeName;
  switch (tn) {
    case "ZodString": {
      desc.kind = "string";
      const c = collectStringConstraints(def.checks);
      if (c) desc.constraints = c;
      return;
    }
    case "ZodNumber":
    case "ZodBigInt": {
      desc.kind = "number";
      const c = collectNumberConstraints(def.checks);
      if (c) desc.constraints = c;
      return;
    }
    case "ZodBoolean":
      desc.kind = "boolean";
      return;
    case "ZodEnum": {
      desc.kind = "enum";
      const values = def.values ?? [];
      desc.enumOptions = values.map((v) => ({ label: String(v), value: v }));
      return;
    }
    case "ZodNativeEnum": {
      desc.kind = "enum";
      const native = (def as unknown as { values?: Record<string, unknown> })
        .values;
      if (native && typeof native === "object") {
        const opts: Array<{ label: string; value: string | number }> = [];
        for (const [k, v] of Object.entries(native)) {
          if (typeof v === "string" || typeof v === "number") {
            // TS native enums duplicate keys (numeric reverse lookup); skip.
            if (typeof v === "number" && /^\d+$/.test(k)) continue;
            opts.push({ label: k, value: v });
          }
        }
        desc.enumOptions = opts;
      }
      return;
    }
    case "ZodLiteral": {
      const v = (def as unknown as { value?: unknown }).value;
      if (typeof v === "string" || typeof v === "number") {
        desc.kind = "enum";
        desc.enumOptions = [{ label: String(v), value: v }];
      } else if (typeof v === "boolean") {
        desc.kind = "boolean";
      } else {
        desc.kind = "unknown";
      }
      return;
    }
    case "ZodArray": {
      // String-like arrays get a first-class list control; everything
      // else falls back to the generic long-text renderer via `unknown`.
      const innerDef = def.type?._def;
      switch (innerDef?.typeName) {
        case "ZodString":
          desc.kind = "string[]";
          return;
        case "ZodEnum": {
          desc.kind = "string[]";
          const values = innerDef.values ?? [];
          desc.enumOptions = values.map((v) => ({ label: String(v), value: v }));
          return;
        }
        case "ZodNativeEnum": {
          desc.kind = "string[]";
          const native = (
            innerDef as unknown as { values?: Record<string, unknown> }
          ).values;
          if (native && typeof native === "object") {
            const opts: Array<{ label: string; value: string | number }> = [];
            for (const [k, v] of Object.entries(native)) {
              if (typeof v === "string" || typeof v === "number") {
                if (typeof v === "number" && /^\d+$/.test(k)) continue;
                opts.push({ label: k, value: v });
              }
            }
            desc.enumOptions = opts;
          }
          return;
        }
        default:
          desc.kind = "unknown";
          return;
      }
    }
    case "ZodRecord":
      desc.kind = "record";
      return;
    case "ZodObject":
      desc.kind = "object";
      desc.children = describeNestedObject(schema);
      return;
    case "ZodAny":
    case "ZodUnknown":
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
    default:
      desc.kind = "unknown";
      return;
  }
}

function describeNestedObject(schema: ZodLike): FieldDescriptor[] {
  const shape = schema._def?.shape?.();
  if (!shape) return [];
  const out: FieldDescriptor[] = [];
  for (const [name, child] of Object.entries(shape)) {
    // Nested objects are flattened to one level; deeper nesting becomes
    // `unknown` and uses the generic long-text renderer.
    const inner = describeField(name, child as ZodLike);
    if (inner.kind === "object") inner.children = undefined;
    out.push(inner);
  }
  return out;
}

function collectStringConstraints(
  checks: ZodDef["checks"],
): FieldConstraints | undefined {
  if (!checks || checks.length === 0) return undefined;
  const c: FieldConstraints = {};
  for (const chk of checks) {
    switch (chk.kind) {
      case "min":
        if (typeof chk.value === "number") c.min = chk.value;
        break;
      case "max":
        if (typeof chk.value === "number") c.max = chk.value;
        break;
      case "regex":
        if (chk.regex?.source) c.pattern = chk.regex.source;
        break;
      case "email":
      case "url":
      case "uuid":
      case "cuid":
      case "cuid2":
      case "ulid":
      case "datetime":
      case "ip":
        c.format = chk.kind;
        break;
      default:
        break;
    }
  }
  return Object.keys(c).length > 0 ? c : undefined;
}

function collectNumberConstraints(
  checks: ZodDef["checks"],
): FieldConstraints | undefined {
  if (!checks || checks.length === 0) return undefined;
  const c: FieldConstraints = {};
  for (const chk of checks) {
    if (chk.kind === "min" && typeof chk.value === "number") c.min = chk.value;
    if (chk.kind === "max" && typeof chk.value === "number") c.max = chk.value;
    if (chk.kind === "int") c.format = "int";
  }
  return Object.keys(c).length > 0 ? c : undefined;
}

// Surface the kind alphabet for downstream consumers that want to
// switch over it without re-importing from `flow-ir`.
export type { FieldKind };
