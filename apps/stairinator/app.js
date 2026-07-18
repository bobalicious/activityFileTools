// app.js — UI wiring and application state. Loaded last.
(function () {
  'use strict';
  var model = Stair.model, storage = Stair.storage, elevation = Stair.elevation;
  var gpxLib = window.GpxParse, align = Stair.align;
  var filePanel = null;

  // ---- state ----
  var doc = model.normalizeDoc(storage.load());
  var state = {
    currentPlanId: doc.plans[0] ? doc.plans[0].id : null,
    currentMachineId: doc.machines[0] ? doc.machines[0].id : null,
    activeTab: 'activity',
    parsed: null,        // parsed uploaded file (GPX or FIT); null when none
    offsetSec: 0,
    planKind: 'rate',
    dragIndex: null
  };
  var chart = null;

  var $ = function (sel) { return document.querySelector(sel); };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function persist() { storage.save(doc); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function formatDTL(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function parseDTL(str) {
    if (!str) return null;
    var t = new Date(str).getTime();
    return isNaN(t) ? null : t;
  }
  function currentPlan() { return doc.plans.find(function (p) { return p.id === state.currentPlanId; }) || null; }
  function currentMachine() { return doc.machines.find(function (m) { return m.id === state.currentMachineId; }) || null; }
  function machineFor(plan) { return plan ? doc.machines.find(function (m) { return m.id === plan.machineId; }) : null; }
  function fmt(n, d) { return Number(n).toFixed(d == null ? 1 : d); }

  // ================= TABS =================
  function showTab(name) {
    state.activeTab = name;
    ['machines', 'activity'].forEach(function (t) {
      $('#tab-' + t).classList.toggle('active', t === name);
      $('#tab-btn-' + t).classList.toggle('active', t === name);
    });
  }

  // ================= 1. MACHINES =================
  function renderMachineSelect() {
    var sel = $('#machine-select');
    sel.innerHTML = '';
    if (!doc.machines.length) {
      sel.appendChild(el('option', { value: '' }, ['(no machines yet)']));
      return;
    }
    doc.machines.forEach(function (m) { sel.appendChild(el('option', { value: m.id }, [m.name || '(unnamed)'])); });
    sel.value = state.currentMachineId || '';
  }

  function renderMachines() {
    renderMachineSelect();
    var host = $('#machine-editor');
    host.innerHTML = '';
    var m = currentMachine();
    if (!m) {
      host.appendChild(el('p', { class: 'hint' }, ['No machine selected. Add one to get started.']));
      return;
    }
    host.appendChild(machineCard(m));
  }

  function machineCard(m) {
    var head = el('div', { class: 'machine-head' }, [
      el('label', { class: 'inline' }, ['name ',
        el('input', { type: 'text', value: m.name, title: 'Machine name', style: 'width:12rem',
          oninput: function (e) { m.name = e.target.value; persist(); renderMachineSelect(); refreshPlanUI(); } })]),
      el('label', { class: 'inline' }, ['riser (m) ',
        el('input', { type: 'number', step: '0.001', value: m.riser, title: 'Vertical rise per step', style: 'width:5rem',
          oninput: function (e) { m.riser = parseFloat(e.target.value) || 0; persist(); rebuildDerived(); refreshPlanUI(); } })]),
      el('label', { class: 'inline' }, ['tread (m) ',
        el('input', { type: 'number', step: '0.001', value: m.tread, title: 'Forward depth per step', style: 'width:5rem',
          oninput: function (e) { m.tread = parseFloat(e.target.value) || 0; persist(); rebuildDerived(); refreshPlanUI(); } })])
    ]);

    var table = el('table', { class: 'levels' });
    function derivedText(lvl) {
      var c = elevation.climbRate(m, lvl), f = elevation.forwardRate(m, lvl);
      if (c == null) return '—';
      return '↑ ' + fmt(c * 60, 1) + ' m/min  ·  → ' + fmt(f * 60, 1) + ' m/min';
    }
    function rebuildDerived() {
      Array.prototype.forEach.call(table.querySelectorAll('tr[data-lvl]'), function (tr) {
        tr.querySelector('.derived').textContent = derivedText(Number(tr.getAttribute('data-lvl')));
      });
    }
    table.appendChild(el('tr', {}, [el('th', {}, ['Name']), el('th', {}, ['Steps/min']), el('th', {}, ['Climb · Forward'])]));
    m.levels.forEach(function (lv) {
      table.appendChild(el('tr', { 'data-lvl': lv.level }, [
        el('td', {}, [el('input', { type: 'text', value: lv.name != null ? lv.name : String(lv.level), style: 'width:7rem',
          oninput: function (e) { lv.name = e.target.value; persist(); refreshPlanUI(); } })]),
        el('td', {}, [el('input', { type: 'number', value: lv.stepsPerMin, min: '0',
          oninput: function (e) { lv.stepsPerMin = parseFloat(e.target.value) || 0; persist(); rebuildDerived(); refreshPlanUI(); } })]),
        el('td', { class: 'derived' }, [derivedText(lv.level)])
      ]));
    });

    var levelControls = el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('button', { class: 'ghost', onclick: function () {
        var next = m.levels.length ? m.levels[m.levels.length - 1].level + 1 : 1;
        m.levels.push({ level: next, name: String(next), stepsPerMin: 100 }); persist(); renderMachines(); refreshPlanUI();
      } }, ['+ Level']),
      el('button', { class: 'ghost', onclick: function () {
        if (m.levels.length > 1) { m.levels.pop(); persist(); renderMachines(); refreshPlanUI(); }
      } }, ['− Level'])
    ]);

    return el('div', { class: 'machine' }, [head, table, levelControls]);
  }

  // ================= 2. PLANS =================
  function refreshPlanUI() {
    renderPlanSelect();
    renderPlanEditor();
    renderGenerate();
    renderAlign();
  }

  function renderPlanSelect() {
    var sel = $('#plan-select');
    sel.innerHTML = '';
    if (!doc.plans.length) { sel.appendChild(el('option', { value: '' }, ['(no activities yet)'])); return; }
    doc.plans.forEach(function (p) { sel.appendChild(el('option', { value: p.id }, [p.name || '(unnamed)'])); });
    sel.value = state.currentPlanId || '';
  }

  function renderPlanEditor() {
    var wrap = $('#plan-editor');
    wrap.innerHTML = '';
    var plan = currentPlan();
    if (!plan) { wrap.appendChild(el('p', { class: 'hint' }, ['Create an activity to begin.'])); return; }

    wrap.appendChild(el('div', { class: 'row' }, [
      el('label', {}, ['Name', el('input', { type: 'text', value: plan.name,
        oninput: function (e) { plan.name = e.target.value; persist(); renderPlanSelect(); } })]),
      el('label', {}, ['Machine', machineSelect(plan)])
    ]));

    var segWrap = el('div', { class: 'segments' });
    var machine = machineFor(plan);
    plan.segments.forEach(function (seg, i) { segWrap.appendChild(segmentRow(plan, machine, seg, i)); });
    wrap.appendChild(segWrap);

    wrap.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'ghost', onclick: function () {
        plan.segments.push({ level: machine && machine.levels[0] ? machine.levels[0].level : 1, minutes: 5, seconds: 0 });
        persist(); renderPlanEditor(); renderAlign();
      } }, ['+ Segment'])
    ]));

    wrap.appendChild(el('div', { id: 'plan-summary-host' }));
    renderSummary();
  }

  function machineSelect(plan) {
    var sel = el('select', { class: 'wide', onchange: function (e) { plan.machineId = e.target.value || null; persist(); renderPlanEditor(); renderAlign(); renderGenerate(); } });
    sel.appendChild(el('option', { value: '' }, ['— choose —']));
    doc.machines.forEach(function (m) {
      var o = el('option', { value: m.id }, [m.name]);
      if (m.id === plan.machineId) o.selected = true;
      sel.appendChild(o);
    });
    return sel;
  }

  function segmentRow(plan, machine, seg, i) {
    var levelSel;
    if (machine) {
      levelSel = el('select', { onchange: function (e) { seg.level = Number(e.target.value); persist(); renderSummary(); renderAlign(); } });
      machine.levels.forEach(function (lv) {
        var label = (lv.name != null ? lv.name : String(lv.level)) + ' · ' + lv.stepsPerMin + '/min';
        var o = el('option', { value: lv.level }, [label]);
        if (Number(lv.level) === Number(seg.level)) o.selected = true;
        levelSel.appendChild(o);
      });
    } else {
      levelSel = el('input', { type: 'number', value: seg.level,
        oninput: function (e) { seg.level = Number(e.target.value); persist(); renderSummary(); } });
    }

    var row = el('div', { class: 'segment', draggable: 'true', 'data-index': i }, [
      el('span', { class: 'handle', title: 'Drag to reorder' }, ['⋮⋮']),
      el('span', { class: 'idx' }, [String(i + 1)]),
      levelSel,
      el('input', { type: 'number', step: '1', min: '0', value: seg.minutes, title: 'minutes',
        oninput: function (e) { seg.minutes = parseInt(e.target.value, 10) || 0; persist(); renderSummary(); renderAlign(); } }),
      el('span', { class: 'derived' }, ['min']),
      el('input', { type: 'number', step: '1', min: '0', value: seg.seconds != null ? seg.seconds : 0, title: 'seconds',
        oninput: function (e) { seg.seconds = parseInt(e.target.value, 10) || 0; persist(); renderSummary(); renderAlign(); } }),
      el('span', { class: 'derived' }, ['sec']),
      el('button', { class: 'ghost danger', onclick: function () { plan.segments.splice(i, 1); persist(); renderPlanEditor(); renderAlign(); } }, ['✕'])
    ]);

    row.addEventListener('dragstart', function (e) {
      state.dragIndex = i; row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) {}
    });
    row.addEventListener('dragend', function () {
      state.dragIndex = null; row.classList.remove('dragging');
      Array.prototype.forEach.call(document.querySelectorAll('.segment.drop-target'), function (r) { r.classList.remove('drop-target'); });
    });
    row.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target'); });
    row.addEventListener('dragleave', function () { row.classList.remove('drop-target'); });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      row.classList.remove('drop-target');
      var from = state.dragIndex; var to = i;
      if (from == null || from === to) return;
      var arr = plan.segments;
      var item = arr.splice(from, 1)[0];
      var insertAt = from < to ? to - 1 : to;
      arr.splice(insertAt, 0, item);
      persist(); renderPlanEditor(); renderAlign();
    });

    return row;
  }

  function renderSummary() {
    var host = $('#plan-summary-host'); if (!host) return;
    host.innerHTML = '';
    var plan = currentPlan(); var machine = machineFor(plan);
    var errors = model.validatePlan(plan, machine);
    if (machine && plan) {
      var prof = elevation.buildProfile(plan, machine);
      host.appendChild(el('div', { class: 'plan-summary' }, [
        stat('Total time', fmt(prof.totalTime / 60, 1) + ' min'),
        stat('Total climb', fmt(prof.totalClimb, 1) + ' m'),
        stat('Forward distance', fmt(prof.totalDistance, 1) + ' m'),
        stat('Avg climb', prof.totalTime ? fmt(prof.totalClimb / prof.totalTime, 3) + ' m/s' : '—')
      ]));
    }
    if (errors.length) {
      host.appendChild(el('div', { class: 'errors' }, [
        el('strong', {}, ['Fix before generating:']),
        el('ul', {}, errors.map(function (e) { return el('li', {}, [e]); }))
      ]));
    }
    renderGenerate();
  }
  function stat(k, v) { return el('div', { class: 'stat' }, [el('div', { class: 'k' }, [k]), el('div', { class: 'v' }, [v])]); }

  // ================= 3. ALIGN =================
  function renderGpxSummary() {
    var host = $('#gpx-summary');
    if (!state.parsed) { host.className = 'summary hidden'; return; }
    var p = state.parsed;
    var dur = (p.points[p.points.length - 1].timeMs - p.points[0].timeMs) / 1000;
    host.className = 'summary';
    host.innerHTML = '';
    host.appendChild(el('div', {}, [
      badge('Heart rate', p.hasHr),
      badge('GPS location', p.hasGps),
      badge('Timestamps', p.hasTime),
      el('span', {}, [p.points.length + ' points · ' + fmt(dur / 60, 1) + ' min' + (p.name ? ' · “' + p.name + '”' : '')])
    ]));
    if (!p.hasTime) host.appendChild(el('div', { class: 'errors' }, ['No timestamps found — synthesized 1-second samples.']));
  }
  function badge(label, on) { return el('span', { class: 'badge ' + (on ? 'yes' : 'no') }, [(on ? '✓ ' : '– ') + label]); }

  function renderAlign() {
    var area = $('#align-area');
    if (!state.parsed) { area.className = 'hidden'; return; }
    var plan = currentPlan(); var machine = machineFor(plan);
    if (!plan || !machine || model.validatePlan(plan, machine).length) { area.className = 'hidden'; return; }
    area.className = '';
    if (!chart) {
      chart = Stair.chart.create($('#chart'), { onOffsetDelta: function (d) {
        state.offsetSec = Math.round((state.offsetSec + d) * 10) / 10;
        $('#offset-input').value = state.offsetSec;
        drawChart(); updateOffsetReadout();
      } });
    }
    drawChart(); updateOffsetReadout();
  }

  function drawChart() {
    var plan = currentPlan(); var machine = machineFor(plan);
    if (!state.parsed || !plan || !machine) return;
    var prof = elevation.buildProfile(plan, machine);
    var series = align.buildSeries(state.parsed, prof, state.offsetSec, state.planKind);
    chart.render(series, { planKind: state.planKind });
  }

  function updateOffsetReadout() {
    var p = state.parsed; if (!p) return;
    var startMs = align.planStartMs(p, state.offsetSec);
    var d = p.hasTime ? new Date(startMs) : null;
    $('#offset-readout').textContent = 'Plan starts at ' +
      (d ? d.toLocaleTimeString() : ('+' + state.offsetSec + 's into the recording'));
    updateStartField();
  }

  // ================= 4. GENERATE (FIT) =================
  // Start date/time field: editable (default now) when no file is uploaded;
  // read-only and derived from the file + alignment offset when a file is loaded.
  function updateStartField() {
    var input = $('#start-datetime'); if (!input) return;
    if (state.parsed) {
      // The activity spans the union of the recording and the plan, so it starts
      // at whichever is earlier: the file's start, or the (offset) plan start.
      var fileStart = state.parsed.points[0].timeMs;
      var planStart = align.planStartMs(state.parsed, state.offsetSec);
      input.value = formatDTL(Math.min(fileStart, planStart));
      input.disabled = true;
    } else {
      input.disabled = false;
      if (!input.value) input.value = formatDTL(Date.now());
    }
  }

  function renderGenerate() {
    updateStartField();
    var plan = currentPlan(); var machine = machineFor(plan);
    var planValid = plan && machine && model.validatePlan(plan, machine).length === 0;
    $('#btn-gen-fit').disabled = !planValid;
    var status = $('#generate-status');
    if (!planValid) { status.textContent = 'Build a valid activity in step 2 to enable the download.'; return; }
    var haveHr = state.parsed && state.parsed.hasHr;
    status.innerHTML = haveHr
      ? 'Ready: a record per heart-rate datapoint from your file, aligned by the offset in step 3.'
      : 'Ready: no heart-rate file, so a record will be written every 5 seconds across the plan.';
  }

  // Assemble the FIT record/lap/session structures from the plan + optional HR.
  function buildFitInputs() {
    var plan = currentPlan(); var machine = machineFor(plan);
    var prof = elevation.buildProfile(plan, machine);
    var records = [];
    var haveHr = state.parsed && state.parsed.hasHr;

    // Minimal placeholder location: a tiny loop whose arc length equals the
    // forward distance, so Strava gets a "map" (needed to show elevation) while
    // any GPS-derived distance still matches our distance field. The trusted
    // barometric device means Strava keeps our altitude, not the terrain's.
    var PH_LAT = 0, PH_LON = 0, PH_R = 5; // null-island placeholder, 5 m radius
    function placeholder(distanceM) {
      var angle = distanceM / PH_R;
      return {
        lat: PH_LAT + (PH_R * Math.sin(angle)) / 111320,
        lon: PH_LON + (PH_R * Math.cos(angle)) / (111320 * Math.cos(PH_LAT * Math.PI / 180))
      };
    }
    // Which lap a record belongs to: a "pre" lap for HR before the climb starts,
    // one lap per climbing segment, and a "post" lap for HR after it finishes.
    function lapKeyFor(elapsed) {
      if (elapsed < 0) return 'pre';
      if (elapsed > prof.totalTime) return 'post';
      return 'seg' + prof.segIndexAt(elapsed);
    }
    function rec(timeMs, elapsed, hr) {
      var distanceM = prof.D(elapsed);
      var ll = placeholder(distanceM);
      return {
        timeMs: timeMs, lapKey: lapKeyFor(elapsed),
        latDeg: ll.lat, lonDeg: ll.lon,
        hr: (hr != null && !isNaN(hr)) ? hr : null,
        cadence: prof.cadenceAt(elapsed),
        distanceM: distanceM,
        altitudeM: prof.E(elapsed)
      };
    }

    if (haveHr) {
      // The activity spans the UNION of the HR recording and the plan window, so
      // the whole climb is captured and it starts at min(fileStart, planStart).
      var pts = state.parsed.points;
      var planStart = align.planStartMs(state.parsed, state.offsetSec);
      var planEnd = planStart + prof.totalTime * 1000;
      var fileStart = pts[0].timeMs, fileEnd = pts[pts.length - 1].timeMs;
      var tm;
      // Plan lead-in: climb begins before the HR recording (negative offset).
      for (tm = planStart; tm < fileStart; tm += 5000) {
        records.push(rec(tm, (tm - planStart) / 1000, null));
      }
      // The recorded heart-rate data, verbatim.
      pts.forEach(function (p) { records.push(rec(p.timeMs, (p.timeMs - planStart) / 1000, p.hr)); });
      // Plan lead-out: climb continues after the HR recording ends.
      if (planEnd > fileEnd) {
        for (tm = fileEnd + 5000; tm < planEnd; tm += 5000) {
          records.push(rec(tm, (tm - planStart) / 1000, null));
        }
        records.push(rec(planEnd, prof.totalTime, null)); // exact final point
      }
    } else {
      var startMs = parseDTL($('#start-datetime').value);
      if (startMs == null) startMs = Date.now();
      for (var t = 0; t <= prof.totalTime + 1e-6; t += 5) {
        var tt = Math.min(t, prof.totalTime);
        records.push(rec(startMs + tt * 1000, tt, null));
        if (tt >= prof.totalTime) break;
      }
    }

    // Group consecutive records by segment index → one lap per segment.
    var groups = [];
    records.forEach(function (r) {
      var g = groups[groups.length - 1];
      if (!g || g.key !== r.lapKey) groups.push({ key: r.lapKey, recs: [r] });
      else g.recs.push(r);
    });
    function avg(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
    var laps = groups.map(function (g) {
      var f = g.recs[0], last = g.recs[g.recs.length - 1];
      var hrs = g.recs.map(function (r) { return r.hr; }).filter(function (h) { return h != null; });
      return {
        startTimeMs: f.timeMs, endTimeMs: last.timeMs,
        totalDistanceM: last.distanceM - f.distanceM,
        totalAscentM: Math.max(0, last.altitudeM - f.altitudeM),
        avgHr: hrs.length ? avg(hrs) : null,
        maxHr: hrs.length ? Math.max.apply(null, hrs) : null,
        avgCadence: avg(g.recs.map(function (r) { return r.cadence; }))
      };
    });

    var allHr = records.map(function (r) { return r.hr; }).filter(function (h) { return h != null; });
    var first = records[0], lastR = records[records.length - 1];
    var session = {
      sport: 4 /* fitness_equipment */, subSport: 16 /* stair_climbing */,
      totalDistanceM: lastR.distanceM - first.distanceM,
      totalAscentM: Math.max(0, lastR.altitudeM - first.altitudeM),
      avgHr: allHr.length ? avg(allHr) : null,
      maxHr: allHr.length ? Math.max.apply(null, allHr) : null,
      avgCadence: avg(records.map(function (r) { return r.cadence; })),
      numLaps: laps.length
    };
    return { records: records, laps: laps, session: session, totalClimb: prof.totalClimb };
  }

  function doGenerateFit() {
    var plan = currentPlan();
    var inputs = buildFitInputs();
    var bytes = Stair.fit.encodeActivity(inputs);
    var base = (plan.name || 'stairinator').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    download(new Blob([bytes], { type: 'application/octet-stream' }), base + '.fit');
    $('#generate-status').innerHTML = '<span class="ok-msg">✓ Downloaded ' + base + '.fit — ' +
      inputs.records.length + ' records, ' + inputs.laps.length + ' laps, climbed ' +
      fmt(inputs.totalClimb, 0) + ' m.</span>';
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ================= file upload (GPX or FIT) =================
  function handleActivityFile(file) {
    var reader = new FileReader();
    reader.onerror = function () {
      filePanel.showError('Could not read that file.', 'The browser refused to open it.');
    };
    reader.onload = function () {
      try {
        var bytes = new Uint8Array(reader.result);
        var isFit = bytes.length > 12 && bytes[8] === 0x2E && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
        if (isFit) {
          state.parsed = Stair.fit.decode(reader.result);
        } else {
          state.parsed = gpxLib.parse(new TextDecoder('utf-8').decode(bytes));
        }
        state.offsetSec = 0;
        $('#offset-input').value = 0;
        filePanel.clearError();
        filePanel.setLoaded(file.name, fileDetail(state.parsed));
      } catch (err) {
        // Leave any previously loaded file in place — a bad second file should
        // not cost you the good one you already had.
        filePanel.showError('Could not read that file.', err.message);
      }
      renderGpxSummary(); renderGenerate(); renderAlign();
    };
    reader.readAsArrayBuffer(file);
  }

  function fileDetail(parsed) {
    if (!parsed || !parsed.points.length) return '';
    var mins = (parsed.points[parsed.points.length - 1].timeMs - parsed.points[0].timeMs) / 60000;
    return parsed.points.length + ' points · ' + fmt(mins, 1) + ' min' +
      (parsed.hasHr ? ' · heart rate' : ' · no heart rate');
  }

  // ================= wiring =================
  function wire() {
    // tabs
    $('#tab-btn-machines').addEventListener('click', function () { showTab('machines'); });
    $('#tab-btn-activity').addEventListener('click', function () { showTab('activity'); });

    // machines
    $('#machine-select').addEventListener('change', function (e) { state.currentMachineId = e.target.value; renderMachines(); });
    $('#btn-add-machine').addEventListener('click', function () {
      var m = model.defaultMachine();
      doc.machines.push(m); state.currentMachineId = m.id;
      // Give a brand-new user a starter activity so the Activity tab is usable.
      if (!doc.plans.length) { var p = model.defaultPlan(m.id); doc.plans.push(p); state.currentPlanId = p.id; }
      persist(); renderMachines(); refreshPlanUI();
    });
    $('#btn-del-machine').addEventListener('click', function () {
      var m = currentMachine(); if (!m) return;
      if (confirm('Delete machine "' + m.name + '"?')) {
        doc.machines = doc.machines.filter(function (x) { return x.id !== m.id; });
        state.currentMachineId = doc.machines[0] ? doc.machines[0].id : null;
        persist(); renderMachines(); refreshPlanUI();
      }
    });

    // plans
    $('#plan-select').addEventListener('change', function (e) { state.currentPlanId = e.target.value; refreshPlanUI(); });
    $('#btn-add-plan').addEventListener('click', function () {
      var p = model.defaultPlan(doc.machines[0] ? doc.machines[0].id : null);
      doc.plans.push(p); state.currentPlanId = p.id; persist(); refreshPlanUI();
    });
    $('#btn-del-plan').addEventListener('click', function () {
      var plan = currentPlan(); if (!plan) return;
      if (confirm('Delete activity "' + plan.name + '"?')) {
        doc.plans = doc.plans.filter(function (x) { return x.id !== plan.id; });
        state.currentPlanId = doc.plans[0] ? doc.plans[0].id : null;
        persist(); refreshPlanUI();
      }
    });

    // file upload — the panel owns the picker, drag/drop and error display
    filePanel = window.FilePanel.create({
      mount: $('#file-panel'),
      accept: '.gpx,.fit,application/gpx+xml,application/xml,text/xml,application/octet-stream',
      prompt: 'Drop a <strong>GPX</strong> or <strong>FIT</strong> file here, or click to choose',
      onFile: handleActivityFile,
      onClear: function () {
        state.parsed = null;
        state.offsetSec = 0;
        $('#offset-input').value = 0;
        filePanel.clearError();
        filePanel.setEmpty();
        renderGpxSummary(); renderGenerate(); renderAlign();
      }
    });

    // align controls
    $('#plan-kind').addEventListener('change', function (e) { state.planKind = e.target.value; drawChart(); });
    $('#offset-input').addEventListener('input', function (e) { state.offsetSec = parseFloat(e.target.value) || 0; drawChart(); updateOffsetReadout(); });

    // generate
    $('#btn-gen-fit').addEventListener('click', doGenerateFit);

    window.Help.install({
      trigger: $('#btn-help'),
      extraTriggers: [$('#footer-help')],
      label: 'Stairinator help'
    });

    // Backing up and restoring is not this app's job — it lives at the top
    // level, in settings.html, so one export covers every tool.
  }

  // ================= init =================
  function init() {
    // No auto-seeding: a first-time user has no machines and lands on the
    // Machines tab to create one. Once a machine exists, default to Activity.
    var configured = doc.machines.length > 0;
    state.currentMachineId = doc.machines[0] ? doc.machines[0].id : null;
    state.currentPlanId = doc.plans[0] ? doc.plans[0].id : null;
    wire();
    renderMachines();
    refreshPlanUI();
    renderGpxSummary();
    showTab(configured ? 'activity' : 'machines');
  }
  init();
})();
