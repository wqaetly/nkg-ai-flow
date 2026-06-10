import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ReactFlowStudio } from "./ReactFlowStudio.js";
import { FlowRunController } from "./FlowRunController.js";
import { createStudioState } from "./viewModel.js";
import { SidecarClient, type EnvOverrides } from "./httpClient.js";
import type { StudioPaletteItem, StudioState } from "./types.js";
import type { FlowGraph } from "@ai-native-flow/flow-ir";
import {
  GLOBAL_SCOPE,
  ENV_STORAGE_KEY,
  buildPickerEntries,
  countEffectiveKeys,
  createEnvRowId,
  deriveFlowScopeId,
  loadEnvState,
  mergeEnvOverrides,
  setRowsForScope as applyRowsForScope,
  type EnvPickerEntry,
  type EnvRow,
  type EnvState,
} from "./envState.js";
// Bundlers resolve this to a URL; the ambient declaration in assets.d.ts
// keeps the import type-safe.
import iconUrl from "./icon.webp";

/** Default sidecar location — single-machine local dev convention. */
const DEFAULT_SIDECAR_URL = "http://localhost:5173";
const SIDECAR_STORAGE_KEY = "anf.studio.sidecarUrl";

/**
 * Workbench is a VSCode-like IDE shell wrapped around the React Flow canvas:
 *
 *   ┌─────────┬──────────────── tabs ───────────────────┐
 *   │ Explorer│ tab1 │ tab2 │ tab3 │ ⋯                  │
 *   │ (tree)  ├─────────────────────────────────────────┤
 *   │  + import│                                         │
 *   │  flow A │            React Flow canvas            │
 *   │  flow B │                                         │
 *   │  …      ├─────────────────────────────────────────┤
 *   │         │ Console (logs, resizable)               │
 *   └─────────┴─────────────────────────────────────────┘
 *
 * Both the explorer and the console can collapse to maximise canvas space.
 * Switching tabs swaps the underlying StudioState so the canvas mounts a
 * fresh editor — selections and dirty state are isolated per flow.
 */

export interface FlowEntry {
  /** Stable identifier — used as React key and tab/file id. */
  id: string;
  /** Display label in tree + tab. */
  label: string;
  /** Optional folder path; nested by `/` separators when building the tree. */
  path?: string;
  /** Initial Studio state for this flow. */
  state: StudioState;
  /**
   * Optional Sidecar-relative filename (e.g. `"hello-flow.json"`). When
   * present, Save writes back via the Sidecar's `/studio/flows/file`
   * endpoint silently — no Save-As dialog, no lost handles across
   * page reloads. The starter flows shipped by `studio-browser` use
   * this path; user-imported flows continue to rely on the File System
   * Access API handle stored on the tab.
   */
  sidecarPath?: string;
}

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
  id: number;
  ts: number;
  level: ConsoleLevel;
  message: string;
}

export interface StudioWorkbenchProps {
  /** Initial flow set displayed in the explorer. */
  initialFlows: FlowEntry[];
  /** Optional palette to seed newly imported flows that don't carry one. */
  defaultPalette?: StudioPaletteItem[];
  /** Workbench title shown in the activity bar / window chrome. */
  title?: string;
  /** Initial active flow id. Defaults to the first entry. */
  initialActiveId?: string;
  /**
   * Whether to subscribe to global console.* and surface logs in the bottom
   * panel. Defaults to true. Set to false in tests.
   */
  captureConsole?: boolean;
  /**
   * Initial sidecar base URL. Defaults to `http://localhost:5173`. The
   * user can override this in-session via the title-bar field; the
   * choice is persisted to `localStorage` so refreshes preserve it.
   * Tests pass a stub URL (and `captureConsole={false}`) to keep the
   * suite hermetic.
   */
  initialSidecarUrl?: string;
}

interface TabState {
  id: string;
  label: string;
  state: StudioState;
  /**
   * Handle to the on-disk file this tab was loaded from (when the
   * browser exposes the File System Access API). When present, Save
   * writes back to the same file silently — no “Save As” dialog. The
   * handle is acquired from `showOpenFilePicker` on Import, or from
   * `showSaveFilePicker` the first time the user saves a flow that
   * has no source file (e.g. a built-in starter).
   */
  fileHandle?: SaveFileHandle;
  /**
   * When set, Save POSTs the graph to the Sidecar's file API instead of
   * touching the browser's File System Access stack. Mirrors
   * {@link FlowEntry.sidecarPath}. Survives page reloads because the
   * file lives on disk on the Sidecar host.
   */
  sidecarPath?: string;
}

/**
 * Local, structural type for the subset of the File System Access
 * API we actually use. Declaring it here (instead of relying on
 * `lib.dom`'s WICG types, which vary across TS versions) means we
 * can compile with older typings while still feature-detecting the
 * API at runtime.
 */
interface SaveFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<{
    write(data: Blob | string | ArrayBuffer | ArrayBufferView): Promise<void>;
    close(): Promise<void>;
  }>;
  /** Permission gating — some browsers require an explicit re-grant after a reload. */
  queryPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  requestPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
}

interface FileSystemAccessWindow {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    excludeAcceptAllOption?: boolean;
  }) => Promise<SaveFileHandle[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    excludeAcceptAllOption?: boolean;
  }) => Promise<SaveFileHandle>;
}

const MIN_EXPLORER = 180;
const MIN_CONSOLE = 80;
const DEFAULT_EXPLORER = 248;
const DEFAULT_CONSOLE = 180;

export function StudioWorkbench({
  initialFlows,
  defaultPalette,
  title = "AI Native Flow Studio",
  initialActiveId,
  captureConsole = true,
  initialSidecarUrl,
}: StudioWorkbenchProps) {
  // Each flow lives as its own tab; the explorer tree is derived from them.
  const [tabs, setTabs] = useState<TabState[]>(() =>
    initialFlows.map((f) => {
      const t: TabState = { id: f.id, label: f.label, state: f.state };
      if (f.sidecarPath) t.sidecarPath = f.sidecarPath;
      return t;
    }),
  );
  // Stable ref mirror so callbacks (Import / Save) can see the latest
  // tabs array without becoming dependents themselves — we don't want
  // every keystroke on a node config to invalidate `handleSave`.
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const [openTabIds, setOpenTabIds] = useState<string[]>(() =>
    initialFlows.length > 0 ? [initialFlows[0]!.id] : [],
  );
  const [activeId, setActiveId] = useState<string | undefined>(
    () => initialActiveId ?? initialFlows[0]?.id,
  );
  const [paths, setPaths] = useState<Record<string, string | undefined>>(() => {
    const map: Record<string, string | undefined> = {};
    for (const f of initialFlows) map[f.id] = f.path;
    return map;
  });

  // Layout: explorer + console can collapse independently. Sizes persist
  // within the session via local component state (purposefully not localStorage
  // to keep the package side-effect free).
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(DEFAULT_EXPLORER);
  const [consoleHeight, setConsoleHeight] = useState(DEFAULT_CONSOLE);

  // Free-text filter for the FLOWS tree. Matches against the leaf labels
  // (case-insensitive). Folders are kept whenever any descendant leaf
  // matches so the path to a hit stays visible.
  const [searchQuery, setSearchQuery] = useState("");

  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const logSeq = useRef(0);

  // Sidecar URL state — hydrated from localStorage on first render so a
  // page refresh preserves the user's last choice. The `initialSidecarUrl`
  // prop overrides only on first mount; later changes happen via the
  // workbench title-bar field.
  const [sidecarUrl, setSidecarUrl] = useState<string>(() => {
    if (initialSidecarUrl) return initialSidecarUrl;
    if (typeof window !== "undefined") {
      try {
        return localStorage.getItem(SIDECAR_STORAGE_KEY) ?? DEFAULT_SIDECAR_URL;
      } catch {
        /* localStorage may be disabled (private mode); fall through. */
      }
    }
    return DEFAULT_SIDECAR_URL;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(SIDECAR_STORAGE_KEY, sidecarUrl);
    } catch {
      /* persistence is best-effort. */
    }
  }, [sidecarUrl]);

  const [envPanelOpen, setEnvPanelOpen] = useState(false);
  const [envState, setEnvState] = useState<EnvState>(() =>
    loadEnvState(typeof window === "undefined" ? null : window.localStorage),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify({ version: 2, ...envState }));
    } catch {
      /* persistence is best-effort. */
    }
  }, [envState]);

  const activeSidecarPath = useMemo<string | undefined>(() => {
    const tab = tabs.find((t) => t.id === activeId);
    return tab?.sidecarPath;
  }, [tabs, activeId]);

  const activeEnvSidecarKey = useMemo<string | undefined>(() => {
    if (!activeSidecarPath) return undefined;
    return `${sidecarUrl.replace(/\/+$/, "")}|${activeSidecarPath}`;
  }, [sidecarUrl, activeSidecarPath]);

  const loadedEnvSidecarKeyRef = useRef<string | undefined>(undefined);
  const envSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Active flow's env scope. Sidecar-managed flows use their full
  // sidecarPath so variables stay isolated per flow. Imported /
  // Save-As flows have no sidecarPath, so only Global is available.
  const activeFlowScopeId = useMemo<string | undefined>(() => {
    return deriveFlowScopeId(activeSidecarPath);
  }, [activeSidecarPath]);

  useEffect(() => {
    if (!activeSidecarPath || !activeFlowScopeId || !activeEnvSidecarKey) {
      loadedEnvSidecarKeyRef.current = undefined;
      return;
    }
    let cancelled = false;
    const client = new SidecarClient({ baseUrl: sidecarUrl });
    loadedEnvSidecarKeyRef.current = undefined;
    void (async () => {
      try {
        const doc = await client.loadFlowEnv(activeSidecarPath);
        if (cancelled) return;
        const fileRows = rowsFromVariables(doc.variables);
        setEnvState((prev) => {
          const existingRows = prev.apps[activeFlowScopeId] ?? [];
          const rows = existingRows.length > 0
            ? mergeEnvRows(fileRows, existingRows)
            : fileRows;
          if (rows.length === 0) {
            if (!prev.apps[activeFlowScopeId]) return prev;
            const { [activeFlowScopeId]: _drop, ...rest } = prev.apps;
            void _drop;
            return { ...prev, apps: rest };
          }
          return {
            ...prev,
            apps: {
              ...prev.apps,
              [activeFlowScopeId]: rows,
            },
          };
        });
        loadedEnvSidecarKeyRef.current = activeEnvSidecarKey;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Studio] Flow env load failed for ${activeSidecarPath}: ${msg}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSidecarPath, activeFlowScopeId, activeEnvSidecarKey, sidecarUrl]);

  const visibleFlowScopeIds = useMemo<string[]>(
    () => (activeFlowScopeId ? [activeFlowScopeId] : []),
    [activeFlowScopeId],
  );

  // Which bucket the panel is currently editing. Defaults to the
  // active flow on first open so users land in the right place;
  // falls back to global when no flow is in scope.
  const [envScope, setEnvScope] = useState<string>(() =>
    activeFlowScopeId ?? GLOBAL_SCOPE,
  );
  // Auto-switch the panel scope when the user changes flows, but only
  // while the panel is closed — don't yank the bucket out from under
  // them mid-edit.
  useEffect(() => {
    if (envPanelOpen) return;
    setEnvScope(activeFlowScopeId ?? GLOBAL_SCOPE);
  }, [activeFlowScopeId, envPanelOpen]);

  useEffect(() => {
    if (envScope === GLOBAL_SCOPE) return;
    if (activeFlowScopeId && envScope === activeFlowScopeId) return;
    setEnvScope(activeFlowScopeId ?? GLOBAL_SCOPE);
  }, [activeFlowScopeId, envScope]);

  const editingRows: EnvRow[] = useMemo(() => {
    if (envScope === GLOBAL_SCOPE) return envState.global;
    return envState.apps[envScope] ?? [];
  }, [envState, envScope]);

  // Merge global + active-flow buckets into the wire-format payload
  // used for runs. Flow entries take precedence over global ones
  // on key collision — this is what makes private flow variables not
  // conflict with the global pool.
  const envOverrides = useMemo<EnvOverrides>(
    () => mergeEnvOverrides(envState, activeFlowScopeId),
    [envState, activeFlowScopeId],
  );

  const flowEnvVariablesForSave = useMemo(
    () => rowsToVariables(activeFlowScopeId ? envState.apps[activeFlowScopeId] ?? [] : []),
    [envState.apps, activeFlowScopeId],
  );

  // Count drives the badge on the toolbar Env button — reflect the
  // effective merged keyset for the active flow, not the bucket the
  // panel happens to have selected.
  useEffect(() => {
    if (envSaveTimerRef.current) {
      clearTimeout(envSaveTimerRef.current);
      envSaveTimerRef.current = undefined;
    }
    if (!activeSidecarPath || !activeEnvSidecarKey) return;
    if (loadedEnvSidecarKeyRef.current !== activeEnvSidecarKey) return;
    const client = new SidecarClient({ baseUrl: sidecarUrl });
    envSaveTimerRef.current = setTimeout(() => {
      void client.saveFlowEnv(activeSidecarPath, flowEnvVariablesForSave).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Studio] Flow env save failed for ${activeSidecarPath}: ${msg}`);
      });
    }, 300);
    return () => {
      if (envSaveTimerRef.current) {
        clearTimeout(envSaveTimerRef.current);
        envSaveTimerRef.current = undefined;
      }
    };
  }, [flowEnvVariablesForSave, activeSidecarPath, activeEnvSidecarKey, sidecarUrl]);

  const envCount = useMemo(
    () => countEffectiveKeys(envState, activeFlowScopeId),
    [envState, activeFlowScopeId],
  );

  // Stable, picker-friendly projection of the merged env state. Only
  // surfaces the active flow's bucket plus global — no cross-flow leakage.
  const envEntriesForPicker = useMemo<EnvPickerEntry[]>(
    () => buildPickerEntries(envState, activeFlowScopeId),
    [envState, activeFlowScopeId],
  );

  const setRowsForScope = useCallback(
    (scope: string, mutate: (rows: EnvRow[]) => EnvRow[]) => {
      setEnvState((prev) => applyRowsForScope(prev, scope, mutate));
    },
    [],
  );

  const addEnvRow = useCallback(() => {
    setRowsForScope(envScope, (rows) =>
      rows.concat({ id: createEnvRowId(), key: "", value: "", secret: false }),
    );
  }, [envScope, setRowsForScope]);
  const updateEnvRow = useCallback(
    (id: string, patch: Partial<Omit<EnvRow, "id">>) => {
      setRowsForScope(envScope, (rows) =>
        rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
    },
    [envScope, setRowsForScope],
  );
  const deleteEnvRow = useCallback(
    (id: string) => {
      setRowsForScope(envScope, (rows) => rows.filter((row) => row.id !== id));
    },
    [envScope, setRowsForScope],
  );

  /**
   * `appendLog` is the sink the per-tab `FlowRunController` writes
   * runtime events into. We expose it as a stable callback so a
   * controller's effect dependency array stays clean. The same buffer
   * also receives `console.*` mirrors when `captureConsole` is on.
   */
  const appendLog = useCallback(
    (level: ConsoleLevel, message: string) => {
      setLogs((prev) => {
        const next = prev.concat({
          id: ++logSeq.current,
          ts: Date.now(),
          level,
          message,
        });
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    },
    [],
  );

  /** Subscribe to console.* once on mount and mirror entries into the panel. */
  useEffect(() => {
    if (!captureConsole) return;
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const push = (level: ConsoleLevel, args: unknown[]) => {
      const message = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.stack ?? arg.message;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      appendLog(level, message);
    };
    console.log = (...args: unknown[]) => { push("log", args); original.log(...args); };
    console.info = (...args: unknown[]) => { push("info", args); original.info(...args); };
    console.warn = (...args: unknown[]) => { push("warn", args); original.warn(...args); };
    console.error = (...args: unknown[]) => { push("error", args); original.error(...args); };
    console.debug = (...args: unknown[]) => { push("debug", args); original.debug(...args); };
    return () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
    };
  }, [captureConsole, appendLog]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId),
    [tabs, activeId],
  );

  /** Open (or focus if already open) a flow in a tab. */
  const openFlow = useCallback((id: string) => {
    setOpenTabIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveId(id);
  }, []);

  /** Close a tab; if it was the active one, fall back to a neighbour. */
  const closeTab = useCallback((id: string) => {
    setOpenTabIds((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = prev.filter((tid) => tid !== id);
      if (id === activeId) {
        const fallback = next[idx] ?? next[idx - 1];
        setActiveId(fallback);
      }
      return next;
    });
  }, [activeId]);

  /** Persist edits inside a tab's StudioState. */
  const handleStateChange = useCallback((id: string, next: StudioState) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, state: next } : t)));
  }, []);

  /**
   * Save the active tab's flow back to its source file when possible.
   *
   * Resolution order:
   *   1. Tab carries a {@link SaveFileHandle} (acquired on Import via
   *      `showOpenFilePicker` or remembered from a previous Save) —
   *      write to that file silently, no dialog.
   *   2. Browser exposes `showSaveFilePicker` — prompt once, remember
   *      the handle so subsequent saves are silent.
   *   3. Fallback for browsers without the File System Access API —
   *      stream a download via an `<a download>` click, same shape
   *      that `handleImport` accepts on the way back in.
   */
  // Stable ref so handleSave reads the latest sidecar URL without
  // re-creating the callback on every keystroke in the URL field.
  const sidecarUrlRef = useRef(sidecarUrl);
  useEffect(() => { sidecarUrlRef.current = sidecarUrl; }, [sidecarUrl]);

  const handleSave = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    const json = JSON.stringify(tab.state.graph, null, 2);
    const suggestedName = `${tab.label.replace(/\.json$/i, "")}.json`;
    const w = window as unknown as FileSystemAccessWindow;

    // ---- (0) silent write-back via the Sidecar file API ------------
    // Starter flows live as real JSON files in the Sidecar host's
    // `flows/` directory; saving them goes through HTTP, no browser
    // file dialog, no permission prompt, survives page reloads.
    if (tab.sidecarPath) {
      try {
        const base = sidecarUrlRef.current.replace(/\/+$/, "");
        const res = await fetch(
          `${base}/studio/flows/file?path=${encodeURIComponent(tab.sidecarPath)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: json,
          },
        );
        if (!res.ok) {
          let detail = `${res.status} ${res.statusText}`;
          try {
            const body = await res.json() as { error?: { message?: string } };
            if (body?.error?.message) detail = body.error.message;
          } catch { /* keep status text */ }
          throw new Error(detail);
        }
        console.info(
          `[Studio] Saved flow "${tab.label}" → sidecar:${tab.sidecarPath} ` +
          `(${tab.state.graph.nodes.length} nodes, ${tab.state.graph.edges.length} edges).`,
        );
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Studio] Sidecar save failed for "${tab.label}": ${msg}`);
        // Don't fall back to a Save-As dialog here — the user explicitly
        // chose this flow from the Sidecar-served tree, popping a file
        // picker would be confusing. Surface the error in the console
        // and let them retry once the sidecar is reachable.
        return;
      }
    }

    // ---- (1) silent write-back to the original file ---------------
    if (tab.fileHandle) {
      try {
        await ensureWritePermission(tab.fileHandle);
        await writeJsonToHandle(tab.fileHandle, json);
        console.info(
          `[Studio] Saved flow "${tab.label}" → ${tab.fileHandle.name} ` +
          `(${tab.state.graph.nodes.length} nodes, ${tab.state.graph.edges.length} edges).`,
        );
        return;
      } catch (err) {
        // The handle may have been invalidated (file moved/deleted) or
        // permission may have been revoked. Fall through to Save-As.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Studio] In-place save failed (${msg}); falling back to Save As…`);
      }
    }

    // ---- (2) Save As via showSaveFilePicker ------------------------
    if (typeof w.showSaveFilePicker === "function") {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName,
          types: [{ description: "Flow JSON", accept: { "application/json": [".json"] } }],
        });
        await writeJsonToHandle(handle, json);
        // Remember the handle so the next Save is silent.
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, fileHandle: handle } : t)));
        setPaths((prev) => ({ ...prev, [id]: "local" }));
        console.info(`[Studio] Saved flow "${tab.label}" → ${handle.name}.`);
        return;
      } catch (err) {
        // AbortError = user cancelled the dialog; treat as a no-op.
        if (isAbortError(err)) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Studio] Save dialog failed (${msg}); falling back to download…`);
      }
    }

    // ---- (3) <a download> fallback ---------------------------------
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke on the next tick so Safari has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      console.info(
        `[Studio] Downloaded flow "${tab.label}" ` +
        `(${tab.state.graph.nodes.length} nodes, ${tab.state.graph.edges.length} edges).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Studio] Failed to save flow: ${msg}`);
    }
  }, []);

  /**
   * Import a JSON file from disk and add it as a new tab. The optional
   * `fileHandle` is captured when Import was triggered via the modern
   * `showOpenFilePicker` API; it lets `handleSave` write back to the
   * same file silently. When undefined (legacy `<input type="file">`
   * path), Save will prompt the user once via `showSaveFilePicker`.
   */
  const handleImport = useCallback(async (file: File, fileHandle?: SaveFileHandle) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<FlowGraph> & Record<string, unknown>;
      // Accept either a raw FlowGraph or `{ graph: FlowGraph }` envelopes.
      const graph = (parsed.nodes && parsed.edges ? parsed : (parsed as { graph?: FlowGraph }).graph) as
        | FlowGraph
        | undefined;
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new Error("File does not contain a FlowGraph (missing nodes/edges arrays)");
      }
      const id = uniqueFlowId(tabsRef.current, graph.id ?? file.name.replace(/\.json$/i, ""));
      const label = graph.label ?? file.name.replace(/\.json$/i, "");
      const state = createStudioState({ graph: { ...graph, id }, palette: [] });
      // Newly imported flows inherit the workbench's default palette so users
      // still get a runnable type registry on the canvas.
      if (defaultPalette && defaultPalette.length > 0) state.palette = defaultPalette;
      const tab: TabState = fileHandle ? { id, label, state, fileHandle } : { id, label, state };
      setTabs((prev) => [...prev, tab]);
      setPaths((prev) => ({ ...prev, [id]: fileHandle ? "local" : "imported" }));
      setOpenTabIds((prev) => [...prev, id]);
      setActiveId(id);
      console.info(`[Studio] Imported flow "${label}" with ${graph.nodes.length} nodes / ${graph.edges.length} edges.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Studio] Failed to import flow: ${msg}`);
    }
  }, [defaultPalette]);

  /**
   * Open the OS file picker via the File System Access API when
   * available (so we can later write back to the same file), falling
   * back to the hidden `<input type="file">` element otherwise.
   */
  const triggerImport = useCallback(async () => {
    const w = window as unknown as FileSystemAccessWindow;
    if (typeof w.showOpenFilePicker === "function") {
      try {
        const [handle] = await w.showOpenFilePicker({
          multiple: false,
          types: [{ description: "Flow JSON", accept: { "application/json": [".json"] } }],
        });
        if (!handle) return;
        const file = await handle.getFile();
        await handleImport(file, handle);
        return;
      } catch (err) {
        if (isAbortError(err)) return; // user cancelled
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Studio] Open dialog failed (${msg}); falling back to <input>…`);
      }
    }
    fileInputRef.current?.click();
  }, [handleImport]);

  // Build a tree view from each flow's path + label, then narrow it down
  // when the user types in the FLOWS search box. We deliberately keep the
  // raw tree memoised separately so the filter pass stays cheap.
  const tree = useMemo(() => {
    const entries = tabs.map((t) => ({ id: t.id, label: t.label, path: paths[t.id] }));
    return buildTree(entries);
  }, [tabs, paths]);
  const filteredTree = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tree;
    return filterTree(tree, q) ?? { id: "__root__", name: "root", children: [] };
  }, [tree, searchQuery]);

  // Resize handlers ---------------------------------------------------------

  const dragRef = useRef<{ kind: "explorer" | "console"; startX: number; startY: number; startSize: number } | null>(null);
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "explorer") {
        const dx = e.clientX - drag.startX;
        const next = clamp(drag.startSize + dx, MIN_EXPLORER, 520);
        setExplorerWidth(next);
      } else {
        const dy = e.clientY - drag.startY;
        // Console panel grows upward, so dragging the splitter UP increases height.
        const next = clamp(drag.startSize - dy, MIN_CONSOLE, 480);
        setConsoleHeight(next);
      }
    }
    function onUp() { dragRef.current = null; document.body.style.cursor = ""; document.body.style.userSelect = ""; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startResize = (kind: "explorer" | "console") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      startSize: kind === "explorer" ? explorerWidth : consoleHeight,
    };
    document.body.style.cursor = kind === "explorer" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  // -------------------------------------------------------------------------

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onFileChosen = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Legacy <input> path — we cannot obtain a writable handle, so the
    // first Save will prompt with showSaveFilePicker (or download).
    if (file) void handleImport(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const openTabs = openTabIds
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is TabState => Boolean(t));

  const envControl = (
    <div className="anf-env-config">
      <button
        type="button"
        className={`anf-env-button ${envPanelOpen ? "is-active" : ""}`}
        title="配置运行环境变量"
        onClick={() => setEnvPanelOpen((open) => !open)}
      >
        <IconEnv /> <span>环境</span>
        {envCount > 0 ? <span className="anf-env-count">{envCount}</span> : null}
      </button>
      {envPanelOpen ? (
        <div className="anf-env-popover" role="dialog" aria-label="环境变量">
          <div className="anf-env-popover-header">
            <div>
              <div className="anf-env-popover-title">运行环境</div>
              <div className="anf-env-popover-subtitle">
                {envScope === GLOBAL_SCOPE
                  ? "全局变量 - 所有流程都可使用。"
                  : "当前流程专属变量 - 同名时优先覆盖全局变量。"}
              </div>
            </div>
            <button type="button" className="anf-env-close" onClick={() => setEnvPanelOpen(false)} aria-label="关闭环境变量面板">
              ×
            </button>
          </div>
          <div className="anf-env-scope-tabs" role="tablist" aria-label="环境变量作用域">
            <button
              type="button"
              role="tab"
              aria-selected={envScope === GLOBAL_SCOPE}
              className={`anf-env-scope-tab ${envScope === GLOBAL_SCOPE ? "is-active" : ""}`}
              onClick={() => setEnvScope(GLOBAL_SCOPE)}
              title="所有流程共享的变量"
            >
              全局
              {envState.global.some((r) => r.key.trim()) ? (
                <span className="anf-env-scope-dot" aria-hidden />
              ) : null}
            </button>
            {visibleFlowScopeIds.map((flowScopeId) => (
              <button
                key={flowScopeId}
                type="button"
                role="tab"
                aria-selected={envScope === flowScopeId}
                className={`anf-env-scope-tab ${envScope === flowScopeId ? "is-active" : ""} is-current`}
                onClick={() => setEnvScope(flowScopeId)}
                title={`当前流程：${flowScopeId}`}
              >
                当前流程
                {(envState.apps[flowScopeId] ?? []).some((r) => r.key.trim()) ? (
                  <span className="anf-env-scope-dot" aria-hidden />
                ) : null}
              </button>
            ))}
          </div>
          <div className="anf-env-table" role="table" aria-label="运行环境变量">
            <div className="anf-env-row anf-env-row--head" role="row">
              <span>变量名</span>
              <span>变量值</span>
              <span>隐藏</span>
              <span />
            </div>
            {editingRows.length === 0 ? (
              <div className="anf-env-empty">还没有配置环境变量。</div>
            ) : editingRows.map((row) => (
              <div className="anf-env-row" role="row" key={row.id}>
                <input
                  className="anf-env-input"
                  value={row.key}
                  spellCheck={false}
                  placeholder="LLM_BASE_URL"
                  onChange={(e) => updateEnvRow(row.id, { key: e.target.value })}
                />
                <input
                  className="anf-env-input"
                  type={row.secret ? "password" : "text"}
                  value={row.value}
                  spellCheck={false}
                  placeholder={row.secret ? "sk-..." : "变量值"}
                  onChange={(e) => updateEnvRow(row.id, { value: e.target.value })}
                />
                <label className="anf-env-secret-toggle" title="隐藏变量值">
                  <input
                    type="checkbox"
                    checked={row.secret}
                    onChange={(e) => updateEnvRow(row.id, { secret: e.target.checked })}
                  />
                </label>
                <button
                  type="button"
                  className="anf-env-delete"
                  title="删除变量"
                  onClick={() => deleteEnvRow(row.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="anf-env-actions">
            <button type="button" className="anf-env-add" onClick={addEnvRow}>+ 添加变量</button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="anf-workbench">
      <header className="anf-workbench-titlebar">
        <img
          className="anf-workbench-logo"
          src={iconUrl}
          alt=""
          aria-hidden
          draggable={false}
        />
        <span className="anf-workbench-title">{title}</span>
        <span className="anf-workbench-spacer" />
        <label
          className="anf-workbench-sidecar"
          title="Local sidecar URL"
        >
          <span className="anf-workbench-sidecar-label">Sidecar</span>
          <input
            className="anf-workbench-sidecar-input"
            type="url"
            spellCheck={false}
            value={sidecarUrl}
            onChange={(e) => setSidecarUrl(e.target.value)}
            placeholder={DEFAULT_SIDECAR_URL}
          />
        </label>
        {envControl}
      </header>

      <div className="anf-workbench-body">
        {explorerOpen ? (
          <aside className="anf-explorer" style={{ width: explorerWidth }}>
            <div className="anf-explorer-section-header">
              <span className="anf-explorer-section-title">FLOWS</span>
              <span className="anf-explorer-spacer" />
              <button
                type="button"
                className="anf-explorer-action"
                title="Import flow JSON"
                onClick={() => void triggerImport()}
              >
                <IconUpload /> <span>Import</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={onFileChosen}
              />
            </div>
            <div className="anf-explorer-search">
              <span className="anf-explorer-search-icon" aria-hidden>
                <IconSearch />
              </span>
              <input
                type="search"
                className="anf-explorer-search-input"
                placeholder="Search flows…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                spellCheck={false}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="anf-explorer-search-clear"
                  title="Clear search"
                  onClick={() => setSearchQuery("")}
                >
                  ×
                </button>
              ) : null}
            </div>
            <div className="anf-explorer-tree" role="tree">
              {filteredTree.children && filteredTree.children.length > 0 ? (
                <TreeView
                  node={filteredTree}
                  activeId={activeId}
                  onOpen={openFlow}
                  depth={0}
                />
              ) : (
                <div className="anf-explorer-empty">
                  {searchQuery ? `No flows match "${searchQuery}".` : "No flows yet."}
                </div>
              )}
            </div>
          </aside>
        ) : null}

        {explorerOpen ? (
          <div
            className="anf-splitter anf-splitter--vertical"
            onMouseDown={startResize("explorer")}
            role="separator"
            aria-orientation="vertical"
          />
        ) : null}

        <section className="anf-workbench-main">
          <div className="anf-tabs" role="tablist">
            {openTabs.length === 0 ? (
              <div className="anf-tabs-empty">No flow opened — pick one from the Explorer.</div>
            ) : null}
            {openTabs.map((tab) => (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeId}
                className={`anf-tab ${tab.id === activeId ? "is-active" : ""}`}
                onClick={() => setActiveId(tab.id)}
              >
                <span className="anf-tab-icon"><IconFile /></span>
                <span className="anf-tab-label">{tab.label}</span>
                <button
                  type="button"
                  className="anf-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="anf-workbench-canvas">
            {activeTab ? (
              // `key` forces a fresh ReactFlow tree per flow so each tab has
              // its own undo/selection state.
              <FlowRunController
                key={activeTab.id}
                graph={activeTab.state.graph}
                sidecarUrl={sidecarUrl}
                envOverrides={envOverrides}
                appendLog={(level, message) => appendLog(level, message)}
                onToggleSidebar={() => setExplorerOpen((v) => !v)}
                sidebarOpen={explorerOpen}
                onToggleConsole={() => setConsoleOpen((v) => !v)}
                consoleOpen={consoleOpen}
                onSave={() => void handleSave(activeTab.id)}
              >
                {({ headerSlot, onNodeContextMenu }) => (
                  <ReactFlowStudio
                    initialState={activeTab.state}
                    title={activeTab.label}
                    onStateChange={(next) => handleStateChange(activeTab.id, next)}
                    headerSlot={headerSlot}
                    onNodeContextMenu={onNodeContextMenu}
                    envEntries={envEntriesForPicker}
                  />
                )}
              </FlowRunController>
            ) : (
              <div className="anf-canvas-empty">
                <div className="anf-canvas-empty-card">
                  <h2>No flow open</h2>
                  <p>Choose a flow from the Explorer or import a JSON file to get started.</p>
                  <button type="button" onClick={() => void triggerImport()}>
                    <IconUpload /> Import flow JSON…
                  </button>
                </div>
              </div>
            )}
          </div>

          {consoleOpen ? (
            <>
              <div
                className="anf-splitter anf-splitter--horizontal"
                onMouseDown={startResize("console")}
                role="separator"
                aria-orientation="horizontal"
              />
              <div className="anf-console" style={{ height: consoleHeight }}>
                <div className="anf-console-header">
                  <div className="anf-console-tabs">
                    <span className="anf-console-tab is-active">CONSOLE</span>
                    <span className="anf-console-counter">{logs.length}</span>
                  </div>
                  <span className="anf-explorer-spacer" />
                  <button
                    type="button"
                    className="anf-console-action"
                    title="Clear console"
                    onClick={() => setLogs([])}
                  >
                    Clear
                  </button>
                </div>
                <div className="anf-console-body">
                  {logs.length === 0 ? (
                    <div className="anf-console-empty">No log output yet.</div>
                  ) : (
                    logs.map((entry) => (
                      <div key={entry.id} className={`anf-console-line anf-console-line--${entry.level}`}>
                        <span className="anf-console-time">{formatTs(entry.ts)}</span>
                        <span className={`anf-console-level anf-console-level--${entry.level}`}>{entry.level}</span>
                        <span className="anf-console-message">{entry.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

// --- Tree -------------------------------------------------------------------

interface TreeNode {
  id: string;
  /** Display name. */
  name: string;
  /** Children nodes if folder; null/undefined if leaf (a flow). */
  children?: TreeNode[];
  /** When set, this is a leaf entry referencing a flow id. */
  flowId?: string;
}

function buildTree(entries: { id: string; label: string; path?: string }[]): TreeNode {
  const root: TreeNode = { id: "__root__", name: "root", children: [] };
  for (const e of entries) {
    const segments = (e.path ?? "").split("/").map((s) => s.trim()).filter(Boolean);
    let cursor = root;
    for (const seg of segments) {
      cursor.children ??= [];
      let child = cursor.children.find((c) => c.name === seg && !c.flowId);
      if (!child) {
        child = { id: `${cursor.id}/${seg}`, name: seg, children: [] };
        cursor.children.push(child);
      }
      cursor = child;
    }
    cursor.children ??= [];
    cursor.children.push({ id: e.id, name: e.label, flowId: e.id });
  }
  return root;
}

function TreeView({
  node,
  activeId,
  onOpen,
  depth,
}: {
  node: TreeNode;
  activeId: string | undefined;
  onOpen: (id: string) => void;
  depth: number;
}): ReactNode {
  if (!node.children) return null;
  return (
    <ul className="anf-tree-list">
      {node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth}
          activeId={activeId}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  activeId,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activeId: string | undefined;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const isLeaf = Boolean(node.flowId);
  const isActive = node.flowId === activeId;
  // Folder rows render: [chevron 12px] [gap 6px] [folder icon 16px] [name].
  // Leaf rows render:                              [file icon 16px] [name].
  // Adding the chevron's footprint (chevron width + gap = 18px) to a leaf's
  // left padding makes its file icon line up directly under the folder icon
  // of its parent — same visual rhythm as VSCode's File Explorer.
  const basePadding = 8 + depth * 14;
  const padding = isLeaf ? basePadding + 18 : basePadding;

  if (isLeaf) {
    return (
      <li>
        <button
          type="button"
          className={`anf-tree-row anf-tree-row--leaf ${isActive ? "is-active" : ""}`}
          style={{ paddingLeft: padding }}
          onClick={() => onOpen(node.flowId!)}
          onDoubleClick={() => onOpen(node.flowId!)}
        >
          <IconFile /> <span className="anf-tree-name">{node.name}</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className="anf-tree-row anf-tree-row--folder"
        style={{ paddingLeft: padding }}
        onClick={() => setOpen((v) => !v)}
      >
        <IconChevron open={open} />
        <IconFolder open={open} />
        <span className="anf-tree-name">{node.name}</span>
      </button>
      {open ? (
        <TreeView node={node} activeId={activeId} onOpen={onOpen} depth={depth + 1} />
      ) : null}
    </li>
  );
}

// --- Helpers ----------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function uniqueFlowId(tabs: TabState[], proposed: string): string {
  if (!tabs.some((t) => t.id === proposed)) return proposed;
  let i = 2;
  while (tabs.some((t) => t.id === `${proposed}_${i}`)) i++;
  return `${proposed}_${i}`;
}

function formatEnvValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rowsFromVariables(variables: Record<string, unknown>): EnvRow[] {
  return Object.entries(variables).map(([key, value]) => ({
    id: createEnvRowId(),
    key,
    value: formatEnvValue(value),
    secret: false,
  }));
}

function rowsToVariables(rows: EnvRow[]): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    variables[key] = row.value;
  }
  return variables;
}

function mergeEnvRows(...layers: EnvRow[][]): EnvRow[] {
  const byKey = new Map<string, EnvRow>();
  const order: string[] = [];
  for (const layer of layers) {
    for (const row of layer) {
      const key = row.key.trim();
      if (!key) continue;
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, { ...row, key });
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Returns a copy of the tree containing only branches that have at least
 * one leaf whose name matches the (lower-cased) query. Returning
 * `undefined` lets callers prune empty folders during recursion.
 */
function filterTree(node: TreeNode, query: string): TreeNode | undefined {
  // Leaf: keep when the label matches.
  if (node.flowId) {
    return node.name.toLowerCase().includes(query) ? { ...node } : undefined;
  }
  const filteredChildren = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode => Boolean(child));
  // Always keep the synthetic root so the renderer has something to walk.
  if (node.id === "__root__" || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return undefined;
}

/**
 * Stream a JSON string to a {@link SaveFileHandle}'s underlying file.
 * Always closes the writable to commit the change to disk; callers
 * are expected to have ensured write permission first.
 */
async function writeJsonToHandle(handle: SaveFileHandle, json: string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([json], { type: "application/json" }));
  } finally {
    // `close()` is what actually flushes to disk on Chromium; without
    // it the file stays empty.
    await writable.close();
  }
}

/**
 * Ensure the handle is currently in `readwrite` permission state,
 * prompting the user if necessary. Throws when the user denies the
 * request — the caller is expected to surface a fallback (Save As).
 *
 * Older browsers may omit `queryPermission` / `requestPermission`; in
 * that case we assume access is fine and let the subsequent write
 * surface any real error.
 */
async function ensureWritePermission(handle: SaveFileHandle): Promise<void> {
  if (typeof handle.queryPermission !== "function") return;
  const current = await handle.queryPermission({ mode: "readwrite" });
  if (current === "granted") return;
  if (typeof handle.requestPermission !== "function") {
    throw new Error("Write permission to the file is no longer granted");
  }
  const next = await handle.requestPermission({ mode: "readwrite" });
  if (next !== "granted") {
    throw new Error("Write permission to the file was denied");
  }
}

/**
 * Best-effort detection of the standard `AbortError` thrown when the
 * user cancels a `showOpen/SaveFilePicker` dialog. We don't want to
 * log that as a failure — it is the expected exit for a cancelled
 * dialog.
 */
function isAbortError(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { name?: string }).name === "AbortError";
}

// --- Inline icons (kept dependency-free) -----------------------------------

function IconEnv() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="5" cy="4.5" r="1.3" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.3" fill="currentColor" />
      <circle cx="7" cy="11.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

function IconUpload() {
  // "Import" semantics: arrow points DOWN into a tray — content is being
  // pulled FROM outside INTO the workspace. (An upward arrow would read as
  // "upload / send out" which is the opposite intent.)
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path d="M8 3v8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 8l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12.5v.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <line x1="10.2" y1="10.2" x2="13.2" y2="13.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconFile() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>
      <path d="M3 1.5h6.5L13 5v9a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.5V5h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function IconFolder({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>
        <path d="M2 5.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z" fill="currentColor" opacity="0.18" />
        <path d="M2 5.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>
      <path d="M2 5.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      aria-hidden
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms ease" }}
    >
      <polyline points="5,4 10,8 5,12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
