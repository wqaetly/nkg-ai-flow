/**
 * Public entry-point for the Node Field Inspector.
 *
 * Studio integrators import:
 *   - `defaultFieldRendererRegistry` (singleton, prewired with default renderers)
 *   - `registerFieldRenderer` (sugar over the singleton's `register`)
 *   - `NodeFieldsPanel` (the React component used inside the node card)
 *
 * Tests can reach for `createFieldRendererRegistry` and `registerDefaults`
 * directly to spin up isolated registries.
 */

import {
  createFieldRendererRegistry,
  type FieldRenderer,
  type FieldRendererRegistry,
  type RendererMatcher,
} from "./registry.js";
import { registerDefaults } from "./defaultRenderers.js";

/** The shared registry used by `NodeFieldsPanel` when none is supplied. */
export const defaultFieldRendererRegistry: FieldRendererRegistry =
  (() => {
    const r = createFieldRendererRegistry();
    registerDefaults(r);
    return r;
  })();

/** Sugar wrapper so callers don't have to import the singleton by name. */
export function registerFieldRenderer(
  matcher: RendererMatcher,
  renderer: FieldRenderer,
): void {
  defaultFieldRendererRegistry.register(matcher, renderer);
}

export { createFieldRendererRegistry, registerDefaults };
export type {
  FieldRenderer,
  FieldRendererProps,
  FieldRendererRegistry,
  RendererMatcher,
} from "./registry.js";
export { NodeFieldsPanel } from "./NodeFieldsPanel.js";
export type { NodeFieldsPanelProps } from "./NodeFieldsPanel.js";
export {
  DEFAULT_STUDIO_FIELD_LOCALE,
  STUDIO_FIELD_LABEL_DICTIONARIES,
  localizeFieldDescriptor,
  resolveFieldDisplayLabel,
} from "./fieldLabels.js";
export type {
  StudioFieldLabelDictionary,
  StudioFieldLocale,
} from "./fieldLabels.js";
export {
  EnvVarsProvider,
  EnvVarPicker,
  useEnvVars,
  tokenForEnvEntry,
  refObjectForEnvEntry,
} from "./envContext.js";
export type { EnvVarEntry, EnvVarsProviderProps, EnvVarPickerProps } from "./envContext.js";
