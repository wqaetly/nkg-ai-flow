/**
 * Shared plumbing for the in-node "environment variable picker".
 *
 * Every text-like field renderer (string, textarea, number, secret,
 * json, array, …) gets a small chevron button on its right edge.
 * Clicking it opens a search-enabled popover at the cursor position
 * listing the workbench-configured environment variables.
 * Picking an entry replaces the field value (or appends to the
 * caret position for textareas — see `applyEnvValueToInput`).
 *
 * The list of available variables is provided once at the workbench
 * level via `EnvVarsProvider` and consumed by every renderer through
 * `useEnvVars`. This avoids prop-drilling through the registry layer.
 *
 * Visually the popover reuses the existing `anf-add-node-menu`
 * styling so the canvas feels coherent — the only addition is the
 * `.anf-env-picker-row` row, which is dimensioned to fit a key /
 * value pair compactly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * A single environment binding surfaced to the picker.
 *
 * Scopes mirror the workbench Env panel:
 *  - `"flow"`   — private to the active flow.
 *                Higher priority; shadows a same-name `global` entry.
 *  - `"global"` — shared across every app/flow.
 *
 * The optional `flowLabel` is used purely for the picker section header.
 */
export type EnvVarScope = "flow" | "global";

export interface EnvVarEntry {
  /** Variable key (e.g. `LLM_BASE_URL`). */
  key: string;
  /** Plain value; empty string when masked and `hideValue` is set. */
  value: string;
  /** UI-only value masking flag; runtime still receives a variable. */
  secret: boolean;
  /**
   * Source layer this entry came from. Defaults to `"global"` when
   * omitted so older callers keep working unchanged.
   */
  scope?: EnvVarScope;
  /** Human-readable flow name; only meaningful for `scope = "flow"`. */
  flowLabel?: string;
}

interface EnvVarsContextValue {
  entries: EnvVarEntry[];
}

const EnvVarsContext = createContext<EnvVarsContextValue>({ entries: [] });

export interface EnvVarsProviderProps {
  entries: EnvVarEntry[];
  children: ReactNode;
}

export function EnvVarsProvider({ entries, children }: EnvVarsProviderProps): ReactNode {
  const value = useMemo<EnvVarsContextValue>(() => ({ entries }), [entries]);
  return <EnvVarsContext.Provider value={value}>{children}</EnvVarsContext.Provider>;
}

export function useEnvVars(): EnvVarEntry[] {
  return useContext(EnvVarsContext).entries;
}

// ─────────────────────── picker popover ───────────────────────

export interface EnvVarPickerProps {
  /** Anchor coordinates in viewport space. */
  x: number;
  y: number;
  entries: EnvVarEntry[];
  /** Called when the user picks an entry. */
  onPick: (entry: EnvVarEntry) => void;
  onClose: () => void;
}

const PICKER_WIDTH = 280;
const PICKER_HEIGHT = 320;

export function EnvVarPicker({ x, y, entries, onPick, onClose }: EnvVarPickerProps): ReactNode {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Auto-focus search on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Outside click / Escape dismisses the popover. We listen in capture
  // phase so React Flow's own pointer handlers can't swallow the event
  // before we observe it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed) return entries;
    return entries.filter(
      (e) =>
        e.key.toLowerCase().includes(trimmed) ||
        (!e.secret && e.value.toLowerCase().includes(trimmed)),
    );
  }, [entries, trimmed]);

  // Group by scope only. `secret` is display metadata, not a runtime kind.
  const flowEntries = filtered.filter((e) => e.scope === "flow");
  const globalEntries = filtered.filter((e) => e.scope !== "flow");
  const flowLabel = flowEntries.find((e) => e.flowLabel)?.flowLabel ?? "当前流程";

  // Pin to viewport so right-edge clicks don't spill off-screen.
  const left = Math.min(x, window.innerWidth - PICKER_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - PICKER_HEIGHT - 8);

  const node = (
    <div
      ref={rootRef}
      className="anf-add-node-menu anf-env-picker"
      role="menu"
      style={{ left, top, width: PICKER_WIDTH, maxHeight: PICKER_HEIGHT }}
      data-anf-menu="env-picker"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="anf-add-node-menu-search">
        <input
          ref={inputRef}
          type="search"
          placeholder="搜索环境变量..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="anf-add-node-menu-body">
        {entries.length === 0 ? (
          <div className="anf-add-node-menu-empty">
            还没有配置环境变量。
            <br />
            点击工具栏里的“环境”按钮添加变量。
          </div>
        ) : filtered.length === 0 ? (
          <div className="anf-add-node-menu-empty">{`没有匹配“${query}”的变量。`}</div>
        ) : (
          <>
            {flowEntries.length > 0 ? (
              <EnvSection title={`${flowLabel} 变量`} rows={flowEntries} onPick={onPick} />
            ) : null}
            {globalEntries.length > 0 ? (
              <EnvSection title="全局变量" rows={globalEntries} onPick={onPick} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  // Render through a portal so the menu is never clipped by the node
  // card's overflow / transform context.
  if (typeof document === "undefined") return node;
  return createPortal(node, document.body);
}

interface EnvSectionProps {
  title: string;
  rows: EnvVarEntry[];
  onPick: (entry: EnvVarEntry) => void;
}

function EnvSection({ title, rows, onPick }: EnvSectionProps): ReactNode {
  return (
    <div className="anf-add-node-group">
      <div className="anf-add-node-group-header" style={{ cursor: "default" }}>
        <span className="anf-add-node-group-name">{title}</span>
        <span className="anf-add-node-group-count">{rows.length}</span>
      </div>
      <ul className="anf-add-node-group-list">
        {rows.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              className="anf-add-node-item anf-env-picker-row"
              onClick={() => onPick(entry)}
              title={entry.secret ? entry.key : entry.value || entry.key}
            >
              <span className="anf-env-picker-key">{entry.key}</span>
              {!entry.secret && entry.value ? (
                <span className="anf-env-picker-value">{truncate(entry.value, 40)}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

// ─────────────────────── insertion helpers ───────────────────────

/**
 * Build the textual token a renderer should paste into a string-like
 * field when the user picks `entry`. Variables become their literal
 * value (the whole point is to avoid manually typing it). The `secret`
 * flag is UI metadata only; runtime configuration treats every entry as
 * a variable.
 */
export function tokenForEnvEntry(entry: EnvVarEntry): string {
  return entry.value;
}

/**
 * Build the JSON-shaped reference object for the runtime's `$var` resolver.
 * Legacy `$secret` references still load, but new edits always emit `$var`.
 */
export function refObjectForEnvEntry(entry: EnvVarEntry): Record<string, string> {
  return { $var: entry.key };
}

/**
 * Insert `text` into an `<input>` / `<textarea>` at its current
 * caret/selection. Returns the resulting full string so the caller
 * can flow it through the standard `onChange` commit path.
 *
 * If no element is supplied, falls back to plain replacement.
 */
export function insertAtCaret(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  current: string,
  insert: string,
): string {
  if (!el) return insert; // No element ref → pure replacement.
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const next = current.slice(0, start) + insert + current.slice(end);
  // Schedule caret restore after React reconciles the new value so the
  // user keeps typing seamlessly after their inserted token.
  const caret = start + insert.length;
  requestAnimationFrame(() => {
    try {
      el.focus();
      el.setSelectionRange(caret, caret);
    } catch {
      /* element may have unmounted */
    }
  });
  return next;
}
