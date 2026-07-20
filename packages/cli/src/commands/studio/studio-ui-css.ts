/** Kora Studio stylesheet (served at /style.css). */
export const STUDIO_CSS = `
:root {
  --bg: #0e1015; --panel: #161a22; --panel-2: #1c212c; --panel-3: #232936;
  --border: #262c3a; --text: #e6e9f0; --muted: #8b93a7;
  --accent: #4fd1c5; --accent-2: #9f7aea;
  --insert: #48bb78; --update: #4299e1; --delete: #f56565; --warn: #ed8936;
  --ok-bg: rgba(72,187,120,.12); --bad-bg: rgba(245,101,101,.12);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text); overflow: hidden;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
button {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px;
}
button:hover { border-color: var(--accent); }
button.primary { background: rgba(79,209,197,.12); border-color: var(--accent); color: var(--accent); }
button.danger { color: var(--delete); }
button:disabled { opacity: .4; cursor: default; }
input, select {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 8px; font-size: 13px;
}
input:focus, select:focus { outline: none; border-color: var(--accent); }
input[type="checkbox"] { width: auto; }
input[type="range"] { padding: 0; }

header {
  display: flex; align-items: center; gap: 14px; padding: 10px 16px;
  background: var(--panel); border-bottom: 1px solid var(--border); height: 48px;
}
header .logo { font-weight: 700; letter-spacing: .3px; white-space: nowrap; }
header .logo span { color: var(--accent); }
header .modebadge {
  font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 2px 8px;
  border-radius: 10px; background: rgba(159,122,234,.15); color: var(--accent-2);
}
header .dbpath { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
header .live { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
header .live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
header .live.on .dot { background: var(--insert); box-shadow: 0 0 8px rgba(72,187,120,.8); }

.tabs { display: flex; gap: 2px; padding: 0 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
.tabs .tab {
  padding: 8px 16px; cursor: pointer; color: var(--muted); font-size: 13px;
  border-bottom: 2px solid transparent; user-select: none;
}
.tabs .tab:hover { color: var(--text); }
.tabs .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tabs .spacer { flex: 1; }
.tabs .devicepick { display: flex; align-items: center; gap: 6px; padding: 6px 0; color: var(--muted); font-size: 12px; }

.layout { display: flex; height: calc(100vh - 85px); }
nav.sidebar {
  width: 220px; background: var(--panel); border-right: 1px solid var(--border);
  padding: 12px 0; overflow-y: auto; flex-shrink: 0;
}
nav.sidebar h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); padding: 8px 16px 4px; }
nav.sidebar .item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 16px; cursor: pointer; border-left: 2px solid transparent; font-size: 13px;
}
nav.sidebar .item:hover { background: var(--panel-2); }
nav.sidebar .item.active { border-left-color: var(--accent); background: var(--panel-2); }
nav.sidebar .item .count { color: var(--muted); font-size: 11px; }
main { flex: 1; overflow: auto; padding: 16px 20px; }

.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.toolbar h2 { font-size: 16px; margin-right: auto; }
.toolbar label { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 5px; cursor: pointer; }

table.grid { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
table.grid th, table.grid td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.grid th { background: var(--panel-2); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; position: sticky; top: 0; z-index: 1; }
table.grid tbody tr.clickable { cursor: pointer; }
table.grid tbody tr.clickable:hover { background: var(--panel-2); }
tr.tombstone td { color: var(--muted); text-decoration: line-through; }

.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.badge.insert { background: rgba(72,187,120,.15); color: var(--insert); }
.badge.update { background: rgba(66,153,225,.15); color: var(--update); }
.badge.delete { background: rgba(245,101,101,.15); color: var(--delete); }
.badge.neutral { background: var(--panel-3); color: var(--muted); }
.badge.ok { background: var(--ok-bg); color: var(--insert); }
.badge.bad { background: var(--bad-bg); color: var(--delete); }

.chip {
  display: inline-flex; gap: 6px; align-items: center; background: var(--panel-2);
  border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: var(--muted);
}
.chip b { color: var(--accent-2); font-weight: 600; }

.pager { display: flex; gap: 8px; align-items: center; margin-top: 10px; color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); padding: 40px; text-align: center; }
.error { color: var(--delete); padding: 20px; }

.drawer {
  position: fixed; top: 85px; right: 0; bottom: 0; width: 560px; max-width: 92vw;
  background: var(--panel); border-left: 1px solid var(--border); overflow-y: auto;
  padding: 16px; box-shadow: -12px 0 30px rgba(0,0,0,.45); display: none; z-index: 20;
}
.drawer.open { display: block; }
.drawer h3 { font-size: 14px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.drawer h4 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; margin: 16px 0 8px; }
.drawer .close { cursor: pointer; color: var(--muted); padding: 4px 8px; }
.fieldrow { padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; }
.fieldrow .fname { color: var(--accent); font-size: 12px; }
.fieldrow .fval { word-break: break-word; margin: 2px 0 4px; }
.fieldrow .preview { color: var(--muted); font-style: italic; }

.op { border-left: 2px solid var(--border); margin-left: 6px; padding: 6px 0 6px 14px; position: relative; }
.op::before { content: ""; position: absolute; left: -5px; top: 13px; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.op.insert::before { background: var(--insert); } .op.update::before { background: var(--update); } .op.delete::before { background: var(--delete); }
.op .meta { color: var(--muted); font-size: 11px; }
.op pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; margin-top: 4px; overflow-x: auto; }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
.panel h3 { font-size: 13px; margin-bottom: 8px; color: var(--accent); }

/* DAG */
.dagwrap { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; margin-bottom: 14px; }
.dagwrap svg { display: block; }
.dag-node { cursor: pointer; }
.dag-node circle { stroke-width: 2; }
.dag-node text { fill: var(--muted); font-size: 10px; font-family: ui-monospace, Menlo, monospace; }
.dag-edge { stroke: #3a4356; stroke-width: 1.4; fill: none; marker-end: url(#arrow); }
.dag-lane-label { fill: var(--accent-2); font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
.dag-lane-line { stroke: #1d2330; stroke-width: 1; }
.dag-tip {
  position: fixed; background: var(--panel-3); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 10px; font-size: 12px; pointer-events: none; z-index: 50; max-width: 380px; display: none;
}

/* Time travel */
.tt-controls { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.tt-controls input[type="range"] { flex: 1; }
.tt-cut { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 12px; }

/* Lab */
.lab-top { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.convergence { padding: 8px 14px; border-radius: 8px; font-weight: 600; font-size: 13px; }
.convergence.ok { background: var(--ok-bg); color: var(--insert); border: 1px solid rgba(72,187,120,.4); }
.convergence.bad { background: var(--bad-bg); color: var(--delete); border: 1px solid rgba(245,101,101,.4); }
.convergence .diffs { font-weight: 400; font-size: 11px; margin-top: 4px; color: var(--muted); }
.lab-grid { display: flex; gap: 14px; align-items: flex-start; }
.lab-devices { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(390px, 1fr)); gap: 14px; }
.device-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.device-card.offline { border-color: rgba(245,101,101,.35); }
.device-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--panel-2); }
.device-head .name { font-weight: 700; }
.device-head .node { color: var(--muted); font-size: 11px; }
.device-head .spacer { flex: 1; }
.device-body { padding: 10px 12px; }
.device-body h5 { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; margin: 10px 0 6px; }
.chaos-row { display: grid; grid-template-columns: 78px 1fr 44px; gap: 6px; align-items: center; font-size: 11px; color: var(--muted); margin-bottom: 3px; }
.rec-line { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-bottom: 1px solid var(--border); font-size: 12px; flex-wrap: wrap; }
.rec-line:hover { background: var(--panel-2); }
.rec-line .title { flex: 1; min-width: 120px; }
.rec-line input[type="text"] { font-size: 12px; padding: 2px 6px; width: 130px; }
.rec-line .pts { color: var(--accent); min-width: 30px; text-align: right; }
.insert-form { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.insert-form input { flex: 1; min-width: 120px; }
.lab-feed { width: 360px; flex-shrink: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; max-height: calc(100vh - 200px); }
.lab-feed h3 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.lab-feed .feed { overflow-y: auto; padding: 6px 0; flex: 1; }
.feed-line { display: flex; gap: 8px; padding: 3px 12px; font-size: 11px; align-items: baseline; }
.feed-line .dev { min-width: 66px; font-weight: 600; }
.feed-line .what { color: var(--muted); }
.feed-line.evt-created .what, .feed-line.evt-applied .what { color: var(--text); }
.feed-line.evt-conflict .what { color: var(--warn); }
.feed-line.evt-failed .what { color: var(--delete); font-weight: 700; }
.dev-c0 { color: #4fd1c5; } .dev-c1 { color: #9f7aea; } .dev-c2 { color: #f6ad55; }
.dev-c3 { color: #63b3ed; } .dev-c4 { color: #f687b3; } .dev-c5 { color: #68d391; }
`
