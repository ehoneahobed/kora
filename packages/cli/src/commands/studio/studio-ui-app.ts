/** Kora Studio application (served at /app.js). Vanilla DOM, zero dependencies. */
export const STUDIO_APP_JS = `
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  var state = {
    mode: 'file',            // 'file' | 'lab'
    tab: 'data',             // data | ops | timetravel | merges | sync | lab
    device: null,            // selected lab device for data-ish tabs
    devices: [],
    collection: null,
    page: 0,
    includeDeleted: false,
    search: '',
    overview: null,
    ttPosition: null,        // time-travel slider position
    ttPlaying: null,
    labState: null,
    feed: [],
    deviceColors: {},
    live: false
  };
  var PAGE = 50;
  var refreshTimer = null;

  // ── Utilities ──────────────────────────────────────────────────────────────
  function qs(sel) { return document.querySelector(sel); }
  function api(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    var url = state.device ? path + sep + 'device=' + encodeURIComponent(state.device) : path;
    return fetch(url).then(function (r) {
      if (!r.ok) { return r.json().then(function (b) { throw new Error(b.error || r.statusText); }); }
      return r.json();
    });
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) { return r.json().then(function (b) { throw new Error(b.error || r.statusText); }); }
      return r.json();
    });
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }); }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function fmtTime(ms) {
    if (!ms) return '·';
    var d = new Date(ms);
    return d.toLocaleTimeString() + '.' + ('00' + d.getMilliseconds()).slice(-3);
  }
  function fmtDateTime(ms) {
    if (!ms) return '·';
    var d = new Date(ms);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }
  function shortNode(id) { return id && id.length > 8 ? id.slice(-8) : (id || '·'); }
  function shortId(id) { return id && id.length > 13 ? id.slice(0, 13) + '…' : (id || ''); }
  function fmtVal(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function deviceColor(name) {
    if (!(name in state.deviceColors)) {
      state.deviceColors[name] = 'dev-c' + (Object.keys(state.deviceColors).length % 6);
    }
    return state.deviceColors[name];
  }
  function debounceRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { render(false); }, 250);
  }

  // ── Boot + live events ─────────────────────────────────────────────────────
  fetch('/api/mode').then(function (r) { return r.json(); }).then(function (info) {
    state.mode = info.mode;
    state.devices = info.devices || [];
    if (state.mode === 'lab') { state.tab = 'lab'; state.device = state.devices[0] || null; }
    qs('#modebadge').textContent = state.mode;
    if (info.spectator) {
      qs('#dbpath').textContent = '⇄ ' + info.spectator.url +
        (info.spectator.connected ? ' · connected' : ' · connecting…') +
        ' · ' + info.spectator.operationsReceived + ' ops received';
    }
    connectEvents();
    render(true);
  });

  function connectEvents() {
    var source = new EventSource('/api/events');
    source.addEventListener('hello', function () {
      state.live = true; qs('#live').className = 'live on';
    });
    source.addEventListener('change', function () {
      if (state.tab !== 'timetravel') debounceRefresh();
    });
    source.addEventListener('lab', function (event) {
      var data = JSON.parse(event.data);
      state.feed.push(data);
      if (state.feed.length > 400) state.feed.shift();
      appendFeedLine(data);
    });
    source.addEventListener('spectator', function (event) {
      var data = JSON.parse(event.data);
      data.device = 'server';
      state.feed.push(data);
      if (state.feed.length > 400) state.feed.shift();
      appendFeedLine(data);
      // Keep the header status fresh as ops stream in.
      fetch('/api/spectator/status').then(function (r) { return r.json(); }).then(function (s) {
        qs('#dbpath').textContent = '⇄ ' + s.url +
          (s.connected ? ' · connected' : ' · reconnecting…') +
          ' · ' + s.operationsReceived + ' ops received';
      }).catch(function () {});
    });
    source.onerror = function () {
      state.live = false; qs('#live').className = 'live';
    };
  }

  // ── Tabs + chrome ──────────────────────────────────────────────────────────
  function renderTabs() {
    var tabs = qs('#tabs');
    tabs.textContent = '';
    var defs = [];
    if (state.mode === 'lab') defs.push(['lab', 'Lab']);
    defs.push(['data', 'Data'], ['ops', 'Operations'], ['timetravel', 'Time Travel'], ['merges', 'Merges'], ['sync', 'Sync']);
    defs.forEach(function (d) {
      tabs.appendChild(el('div', {
        class: 'tab' + (state.tab === d[0] ? ' active' : ''),
        text: d[1],
        onclick: function () { state.tab = d[0]; state.page = 0; closeDrawer(); render(true); }
      }));
    });
    tabs.appendChild(el('div', { class: 'spacer' }));
    if (state.mode === 'lab' && state.tab !== 'lab') {
      var pick = el('select', { onchange: function () { state.device = pick.value; state.page = 0; render(true); } },
        state.devices.map(function (d) {
          var o = el('option', { value: d, text: d });
          if (d === state.device) o.selected = true;
          return o;
        }));
      tabs.appendChild(el('div', { class: 'devicepick' }, [el('span', { text: 'device:' }), pick]));
    }
  }

  function renderSidebar() {
    var nav = qs('#sidebar');
    nav.textContent = '';
    if (state.tab === 'lab' || state.tab === 'sync' || state.tab === 'merges') {
      nav.style.display = 'none';
      return;
    }
    nav.style.display = '';
    nav.appendChild(el('h3', { text: 'Collections' }));
    (state.overview ? state.overview.collections : []).forEach(function (c) {
      nav.appendChild(el('div', {
        class: 'item' + (state.collection === c.name ? ' active' : ''),
        onclick: function () { state.collection = c.name; state.page = 0; closeDrawer(); render(false); }
      }, [
        el('span', { text: c.name }),
        el('span', { class: 'count', text: String(c.liveRecords) + (c.tombstones ? ' +' + c.tombstones + '†' : '') })
      ]));
    });
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function render(full) {
    renderTabs();
    if (state.tab === 'lab') { renderSidebar(); renderLab(full); return; }
    api('/api/overview').then(function (overview) {
      state.overview = overview;
      qs('#dbpath').textContent = overview.dbPath || '';
      if (!state.collection || !overview.collections.some(function (c) { return c.name === state.collection; })) {
        state.collection = overview.collections.length ? overview.collections[0].name : null;
      }
      renderSidebar();
      var main = qs('#main');
      main.textContent = '';
      if (state.tab === 'data') return renderData(main);
      if (state.tab === 'ops') return renderOps(main);
      if (state.tab === 'timetravel') return renderTimeTravel(main);
      if (state.tab === 'merges') return renderMerges(main);
      if (state.tab === 'sync') return renderSync(main);
    }).catch(function (e) {
      qs('#main').innerHTML = '<div class="error">' + e.message + '</div>';
    });
  }

  function toolbar(main, title, extra) {
    main.appendChild(el('div', { class: 'toolbar' }, [el('h2', { text: title })].concat(extra || [])));
  }
  function pager(main, total) {
    var pages = Math.max(1, Math.ceil(total / PAGE));
    main.appendChild(el('div', { class: 'pager' }, [
      el('button', { text: '‹ Prev', onclick: function () { if (state.page > 0) { state.page--; render(false); } } }),
      el('span', { text: 'page ' + (state.page + 1) + ' / ' + pages + ' · ' + total + ' total' }),
      el('button', { text: 'Next ›', onclick: function () { if (state.page < pages - 1) { state.page++; render(false); } } })
    ]));
  }

  // ── Data tab ───────────────────────────────────────────────────────────────
  function renderData(main) {
    if (!state.collection) { main.appendChild(el('div', { class: 'empty', text: 'No collections.' })); return; }
    var searchBox = el('input', { type: 'text', placeholder: 'search…', value: state.search });
    searchBox.oninput = function () { state.search = searchBox.value; state.page = 0; debounceRefresh(); };
    var deletedToggle = el('label', {}, [
      (function () { var cb = el('input', { type: 'checkbox' }); cb.checked = state.includeDeleted;
        cb.onchange = function () { state.includeDeleted = cb.checked; state.page = 0; render(false); }; return cb; })(),
      el('span', { text: 'tombstones' })
    ]);
    toolbar(main, state.collection, [searchBox, deletedToggle]);

    var q = '/api/collections/' + state.collection + '/records?limit=' + PAGE +
      '&offset=' + (state.page * PAGE) + '&includeDeleted=' + state.includeDeleted +
      (state.search ? '&search=' + encodeURIComponent(state.search) : '');
    api(q).then(function (data) {
      var info = state.overview.collections.filter(function (c) { return c.name === state.collection; })[0];
      var columns = info ? info.columns : [];
      if (!data.records.length) { main.appendChild(el('div', { class: 'empty', text: 'No records.' })); return; }
      var thead = el('tr', {}, [el('th', { text: 'id' })].concat(
        columns.map(function (c) { return el('th', { text: c }); }),
        [el('th', { text: 'updated' })]
      ));
      var tbody = el('tbody', {}, data.records.map(function (r) {
        return el('tr', { class: 'clickable' + (r.deleted ? ' tombstone' : ''), onclick: function () { openRecord(r.id); } },
          [el('td', { class: 'mono', text: shortId(r.id) })].concat(
            columns.map(function (c) { return el('td', { text: fmtVal(r.fields[c]).slice(0, 60) }); }),
            [el('td', { class: 'mono', text: fmtDateTime(r.updatedAt) })]
          ));
      }));
      main.appendChild(el('table', { class: 'grid' }, [el('thead', {}, [thead]), tbody]));
      pager(main, data.total);
    }).catch(showError(main));
  }

  // ── Record drawer ──────────────────────────────────────────────────────────
  function openRecord(id) {
    api('/api/collections/' + state.collection + '/records/' + encodeURIComponent(id)).then(function (data) {
      var drawer = qs('#drawer');
      drawer.textContent = '';
      var r = data.record;
      drawer.appendChild(el('h3', {}, [
        el('span', { class: 'mono', text: r.id }),
        el('span', { class: 'close', text: '✕', onclick: closeDrawer })
      ]));
      if (r.deleted) drawer.appendChild(el('span', { class: 'badge delete', text: 'tombstone' }));

      drawer.appendChild(el('h4', { text: 'Fields — with last writer per field' }));
      Object.keys(r.fields).forEach(function (f) {
        var fv = r.fieldVersions[f];
        var val = fmtVal(r.fields[f]);
        var preview = data.richtextPreviews && data.richtextPreviews[f];
        drawer.appendChild(el('div', { class: 'fieldrow' }, [
          el('div', { class: 'fname mono', text: f }),
          el('div', { class: 'fval', text: val }),
          preview ? el('div', { class: 'preview', text: '“' + preview + '”' }) : null,
          fv ? el('span', { class: 'chip' }, [
            el('span', { text: 'last writer' }),
            el('b', { class: 'mono', text: shortNode(fv.nodeId) }),
            el('span', { class: 'mono', text: fmtDateTime(fv.wallTime) })
          ]) : el('span', { class: 'chip', text: 'no field version' })
        ]));
      });

      drawer.appendChild(el('h4', { text: 'Causal graph for this record' }));
      var dagBox = el('div', { class: 'dagwrap' });
      drawer.appendChild(dagBox);
      api('/api/collections/' + state.collection + '/dag?record=' + encodeURIComponent(id)).then(function (dag) {
        renderDag(dagBox, dag, 500);
      });

      drawer.appendChild(el('h4', { text: 'Operation history (newest first)' }));
      if (!data.operations.length) drawer.appendChild(el('div', { class: 'empty', text: 'No operations (compacted?).' }));
      data.operations.forEach(function (o) {
        var body = el('div', { class: 'op ' + o.type }, [
          el('div', {}, [
            el('span', { class: 'badge ' + o.type, text: o.type }),
            el('span', { class: 'meta', text: '  ' + shortNode(o.nodeId) + ' · seq ' + o.sequenceNumber + ' · ' + (o.timestamp ? fmtDateTime(o.timestamp.wallTime) : '·') })
          ])
        ]);
        if (o.data) {
          var pre = el('pre', { class: 'mono' });
          pre.textContent = JSON.stringify(o.data, null, 1);
          body.appendChild(pre);
        }
        drawer.appendChild(body);
      });
      drawer.className = 'drawer open';
    }).catch(function (e) { alertError(e); });
  }
  function closeDrawer() { qs('#drawer').className = 'drawer'; }

  // ── Operations tab (DAG + table) ───────────────────────────────────────────
  function renderOps(main) {
    if (!state.collection) { main.appendChild(el('div', { class: 'empty', text: 'No collections.' })); return; }
    toolbar(main, state.collection + ' — operation log');
    var dagBox = el('div', { class: 'dagwrap' });
    main.appendChild(dagBox);
    api('/api/collections/' + state.collection + '/dag?limit=120').then(function (dag) {
      renderDag(dagBox, dag, null);
    });

    api('/api/collections/' + state.collection + '/ops?limit=' + PAGE + '&offset=' + (state.page * PAGE)).then(function (data) {
      if (!data.operations.length) { main.appendChild(el('div', { class: 'empty', text: 'Empty (compacted?).' })); return; }
      var thead = el('tr', {}, ['type', 'record', 'node', 'seq', 'time', 'data'].map(function (h) { return el('th', { text: h }); }));
      var tbody = el('tbody', {}, data.operations.map(function (o) {
        return el('tr', { class: 'clickable', onclick: function () { openRecord(o.recordId); } }, [
          el('td', {}, [el('span', { class: 'badge ' + o.type, text: o.type })]),
          el('td', { class: 'mono', text: shortId(o.recordId) }),
          el('td', { class: 'mono', text: shortNode(o.nodeId) }),
          el('td', { class: 'mono', text: String(o.sequenceNumber) }),
          el('td', { class: 'mono', text: o.timestamp ? fmtDateTime(o.timestamp.wallTime) : '·' }),
          el('td', { class: 'mono', text: o.data ? JSON.stringify(o.data).slice(0, 70) : '·' })
        ]);
      }));
      main.appendChild(el('table', { class: 'grid' }, [el('thead', {}, [thead]), tbody]));
      pager(main, data.total);
    }).catch(showError(main));
  }

  // ── Causal DAG renderer (SVG) ──────────────────────────────────────────────
  function renderDag(container, dag, maxWidth) {
    container.textContent = '';
    if (!dag.nodes.length) { container.appendChild(el('div', { class: 'empty', text: 'No operations to graph.' })); return; }
    var XSTEP = 46, YSTEP = 44, PADX = 90, PADY = 26, R = 7;
    var width = PADX + dag.nodes.length * XSTEP + 30;
    var height = PADY + dag.lanes.length * YSTEP + 16;
    var svgns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgns, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    var defs = document.createElementNS(svgns, 'defs');
    defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3a4356"/></marker>';
    svg.appendChild(defs);

    var colors = { insert: '#48bb78', update: '#4299e1', delete: '#f56565' };
    var pos = {};
    dag.nodes.forEach(function (n) {
      pos[n.id] = { x: PADX + n.x * XSTEP, y: PADY + n.lane * YSTEP + YSTEP / 2 };
    });

    dag.lanes.forEach(function (lane, i) {
      var y = PADY + i * YSTEP + YSTEP / 2;
      var line = document.createElementNS(svgns, 'line');
      line.setAttribute('x1', '10'); line.setAttribute('x2', String(width - 10));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('class', 'dag-lane-line');
      svg.appendChild(line);
      var label = document.createElementNS(svgns, 'text');
      label.setAttribute('x', '10'); label.setAttribute('y', String(y - 8));
      label.setAttribute('class', 'dag-lane-label');
      label.textContent = lane.shortNodeId;
      svg.appendChild(label);
    });

    dag.edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var path = document.createElementNS(svgns, 'path');
      var midX = (a.x + b.x) / 2;
      path.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + midX + ' ' + a.y + ', ' + midX + ' ' + b.y + ', ' + (b.x - R - 2) + ' ' + b.y);
      path.setAttribute('class', 'dag-edge');
      svg.appendChild(path);
    });

    var tip = qs('#dagtip');
    dag.nodes.forEach(function (n) {
      var g = document.createElementNS(svgns, 'g');
      g.setAttribute('class', 'dag-node');
      var c = document.createElementNS(svgns, 'circle');
      var p = pos[n.id];
      c.setAttribute('cx', String(p.x)); c.setAttribute('cy', String(p.y)); c.setAttribute('r', String(R));
      c.setAttribute('fill', '#161a22');
      c.setAttribute('stroke', colors[n.type] || '#8b93a7');
      g.appendChild(c);
      g.addEventListener('mousemove', function (ev) {
        tip.style.display = 'block';
        tip.style.left = (ev.clientX + 14) + 'px';
        tip.style.top = (ev.clientY + 14) + 'px';
        tip.innerHTML = '<b>' + n.type + '</b> by ' + n.shortNodeId + ' · seq ' + n.sequenceNumber +
          '<br/>record ' + shortId(n.recordId) +
          (n.dataPreview ? '<br/><span class="mono">' + escapeHtml(n.dataPreview) + '</span>' : '');
      });
      g.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
      g.addEventListener('click', function () { openRecord(n.recordId); });
      svg.appendChild(g);
    });

    if (maxWidth) container.style.maxWidth = maxWidth + 'px';
    container.appendChild(svg);
    container.scrollLeft = width;
  }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Time travel tab ────────────────────────────────────────────────────────
  function renderTimeTravel(main) {
    if (!state.collection) { main.appendChild(el('div', { class: 'empty', text: 'No collections.' })); return; }
    toolbar(main, state.collection + ' — time travel');
    api('/api/collections/' + state.collection + '/replay').then(function (full) {
      var total = full.totalCount;
      if (!total) { main.appendChild(el('div', { class: 'empty', text: 'No operations to replay.' })); return; }
      if (state.ttPosition === null || state.ttPosition > total) state.ttPosition = total;

      var posLabel = el('span', { class: 'mono', text: '' });
      var slider = el('input', { type: 'range', min: '1', max: String(total), value: String(state.ttPosition) });
      var playBtn = el('button', { text: '▶ replay' });
      var cutBox = el('div', { class: 'tt-cut mono' });
      var stateBox = el('div', {});

      function show(position) {
        state.ttPosition = position;
        posLabel.textContent = position + ' / ' + total + ' ops';
        api('/api/collections/' + state.collection + '/replay?upTo=' + encodeURIComponent(opIdAt(position))).then(function (cut) {
          var o = cut.cutOperation;
          cutBox.innerHTML = o
            ? 'cut at <b>' + o.type + '</b> by ' + shortNode(o.nodeId) + ' · ' + (o.timestamp ? fmtDateTime(o.timestamp.wallTime) : '') +
              (o.data ? ' · ' + escapeHtml(JSON.stringify(o.data).slice(0, 90)) : '')
            : '';
          renderReplayState(stateBox, cut);
        });
      }
      // The full replay result orders ops by HLC; fetch the ordered id list once.
      var orderedIds = [];
      api('/api/collections/' + state.collection + '/dag?limit=20000').then(function (dag) {
        orderedIds = dag.nodes.map(function (n) { return n.id; });
        show(Math.min(state.ttPosition, orderedIds.length));
      });
      function opIdAt(position) { return orderedIds[position - 1]; }

      slider.oninput = function () { show(Number(slider.value)); };
      playBtn.onclick = function () {
        if (state.ttPlaying) { clearInterval(state.ttPlaying); state.ttPlaying = null; playBtn.textContent = '▶ replay'; return; }
        var pos = 1;
        playBtn.textContent = '⏸ pause';
        state.ttPlaying = setInterval(function () {
          if (pos > orderedIds.length) { clearInterval(state.ttPlaying); state.ttPlaying = null; playBtn.textContent = '▶ replay'; return; }
          slider.value = String(pos);
          show(pos);
          pos++;
        }, 350);
      };

      main.appendChild(el('div', { class: 'tt-controls' }, [playBtn, slider, posLabel]));
      main.appendChild(cutBox);
      main.appendChild(stateBox);
    }).catch(showError(main));
  }

  function renderReplayState(box, cut) {
    box.textContent = '';
    if (!cut.records.length) { box.appendChild(el('div', { class: 'empty', text: 'No records at this point.' })); return; }
    var fieldSet = {};
    cut.records.forEach(function (r) { Object.keys(r.fields).forEach(function (f) { fieldSet[f] = true; }); });
    var fields = Object.keys(fieldSet);
    var thead = el('tr', {}, [el('th', { text: 'id' })].concat(fields.map(function (f) { return el('th', { text: f }); })));
    var tbody = el('tbody', {}, cut.records.map(function (r) {
      return el('tr', { class: r.deleted ? 'tombstone' : '' },
        [el('td', { class: 'mono', text: shortId(r.id) })].concat(fields.map(function (f) {
          return el('td', { text: r.fields[f] === undefined ? '' : fmtVal(r.fields[f]).slice(0, 40) });
        })));
    }));
    box.appendChild(el('table', { class: 'grid' }, [el('thead', {}, [thead]), tbody]));
  }

  // ── Merges tab ─────────────────────────────────────────────────────────────
  function renderMerges(main) {
    toolbar(main, 'Merge audit trail');
    api('/api/audit?limit=200').then(function (data) {
      if (!data.traces.length) { main.appendChild(el('div', { class: 'empty', text: 'No merge audit traces recorded.' })); return; }
      var thead = el('tr', {}, ['when', 'event', 'collection', 'record', 'field', 'strategy', 'tier'].map(function (h) { return el('th', { text: h }); }));
      var tbody = el('tbody', {}, data.traces.map(function (t) {
        return el('tr', {}, [
          el('td', { class: 'mono', text: fmtDateTime(t.recordedAt) }),
          el('td', { text: t.eventType }),
          el('td', { text: t.collection }),
          el('td', { class: 'mono', text: shortId(t.recordId) }),
          el('td', { text: t.field }),
          el('td', { text: t.strategy }),
          el('td', { text: String(t.tier) })
        ]);
      }));
      main.appendChild(el('table', { class: 'grid' }, [el('thead', {}, [thead]), tbody]));
    }).catch(showError(main));
  }

  // ── Sync tab ───────────────────────────────────────────────────────────────
  function renderSync(main) {
    toolbar(main, 'Sync state' + (state.device ? ' — ' + state.device : ''));
    var o = state.overview;
    main.appendChild(el('div', { class: 'panel' }, [
      el('h3', { text: 'Version vector — what this store has seen from each node' }),
      el('table', { class: 'grid' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: 'node' }), el('th', { text: 'max sequence' })])]),
        el('tbody', {}, o.versionVector.map(function (v) {
          return el('tr', {}, [el('td', { class: 'mono', text: v.nodeId }), el('td', { class: 'mono', text: String(v.sequenceNumber) })]);
        }))
      ])
    ]));
    main.appendChild(el('div', { class: 'panel' }, [
      el('h3', { text: 'Outbound queue' }),
      el('div', { text: o.pendingSyncOps + ' operation(s) waiting to sync' })
    ]));
    main.appendChild(el('div', { class: 'panel' }, [
      el('h3', { text: 'Store meta' }),
      el('table', { class: 'grid' }, [
        el('tbody', {}, o.meta.map(function (m) {
          return el('tr', {}, [el('td', { class: 'mono', text: m.key }), el('td', { class: 'mono', text: m.value })]);
        }))
      ])
    ]));
    if (state.mode === 'spectator') {
      var feedBox = el('div', { class: 'lab-feed', style: 'width:100%;max-height:340px' }, [
        el('h3', { text: 'Live events from the server' }),
        el('div', { class: 'feed', id: 'feed' })
      ]);
      main.appendChild(feedBox);
      state.feed.slice(-200).forEach(appendFeedLine);
    }
  }

  // ── Lab tab ────────────────────────────────────────────────────────────────
  function renderLab(full) {
    var main = qs('#main');
    qs('#sidebar').style.display = 'none';
    Promise.all([fetch('/api/lab/state').then(function (r) { return r.json(); }),
                 fetch('/api/lab/convergence').then(function (r) { return r.json(); })])
      .then(function (results) {
        state.labState = results[0];
        state.devices = results[0].devices.map(function (d) { return d.name; });
        var convergence = results[1];
        main.textContent = '';
        qs('#dbpath').textContent = 'sync laboratory · ' + results[0].serverOperations + ' ops on server';

        var conv = el('div', { class: 'convergence ' + (convergence.converged ? 'ok' : 'bad') }, [
          el('div', { text: convergence.converged
            ? '✓ ALL ' + convergence.deviceCount + ' DEVICES CONVERGED'
            : '✗ DEVICES DIVERGED (' + convergence.differences.length + ' difference(s)) — sync to converge' })
        ]);
        if (!convergence.converged) {
          conv.appendChild(el('div', { class: 'diffs', text: convergence.differences.slice(0, 4).join(' · ') }));
        }
        var addBtn = el('button', { class: 'primary', text: '+ add device', onclick: function () {
          post('/api/lab/devices', {}).then(function () { render(true); }).catch(alertError);
        } });
        var syncAllBtn = el('button', { text: 'sync all', onclick: function () {
          var chain = Promise.resolve();
          state.devices.forEach(function (d) { chain = chain.then(function () { return post('/api/lab/devices/' + d + '/sync', {}); }); });
          chain.then(function () { return post('/api/lab/devices/' + state.devices[0] + '/sync', {}); })
               .then(function () { render(true); }).catch(alertError);
        } });
        main.appendChild(el('div', { class: 'lab-top' }, [conv, addBtn, syncAllBtn]));

        var devicesBox = el('div', { class: 'lab-devices' });
        results[0].devices.forEach(function (d) { devicesBox.appendChild(deviceCard(d, results[0].collections)); });

        var feedBox = el('div', { class: 'lab-feed' }, [
          el('h3', { text: 'Live events' }),
          el('div', { class: 'feed', id: 'feed' })
        ]);
        main.appendChild(el('div', { class: 'lab-grid' }, [devicesBox, feedBox]));
        state.feed.slice(-200).forEach(appendFeedLine);
      })
      .catch(showError(qs('#main')));
  }

  function deviceCard(d, collections) {
    var collection = collections[0];
    var card = el('div', { class: 'device-card' + (d.connected ? '' : ' offline') });
    card.appendChild(el('div', { class: 'device-head' }, [
      el('span', { class: 'name ' + deviceColor(d.name), text: d.name }),
      el('span', { class: 'node mono', text: shortNode(d.nodeId) }),
      el('span', { class: 'badge ' + (d.connected ? 'ok' : 'bad'), text: d.connected ? 'online' : 'offline' }),
      d.pendingOperations ? el('span', { class: 'badge neutral', text: d.pendingOperations + ' queued' }) : null,
      el('span', { class: 'spacer' }),
      el('button', { text: d.connected ? 'disconnect' : 'connect', onclick: function () {
        post('/api/lab/devices/' + d.name + '/' + (d.connected ? 'disconnect' : 'connect'), {})
          .then(function () { render(true); }).catch(alertError);
      } }),
      el('button', { text: 'sync', onclick: function () {
        post('/api/lab/devices/' + d.name + '/sync', {}).then(function () { render(true); }).catch(alertError);
      } })
    ]));

    var body = el('div', { class: 'device-body' });
    card.appendChild(body);

    // Chaos controls
    body.appendChild(el('h5', { text: 'Network chaos (applies on next connect)' }));
    var chaosDefs = [['dropRate', 'drop'], ['duplicateRate', 'duplicate'], ['reorderRate', 'reorder']];
    chaosDefs.forEach(function (cd) {
      var key = cd[0];
      var valueLabel = el('span', { class: 'mono', text: String(d.chaos[key]) });
      var range = el('input', { type: 'range', min: '0', max: '0.5', step: '0.05', value: String(d.chaos[key]) });
      range.oninput = function () { valueLabel.textContent = range.value; };
      range.onchange = function () {
        var body2 = {}; body2[key] = Number(range.value);
        post('/api/lab/devices/' + d.name + '/chaos', body2).catch(alertError);
      };
      body.appendChild(el('div', { class: 'chaos-row' }, [el('span', { text: cd[1] }), range, valueLabel]));
    });

    // Records with inline editing
    body.appendChild(el('h5', { text: 'records (' + collection.name + ') — edits happen ON this device' }));
    var recBox = el('div', {});
    body.appendChild(recBox);
    api('/api/collections/' + collection.name + '/records?limit=20&device=' + encodeURIComponent(d.name)).then(function (data) {
      data.records.forEach(function (r) {
        var titleInput = el('input', { type: 'text', value: String(r.fields.title || '') });
        titleInput.onchange = function () {
          post('/api/lab/devices/' + d.name + '/update', { collection: collection.name, id: r.id, data: { title: titleInput.value } }).catch(alertError);
        };
        var doneCb = el('input', { type: 'checkbox', title: 'done' });
        doneCb.checked = !!r.fields.done;
        doneCb.onchange = function () {
          post('/api/lab/devices/' + d.name + '/update', { collection: collection.name, id: r.id, data: { done: doneCb.checked } }).catch(alertError);
        };
        var incBtn = el('button', { text: '+1', title: 'atomic increment — composes across devices', onclick: function () {
          post('/api/lab/devices/' + d.name + '/update', { collection: collection.name, id: r.id, data: {}, increments: { points: 1 } })
            .then(function () { debounceRefresh(); }).catch(alertError);
        } });
        var delBtn = el('button', { class: 'danger', text: '✕', title: 'delete', onclick: function () {
          post('/api/lab/devices/' + d.name + '/delete', { collection: collection.name, id: r.id })
            .then(function () { debounceRefresh(); }).catch(alertError);
        } });
        recBox.appendChild(el('div', { class: 'rec-line' }, [
          doneCb, titleInput,
          el('span', { class: 'pts mono', text: String(r.fields.points === undefined ? '' : r.fields.points) }),
          incBtn, delBtn,
          el('button', { text: '⌕', title: 'inspect', onclick: function () { state.device = d.name; state.collection = collection.name; openRecord(r.id); } })
        ]));
      });
      if (!data.records.length) recBox.appendChild(el('div', { class: 'empty', text: 'no records yet' }));
    });

    // Insert form
    var newTitle = el('input', { type: 'text', placeholder: 'new task title…' });
    var insertBtn = el('button', { class: 'primary', text: 'insert', onclick: function () {
      if (!newTitle.value.trim()) return;
      post('/api/lab/devices/' + d.name + '/insert', { collection: collection.name, data: { title: newTitle.value.trim() } })
        .then(function () { newTitle.value = ''; debounceRefresh(); }).catch(alertError);
    } });
    newTitle.addEventListener('keydown', function (e) { if (e.key === 'Enter') insertBtn.click(); });
    body.appendChild(el('div', { class: 'insert-form' }, [newTitle, insertBtn]));
    return card;
  }

  function appendFeedLine(event) {
    var feed = qs('#feed');
    if (!feed) return;
    var cls = 'feed-line';
    if (event.type === 'operation:created') cls += ' evt-created';
    if (event.type === 'operation:applied') cls += ' evt-applied';
    if (event.type === 'merge:conflict') cls += ' evt-conflict';
    if (event.type === 'sync:apply-failed') cls += ' evt-failed';
    feed.appendChild(el('div', { class: cls }, [
      el('span', { class: 'mono', text: fmtTime(event.at) }),
      el('span', { class: 'dev ' + deviceColor(event.device), text: event.device }),
      el('span', { class: 'what', text: event.type.replace('operation:', '').replace('sync:', '') + ' · ' + event.summary })
    ]));
    feed.scrollTop = feed.scrollHeight;
  }

  // ── Misc ───────────────────────────────────────────────────────────────────
  function showError(main) {
    return function (e) { main.appendChild(el('div', { class: 'error', text: e.message })); };
  }
  function alertError(e) { console.error(e); qs('#dbpath').textContent = 'error: ' + e.message; }

  qs('#refresh').onclick = function () { render(true); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
})();
`
