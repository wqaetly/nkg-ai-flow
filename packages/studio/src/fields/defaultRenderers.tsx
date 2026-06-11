/**
 * Default field renderers for the Node Field Inspector.
 *
 * Every renderer:
 *   - Is a controlled component reading `props.value` and emitting via
 *     `props.onChange(next)`. The parent (`NodeFieldsPanel`) is the
 *     single source of truth and writes back to `node.config` through
 *     the standard `update_node_config` graph operation.
 *   - Wraps its DOM in `nodrag nopan nowheel` and stops propagation on
 *     pointer/keyboard events so React Flow doesn't swallow input.
 *   - Marks itself with `anf-field--invalid` when the current value
 *     violates a known constraint, but never blocks editing.
 *
 * The exported `registerDefaults` registers the full kit on a fresh
 * `FieldRendererRegistry` and is invoked once at module load by the
 * shared registry export.
 */

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { createPortal } from "react-dom";
import type {
  FieldRenderer,
  FieldRendererProps,
  FieldRendererRegistry,
} from "./registry.js";

// ───────────────────────── helpers ─────────────────────────

/** Stop React Flow from intercepting pointer / keyboard events. */
const STOP_PROPS = {
  className: "nodrag nopan nowheel",
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

function asString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function asTextValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function classNames(...xs: Array<string | false | undefined | null>): string {
  return xs.filter(Boolean).join(" ");
}

// ───────────────────────── renderers ───────────────────────

const StringRenderer: FieldRenderer = ({
  descriptor,
  value,
  onChange,
  disabled,
}: FieldRendererProps) => {
  const v = asString(value);
  const c = descriptor.constraints;
  const invalid =
    (c?.min !== undefined && v.length > 0 && v.length < c.min) ||
    (c?.max !== undefined && v.length > c.max) ||
    (c?.pattern !== undefined && v.length > 0 && !new RegExp(c.pattern).test(v));
  return (
    <input
      {...STOP_PROPS}
      type="text"
      className={classNames(
        "anf-field-control anf-field-control--string nodrag nopan nowheel",
        invalid && "anf-field--invalid",
      )}
      value={v}
      placeholder={descriptor.placeholder}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
    />
  );
};

const TextareaRenderer: FieldRenderer = ({
  descriptor,
  value,
  onChange,
  disabled,
}) => (
  <TextFieldShell
    descriptor={descriptor}
    value={asTextValue(value)}
    placeholder={descriptor.placeholder}
    disabled={disabled}
    onChange={onChange}
  />
);

const SecretRenderer: FieldRenderer = ({
  descriptor,
  value,
  onChange,
  disabled,
}) => {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      {...STOP_PROPS}
      className="anf-field-control anf-field-control--secret nodrag nopan nowheel"
    >
      <input
        type={revealed ? "text" : "password"}
        className="anf-field-secret-input"
        value={asString(value)}
        placeholder={descriptor.placeholder}
        disabled={disabled}
        autoComplete="off"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="anf-field-secret-toggle"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setRevealed((r) => !r);
        }}
        title={revealed ? "Hide" : "Show"}
      >
        {revealed ? "🙈" : "👁"}
      </button>
    </span>
  );
};

const NumberRenderer: FieldRenderer = ({
  descriptor,
  value,
  onChange,
  disabled,
}) => {
  const c = descriptor.constraints;
  const num = typeof value === "number" ? value : Number(value);
  const isNum = Number.isFinite(num);
  const invalid =
    isNum &&
    ((c?.min !== undefined && num < c.min) ||
      (c?.max !== undefined && num > c.max));
  return (
    <input
      {...STOP_PROPS}
      type="number"
      className={classNames(
        "anf-field-control anf-field-control--number nodrag nopan nowheel",
        invalid && "anf-field--invalid",
      )}
      value={
        value === undefined || value === null || Number.isNaN(num as number)
          ? ""
          : String(num)
      }
      placeholder={descriptor.placeholder}
      min={c?.min}
      max={c?.max}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange(undefined);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
};

const BooleanRenderer: FieldRenderer = ({
  value,
  onChange,
  disabled,
}) => {
  // The label is rendered on the left by `FieldRow`, matching every
  // other field. The renderer itself only emits the toggle switch so
  // the row layout stays uniform across kinds.
  const checked = value === true;
  return (
    <label
      {...STOP_PROPS}
      className="anf-field-control anf-field-control--boolean nodrag nopan nowheel"
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <span className="anf-field-boolean-state">{checked ? "On" : "Off"}</span>
    </label>
  );
};

const EnumRenderer: FieldRenderer = ({
  descriptor,
  value,
  onChange,
  disabled,
}) => {
  const opts = descriptor.enumOptions ?? [];
  // Render as string in <select>; coerce back if the option's underlying
  // value was numeric.
  const isNumeric = opts.some((o) => typeof o.value === "number");
  return (
    <select
      {...STOP_PROPS}
      className="anf-field-control anf-field-control--enum nodrag nopan nowheel"
      value={value === undefined || value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange(undefined);
          return;
        }
        onChange(isNumeric ? Number(raw) : raw);
      }}
    >
      {descriptor.optional ? <option value="">—</option> : null}
      {opts.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
};

const StringArrayRenderer: FieldRenderer = ({
  descriptor,
  value,
  onChange,
  disabled,
}) => {
  const arr = Array.isArray(value) ? (value as unknown[]) : [];
  const text = useMemo(() => arr.map((x) => asString(x)).join("\n"), [arr]);
  return (
    <TextFieldShell
      descriptor={descriptor}
      value={text}
      placeholder={descriptor.placeholder ?? "one per line or comma separated"}
      disabled={disabled}
      className="anf-field-control--array"
      onChange={(raw) => {
        const next = asString(raw)
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        onChange(next);
      }}
    />
  );
};

const UnknownRenderer: FieldRenderer = TextareaRenderer;

function TextFieldShell({
  descriptor,
  value,
  placeholder,
  disabled,
  className,
  onChange,
}: {
  descriptor: FieldRendererProps["descriptor"];
  value: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onChange: (next: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = descriptor.label ?? descriptor.name;

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const modal =
    expanded && typeof document !== "undefined"
      ? createPortal(
          <div
            className="anf-textarea-modal-backdrop nodrag nopan nowheel"
            role="presentation"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setExpanded(false)}
          >
            <section
              className="anf-textarea-modal"
              role="dialog"
              aria-modal="true"
              aria-label={label}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <header className="anf-textarea-modal-head">
                <div className="anf-textarea-modal-title">{label}</div>
                <button
                  type="button"
                  className="anf-textarea-icon-button"
                  title="关闭"
                  aria-label="关闭"
                  onClick={() => setExpanded(false)}
                >
                  <IconClose />
                </button>
              </header>
              <textarea
                className="anf-textarea-modal-editor nodrag nopan nowheel"
                value={value}
                placeholder={placeholder}
                disabled={disabled}
                spellCheck={false}
                autoFocus
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setExpanded(false);
                  else e.stopPropagation();
                }}
              />
            </section>
          </div>,
          document.body,
        )
      : null;

  return (
    <span
      {...STOP_PROPS}
      className={classNames(
        "anf-field-control anf-field-control--textarea anf-field-control--textarea-shell nodrag nopan nowheel",
        className,
      )}
    >
      <textarea
        className="anf-field-textarea-preview nodrag nopan nowheel"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        spellCheck={false}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="anf-textarea-expand-button nodrag nopan nowheel"
        title="放大展示"
        aria-label="放大展示"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(true);
        }}
      >
        <IconExpand />
      </button>
      {modal}
    </span>
  );
}

function IconExpand() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path
        d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ───────────────────────── registration ───────────────────

/**
 * Wire up the default kit. Called once when the shared registry is
 * created; tests can call it on isolated registries too.
 */
export function registerDefaults(registry: FieldRendererRegistry): void {
  // Kind defaults
  registry.register({ kind: "string" }, StringRenderer);
  registry.register({ kind: "number" }, NumberRenderer);
  registry.register({ kind: "boolean" }, BooleanRenderer);
  registry.register({ kind: "enum" }, EnumRenderer);
  registry.register({ kind: "string[]" }, StringArrayRenderer);
  registry.register({ kind: "record" }, TextareaRenderer);
  registry.register({ kind: "object" }, TextareaRenderer);
  registry.register({ kind: "unknown" }, UnknownRenderer);

  // Control overrides
  registry.register({ control: "input" }, StringRenderer);
  registry.register({ control: "textarea" }, TextareaRenderer);
  registry.register({ control: "password" }, SecretRenderer);
  registry.register({ control: "number" }, NumberRenderer);
  registry.register({ control: "switch" }, BooleanRenderer);
  registry.register({ control: "select" }, EnumRenderer);
  // Fallback
  registry.setFallback(UnknownRenderer);
}

export {
  StringRenderer,
  TextareaRenderer,
  SecretRenderer,
  NumberRenderer,
  BooleanRenderer,
  EnumRenderer,
  StringArrayRenderer,
  UnknownRenderer,
};
