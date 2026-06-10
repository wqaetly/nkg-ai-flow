import type { StudioRenderOptions, StudioTimelineItem, StudioViewModel } from "./types.js";

export function renderStudioShell(viewModel: StudioViewModel, options: StudioRenderOptions = {}): string {
  const title = escapeHtml(options.title ?? viewModel.flow.label ?? viewModel.flow.id);
  const subtitle = escapeHtml(options.subtitle ?? "Graph editing · Run timeline · Trace viewer · Stream inspector");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>${studioDarkFlatCss}</style>
</head>
<body>
  <main class="studio-shell">
    <header class="studio-header card">
      <div>
        <p class="eyebrow">AI Native Flow Studio</p>
        <h1>${title}</h1>
        <p>${subtitle}</p>
      </div>
      <div class="status-pill ${viewModel.validation.ok ? "ok" : "error"}">${viewModel.validation.ok ? "Valid graph" : `${viewModel.validation.errors.length} issue(s)`}</div>
    </header>

    <section class="studio-grid">
      <aside class="card palette-panel">
        <div class="panel-title">Node Palette</div>
        ${viewModel.palette.map((item) => `
          <article class="palette-item">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.type)}@${escapeHtml(item.typeVersion)}</span>
          </article>`).join("") || emptyState("No node types registered")}
      </aside>

      <section class="card canvas-panel">
        <div class="panel-title">Flow Canvas</div>
        <div class="canvas-stage">
          ${viewModel.edges.map((edge) => `<div class="edge-chip">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</div>`).join("")}
          ${viewModel.nodes.map((node) => `
            <article class="flow-node ${node.status ?? "idle"}" style="left:${node.position.x}px;top:${node.position.y}px;width:${node.size.width}px;min-height:${node.size.height}px">
              <div class="node-head">
                <strong>${escapeHtml(node.label)}</strong>
                <span>${escapeHtml(node.type)}</span>
              </div>
              <div class="ports">
                <div>${node.inputs.map((port) => portBadge(port.label ?? port.id, "in")).join("")}</div>
                <div>${node.outputs.map((port) => portBadge(port.label ?? port.id, "out")).join("")}</div>
              </div>
            </article>`).join("")}
        </div>
      </section>

      <aside class="card inspector-panel">
        <div class="panel-title">Property Panel</div>
        ${renderSelection(viewModel)}
        <div class="panel-title spaced">Graph Validation</div>
        ${renderValidation(viewModel)}
      </aside>
    </section>

    <section class="bottom-grid">
      <article class="card">
        <div class="panel-title">Run Timeline</div>
        <div class="timeline">${viewModel.runTimeline.slice(-8).map(renderTimelineItem).join("") || emptyState("No run events yet")}</div>
      </article>
      <article class="card">
        <div class="panel-title">Trace Viewer</div>
        <div class="metric-grid">
          ${metric("Events", viewModel.traceViewer.eventCount)}
          ${metric("Nodes", viewModel.traceViewer.nodeCount)}
          ${metric("Streams", viewModel.traceViewer.streamCount)}
          ${metric("Errors", viewModel.traceViewer.errorCount)}
        </div>
      </article>
      <article class="card">
        <div class="panel-title">Stream Inspector</div>
        <pre class="stream-replay">${escapeHtml(viewModel.streamInspector.replayText || "No stream deltas captured")}</pre>
        <span class="muted">${viewModel.streamInspector.frames.length} frame(s), ${viewModel.streamInspector.artifacts.length} artifact(s)</span>
      </article>
    </section>
  </main>
</body>
</html>`;
}

function renderSelection(viewModel: StudioViewModel): string {
  if (viewModel.selectedNodeId) {
    const node = viewModel.nodes.find((item) => item.id === viewModel.selectedNodeId);
    if (node) {
      return `<div class="selection-card"><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.type)} · ${escapeHtml(node.status ?? "idle")}</span></div>`;
    }
  }
  if (viewModel.selectedEdgeId) {
    const edge = viewModel.edges.find((item) => item.id === viewModel.selectedEdgeId);
    if (edge) {
      return `<div class="selection-card"><strong>${escapeHtml(edge.id)}</strong><span>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span></div>`;
    }
  }
  return emptyState("Select a node or edge to inspect") ;
}

function renderValidation(viewModel: StudioViewModel): string {
  if (viewModel.validation.ok) return `<div class="validation-ok">No validation errors</div>`;
  return viewModel.validation.errors.map((error) => `<div class="validation-error"><strong>${escapeHtml(error.code)}</strong><span>${escapeHtml(error.message)}</span></div>`).join("");
}

function renderTimelineItem(item: StudioTimelineItem): string {
  return `<div class="timeline-row ${item.severity}"><span>${escapeHtml(item.timestamp)}</span><strong>${escapeHtml(item.label)}</strong></div>`;
}

function metric(label: string, value: number): string {
  return `<div class="metric"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

function portBadge(label: string, side: "in" | "out"): string {
  return `<span class="port ${side}">${escapeHtml(label)}</span>`;
}

function emptyState(text: string): string {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const studioDarkFlatCss = `
:root {
  color-scheme: dark;
  --bg: #080b12;
  --surface: #101622;
  --surface-2: #151d2b;
  --line: #253044;
  --text: #edf2ff;
  --muted: #8d9ab1;
  --accent: #66e3ff;
  --accent-2: #8b7dff;
  --ok: #4ade80;
  --warning: #facc15;
  --error: #fb7185;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.studio-shell { padding: 24px; display: grid; gap: 18px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; box-shadow: none; }
.studio-header { padding: 24px; display: flex; align-items: center; justify-content: space-between; }
.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .16em; font-size: 12px; margin: 0 0 10px; }
h1 { margin: 0 0 8px; font-size: 30px; }
p { color: var(--muted); margin: 0; }
.status-pill { padding: 10px 14px; border-radius: 999px; background: var(--surface-2); color: var(--muted); font-weight: 700; }
.status-pill.ok { color: var(--ok); }
.status-pill.error { color: var(--error); }
.studio-grid { display: grid; grid-template-columns: 260px minmax(520px, 1fr) 300px; gap: 18px; min-height: 520px; }
.bottom-grid { display: grid; grid-template-columns: 1.15fr .85fr 1fr; gap: 18px; }
.palette-panel, .canvas-panel, .inspector-panel, .bottom-grid .card { padding: 18px; }
.panel-title { color: var(--text); font-weight: 800; margin-bottom: 14px; }
.panel-title.spaced { margin-top: 24px; }
.palette-item, .selection-card, .validation-error, .validation-ok, .timeline-row, .metric, .empty-state {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
}
.palette-item { display: grid; gap: 4px; margin-bottom: 10px; }
.palette-item span, .selection-card span, .muted { color: var(--muted); font-size: 12px; }
.canvas-stage { position: relative; min-height: 460px; overflow: hidden; border-radius: 16px; background: #0b101a; border: 1px solid var(--line); }
.canvas-stage::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 32px 32px;
  opacity: .22;
}
.flow-node { position: absolute; z-index: 1; padding: 14px; border-radius: 16px; background: var(--surface-2); border: 1px solid var(--line); }
.flow-node.running, .flow-node.streaming { border-color: var(--accent); }
.flow-node.succeeded { border-color: var(--ok); }
.flow-node.failed { border-color: var(--error); }
.node-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.node-head span { color: var(--muted); font-size: 12px; }
.ports { display: flex; justify-content: space-between; gap: 10px; }
.port { display: block; width: fit-content; margin-bottom: 6px; padding: 5px 8px; border-radius: 999px; font-size: 11px; color: var(--text); background: #202a3b; }
.port.in { border-left: 3px solid var(--accent-2); }
.port.out { border-right: 3px solid var(--accent); }
.edge-chip { position: relative; z-index: 1; display: inline-block; margin: 10px 0 0 10px; padding: 7px 10px; border-radius: 999px; background: #1b2636; color: var(--muted); font-size: 12px; }
.validation-ok { color: var(--ok); }
.validation-error { display: grid; gap: 4px; margin-bottom: 10px; color: var(--error); }
.timeline { display: grid; gap: 8px; }
.timeline-row { display: grid; gap: 4px; }
.timeline-row span { color: var(--muted); font-size: 11px; }
.timeline-row.success { border-color: color-mix(in srgb, var(--ok), var(--line) 50%); }
.timeline-row.error { border-color: color-mix(in srgb, var(--error), var(--line) 50%); }
.timeline-row.stream { border-color: color-mix(in srgb, var(--accent), var(--line) 50%); }
.metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.metric strong { display: block; font-size: 28px; }
.metric span { color: var(--muted); }
.stream-replay { min-height: 120px; margin: 0 0 10px; padding: 14px; white-space: pre-wrap; border-radius: 14px; color: var(--text); background: #080c14; border: 1px solid var(--line); }
@media (max-width: 1100px) { .studio-grid, .bottom-grid { grid-template-columns: 1fr; } .canvas-stage { min-height: 560px; } }
`;
