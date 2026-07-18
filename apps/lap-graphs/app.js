/* Vanilla UI — no framework, no build. Wires the FIT decoder + Graph into the DOM. */
(function () {
  'use strict';
  var G = window.Graph;
  var SPECS = G.METRIC_SPECS, COLORS = G.METRIC_COLORS;
  var GRAPH_TYPES = [['line', 'Line'], ['bar', 'Bar'], ['range', 'Range'], ['trace', 'Trace']];
  var STATS = [['min', 'Min'], ['max', 'Max'], ['avg', 'Avg']];
  var CFG_KEY = 'bd-licious.graph-configs', ZONE_KEY = 'bd-licious.hr-zones';
  var DEFAULT_ZONES = [120, 140, 160, 175, 190];

  function loadJSON(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  var state = {
    activity: null, laps: [],
    rows: [newRow('bar')],
    colors: Object.assign({}, COLORS),
    sensitivity: 0.5, yStart: 0, showTime: true, showDistance: false,
    theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    zones: (function () { var z = loadJSON(ZONE_KEY, null); return Array.isArray(z) && z.length === 5 ? z : DEFAULT_ZONES.slice(); })(),
    showZones: false,
    configs: (function () { var c = loadJSON(CFG_KEY, []); return Array.isArray(c) ? c.filter(function (x) { return x && Array.isArray(x.rows); }) : []; })(),
    configName: '',
  };

  function newRow(gt) { return { metric: 'pace', graphType: gt || 'line', statistic: 'avg', labels: true, rests: false, clip: 0.05, smoothingSec: 10, linked: true, color: undefined }; }
  function availableMetrics() { return state.activity && state.activity.sport === 'swimming' ? G.SWIM_METRICS : G.RUN_METRICS; }
  function effColor(r) { return r.linked ? state.colors[r.metric] : (r.color || state.colors[r.metric]); }

  // ---- rendering ----------------------------------------------------------
  var app = document.getElementById('app');
  app.innerHTML =
    '<header><h1>bd-licious graphs</h1><p class="tagline">Drop a <code>.fit</code> file to graph your interval session.</p></header>' +
    '<h2 class="step"><span class="step-num">1</span>Open a file</h2>' +
    '<div id="drop" class="filedrop" role="button" tabindex="0"><p>Drop a <strong>.fit</strong> file here, or click to choose</p></div>' +
    '<input id="file" type="file" accept=".fit" hidden>' +
    '<p id="error" class="error" hidden></p>' +
    '<div id="body"></div>';

  function btn(active, k, i, v, label, disabled) {
    return '<button class="' + (active ? 'active' : '') + '" data-k="' + k + '" data-i="' + i + '" data-v="' + v + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  }
  function metricCard(row, i) {
    var isTrace = row.graphType === 'trace';
    var mt = availableMetrics().map(function (m) { return btn(m === row.metric, 'metric', i, m, SPECS[m].short); }).join('');
    var gt = GRAPH_TYPES.map(function (g) { return btn(g[0] === row.graphType, 'gtype', i, g[0], g[1]); }).join('');
    var st = STATS.map(function (s) { return btn(s[0] === row.statistic, 'stat', i, s[0], s[1], row.graphType === 'range' || isTrace); }).join('');
    var opts =
      '<label class="control"><input type="checkbox" data-k="labels" data-i="' + i + '"' + (row.labels ? ' checked' : '') + (isTrace ? ' disabled' : '') + '> Bar labels</label>' +
      '<label class="control"><input type="checkbox" data-k="rests" data-i="' + i + '"' + (row.rests ? ' checked' : '') + (isTrace ? ' disabled' : '') + '> Show rests</label>' +
      '<label class="control">Clip: <span>' + Math.round(row.clip * 100) + '%</span><input type="range" min="0" max="0.25" step="0.01" value="' + row.clip + '" data-k="clip" data-i="' + i + '"></label>' +
      (isTrace ? '<label class="control">Smoothing: <span>' + row.smoothingSec + 's</span><input type="range" min="2" max="60" step="1" value="' + row.smoothingSec + '" data-k="smooth" data-i="' + i + '"></label>' : '') +
      '<label class="control">Colour <input type="color" value="' + effColor(row) + '" data-k="color" data-i="' + i + '"></label>' +
      '<button class="link-btn" data-k="link" data-i="' + i + '">' + (row.linked ? '🔗 Linked' : '⛓ Unlinked') + '</button>';
    return '<div class="metric-card">' +
      '<div class="picker"><span class="picker-label">Metric ' + (i + 1) + '</span><div class="metric-tabs">' + mt + '</div>' +
      '<button class="remove-metric" data-k="removeRow" data-i="' + i + '"' + (state.rows.length === 1 ? ' disabled' : '') + '>Remove</button></div>' +
      '<div class="picker"><span class="picker-label">Graph</span><div class="metric-tabs">' + gt + '<span class="tab-divider"></span>' + st + '</div></div>' +
      '<div class="picker"><span class="picker-label">Options</span><div class="metric-tabs">' + opts + '</div></div>' +
      '</div>';
  }

  function renderBody() {
    var body = document.getElementById('body');
    if (!state.activity) { body.innerHTML = ''; return; }
    var a = state.activity, restCount = state.laps.filter(function (l) { return l.isRest; }).length;
    var hasHr = state.rows.some(function (r) { return r.metric === 'heartRate'; });
    var html = '<section class="summary"><strong>' + (a.sport || 'Activity') + '</strong> · ' +
      a.startTime.toLocaleDateString() + ' · ' + state.laps.length + ' laps · ' + restCount + ' rest · ' +
      (a.totalDistance ? (a.totalDistance / 1000).toFixed(2) + ' km' : '—') + '</section>';
    html += '<h2 class="step"><span class="step-num">2</span>Choose what to graph</h2>';
    html += state.rows.map(metricCard).join('');
    html += '<div class="chart-actions"><button class="primary" data-k="addRow" data-i="0">+ Add metric</button></div>';

    // config bar
    html += '<div class="config-bar"><input id="cfgName" type="text" placeholder="Configuration name" value="' + escAttr(state.configName) + '">' +
      '<button data-k="saveCfg" data-i="0">Save config</button>' +
      state.configs.map(function (c) { return '<span class="config-chip"><button data-k="loadCfg" data-i="0" data-v="' + escAttr(c.name) + '">' + escHtml(c.name) + '</button><button class="chip-x" data-k="delCfg" data-i="0" data-v="' + escAttr(c.name) + '">×</button></span>'; }).join('') +
      '</div>';

    // global controls
    html += '<div class="controls">' +
      '<label class="control">Rest sensitivity<input type="range" min="0" max="1" step="0.05" value="' + state.sensitivity + '" data-k="sens" data-i="0"></label>' +
      '<div class="control">X-axis<label class="control"><input type="checkbox" data-k="showTime" data-i="0"' + (state.showTime ? ' checked' : '') + '> Time</label>' +
      '<label class="control"><input type="checkbox" data-k="showDist" data-i="0"' + (state.showDistance ? ' checked' : '') + '> Distance</label></div>' +
      '<div class="control">Graph theme<div class="metric-tabs">' + btn(state.theme === 'light', 'theme', 0, 'light', 'Light') + btn(state.theme === 'dark', 'theme', 0, 'dark', 'Dark') + '</div></div>' +
      '</div>';
    if (hasHr) {
      html += '<div class="controls"><label class="control"><input type="checkbox" data-k="showZones" data-i="0"' + (state.showZones ? ' checked' : '') + '> Show HR zones</label>' +
        '<div class="control">Zone uppers (bpm)' + state.zones.map(function (z, i) { return '<input class="zone-input" type="number" value="' + z + '" data-k="zone" data-i="' + i + '">'; }).join('') + '</div></div>';
    }

    // chart + y-slider
    html += '<h2 class="step"><span class="step-num">3</span>Your graph</h2>';
    html += '<div class="chart-row"><div class="y-axis-slider"><input class="y-slider" type="range" min="0" max="0.9" step="0.01" value="' + state.yStart + '" data-k="yStart" data-i="0"><span class="y-slider-label">' + Math.round(state.yStart * 100) + '%</span></div>' +
      '<div class="chart-col" id="chart-wrap"></div></div>' +
      '<div class="chart-actions"><button class="primary" data-k="download" data-i="0">Download PNG</button></div>';

    // lap table
    html += '<table class="laptable"><thead><tr><th>#</th><th>Time</th><th>Dist</th><th>Rest?</th></tr></thead><tbody>' +
      state.laps.map(function (l) {
        return '<tr class="' + (l.isRest ? 'is-rest' : '') + '"><td>' + (l.index + 1) + '</td><td>' + Math.round(l.elapsedTime) + 's</td><td>' +
          (l.distance ? Math.round(l.distance) + 'm' : '—') + '</td><td><input type="checkbox" data-k="toggleRest" data-i="' + l.index + '"' + (l.isRest ? ' checked' : '') + '></td></tr>';
      }).join('') + '</tbody></table>';

    body.innerHTML = html;
    renderChart();
  }

  function chartOpts() {
    return {
      laps: state.laps, samples: state.activity.samples, xDomain: G.workTimeDomain(state.laps),
      yStart: state.yStart, theme: state.theme, showTime: state.showTime, showDistance: state.showDistance,
      zones: state.zones, showZones: state.showZones,
      rows: state.rows.map(function (r) { return Object.assign({}, r, { color: effColor(r) }); }),
    };
  }
  function renderChart() {
    var wrap = document.getElementById('chart-wrap');
    if (wrap && state.activity) wrap.innerHTML = G.renderChart(chartOpts());
  }

  // ---- state mutations ----------------------------------------------------
  function updateRow(i, patch) { state.rows[i] = Object.assign({}, state.rows[i], patch); }
  function reclassify() { if (state.activity) state.laps = G.classifyRest(state.activity, state.sensitivity); }

  function handleFile(buffer) {
    document.getElementById('error').hidden = true;
    try {
      // tolerant: this app opens whatever the user throws at it, so a malformed
      // tail should still graph what parsed rather than failing the whole file.
      var act = window.FitAdapters.toActivityModel(
        window.FitDecode.decode(buffer, { nullifyInvalid: true, tolerant: true }));
      var avail = act.sport === 'swimming' ? G.SWIM_METRICS : G.RUN_METRICS;
      state.activity = act;
      state.laps = G.classifyRest(act, state.sensitivity);
      if (!state.rows.every(function (r) { return avail.indexOf(r.metric) >= 0; })) {
        var r = newRow('bar'); r.metric = avail[0]; state.rows = [r];
      }
      renderBody();
    } catch (e) {
      var err = document.getElementById('error'); err.hidden = false; err.textContent = 'Couldn’t read that file: ' + (e && e.message || e);
      state.activity = null; renderBody();
    }
  }

  // ---- events -------------------------------------------------------------
  var drop = document.getElementById('drop'), fileInput = document.getElementById('file');
  function readFile(f) { if (!f) return; f.arrayBuffer().then(handleFile); }
  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('filedrop--active'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('filedrop--active'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('filedrop--active'); readFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', function (e) { readFile(e.target.files[0]); });

  app.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-k]'); if (!b) return;
    var k = b.dataset.k, i = +b.dataset.i, v = b.dataset.v;
    if (k === 'metric') updateRow(i, { metric: v });
    else if (k === 'gtype') updateRow(i, { graphType: v });
    else if (k === 'stat') updateRow(i, { statistic: v });
    else if (k === 'removeRow') { if (state.rows.length > 1) state.rows.splice(i, 1); }
    else if (k === 'addRow') { var nr = newRow('line'); nr.metric = availableMetrics()[0]; state.rows.push(nr); }
    else if (k === 'link') { var r = state.rows[i]; if (r.linked) updateRow(i, { linked: false, color: effColor(r) }); else state.rows.forEach(function (rr) { if (rr.metric === r.metric) { rr.linked = true; rr.color = undefined; } }); }
    else if (k === 'theme') state.theme = v;
    else if (k === 'saveCfg') return saveConfig();
    else if (k === 'loadCfg') return loadConfig(v);
    else if (k === 'delCfg') { state.configs = state.configs.filter(function (c) { return c.name !== v; }); saveJSON(CFG_KEY, state.configs); }
    else if (k === 'download') return downloadPng();
    else return;
    renderBody();
  });

  app.addEventListener('change', function (e) {
    var t = e.target; var k = t.dataset && t.dataset.k; if (!k) return;
    var i = +t.dataset.i;
    if (k === 'labels') updateRow(i, { labels: t.checked });
    else if (k === 'rests') updateRow(i, { rests: t.checked });
    else if (k === 'showTime') state.showTime = t.checked;
    else if (k === 'showDist') state.showDistance = t.checked;
    else if (k === 'showZones') state.showZones = t.checked;
    else if (k === 'zone') { state.zones[i] = +t.value; saveJSON(ZONE_KEY, state.zones); }
    else if (k === 'toggleRest') { var lap = state.laps.find(function (l) { return l.index === i; }); if (lap) { lap.isRest = !lap.isRest; lap.restSource = 'manual'; } }
    else if (k === 'color') { changeColor(i, t.value); renderChart(); return; }
    else return;
    // checkbox changes don't need a full rebuild except rest toggle (affects table/summary)
    if (k === 'toggleRest' || k === 'showZones') renderBody(); else renderChart();
  });

  app.addEventListener('input', function (e) {
    var t = e.target; var k = t.dataset && t.dataset.k; if (!k) return;
    var i = +t.dataset.i, val = +t.value, span = t.previousElementSibling;
    if (k === 'clip') { updateRow(i, { clip: val }); if (span) span.textContent = Math.round(val * 100) + '%'; renderChart(); }
    else if (k === 'smooth') { updateRow(i, { smoothingSec: val }); if (span) span.textContent = val + 's'; renderChart(); }
    else if (k === 'yStart') { state.yStart = val; if (t.nextElementSibling) t.nextElementSibling.textContent = Math.round(val * 100) + '%'; renderChart(); }
    else if (k === 'sens') { state.sensitivity = val; reclassify(); renderChart(); }
    else if (k === 'color') { changeColor(i, t.value); renderChart(); }
    else if (k === 'cfgName') state.configName = t.value;
  });
  app.addEventListener('input', function (e) { if (e.target.id === 'cfgName') state.configName = e.target.value; });

  function changeColor(i, c) { var r = state.rows[i]; if (r.linked) state.colors[r.metric] = c; else updateRow(i, { color: c }); }

  // ---- configs ------------------------------------------------------------
  function saveConfig() {
    var name = (state.configName || '').trim(); if (!name) return;
    var cfg = { name: name, rows: state.rows.map(function (r) { return Object.assign({}, r); }), colors: Object.assign({}, state.colors), yStart: state.yStart, showTime: state.showTime, showDistance: state.showDistance, showZones: state.showZones };
    state.configs = state.configs.filter(function (c) { return c.name !== name; }).concat([cfg]).sort(function (a, b) { return a.name.localeCompare(b.name); });
    saveJSON(CFG_KEY, state.configs); renderBody();
  }
  function loadConfig(name) {
    var c = state.configs.find(function (x) { return x.name === name; }); if (!c) return;
    state.rows = c.rows.map(function (r) { return Object.assign(newRow('bar'), r, { linked: r.linked !== false, smoothingSec: r.smoothingSec || 10 }); });
    state.colors = Object.assign({}, COLORS, c.colors);
    state.yStart = c.yStart || 0; state.showTime = c.showTime !== false; state.showDistance = !!c.showDistance; state.showZones = !!c.showZones;
    state.configName = c.name; renderBody();
  }

  // ---- PNG export ---------------------------------------------------------
  function downloadPng() {
    var svg = document.querySelector('#chart-wrap svg'); if (!svg) return;
    var bg = G.THEMES[state.theme].bg;
    var vb = svg.viewBox.baseVal, w = vb.width || 900, hh = vb.height || 396, scale = 2;
    var clone = svg.cloneNode(true);
    clone.setAttribute('width', w); clone.setAttribute('height', hh);
    clone.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif');
    var url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
    var img = new Image(); img.width = w; img.height = hh;
    img.onload = function () {
      var canvas = document.createElement('canvas'); canvas.width = w * scale; canvas.height = hh * scale;
      var ctx = canvas.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        var a = document.createElement('a');
        var slug = state.activity ? state.activity.startTime.toISOString().slice(0, 10) : 'activity';
        a.href = URL.createObjectURL(blob); a.download = slug + '-' + state.rows.map(function (r) { return r.metric; }).join('-') + '.png'; a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      }, 'image/png');
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  }

  function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }
})();
