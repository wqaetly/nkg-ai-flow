/**
 * Field renderer registry for the Node Field Inspector.
 *
 * Studio renders each `FieldDescriptor` by looking up a renderer in
 * this registry. Resolution order (highest priority first):
 *
 *   1. Exact match on `(nodeType, fieldName)`
 *   2. Match on `fieldMeta.control` value (e.g. "textarea")
 *   3. Match on `kind` (e.g. "string", "number", "enum")
 *   4. The `unknown` fallback renderer
 *
 * The registry has no React dependency on its own — it just stores
 * functions. Default renderers (string, number, ...) are registered by
 * `defaultRenderers.tsx` via `registerDefaults`.
 */

import type {
  FieldDescriptor,
  FieldMeta,
} from "@ai-native-flow/flow-ir";
import type { ReactNode } from "react";

/** Props supplied to every field renderer. */
export interface FieldRendererProps {
  descriptor: FieldDescriptor;
  /** Current value pulled from `node.config[descriptor.name]`. */
  value: unknown;
  /** Patch the node config (called with the new value for this field). */
  onChange: (next: unknown) => void;
  disabled?: boolean;
  nodeType: string;
  nodeId: string;
}

/** Pure render function. Returning `null` is allowed (e.g. for `hidden`). */
export type FieldRenderer = (props: FieldRendererProps) => ReactNode;

/** Selectors used to match a renderer registration. */
export interface RendererMatcher {
  /** Match a specific node type — must be combined with `fieldName`. */
  nodeType?: string;
  /** Match a specific field on `nodeType` (requires `nodeType`). */
  fieldName?: string;
  /** Match `fieldMeta.control` values regardless of node/field. */
  control?: NonNullable<FieldMeta["control"]>;
  /** Match a kind (lowest specificity). */
  kind?: FieldDescriptor["kind"];
}

interface ExactKey {
  nodeType: string;
  fieldName: string;
}

/** Internal entry for non-exact matchers. */
interface CatchAll {
  matcher: RendererMatcher;
  renderer: FieldRenderer;
}

export interface FieldRendererRegistry {
  register: (matcher: RendererMatcher, renderer: FieldRenderer) => void;
  resolve: (
    descriptor: FieldDescriptor,
    nodeType: string,
  ) => FieldRenderer;
  /** Replace the fallback used when nothing else matches. */
  setFallback: (renderer: FieldRenderer) => void;
}

/**
 * Build a fresh registry. Studio creates one at module load and keeps
 * it singleton-style; tests can spin up isolated registries.
 */
export function createFieldRendererRegistry(): FieldRendererRegistry {
  const exact = new Map<string, FieldRenderer>();
  const byControl = new Map<string, FieldRenderer>();
  const byKind = new Map<string, FieldRenderer>();
  let fallback: FieldRenderer = () => null;

  const exactKey = (k: ExactKey) => `${k.nodeType}::${k.fieldName}`;

  return {
    register(matcher, renderer) {
      if (matcher.nodeType && matcher.fieldName) {
        exact.set(
          exactKey({
            nodeType: matcher.nodeType,
            fieldName: matcher.fieldName,
          }),
          renderer,
        );
        return;
      }
      if (matcher.control) {
        byControl.set(matcher.control, renderer);
        return;
      }
      if (matcher.kind) {
        byKind.set(matcher.kind, renderer);
        return;
      }
      // No selectors → treat as fallback.
      fallback = renderer;
    },

    setFallback(renderer) {
      fallback = renderer;
    },

    resolve(descriptor, nodeType) {
      // 1. Exact (nodeType + fieldName)
      const e = exact.get(exactKey({ nodeType, fieldName: descriptor.name }));
      if (e) return e;
      // 2. Control hint
      if (descriptor.control) {
        const c = byControl.get(descriptor.control);
        if (c) return c;
      }
      // 3. Kind
      const k = byKind.get(descriptor.kind);
      if (k) return k;
      // 4. Fallback
      return fallback;
    },
  };
}
