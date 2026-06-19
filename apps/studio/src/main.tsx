import React from "react";
import { createRoot } from "react-dom/client";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  createDefaultRegistry,
  type FlowGraph,
  type NodeTypeDefinition,
} from "@ai-native-flow/flow-ir";
import { getBuiltinNodeDefinitions } from "@ai-native-flow/runtime/builtin-definitions";
import {
  StudioWorkbench,
  createStudioState,
  type FlowEntry,
  type StudioState,
} from "@ai-native-flow/studio";
import "@ai-native-flow/studio/reactFlowStudio.css";

/**
 * Build the palette by combining the IR-level pseudo-nodes (`start` /
 * `end`, pre-filled by `createDefaultRegistry()`) with every "real"
 * built-in authored via `defineNode` in the `runtime` package. We don't
 * special-case the built-ins here — the same path a third-party node
 * pack would take is reused, so any reflected `configSchema.fields`
 * shows up automatically on the canvas.
 *
 * On top of that, the sidecar exposes any custom node definitions
 * loaded from app manifests (built-in apps plus optional host
 * `anf.apps.json` -> `anf.app.json` -> `nodePacks`) under
 * `/studio/nodes/list`. We merge those in too so
 * business-specific node types appear in the palette without a rebuild.
 */
const registry = createDefaultRegistry();
for (const def of getBuiltinNodeDefinitions()) {
  if (registry.has(def.type, def.typeVersion)) continue;
  registry.register(def);
}
const DEFAULT_LLM_CONFIG = {
  baseUrl: "$var:LLM_BASE_URL",
  apiKey: "$var:LLM_API_KEY",
  model: "$var:LLM_DEFAULT_MODEL",
  temperature: 0,
  maxTokens: 4096,
};
// Mutable so it picks up any custom node definitions merged from the
// sidecar's app manifests before the first FlowEntry is built.
let palette = registry.list();

/** Default sidecar URL — kept in sync with `StudioWorkbench`'s constant. */
const DEFAULT_SIDECAR_URL = "http://localhost:5273";
const SIDECAR_STORAGE_KEY = "anf.studio.sidecarUrl";

function readPersistedSidecarUrl(): string {
  if (typeof window === "undefined") return DEFAULT_SIDECAR_URL;
  const urlOverride = new URLSearchParams(window.location.search).get("sidecar");
  if (urlOverride && /^https?:\/\//i.test(urlOverride)) return urlOverride;
  try {
    return localStorage.getItem(SIDECAR_STORAGE_KEY) ?? DEFAULT_SIDECAR_URL;
  } catch {
    return DEFAULT_SIDECAR_URL;
  }
}

function readRequestedFlowId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("flow") ?? undefined;
}

function prioritizeRequestedFlow(flows: FlowEntry[], requestedFlowId: string | undefined): FlowEntry[] {
  if (!requestedFlowId) return flows;
  const index = flows.findIndex((flow) => flow.id === requestedFlowId);
  if (index <= 0) return flows;
  const next = [...flows];
  const [target] = next.splice(index, 1);
  if (target) next.unshift(target);
  return next;
}

interface SidecarFlowItem {
  workspace?: string;
  root?: string;
  file: string;
  graph: unknown;
}
interface SidecarFlowList {
  dir?: string;
  roots?: { name: string; abs: string }[];
  items: SidecarFlowItem[];
}

interface SidecarNodesList {
  definitions: NodeTypeDefinition[];
  packs: { name: string; nodeTypes: string[] }[];
}

/**
 * Pull every custom NodeTypeDefinition exposed by the sidecar (via
 * app manifests' `nodePacks`) and register them into the shared
 * `registry`. Returns silently when the sidecar is offline or the
 * route is missing (older sidecars), so the editor still boots with
 * just the built-in palette.
 */
async function mergeSidecarNodeDefinitions(baseUrl: string): Promise<number> {
  const url = `${baseUrl.replace(/\/+$/, "")}/studio/nodes/list`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch {
    return 0;
  }
  if (!res.ok) return 0;
  let body: SidecarNodesList;
  try {
    body = (await res.json()) as SidecarNodesList;
  } catch {
    return 0;
  }
  if (!body || !Array.isArray(body.definitions)) return 0;
  let added = 0;
  for (const def of body.definitions) {
    if (!def || typeof def.type !== "string") continue;
    if (registry.has(def.type, def.typeVersion)) continue;
    try {
      registry.register(def);
      added += 1;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[Studio] failed to register sidecar node '${def.type}': ${msg}`);
    }
  }
  return added;
}

/**
 * Split the sidecar-relative path into "folder/folder/leaf".
 * Returns `undefined` when the file sits directly at the top level so
 * `buildTree` keeps it at the root of the explorer instead of
 * inventing a synthetic group.
 *
 * In multi-workspace mode the path looks like `"<wsName>/<rest>"` so
 * the workspace name itself becomes the top-level folder — exactly
 * what the explorer needs to group flows by their workspace.
 */
function dirOf(relPath: string): string | undefined {
  const idx = relPath.lastIndexOf("/");
  if (idx < 0) return undefined;
  return relPath.slice(0, idx);
}

/** Best-effort label: prefer `graph.label`, fall back to filename. */
function deriveLabel(item: SidecarFlowItem): string {
  const graph = item.graph as Partial<FlowGraph> | undefined;
  if (graph && typeof graph.label === "string" && graph.label.trim().length > 0) {
    return graph.label;
  }
  // Strip any folder prefix and the .json suffix.
  const base = item.file.slice(item.file.lastIndexOf("/") + 1);
  return base.replace(/\.json$/i, "");
}

async function loadStarterFlowsFromSidecar(baseUrl: string): Promise<FlowEntry[] | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/studio/flows/list`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch {
    // Sidecar not reachable (offline preview, build artefact, etc.).
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as SidecarFlowList;
  if (!body || !Array.isArray(body.items)) return null;

  // If there's only a single root (legacy single-workspace setups), we
  // hide the workspace prefix from the explorer so the tree looks the
  // same as before. Multi-root setups always show the workspace name.
  const rootCount = Array.isArray(body.roots) ? body.roots.length : 1;
  const showWorkspacePrefix = rootCount > 1;

  const entries: FlowEntry[] = [];
  const seenIds = new Set<string>();
  for (const item of body.items) {
    const graph = item.graph as Partial<FlowGraph> | undefined;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.id) {
      console.warn(`[Studio] skipping malformed flow file ${item.file}`);
      continue;
    }
    const ws = item.workspace ?? "";
    // sidecarPath: the round-trip identifier the sidecar uses to read
    // the file back. In multi-root mode it MUST embed the workspace as
    // its first segment so the sidecar's `?path=` auto-split picks the
    // right root. In single-root mode we keep the legacy bare path so
    // existing flows continue to write back to the same place.
    const sidecarPath = ws ? `${ws}/${item.file}` : item.file;
    // Workbench tab/explorer label path — if multiple workspaces, group
    // by workspace name as the top-level folder; otherwise preserve the
    // legacy in-folder structure.
    const explorerRel = showWorkspacePrefix && ws ? `${ws}/${item.file}` : item.file;
    const dir = dirOf(explorerRel);
    const state: StudioState = createStudioState({
      graph: graph as FlowGraph,
      palette,
    });
    // Disambiguate ids across workspaces: two business packs may both
    // ship a `code_review_iwiki` flow, and React keys must stay unique.
    let id = graph.id;
    if (seenIds.has(id) && ws) id = `${ws}/${id}`;
    seenIds.add(id);
    const entry: FlowEntry = {
      id,
      label: deriveLabel(item),
      state,
      sidecarPath,
    };
    if (dir !== undefined) entry.path = dir;
    entries.push(entry);
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Programmatic fallback                                              */
/* ------------------------------------------------------------------ */
/**
 * The starter flows are normally served by the Sidecar from real JSON
 * files on disk so the editor can save back to them silently. These
 * builder-based factories are kept as a fallback path for cases where
 * the Sidecar isn't reachable (e.g. opening the bundled HTML preview
 * without `bun run dev:all`). Saving an in-memory fallback flow still
 * works — it just falls through to the regular Save-As dialog because
 * there's no sidecar file behind it.
 */

function buildHelloAgentFlow(): StudioState {
  const flow = defineFlow({
    id: "helloagent",
    version: "1.0.0",
    label: "Hello Agent",
    description:
      "Text input asks an agent to create a C# helloagent file on the desktop.",
    registry,
  });
  const task = flow.node("text_input", {
    id: "task_create_helloagent",
    label: "创建 helloagent 文件的任务",
    position: { x: 80, y: 160 },
    config: {
      value:
        "帮我在桌面创建一个helloagent文件，里面写上c#版本的helloagent打印代码",
    },
  });
  const agent = flow.node("agent", {
    id: "agent_create_helloagent",
    label: "HelloAgent 文件 Agent",
    position: { x: 360, y: 160 },
    config: {
      ...DEFAULT_LLM_CONFIG,
      workingDir: "",
      maxSteps: 6,
      allowBash: false,
      allowedTools: ["list_files", "read_file", "edit_file"],
      systemPrompt:
        "You are a terse file agent. Understand the user's intent, create or update files inside working_dir, read files when useful, and finish with a concise summary.",
    },
  });
  flow.connect(task.out("out"), agent.in("in"));
  flow.connect(task.out("text"), agent.in("task"));
  return createStudioState({ graph: flow.toFlowGraph(), palette });
}

function buildFanOutFlow(): StudioState {
  const flow = defineFlow({
    id: "fan_out_flow",
    version: "1.0.0",
    label: "Fan-Out Flow",
    description: "Start fans out to two parallel transforms, each into its own End.",
    registry,
  });
  const start = flow.node("start", { id: "node_start", label: "Start", position: { x: 80, y: 200 } });
  const upper = flow.node("transform", {
    id: "node_upper",
    label: "To Upper",
    position: { x: 340, y: 80 },
    config: { expression: "input.text.toUpperCase()" },
  });
  const lower = flow.node("transform", {
    id: "node_lower",
    label: "To Lower",
    position: { x: 340, y: 320 },
    config: { expression: "input.text.toLowerCase()" },
  });
  const endUpper = flow.node("end", { id: "node_end_upper", label: "End (Upper)", position: { x: 640, y: 80 } });
  const endLower = flow.node("end", { id: "node_end_lower", label: "End (Lower)", position: { x: 640, y: 320 } });
  flow.connect(start.out("out"), upper.in("in"));
  flow.connect(start.out("out"), lower.in("in"));
  flow.connect(upper.out("out"), endUpper.in("in"));
  flow.connect(lower.out("out"), endLower.in("in"));
  return createStudioState({ graph: flow.toFlowGraph(), palette });
}

function buildDraftFlow(): StudioState {
  const flow = defineFlow({
    id: "draft_flow",
    version: "0.1.0",
    label: "Draft (Empty)",
    description: "An empty canvas to scribble on.",
    registry,
  });
  flow.node("start", { id: "node_start", label: "Start", position: { x: 120, y: 200 } });
  flow.node("end",   { id: "node_end",   label: "End",   position: { x: 480, y: 200 } });
  return createStudioState({ graph: flow.toFlowGraph(), palette });
}

function buildFallbackFlows(): FlowEntry[] {
  // Keep the fallback list flat — there are no real folders behind
  // these in-memory flows, so inventing `starters/basic` etc. would be
  // misleading next to the sidecar-served tree which mirrors the real
  // `flows/` directory.
  return [
    { id: "helloagent",   label: "Hello Agent.json",  state: buildHelloAgentFlow() },
    { id: "fan_out_flow", label: "Fan-Out Flow.json", state: buildFanOutFlow() },
    { id: "draft_flow",   label: "Draft.json",        state: buildDraftFlow() },
  ];
}

interface BoundaryState {
  error: Error | null;
}

class StudioErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Studio] render error", error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          color: "#fca5a5",
          background: "#080b12",
          minHeight: "100vh",
        }}>
          <h1 style={{ color: "#e5eefc" }}>Studio crashed</h1>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.stack ?? this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; flows: FlowEntry[]; sidecarUrl: string; usedFallback: boolean };

function App() {
  const [loadState, setLoadState] = React.useState<LoadState>({ kind: "loading" });
  const requestedFlowId = React.useMemo(readRequestedFlowId, []);

  React.useEffect(() => {
    let cancelled = false;
    const sidecarUrl = readPersistedSidecarUrl();
    (async () => {
      // Phase 1: merge custom NodeTypeDefinitions exposed by the
      // sidecar (app manifests -> nodePacks). Done BEFORE loading
      // flows so the palette projection inside `createStudioState`
      // already knows about them. Failure here is non-fatal — the
      // editor still boots with the built-in palette.
      try {
        const added = await mergeSidecarNodeDefinitions(sidecarUrl);
        if (cancelled) return;
        if (added > 0) {
          palette = registry.list();
          console.info(
            `[Studio] merged ${added} custom node type(s) from sidecar.`,
          );
        }
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[Studio] node-list fetch failed: ${msg}`);
      }

      // Phase 2: load starter flows.
      const fromSidecar = await loadStarterFlowsFromSidecar(sidecarUrl);
      if (cancelled) return;
      if (fromSidecar && fromSidecar.length > 0) {
        console.info(
          `[Studio] Loaded ${fromSidecar.length} starter flow(s) from sidecar ${sidecarUrl}.`,
        );
        setLoadState({ kind: "ready", flows: fromSidecar, sidecarUrl, usedFallback: false });
        return;
      }
      console.warn(
        `[Studio] Could not load starters from sidecar at ${sidecarUrl}; ` +
        "falling back to in-memory builder flows. Save-As will prompt for a destination.",
      );
      setLoadState({
        kind: "ready",
        flows: buildFallbackFlows(),
        sidecarUrl,
        usedFallback: true,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    if (loadState.kind === "ready") {
      console.info("[Studio] Workbench ready — pick a flow or import a JSON file.");
    }
  }, [loadState.kind]);

  if (loadState.kind === "loading") {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        color: "#94a3b8",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
        background: "#080b12",
      }}>
        Loading flows…
      </div>
    );
  }

  return (
    <StudioWorkbench
      initialFlows={prioritizeRequestedFlow(loadState.flows, requestedFlowId)}
      defaultPalette={loadState.flows[0]?.state.palette}
      title="AI Native Flow Studio"
      initialSidecarUrl={loadState.sidecarUrl}
      initialActiveId={requestedFlowId}
    />
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root container is missing");
createRoot(container).render(
  <StudioErrorBoundary>
    <App />
  </StudioErrorBoundary>,
);
