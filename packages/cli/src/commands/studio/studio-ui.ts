/**
 * Kora Studio HTML shell (served at /). The stylesheet and application are
 * served as separate routes so each stays an editable module; everything is
 * still fully self-contained — no CDN, no build step, works offline.
 */
export const STUDIO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kora Studio</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<header>
  <div class="logo">kora <span>studio</span></div>
  <div class="modebadge" id="modebadge"></div>
  <div class="dbpath mono" id="dbpath"></div>
  <div class="live" id="live"><div class="dot"></div><span>live</span></div>
  <button id="refresh">Refresh</button>
</header>
<div class="tabs" id="tabs"></div>
<div class="layout">
  <nav class="sidebar" id="sidebar"></nav>
  <main id="main"><div class="empty">Loading…</div></main>
</div>
<div class="drawer" id="drawer"></div>
<div class="dag-tip" id="dagtip"></div>
<script src="/app.js"></script>
</body>
</html>
`
