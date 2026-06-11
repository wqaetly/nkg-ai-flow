/**
 * Renders a node's reflected `FieldDescriptor[]` between the card head
 * and the ports section. This is the central piece of the Node Field
 * Inspector — author-defined Zod fields show up here automatically.
 *
 * Responsibilities:
 *   - Read `configFields` from the React Flow node data.
 *   - Look up a renderer per field via the singleton registry.
 *   - Maintain per-field local state with debounce; commit through the
 *     host-injected `onChange(nodeId, patch)` callback.
 *   - Disable controls while the node is running.
 *   - Wrap the whole panel in an error boundary so a misbehaving
 *     renderer can never tear down the canvas.
 *   - Render a uniform "label on the left, control on the right"
 *     row, with a small chevron button that opens the
 *     `EnvVarPicker` popover so users can drop in environment /
 *     secret references without typing them out.
 */

import {
  Component,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Handle, Position } from "@xyflow/react";
import type { FieldDescriptor, PortDefinition } from "@ai-native-flow/flow-ir";
import {
  defaultFieldRendererRegistry,
  type FieldRendererRegistry,
} from "./index.js";
import type { FieldRenderer } from "./registry.js";
import {
  EnvVarPicker,
  refObjectForEnvEntry,
  useEnvVars,
  type EnvVarEntry,
} from "./envContext.js";

export interface NodeFieldsPanelProps {
  nodeId: string;
  nodeType: string;
  fields: FieldDescriptor[];
  config: Record<string, unknown>;
  /** Called with a partial patch of `config`. */
  onChange: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Disable all controls (e.g. while the node is running). */
  disabled?: boolean;
  /** Override the registry — primarily for tests. */
  registry?: FieldRendererRegistry;
  /**
   * Input-side data ports declared by this node instance. Used to
   * promote any field whose name matches a port id into a "port + field"
   * row: a target Handle is rendered to the left of the label so the
   * user can wire an upstream value, and the control is replaced by a
   * read-only "connected" badge once the port has at least one edge.
   */
  inputDataPorts?: PortDefinition[];
  /**
   * Set of port ids on this node that are currently wired to at least
   * one edge. Used in tandem with `inputDataPorts` to decide whether
   * the inline editor should be hidden in favour of the "connected"
   * badge.
   */
  connectedPortIds?: ReadonlySet<string>;
}

const DEBOUNCE_MS = 100;

/**
 * Public entry. Returns `null` when there is nothing to render so the
 * card layout stays tight.
 */
export function NodeFieldsPanel(props: NodeFieldsPanelProps): ReactNode {
  const visible = useMemo(
    () => sortFields(props.fields).filter((f) => !f.hidden),
    [props.fields],
  );
  // Map<fieldName, port> so each FieldRow can ask "is there an input
  // port that shares my name?" in O(1). Lookups by `.name` (which is
  // always the field key in `config`).
  const portByName = useMemo(() => {
    const m = new Map<string, PortDefinition>();
    for (const port of props.inputDataPorts ?? []) {
      // `direction === "input"` is implied by `inputDataPorts` but we
      // double-check to keep the contract explicit.
      if (port.direction !== "input") continue;
      m.set(port.id, port);
    }
    return m;
  }, [props.inputDataPorts]);
  if (visible.length === 0) return null;

  return (
    <div
      className="anf-node-fields"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <FieldErrorBoundary>
        {visible.map((field) => {
          const port = portByName.get(field.name);
          const connected = port
            ? props.connectedPortIds?.has(port.id) ?? false
            : false;
          return (
            <FieldRow
              key={field.name}
              field={field}
              value={props.config[field.name]}
              disabled={props.disabled}
              nodeId={props.nodeId}
              nodeType={props.nodeType}
              port={port}
              connected={connected}
              onChange={(next) => props.onChange(props.nodeId, { [field.name]: next })}
              registry={props.registry ?? defaultFieldRendererRegistry}
            />
          );
        })}
      </FieldErrorBoundary>
    </div>
  );
}

interface FieldRowProps {
  field: FieldDescriptor;
  value: unknown;
  disabled?: boolean;
  nodeId: string;
  nodeType: string;
  /**
   * The matching input data port (same `id` as `field.name`), if the
   * node declares one. Drives the left-side handle and the
   * connected-vs-free pin styling.
   */
  port?: PortDefinition;
  /** True when at least one edge is wired into `port`. */
  connected: boolean;
  onChange: (next: unknown) => void;
  registry: FieldRendererRegistry;
}

/** Field kinds whose serialized value benefits from an env-var picker. */
function fieldSupportsEnvPicker(field: FieldDescriptor): boolean {
  // Boolean and enum fields have a closed value space; pulling an env
  // variable into them would just produce garbage. Everything else
  // (string / number / textarea / arrays / records) is fair game.
  if (field.kind === "boolean" || field.kind === "enum") return false;
  return true;
}

/**
 * Format whatever the renderer is currently rendering as a label so
 * the user can tell at a glance that a field already references an
 * environment variable. Returns `null` when the value is "plain".
 */
function describeRefValue(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.$var === "string") return rec.$var;
    if (typeof rec.$secret === "string") return rec.$secret;
  }
  return null;
}

export function envReferenceForFieldPick(entry: EnvVarEntry): Record<string, string> {
  return refObjectForEnvEntry(entry);
}

function FieldRow({
  field,
  value,
  disabled,
  nodeId,
  nodeType,
  port,
  connected,
  onChange,
  registry,
}: FieldRowProps): ReactNode {
  const [draft, setDraft] = useState<unknown>(value);
  const upstreamRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cellRef = useRef<HTMLSpanElement | null>(null);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const envEntries = useEnvVars();

  // Sync local draft when the upstream value changes (e.g. external
  // graph operation, undo, etc.) — but ignore changes that match what
  // we last committed.
  useEffect(() => {
    if (value !== upstreamRef.current) {
      upstreamRef.current = value;
      setDraft(value);
    }
  }, [value]);

  const commit = useCallback(
    (next: unknown) => {
      setDraft(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        upstreamRef.current = next;
        onChange(next);
        timerRef.current = null;
      }, DEBOUNCE_MS);
    },
    [onChange],
  );

  // Flush pending edit when the row unmounts so we don't lose typing.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const renderer: FieldRenderer = registry.resolve(field, nodeType);

  // Layout invariant: every field renders a row with the label on the
  // left and the control on the right. Boolean fields are special-cased
  // — their renderer returns just the checkbox so we can place the
  // label on the left like every other row.
  const label = field.label ?? field.name;
  const refLabel = describeRefValue(draft);
  const showPickerButton = fieldSupportsEnvPicker(field);
  const controlWrapClassName = [
    "anf-field-control-wrap",
    field.control === "textarea" || field.kind === "string[]"
      ? "anf-field-control-wrap--textarea"
      : "",
  ].join(" ").trim();

  const handleEnvPick = useCallback(
    (entry: EnvVarEntry) => {
      setPicker(null);
      // Store a reference, not the current literal value. The execution
      // engine resolves this object against the active VariableStore
      // immediately before the node runs, so later env edits
      // take effect without reconfiguring every node field.
      commit(envReferenceForFieldPick(entry));
    },
    [commit],
  );

  const openPicker = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    // Anchor the popover at the cursor so the user's mouse lands on
    // the search box without an extra travel — matching the right-
    // click "Add node" menu behaviour.
    setPicker({ x: event.clientX, y: event.clientY });
  }, []);

  // When the field doubles as an input data port and an upstream edge
  // is wired, hide the local editor — the runtime resolves the value
  // from the port. We keep the row (and its handle) so the user can
  // still see the param exists; clicking the chip detaches the edge by
  // the standard delete shortcut on the line itself.
  const portIsWired = Boolean(port && connected);

  const portTitle = port
    ? `${port.label ?? port.id}\n类型：${port.kind}${port.required ? " · 必填" : ""}`
    : undefined;

  return (
    <div
      className={[
        "anf-field-row",
        port ? "anf-field-row--has-port" : "",
        portIsWired ? "anf-field-row--wired" : "",
      ].join(" ").trim()}
      title={field.description}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {port ? (
        <Handle
          id={port.id}
          type="target"
          position={Position.Left}
          className={[
            "anf-handle",
            "anf-handle--input",
            `anf-handle--${port.kind}`,
            "anf-handle--data",
            "anf-handle--inline",
            portIsWired ? "anf-handle--connected" : "anf-handle--free",
          ].join(" ")}
        />
      ) : null}
      <span className="anf-field-label" title={portTitle}>
        {label}
        {field.optional ? null : <span className="anf-field-required">*</span>}
      </span>
      <span className="anf-field-cell" ref={cellRef}>
        {portIsWired ? (
          <span className="anf-field-wired-chip" title="值由上游端口提供">
            <span className="anf-field-wired-dot" aria-hidden />
            已连接
          </span>
        ) : (
          <span className={controlWrapClassName}>
            {refLabel ? (
              <span className="anf-field-ref-chip" title="引用环境变量">
                <span className="anf-field-wired-dot" aria-hidden />
                <span className="anf-field-ref-chip-text">{refLabel}</span>
                <button
                  type="button"
                  className="anf-field-ref-chip-clear"
                  disabled={disabled}
                  title="清除引用"
                  onClick={(e) => {
                    e.stopPropagation();
                    commit(undefined);
                  }}
                >
                  ×
                </button>
              </span>
            ) : (
              createElement(renderer, {
                descriptor: field,
                value: draft,
                onChange: commit,
                disabled,
                nodeId,
                nodeType,
              })
            )}
            {showPickerButton ? (
              <button
                type="button"
                className="anf-field-env-button nodrag nopan nowheel"
                disabled={disabled}
                title="插入环境变量"
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={openPicker}
              >
                <span className="anf-field-env-button-chevron" aria-hidden>
                  ▾
                </span>
              </button>
            ) : null}
          </span>
        )}
      </span>
      {picker ? (
        <EnvVarPicker
          x={picker.x}
          y={picker.y}
          entries={envEntries}
          onPick={handleEnvPick}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}

function sortFields(fields: FieldDescriptor[]): FieldDescriptor[] {
  // Stable sort by `order` (ascending), undefined orders go to the end
  // preserving declaration order.
  return [...fields]
    .map((f, idx) => ({ f, idx }))
    .sort((a, b) => {
      const ao = a.f.order ?? Number.POSITIVE_INFINITY;
      const bo = b.f.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return a.idx - b.idx;
    })
    .map((x) => x.f);
}

/**
 * Catches render errors in any renderer and degrades to a one-line
 * notice. Without this, a broken third-party renderer could unmount
 * the whole React Flow canvas.
 */
class FieldErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.warn("[NodeFieldsPanel] field renderer threw:", error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="anf-node-fields-error">
          Field renderer error: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
