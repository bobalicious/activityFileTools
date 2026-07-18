/* Swim FIT Corrector — interface. */
(function () {
  'use strict';

  var S = window.SwimModel;
  var D = window.FitDecode;
  var E = window.FitEncode;
  var C = window.SwimChart;

  var state = { model: null, issues: [], fileName: '', sensitivity: 0.5,
                selected: null, densify: true };

  var $ = function (id) { return document.getElementById(id); };

  /* ---- File loading ---- */

  // The panel owns the picker, drag/drop, the filename and error display. It
  // stays on screen once a file is open, shrinking to a compact bar.
  var filePanel = window.FilePanel.create({
    mount: $('file-panel'),
    accept: '.fit,application/octet-stream',
    prompt: 'Drop a pool-swim <strong>.fit</strong> file here, or click to choose',
    onFile: readFile,
    onClear: reset
  });

  function readFile(file) {
    state.fileName = file.name;
    var fr = new FileReader();
    fr.onerror = function () {
      filePanel.showError('Could not read that file.', 'The browser refused to open it.');
    };
    fr.onload = function () {
      try {
        loadBytes(new Uint8Array(fr.result));
      } catch (err) {
        if (err instanceof S.SwimLoadError) filePanel.showError(err.message, err.detail);
        else filePanel.showError('That file could not be read as a FIT file.', err.message);
      }
    };
    fr.readAsArrayBuffer(file);
  }

  function loadBytes(bytes) {
    if (!D.isFit(bytes)) {
      throw new S.SwimLoadError('That is not a FIT file.',
        'It has no .FIT signature. Export the original file from Garmin Connect ' +
        'rather than a GPX or TCX copy.');
    }
    var decoded = D.decode(bytes);
    if (!decoded.crc.valid) {
      // Worth saying out loud, but a bad CRC still usually decodes fine.
      console.warn('FIT checksum mismatch: stored', decoded.crc.stored,
                   'computed', decoded.crc.computed);
    }
    state.model = S.load(decoded);
    state.selected = null;
    filePanel.clearError();
    filePanel.setLoaded(state.fileName, fileDetail(state.model));
    $('activity').hidden = false;
    draw();
  }

  function fileDetail(m) {
    var n = m.lengths.length;
    return n + (n === 1 ? ' length' : ' lengths') + ' · ' + m.poolLengthM + ' m pool';
  }

  function reset() {
    state.model = null;
    state.fileName = '';
    state.selected = null;
    $('activity').hidden = true;
    filePanel.clearError();
    filePanel.setEmpty();
  }

  // Kept so code outside the load path reports failures the same way — the
  // export error used to be written into an element that was hidden whenever a
  // file was open, so nobody ever saw it.
  function showError(title, detail) {
    filePanel.showError(title, detail);
  }

  /* ---- Sensitivity ---- */

  $('sens').addEventListener('input', function (e) {
    state.sensitivity = parseFloat(e.target.value);
    draw();
  });

  function sensLabel(v) {
    return v < 0.25 ? 'Strict' : v < 0.45 ? 'Cautious' : v < 0.65 ? 'Balanced'
         : v < 0.85 ? 'Keen' : 'Everything';
  }

  $('resetBtn').addEventListener('click', function () {
    S.resetAll(state.model);
    state.selected = null;
    draw();
  });

  /* ---- Render ---- */

  function draw() {
    var m = state.model;
    if (!m) return;
    state.issues = S.detect(m, { sensitivity: state.sensitivity });
    $('sensLabel').textContent = sensLabel(state.sensitivity);
    drawTitle();
    drawStats();
    drawChart();
    drawIssues();
    drawTable();
    drawExport();
  }

  function drawTitle() {
    var m = state.model;
    var strokes = {};
    S.activeLengths(m).forEach(function (l) {
      if (l.swimStroke != null) strokes[l.swimStroke] = (strokes[l.swimStroke] || 0) + 1;
    });
    var names = Object.keys(strokes).sort(function (a, b) { return strokes[b] - strokes[a]; })
                      .map(function (k) { return S.strokeName(+k); });
    var stroke = names.length === 1 ? names[0] : names.length ? 'Mixed strokes' : '';
    var pool = S.fmtDistance(m.poolLengthM, m.displayUnit) + ' pool';
    $('swimTitle').textContent = [stroke, pool].filter(Boolean).join(' · ');

    var n = S.corrections(m);
    $('editedNote').hidden = n === 0;
    $('editedCount').textContent = n + (n === 1 ? ' correction' : ' corrections');
  }

  function drawStats() {
    var m = state.model;
    var d = S.diff(m);
    var host = $('stats');
    host.innerHTML = '';

    var tiles = [
      { label: 'Distance', now: S.fmtDistance(d.after.distanceM, m.displayUnit),
        was: S.fmtDistance(d.before.distanceM, m.displayUnit) },
      { label: 'Lengths', now: String(d.after.activeLengths), was: String(d.before.activeLengths) },
      { label: 'Pace', now: S.fmtPace(d.after.pacePer100, m.displayUnit),
        was: S.fmtPace(d.before.pacePer100, m.displayUnit) },
      { label: 'SWOLF', now: d.after.swolf == null ? '–' : String(d.after.swolf),
        was: d.before.swolf == null ? '–' : String(d.before.swolf) },
      { label: 'Strokes', now: String(d.after.strokes), was: String(d.before.strokes) },
      { label: 'Swim time', now: S.fmtClock(d.after.timerMs), was: S.fmtClock(d.before.timerMs) }
    ];

    tiles.forEach(function (t) {
      var changed = t.now !== t.was;
      var div = document.createElement('div');
      div.className = 'stat' + (changed ? ' changed' : '');
      var label = document.createElement('div');
      label.className = 'label'; label.textContent = t.label;
      var val = document.createElement('div');
      val.className = 'value'; val.textContent = t.now;
      div.appendChild(label); div.appendChild(val);
      if (changed) {
        var was = document.createElement('div');
        was.className = 'was';
        was.innerHTML = '<s></s><span aria-hidden="true">→</span>';
        was.querySelector('s').textContent = t.was;
        div.appendChild(was);
      }
      host.appendChild(div);
    });
  }

  function drawChart() {
    var m = state.model;
    C.render($('chart'), m, state.issues, { selected: state.selected });

    var present = {};
    m.lengths.forEach(function (l, i) {
      var issues = {}; state.issues.forEach(function (a) { flagAll(issues, a); });
      present[C.stateOf(l, issues)] = true;
    });
    C.renderLegend($('legend'), present);

    var sum = S.summarise(m);
    $('chartDesc').textContent =
      'Bar chart of time per length. ' + sum.activeLengths + ' lengths, median ' +
      S.fmtDur(S.median(S.activeLengths(m).map(function (l) { return l.elapsedMs; }))) +
      '. ' + state.issues.length + ' anomalies flagged. The table below lists every length.';

    bindChart();
  }

  function bindChart() {
    var svg = $('chart');
    var tip = $('tooltip');

    svg.querySelectorAll('.bar').forEach(function (g) {
      g.addEventListener('mouseenter', function () { showTip(g); });
      g.addEventListener('focus', function () { showTip(g); });
      g.addEventListener('mousemove', function (e) { placeTip(e.clientX, e.clientY); });
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('blur', hideTip);
      g.addEventListener('click', function () { openEditor(+g.dataset.index); });
      g.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(+g.dataset.index); }
      });
    });

    function showTip(g) {
      var l = g._length, i = +g.dataset.index, m = state.model;
      var rows = [
        ['Time', S.fmtDur(l.elapsedMs)],
        ['Strokes', l.strokes == null ? '–' : String(l.strokes)],
        ['Pace', S.fmtPace((l.timerMs / 1000) / (m.poolLengthM / 100), m.displayUnit)]
      ];
      if (l.cadence != null) rows.push(['Cadence', l.cadence + ' spm']);
      if (l.calories != null) rows.push(['Calories', l.calories + ' kcal']);

      var note = '';
      if (g._state === 'rest') note = 'Rest — not a swum length.';
      else if (g._issue) note = g._issue.title + ' · ' + Math.round(g._issue.confidence * 100) + '% confidence';
      else if (g._state === 'corrected') note = 'Corrected';

      tip.innerHTML = '';
      var t = document.createElement('div');
      t.className = 't-title';
      t.textContent = (l.active ? 'Length ' + (i + 1) : 'Rest') +
                      (l.active && l.swimStroke != null ? ' · ' + S.strokeName(l.swimStroke) : '');
      tip.appendChild(t);
      rows.forEach(function (r) {
        var d = document.createElement('div');
        d.className = 't-row';
        d.innerHTML = '<span></span><b></b>';
        d.querySelector('span').textContent = r[0];
        d.querySelector('b').textContent = r[1];
        tip.appendChild(d);
      });
      if (note) {
        var n = document.createElement('div');
        n.className = 't-row t-note';
        n.textContent = note;
        tip.appendChild(n);
      }
      tip.classList.add('show');
      var r = g.getBoundingClientRect();
      placeTip(r.left + r.width / 2, r.top + 20);
    }

    function placeTip(x, y) {
      var w = tip.offsetWidth, h = tip.offsetHeight;
      var left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 12));
      var top = y - h - 12;
      if (top < 8) top = y + 18;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function hideTip() { tip.classList.remove('show'); }
  }

  function drawIssues() {
    var host = $('issues');
    var m = state.model;
    host.innerHTML = '';

    var resolved = m.lengths.filter(function (l) {
      return l.edit && l.edit.type !== 'dismissed' && l.edit.half !== 'second';
    });
    var dismissed = m.lengths.filter(function (l) { return l.edit && l.edit.type === 'dismissed'; });

    $('issueCount').textContent = state.issues.length
      ? state.issues.length + ' outstanding'
      : (resolved.length || dismissed.length ? 'All resolved' : 'None found');

    if (!state.issues.length && !resolved.length && !dismissed.length) {
      host.innerHTML = '<div class="empty"><span class="tick" aria-hidden="true">✓</span>' +
        'No anomalies found. Every length is close to the median — nothing looks like a ' +
        'missed or mistaken turn.<br><span style="font-size:12px;color:var(--text-muted)">' +
        'If you know one is wrong, raise the sensitivity or edit it from the table below.</span></div>';
      return;
    }

    state.issues.forEach(function (a) { host.appendChild(issueRow(a)); });
    resolved.forEach(function (l) { host.appendChild(resolvedRow(l)); });
    dismissed.forEach(function (l) { host.appendChild(dismissedRow(l)); });
  }

  /* A false-turn issue covers the pair either side of the phantom turn, so both
     lengths are flagged on the chart even though there is only one issue. */
  function flagAll(map, a) {
    (a.indices || [a.index]).forEach(function (i) { map[i] = a; });
  }

  function issueRow(a) {
    var missed = a.kind === 'missed_turn';
    var row = document.createElement('div');
    row.className = 'issue';
    row.innerHTML =
      '<span class="badge ' + (missed ? 'missed' : 'false') + '" aria-hidden="true">▲</span>' +
      '<div class="grow"><div class="title"></div><div class="detail"></div></div>' +
      '<span class="confidence"></span>' +
      '<div class="actions"></div>';
    row.querySelector('.title').textContent =
      (a.indices && a.indices.length > 1
        ? 'Lengths ' + (a.indices[0] + 1) + ' and ' + (a.indices[1] + 1)
        : 'Length ' + (a.index + 1)) + ' — ' + a.title;
    row.querySelector('.detail').textContent = a.detail;
    row.querySelector('.confidence').textContent = Math.round(a.confidence * 100) + '% confident';

    var acts = row.querySelector('.actions');
    // A lone short length with no neighbour it could merge with has no fix to
    // offer — only the option to dismiss it.
    var canFix = missed || a.mergeIndex != null;
    if (canFix) {
      var fix = document.createElement('button');
      fix.className = 'primary small';
      fix.textContent = missed ? 'Add the turn…'
        : 'Remove the turn between ' + (a.indices[0] + 1) + ' and ' + (a.indices[1] + 1);
      fix.addEventListener('click', function () {
        if (missed) openEditor(a.index);
        else { S.mergeLength(state.model, a.mergeIndex); draw(); }
      });
      acts.appendChild(fix);
    }
    var skip = document.createElement('button');
    skip.className = 'small ghost';
    skip.textContent = 'Dismiss';
    // Dismissing a pair has to dismiss both, or the other half is immediately
    // re-flagged on its own.
    skip.addEventListener('click', function () {
      (a.indices || [a.index]).forEach(function (i) { S.dismiss(state.model, i); });
      draw();
    });
    acts.appendChild(skip);
    return row;
  }

  function resolvedRow(l) {
    var i = state.model.lengths.indexOf(l);
    var row = document.createElement('div');
    row.className = 'issue resolved';
    var what = l.edit.type === 'split'
      ? 'Turn added — split into lengths ' + (i + 1) + ' and ' + (i + 2)
      : 'Turn removed — merged into length ' + (i + 1);
    row.innerHTML =
      '<span class="badge done" aria-hidden="true">✓</span>' +
      '<div class="grow"><div class="title"></div><div class="detail"></div></div>' +
      '<div class="actions"></div>';
    row.querySelector('.title').textContent = what;
    row.querySelector('.detail').textContent = l.edit.type === 'split'
      ? S.fmtDur(l.elapsedMs) + ' + ' +
        S.fmtDur(state.model.lengths[i + 1] ? state.model.lengths[i + 1].elapsedMs : 0) +
        ' · turn placed at ' + S.fmtDur(l.edit.at)
      : 'Now ' + S.fmtDur(l.elapsedMs) + ' with ' + (l.strokes == null ? '–' : l.strokes) + ' strokes';

    var undo = document.createElement('button');
    undo.className = 'small ghost';
    undo.textContent = 'Undo all';
    undo.title = 'Corrections build on each other, so undoing resets the file';
    undo.addEventListener('click', function () { S.resetAll(state.model); draw(); });
    row.querySelector('.actions').appendChild(undo);
    return row;
  }

  function dismissedRow(l) {
    var i = state.model.lengths.indexOf(l);
    var row = document.createElement('div');
    row.className = 'issue dismissed';
    row.innerHTML =
      '<span class="badge" aria-hidden="true">–</span>' +
      '<div class="grow"><div class="title"></div>' +
      '<div class="detail">Left exactly as the watch recorded it.</div></div>' +
      '<div class="actions"></div>';
    row.querySelector('.title').textContent = 'Length ' + (i + 1) + ' — dismissed';
    var restore = document.createElement('button');
    restore.className = 'small ghost';
    restore.textContent = 'Restore';
    restore.addEventListener('click', function () { l.edit = null; draw(); });
    row.querySelector('.actions').appendChild(restore);
    return row;
  }

  /* ---- Length table: the chart's accessible twin ---- */

  function drawTable() {
    var m = state.model;
    var t = $('lengthTable');
    var issues = {};
    state.issues.forEach(function (a) { flagAll(issues, a); });

    t.innerHTML = '<thead><tr><th class="l">#</th><th class="l">Stroke</th><th>Time</th>' +
      '<th>Pace</th><th>Strokes</th><th>Cadence</th><th class="l">Status</th><th></th></tr></thead>';
    var tb = document.createElement('tbody');

    var swum = 0;
    m.lengths.forEach(function (l, i) {
      var st = C.stateOf(l, issues);
      if (l.active) swum++;
      var tr = document.createElement('tr');
      tr.className = !l.active ? 'rest'
        : (st === 'missed' || st === 'false') ? 'flagged'
        : st === 'corrected' ? 'edited' : '';

      var cells = [
        l.active ? String(swum) : '–',
        l.active ? S.strokeName(l.swimStroke) : 'Rest',
        S.fmtDur(l.elapsedMs),
        l.active ? S.fmtPace((l.timerMs / 1000) / (m.poolLengthM / 100), m.displayUnit) : '–',
        l.strokes == null ? '–' : String(l.strokes),
        l.cadence == null ? '–' : l.cadence + ' spm'
      ];
      cells.forEach(function (c, ci) {
        var td = document.createElement('td');
        if (ci < 2) td.className = 'l';
        td.textContent = c;
        tr.appendChild(td);
      });

      var status = document.createElement('td');
      status.className = 'l';
      status.appendChild(tagFor(st, l));
      tr.appendChild(status);

      var act = document.createElement('td');
      if (l.active) {
        var b = document.createElement('button');
        b.className = 'small ghost';
        b.textContent = 'Edit';
        b.addEventListener('click', function () { openEditor(i); });
        act.appendChild(b);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
  }

  function tagFor(st, l) {
    var s = document.createElement('span');
    if (st === 'rest') { s.className = 'tag rest'; s.textContent = 'Rest'; }
    else if (st === 'missed') { s.className = 'tag missed'; s.textContent = '▲ Missed turn'; }
    else if (st === 'false') { s.className = 'tag false'; s.textContent = '▲ False turn'; }
    else if (st === 'corrected') { s.className = 'tag done'; s.textContent = '✓ Corrected'; }
    else if (l.edit && l.edit.type === 'dismissed') { s.className = 'tag rest'; s.textContent = 'Dismissed'; }
    else { s.textContent = ''; }
    return s;
  }

  /* ---- Split editor ---- */

  function openEditor(index) {
    var m = state.model;
    var l = m.lengths[index];
    if (!l || !l.active) return;

    state.selected = index;
    var host = $('modalHost');
    var splitMs = Math.round(l.elapsedMs / 2);
    var strokesFirst = l.strokes == null ? null : Math.round(l.strokes / 2);
    var manualStrokes = false;

    var canMerge = m.lengths[index + 1] && m.lengths[index + 1].active &&
                   S.lapIndexOf(m, l.srcIdx) === S.lapIndexOf(m, m.lengths[index + 1].srcIdx);

    host.innerHTML =
      '<div class="backdrop" id="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">' +
        '<div class="modal-head"><h2 id="mTitle"></h2><p id="mSub"></p></div>' +
        '<div class="modal-body">' +
          '<div class="split-vis">' +
            '<div class="split-track"><div class="split-half a" id="halfA"></div>' +
            '<div class="split-half b" id="halfB"></div></div>' +
            '<input type="range" class="split-slider" id="splitSlider" aria-label="Where the turn happened">' +
          '</div>' +
          '<div class="split-readout">' +
            '<div class="split-card" id="cardA"><div class="h">First length</div>' +
              '<div class="v" id="aTime"></div><div class="sub" id="aSub"></div></div>' +
            '<div class="split-card" id="cardB"><div class="h">Second length</div>' +
              '<div class="v" id="bTime"></div><div class="sub" id="bSub"></div></div>' +
          '</div>' +
          '<div class="stroke-row" id="strokeRow">' +
            '<label for="strokeA">Strokes in the first length</label>' +
            '<input type="number" id="strokeA" min="0">' +
            '<span class="confidence" id="strokeHint"></span>' +
          '</div>' +
          '<div class="note" id="mNote"></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          (canMerge ? '<button class="ghost" id="mergeBtn" style="margin-right:auto">Merge with next length instead</button>' : '') +
          '<button class="ghost" id="cancelBtn">Cancel</button>' +
          '<button class="primary" id="applyBtn">Add the turn</button>' +
        '</div>' +
      '</div></div>';

    var slider = $('splitSlider');
    slider.min = 1000;
    slider.max = Math.max(2000, Math.round(l.elapsedMs) - 1000);
    slider.step = 100;
    slider.value = splitMs;

    $('mTitle').textContent = 'Where was the turn in length ' + (index + 1) + '?';
    $('mSub').textContent = 'This length took ' + S.fmtDur(l.elapsedMs) +
      (l.strokes != null ? ' and recorded ' + l.strokes + ' strokes' : '') +
      '. Drag to place the turn; the default splits it down the middle.';

    var strokeInput = $('strokeA');
    if (l.strokes == null) {
      $('strokeRow').hidden = true;
    } else {
      strokeInput.max = l.strokes;
      strokeInput.addEventListener('input', function () {
        manualStrokes = true;
        var v = parseInt(strokeInput.value, 10);
        if (!isNaN(v)) { strokesFirst = Math.max(0, Math.min(l.strokes, v)); update(); }
      });
    }

    // FIT records no per-stroke timing — worth saying plainly rather than
    // implying the stroke split is measured.
    $('mNote').innerHTML = l.strokes == null
      ? 'This length has no stroke count, so only its time is split.'
      : 'FIT files record only a stroke <em>total</em> per length — there are no ' +
        'per-stroke timings to place the turn from. Strokes are divided in ' +
        'proportion to time; override the number if you know better. The total ' +
        'always stays at ' + l.strokes + '.';

    slider.addEventListener('input', function () {
      splitMs = parseInt(slider.value, 10);
      if (!manualStrokes && l.strokes != null) {
        strokesFirst = Math.round(l.strokes * (splitMs / l.elapsedMs));
      }
      update();
    });

    $('cancelBtn').addEventListener('click', close);
    $('backdrop').addEventListener('click', function (e) {
      if (e.target.id === 'backdrop') close();
    });
    document.addEventListener('keydown', onKey);

    $('applyBtn').addEventListener('click', function () {
      S.splitLength(state.model, index, splitMs, strokesFirst);
      close();
      draw();
    });
    if (canMerge) {
      $('mergeBtn').addEventListener('click', function () {
        S.mergeLength(state.model, index);
        close();
        draw();
      });
    }

    function onKey(e) { if (e.key === 'Escape') close(); }

    function close() {
      document.removeEventListener('keydown', onKey);
      host.innerHTML = '';
      state.selected = null;
      drawChart();
    }

    update();

    function update() {
      var frac = splitMs / l.elapsedMs;
      var aMs = splitMs, bMs = l.elapsedMs - splitMs;
      $('halfA').style.width = (frac * 100) + '%';
      $('halfB').style.width = ((1 - frac) * 100) + '%';
      $('halfA').textContent = S.fmtDur(aMs);
      $('halfB').textContent = S.fmtDur(bMs);
      $('aTime').textContent = S.fmtDur(aMs);
      $('bTime').textContent = S.fmtDur(bMs);

      var pace = function (ms) {
        return S.fmtPace((ms / 1000) / (state.model.poolLengthM / 100), state.model.displayUnit);
      };
      var sa = strokesFirst == null ? null : strokesFirst;
      var sb = strokesFirst == null ? null : l.strokes - strokesFirst;
      $('aSub').textContent = pace(aMs) + (sa == null ? '' : ' · ' + sa + ' strokes');
      $('bSub').textContent = pace(bMs) + (sb == null ? '' : ' · ' + sb + ' strokes');
      if (strokeInput && !manualStrokes) strokeInput.value = strokesFirst;
      if ($('strokeHint') && l.strokes != null) {
        $('strokeHint').textContent = 'of ' + l.strokes + ' · ' +
          (l.strokes - strokesFirst) + ' in the second';
      }

      // Flag halves that would themselves be unusual — a sign the split point
      // is in the wrong place.
      var actives = S.activeLengths(state.model).filter(function (x) { return x !== l; });
      var med = S.median(actives.map(function (x) { return x.elapsedMs; }));
      [['cardA', aMs], ['cardB', bMs]].forEach(function (p) {
        var off = med && (p[1] / med > 1.4 || p[1] / med < 0.6);
        $(p[0]).classList.toggle('warn', !!off);
      });
    }
  }

  /* ---- Export ---- */

  function drawExport() {
    var m = state.model;
    var body = $('exportBody');
    var d = S.diff(m);
    var outstanding = state.issues.length;
    var edited = S.corrections(m);

    body.innerHTML = '';

    // Export is always available. Correcting turns is not the only thing that
    // changes the file — rebuilding the record stream does too — and a swim with
    // anomalies you have chosen not to act on is still a swim you may want to
    // export.
    if (!edited) {
      var p = document.createElement('p');
      p.style.cssText = 'margin:0 0 4px;color:var(--text-secondary)';
      p.textContent = state.densify
        ? 'No turns have been corrected. The record stream is still rebuilt below, ' +
          'so the exported file will differ from your original.'
        : 'No turns have been corrected and the record stream is not being rebuilt, ' +
          'so the exported file will match your original.';
      body.appendChild(p);
    }

    var rows = [
      ['Lengths', d.before.activeLengths, d.after.activeLengths, function (v) { return v; }],
      ['Data points', m.records.length, state.densify ? m.lengths.length : m.records.length,
        function (v) { return v + (v === 1 ? ' record' : ' records'); }],
      ['Distance', d.before.distanceM, d.after.distanceM, function (v) { return S.fmtDistance(v, m.displayUnit); }],
      ['Pace', d.before.pacePer100, d.after.pacePer100, function (v) { return S.fmtPace(v, m.displayUnit); }],
      ['SWOLF', d.before.swolf, d.after.swolf, function (v) { return v == null ? '–' : v; }],
      ['Strokes', d.before.strokes, d.after.strokes, function (v) { return v; }],
      ['Calories', d.before.calories, d.after.calories, function (v) { return v + ' kcal'; }],
      ['Swim time', d.before.timerMs, d.after.timerMs, function (v) { return S.fmtClock(v); }]
    ];

    var table = document.createElement('table');
    table.className = 'changes';
    table.innerHTML = '<thead><tr><th>What changes</th><th>Original</th><th></th><th>Corrected</th></tr></thead>';
    var tb = document.createElement('tbody');
    rows.forEach(function (r) {
      var same = r[1] === r[2];
      var tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td style="color:var(--text-secondary)"></td>' +
                     '<td class="arrow" aria-hidden="true">' + (same ? '' : '→') + '</td>' +
                     '<td class="to"></td>';
      tr.children[0].textContent = r[0];
      tr.children[1].textContent = r[3](r[1]);
      tr.children[3].textContent = r[3](r[2]);
      if (same) {
        tr.children[3].textContent = 'unchanged';
        tr.children[3].style.color = 'var(--text-muted)';
        tr.children[3].style.fontWeight = '400';
      }
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    body.appendChild(table);

    if (outstanding) {
      var unresolved = document.createElement('div');
      unresolved.className = 'caution';
      unresolved.innerHTML =
        '<span class="caution-icon" aria-hidden="true">&#9888;</span>' +
        '<div><strong></strong><span></span></div>';
      unresolved.querySelector('strong').textContent = outstanding === 1
        ? 'One anomaly is still flagged'
        : outstanding + ' anomalies are still flagged';
      unresolved.querySelector('span:last-child').textContent =
        'You can export anyway — anything you have not corrected is left exactly as your ' +
        'watch recorded it. Dismiss an anomaly to stop it being flagged.';
      body.appendChild(unresolved);
    }

    if (d.after.calories !== d.before.calories) {
      var note = document.createElement('p');
      note.style.cssText = 'font-size:12px;color:var(--text-muted);margin:12px 0 0';
      note.textContent = 'Calories moved because the watch under-recorded them on the ' +
        'length with the missed turn. They have been re-estimated from the burn rate of ' +
        'the surrounding lengths.';
      body.appendChild(note);
    }

    // The device's own record stream is what graphing sites draw from, and some
    // watches write almost nothing: this file has one record per ~250s, so a
    // reader has to interpolate across four-minute gaps. Rebuilding at one per
    // length is the fix, but it adds messages the watch never wrote — so it is
    // a toggle, not a silent default.
    var sparse = m.records.length < m.lengths.length;
    var opt = document.createElement('label');
    opt.style.cssText = 'display:flex;gap:9px;align-items:flex-start;margin-top:16px;' +
      'padding:12px 14px;border:1px solid var(--border);border-radius:8px;cursor:pointer';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.densify;
    cb.style.marginTop = '3px';
    cb.addEventListener('change', function () { state.densify = cb.checked; drawExport(); });
    var txt = document.createElement('div');
    txt.innerHTML = '<strong>Rebuild the data stream — one record per length</strong>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-top:2px"></div>';
    txt.querySelector('div').textContent = sparse
      ? 'Your watch wrote only ' + m.records.length + ' records for ' + m.lengths.length +
        ' lengths — roughly one every ' + Math.round(
          (S.summarise(m).elapsedMs / 1000) / Math.max(1, m.records.length)) +
        ' seconds. Sites like Strava draw their pace graph from those, and across gaps ' +
        'that big the graph is mostly guesswork. This replaces them with one record at ' +
        'each length, which is the shape Garmin’s own SDK example uses. Turn it off to ' +
        'keep the watch’s original records untouched.'
      : 'Replaces the record stream with one record per length. Your watch already writes ' +
        m.records.length + ' records, so this is unlikely to change much.';
    opt.appendChild(cb);
    opt.appendChild(txt);
    body.appendChild(opt);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:16px';
    var dl = document.createElement('button');
    dl.className = 'primary';
    // Say what the file actually is. Calling it "corrected" when no turn was
    // corrected would be a lie, and the filename follows the same rule.
    dl.textContent = edited ? 'Download corrected .fit'
                   : state.densify ? 'Download rebuilt .fit'
                   : 'Download .fit';
    dl.addEventListener('click', download);
    btnRow.appendChild(dl);

    // Read before the download, not after: this is the moment a file gets
    // written and the original gets deleted from Strava.
    var caution = document.createElement('div');
    caution.className = 'caution';
    caution.innerHTML =
      '<span class="caution-icon" aria-hidden="true">&#9888;</span>' +
      '<div><strong>Keep your original file</strong>' +
      '<span>Your original is never altered — the corrected file is written fresh. Keep it ' +
      'anyway: getting this onto Strava means deleting the original activity there, and ' +
      're-uploading your original file is the only way back if the result is not what you ' +
      'wanted.</span>' +
      '<span>This tool is provided as-is, with no warranty. You are responsible for your ' +
      'own data: no liability is accepted for corrupted files, lost activities or anything ' +
      'else arising from its use.</span></div>';
    body.appendChild(caution);

    body.appendChild(btnRow);

    var callout = document.createElement('div');
    callout.className = 'callout';
    callout.innerHTML = '<span aria-hidden="true">ℹ</span><div><strong>Re-uploading to Strava</strong>' +
      '<ol><li>Delete the existing activity on Strava — it cannot be updated in place.</li>' +
      '<li>Upload the corrected file.</li></ol>' +
      '<span style="color:var(--text-secondary)">Everything else in the file — your device, ' +
      'timestamps and all the data we did not touch — is preserved exactly, so it uploads ' +
      'as the same activity from the same watch.</span></div>';
    body.appendChild(callout);
  }

  function download() {
    var m = state.model;
    // Read this before apply(), which rewrites the model in place.
    var suffix = S.corrections(m) ? '-corrected' : state.densify ? '-rebuilt' : '-export';
    var bytes;
    try {
      bytes = E.encode(S.apply(m, { densifyRecords: state.densify }));
    } catch (err) {
      showError('Could not build the file.', err.message);
      return;
    }

    // apply() rewrites the decoded structure in place, so reload from the new
    // bytes to keep what is on screen identical to what was just saved.
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    // Matches the button: a file with no corrections in it should not arrive
    // named "-corrected".
    a.download = state.fileName.replace(/\.fit$/i, '') + suffix + '.fit';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    state.model = S.load(D.decode(bytes));
    draw();
  }

  window.addEventListener('resize', function () { if (state.model) drawChart(); });

  window.Help.install({ trigger: $('btn-help'), label: 'Swim FIT Corrector help' });

})();
