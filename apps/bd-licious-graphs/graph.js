/*
 * Analysis + chart, dependency-free. Ports metrics.ts / restDetection.ts /
 * LapBarChart.tsx to plain JS. renderChart() returns an SVG string.
 * Exposes window.Graph (and module.exports for Node tests).
 */
(function (root) {
  'use strict';

  // ---- metric specs -------------------------------------------------------
  var METRIC_SPECS = {
    pace: { label: 'Pace', short: 'Pace', unit: '/km', zeroBased: true, decimals: 0, paceMetres: 1000 },
    cadence: { label: 'Cadence', short: 'Cad', unit: 'spm', zeroBased: true, decimals: 0 },
    stride: { label: 'Stride length', short: 'Stride', unit: 'm', zeroBased: true, decimals: 2 },
    heartRate: { label: 'Heart rate', short: 'HR', unit: 'bpm', zeroBased: true, decimals: 0 },
    // Not zero-based: these vary over a narrow band well away from zero, and
    // anchoring the axis at 0 would flatten the whole point of looking at them.
    gct: { label: 'Ground contact', short: 'GCT', unit: 'ms', zeroBased: false, decimals: 0 },
    verticalOscillation: { label: 'Vertical oscillation', short: 'Vert osc', unit: 'mm', zeroBased: false, decimals: 1 },
    swimPace: { label: 'Pace', short: 'Pace', unit: '/100m', zeroBased: true, decimals: 0, paceMetres: 100 },
    lengthTime: { label: 'Time / length', short: 'Time', unit: '', zeroBased: true, decimals: 0, isTime: true },
    strokes: { label: 'Strokes / length', short: 'Strokes', unit: '', zeroBased: true, decimals: 0 },
    swolf: { label: 'SWOLF', short: 'SWOLF', unit: '', zeroBased: true, decimals: 0 },
  };
  // One source for series colours — see shared/ui/chart-theme.js.
  var METRIC_COLORS = window.ChartTheme.SERIES;
  var RUN_METRICS = ['pace', 'cadence', 'stride', 'heartRate', 'gct', 'verticalOscillation'];
  var SWIM_METRICS = ['swimPace', 'lengthTime', 'strokes', 'swolf'];

  function num(v) { return typeof v === 'number' ? v : undefined; }
  function strideLength(speed, cadence) {
    if (!speed || !cadence) return undefined;
    var sps = cadence / 60;
    return sps > 0 ? speed / sps : undefined;
  }
  function formatDuration(sec) {
    if (!isFinite(sec)) return '—';
    var t = Math.round(sec);
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }
  function formatMetric(value, metric) {
    var spec = METRIC_SPECS[metric];
    if (spec.paceMetres) return formatDuration(value > 0.1 ? spec.paceMetres / value : Infinity);
    if (spec.isTime) return formatDuration(value);
    return value.toFixed(spec.decimals);
  }
  function metricValue(lap, metric) {
    switch (metric) {
      case 'pace': return lap.avgSpeed;
      case 'cadence': return lap.avgCadence;
      case 'stride': return lap.avgStepLength != null ? lap.avgStepLength : strideLength(lap.avgSpeed, lap.avgCadence);
      case 'heartRate': return lap.avgHeartRate;
      case 'gct': return lap.avgGroundContactTime;
      case 'verticalOscillation': return lap.avgVerticalOscillation;
      case 'swimPace': return lap.avgSpeed;
      case 'lengthTime': return lap.elapsedTime;
      case 'strokes': return lap.strokes;
      case 'swolf': return lap.swolf;
    }
  }
  function sampleValue(s, metric) {
    switch (metric) {
      case 'pace': return s.speed;
      case 'cadence': return s.cadence;
      case 'stride': return s.stepLength != null ? s.stepLength : strideLength(s.speed, s.cadence);
      case 'heartRate': return s.heartRate;
      case 'gct': return s.groundContactTime;
      case 'verticalOscillation': return s.verticalOscillation;
      default: return undefined; // swim metrics have no per-sample data
    }
  }
  function lapStats(lap, metric, samples, clip) {
    var vals = [];
    for (var i = lap.startIndex; i <= lap.endIndex && i < samples.length; i++) {
      var v = sampleValue(samples[i], metric);
      if (typeof v === 'number') vals.push(v);
    }
    var agg = metricValue(lap, metric);
    if (vals.length === 0) return typeof agg === 'number' ? { min: agg, max: agg, avg: agg } : null;
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var k = Math.min(Math.floor((clip || 0) * sorted.length), Math.floor((sorted.length - 1) / 2));
    var kept = sorted.slice(k, sorted.length - k);
    var avg = k > 0 ? kept.reduce(function (a, b) { return a + b; }, 0) / kept.length
      : (typeof agg === 'number' ? agg : vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
    return { min: kept[0], max: kept[kept.length - 1], avg: avg };
  }
  function ewma(values, alpha) {
    var out = [], prev = values[0] || 0;
    for (var i = 0; i < values.length; i++) { prev = alpha * values[i] + (1 - alpha) * prev; out.push(prev); }
    return out;
  }
  function workTimeDomain(laps) {
    var work = laps.filter(function (l) { return !l.isRest; });
    var src = work.length ? work : laps;
    if (!src.length) return [0, 1];
    var start = Math.min.apply(null, src.map(function (l) { return l.startTime; }));
    var end = Math.max.apply(null, src.map(function (l) { return l.startTime + l.elapsedTime; }));
    return [start, Math.max(end, start + 1)];
  }

  // ---- rest detection -----------------------------------------------------
  function classifyRest(activity, sensitivity) {
    var laps = activity.laps;
    var hasIntensity = laps.some(function (l) { return l.fitIntensity === 'rest' || l.fitIntensity === 'recovery'; });
    if (hasIntensity) {
      return laps.map(function (l) {
        var r = l.fitIntensity === 'rest' || l.fitIntensity === 'recovery';
        return Object.assign({}, l, { isRest: r, restSource: 'fit-intensity' });
      });
    }
    var noRest = function () { return laps.map(function (l) { return Object.assign({}, l, { isRest: false, restSource: 'none' }); }); };
    if (activity.sport === 'swimming') return noRest();
    var speeds = laps.map(function (l) { return l.avgSpeed; }).filter(function (s) { return typeof s === 'number'; });
    if (speeds.length < 3) return noRest();
    var split = bestSplit(speeds);
    if (!split) return noRest();
    var gap = (split.highMean - split.lowMean) / split.highMean;
    var minGap = 0.5 - 0.35 * Math.max(0, Math.min(1, sensitivity));
    if (gap < minGap) return noRest();
    var classified = laps.map(function (l) {
      var r = typeof l.avgSpeed === 'number' && l.avgSpeed <= split.threshold;
      return Object.assign({}, l, { isRest: r, restSource: r ? 'pace-cluster' : 'none' });
    });
    if (classified.every(function (l) { return l.isRest; })) return noRest();
    return classified;
  }
  function bestSplit(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    if (s[0] === s[s.length - 1]) return null;
    var best = null;
    for (var i = 1; i < s.length; i++) {
      var lo = s.slice(0, i), hi = s.slice(i);
      var lm = mean(lo), hm = mean(hi), wss = sumSq(lo, lm) + sumSq(hi, hm);
      if (!best || wss < best.wss) best = { wss: wss, lowMean: lm, highMean: hm, threshold: (s[i - 1] + s[i]) / 2 };
    }
    return best;
  }
  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }
  function sumSq(xs, m) { return xs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0); }

  // ---- chart --------------------------------------------------------------
  var W = 900, H = 396, TOP = 28, PLOT_H = H - TOP - 66, REST_OPACITY = 0.22;
  var CAPTION = 'Generated by bd-licious graphs';
  // Palette is shared with the other tools — see shared/ui/chart-theme.js.
  var THEMES = window.ChartTheme.THEMES;
  var TYPE_Z = { bar: 0, range: 1, trace: 2, line: 3 };

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function statVal(stat, s) { return stat === 'min' ? s.min : stat === 'max' ? s.max : s.avg; }
  function topVal(g, stat, s) { return g === 'range' ? s.max : statVal(stat, s); }
  function lowVal(g, stat, s) { return g === 'range' ? s.min : statVal(stat, s); }
  function labelVal(g, stat, s) { return g === 'range' ? s.avg : statVal(stat, s); }
  function mmss(sec) { var t = Math.round(sec); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }
  function axisTicks(min, max, n) { var step = (max - min) / n, out = []; for (var i = 0; i < n; i++) out.push(min + step * (i + 1)); return out; }

  // rows: [{ metric, graphType, statistic, labels, rests, clip, smoothingSec, color }]
  function renderChart(o) {
    var laps = o.laps, samples = o.samples, rows = o.rows;
    var theme = o.theme || 'light', bg = THEMES[theme].bg, fg = THEMES[theme].fg;
    var yStart = o.yStart || 0, showTime = o.showTime !== false, showDistance = !!o.showDistance;
    var zones = o.zones, showZones = !!o.showZones;
    var metrics = rows.map(function (r) { return r.metric; });
    var baseY = TOP + PLOT_H;
    var workLaps = laps.filter(function (l) { return !l.isRest; });
    var colorOf = function (i) { return rows[i].color || METRIC_COLORS[metrics[i]]; };
    var clipOf = function (i) { return rows[i].clip || 0; };

    var xd = o.xDomain || [0, Math.max.apply(null, laps.map(function (l) { return l.startTime + l.elapsedTime; }).concat([1]))];
    var xMin = xd[0], xMax = xd[1], spanX = Math.max(1, xMax - xMin);

    function traceVals(m, clip) {
      var vals = samples.filter(function (s) { return s.t >= xMin - 1 && s.t <= xMax + 1; })
        .map(function (s) { return sampleValue(s, m); }).filter(function (v) { return typeof v === 'number'; });
      if (!vals.length) return [];
      var s = vals.slice().sort(function (a, b) { return a - b; });
      var k = Math.min(Math.floor(clip * s.length), Math.floor((s.length - 1) / 2));
      return s.slice(k, s.length - k);
    }

    var shareSwolfTime = metrics.indexOf('swolf') >= 0 && metrics.indexOf('lengthTime') >= 0;
    var groupOf = function (m) { return shareSwolfTime && (m === 'swolf' || m === 'lengthTime') ? 'swolf+time' : m; };
    var order = []; metrics.forEach(function (m) { if (order.indexOf(m) < 0) order.push(m); });

    var extent = {};
    rows.forEach(function (r, i) {
      var spec = METRIC_SPECS[r.metric], key = groupOf(r.metric);
      var acc = extent[key] || (extent[key] = { tops: [], lows: [], zeroBased: spec.zeroBased });
      if (r.graphType === 'trace') {
        var v = traceVals(r.metric, clipOf(i));
        if (v.length) { acc.tops.push(v[v.length - 1]); acc.lows.push(v[0]); }
      } else {
        for (var j = 0; j < workLaps.length; j++) {
          var st = lapStats(workLaps[j], r.metric, samples, clipOf(i));
          if (!st) continue;
          acc.tops.push(topVal(r.graphType, r.statistic, st));
          acc.lows.push(lowVal(r.graphType, r.statistic, st));
        }
      }
      acc.zeroBased = acc.zeroBased && spec.zeroBased;
    });

    var groupScale = {};
    Object.keys(extent).forEach(function (key) {
      var acc = extent[key]; if (!acc.tops.length) return;
      var dMax = Math.max.apply(null, acc.tops);
      var dMin = acc.zeroBased ? 0 : Math.min.apply(null, acc.lows);
      var pad = (dMax - dMin) * 0.06 || Math.abs(dMax) * 0.06 || 1;
      dMax += pad; if (!acc.zeroBased) dMin -= pad;
      if (dMax <= dMin) dMax = dMin + 1;
      dMin += Math.max(0, Math.min(0.95, yStart)) * (dMax - dMin);
      var span = Math.max(1e-6, dMax - dMin);
      groupScale[key] = { domainMin: dMin, domainMax: dMax, yOf: (function (dm, sp) {
        return function (v) { return Math.max(TOP, Math.min(baseY, baseY - ((v - dm) / sp) * PLOT_H)); };
      })(dMin, span) };
    });

    var scaleByMetric = {}; var axisCount = 0;
    order.forEach(function (m) {
      var gs = groupScale[groupOf(m)]; if (!gs) return;
      var axisIdx = axisCount < 2 ? axisCount : -1; axisCount++;
      scaleByMetric[m] = { metric: m, color: colorOf(metrics.indexOf(m)), domainMin: gs.domainMin, domainMax: gs.domainMax, yOf: gs.yOf, axisIdx: axisIdx };
    });
    var scaleList = order.map(function (m) { return scaleByMetric[m]; }).filter(Boolean);
    if (!scaleList.length) return emptyChart('No ' + (METRIC_SPECS[metrics[0]].label.toLowerCase()) + ' data', bg, fg);

    var hasRight = scaleList.some(function (s) { return s.axisIdx === 1; });
    var left = 60, right = hasRight ? 62 : 18, plotW = W - left - right;
    var xOf = function (t) { return left + ((t - xMin) / spanX) * plotW; };
    var clampX = function (x) { return Math.max(left, Math.min(W - right, x)); };
    var inDom = function (l) { return xOf(l.startTime + l.elapsedTime) > left + 0.5 && xOf(l.startTime) < W - right - 0.5; };
    var anyRest = rows.some(function (r) { return r.rests; });
    var hrScale = scaleByMetric.heartRate;

    var out = [];
    out.push('<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img">');
    out.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + bg + '"/>');

    // y axes
    scaleList.forEach(function (sc) {
      if (sc.axisIdx < 0) return;
      var onRight = sc.axisIdx === 1;
      axisTicks(sc.domainMin, sc.domainMax, 4).forEach(function (v) {
        if (!onRight) out.push('<line x1="' + left + '" y1="' + sc.yOf(v).toFixed(1) + '" x2="' + (W - right) + '" y2="' + sc.yOf(v).toFixed(1) + '" stroke="' + fg + '" stroke-opacity="0.12"/>');
        out.push('<text x="' + (onRight ? W - right + 8 : left - 8) + '" y="' + sc.yOf(v).toFixed(1) + '" text-anchor="' + (onRight ? 'start' : 'end') + '" dominant-baseline="middle" font-size="12" fill="' + sc.color + '">' + esc(formatMetric(v, sc.metric)) + '</text>');
      });
    });

    // x axis + interval labels (work laps only)
    out.push('<line x1="' + left + '" y1="' + baseY + '" x2="' + (W - right) + '" y2="' + baseY + '" stroke="' + fg + '" stroke-opacity="0.35"/>');
    laps.forEach(function (l) {
      if (l.isRest || !inDom(l)) return;
      var cx = (clampX(xOf(l.startTime)) + clampX(xOf(l.startTime + l.elapsedTime))) / 2;
      var lines = [];
      if (showTime) lines.push(mmss(l.elapsedTime));
      if (showDistance && typeof l.distance === 'number') lines.push(fmtDist(l.distance));
      lines.forEach(function (t, li) { out.push('<text x="' + cx.toFixed(1) + '" y="' + (baseY + 16 + li * 12) + '" text-anchor="middle" font-size="11" fill="' + fg + '" fill-opacity="0.7">' + esc(t) + '</text>'); });
    });

    // rest gaps
    if (!anyRest) laps.forEach(function (l) {
      if (!l.isRest || !inDom(l)) return;
      var x0 = clampX(xOf(l.startTime)), w = Math.max(0, clampX(xOf(l.startTime + l.elapsedTime)) - x0);
      out.push('<line x1="' + x0.toFixed(1) + '" y1="' + baseY + '" x2="' + (x0 + w).toFixed(1) + '" y2="' + baseY + '" stroke="' + scaleList[0].color + '" stroke-opacity="0.25" stroke-width="2"/>');
    });

    // marks: bars+ranges (back), traces, lines (front)
    function lapMarks(l, allow) {
      if (!inDom(l)) return;
      var items = [];
      rows.forEach(function (r, i) {
        if (!allow(r.graphType)) return;
        var sc = scaleByMetric[r.metric]; if (!sc) return;
        var st = lapStats(l, r.metric, samples, clipOf(i)); if (!st) return;
        items.push({ i: i, r: r, sc: sc, st: st, topY: sc.yOf(topVal(r.graphType, r.statistic, st)) });
      });
      var shown = l.isRest ? items.filter(function (it) { return rows[it.i].rests; }) : items;
      if (!shown.length) return;
      var op = l.isRest ? REST_OPACITY : 1;
      var x0 = clampX(xOf(l.startTime)), w = Math.max(0, clampX(xOf(l.startTime + l.elapsedTime)) - x0 - 1.5);
      shown.sort(function (a, b) { return (TYPE_Z[a.r.graphType] - TYPE_Z[b.r.graphType]) || (a.topY - b.topY); });
      shown.forEach(function (it) {
        out.push(mark(it.r.graphType, x0, w, baseY, it.r.color || METRIC_COLORS[it.r.metric], op,
          it.sc.yOf(statVal(it.r.statistic, it.st)), it.sc.yOf(it.st.avg), it.sc.yOf(it.st.min), it.sc.yOf(it.st.max)));
      });
    }
    laps.forEach(function (l) { lapMarks(l, function (g) { return g === 'bar' || g === 'range'; }); });
    rows.forEach(function (r, i) {
      if (r.graphType !== 'trace') return;
      var sc = scaleByMetric[r.metric]; if (!sc) return;
      var pts = samples.map(function (s) { return { t: s.t, v: sampleValue(s, r.metric) }; })
        .filter(function (p) { return typeof p.v === 'number' && p.t >= xMin - 1 && p.t <= xMax + 1; });
      if (pts.length < 2) return;
      var alpha = Math.min(1, Math.max(0.02, (spanX / Math.max(1, samples.length)) / (r.smoothingSec || 10)));
      var sm = ewma(pts.map(function (p) { return p.v; }), alpha);
      var d = pts.map(function (p, idx) { return (idx === 0 ? 'M' : 'L') + xOf(p.t).toFixed(1) + ',' + sc.yOf(sm[idx]).toFixed(1); }).join(' ');
      out.push('<path d="' + d + '" fill="none" stroke="' + (r.color || METRIC_COLORS[r.metric]) + '" stroke-width="2" stroke-linejoin="round"/>');
    });
    laps.forEach(function (l) { lapMarks(l, function (g) { return g === 'line'; }); });

    // value labels
    laps.forEach(function (l) {
      if (l.isRest || !inDom(l)) return;
      var items = [];
      rows.forEach(function (r, i) {
        if (r.graphType === 'trace' || !r.labels) return;
        var sc = scaleByMetric[r.metric]; if (!sc) return;
        var st = lapStats(l, r.metric, samples, clipOf(i)); if (!st) return;
        items.push({ i: i, r: r, sc: sc, st: st, topY: sc.yOf(topVal(r.graphType, r.statistic, st)) });
      });
      if (!items.length) return;
      var cx = (clampX(xOf(l.startTime)) + clampX(xOf(l.startTime + l.elapsedTime))) / 2;
      var topLabelY = Math.min.apply(null, items.map(function (it) { return it.topY; }));
      items.sort(function (a, b) { return a.i - b.i; });
      items.forEach(function (it, j) {
        out.push('<text x="' + cx.toFixed(1) + '" y="' + (topLabelY - 6 - (items.length - 1 - j) * 13).toFixed(1) + '" text-anchor="middle" font-size="10" fill="' + (it.r.color || METRIC_COLORS[it.r.metric]) + '">' + esc(formatMetric(labelVal(it.r.graphType, it.r.statistic, it.st), it.r.metric)) + '</text>');
      });
    });

    // HR zones
    if (showZones && hrScale && zones) zones.forEach(function (z, n) {
      if (z <= hrScale.domainMin || z >= hrScale.domainMax) return;
      var y = hrScale.yOf(z);
      out.push('<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (W - right) + '" y2="' + y.toFixed(1) + '" stroke="' + fg + '" stroke-opacity="0.3" stroke-dasharray="4 4"/>');
      out.push('<text x="' + (left + 4) + '" y="' + (y + 11).toFixed(1) + '" font-size="10" fill="' + fg + '" fill-opacity="0.5">Z' + (n + 1) + '</text>');
    });

    // titles + caption
    scaleList.forEach(function (sc) {
      if (sc.axisIdx < 0) return;
      var spec = METRIC_SPECS[sc.metric];
      out.push('<text x="' + (sc.axisIdx === 1 ? W - right : left) + '" y="16" text-anchor="' + (sc.axisIdx === 1 ? 'end' : 'start') + '" font-size="13" fill="' + sc.color + '">' + esc(spec.label + (spec.unit ? ' (' + spec.unit + ')' : '')) + '</text>');
    });
    out.push('<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="' + fg + '" fill-opacity="0.45">' + CAPTION + '</text>');
    out.push('</svg>');
    return out.join('');
  }

  function mark(type, x, w, baseY, color, op, yStat, yAvg, yMin, yMax) {
    var s;
    if (type === 'bar') s = '<rect x="' + x.toFixed(1) + '" y="' + yStat.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (baseY - yStat).toFixed(1) + '" fill="' + color + '" rx="1.5"/>';
    else if (type === 'line') s = '<line x1="' + x.toFixed(1) + '" y1="' + yStat.toFixed(1) + '" x2="' + (x + w).toFixed(1) + '" y2="' + yStat.toFixed(1) + '" stroke="' + color + '" stroke-width="3" stroke-linecap="round"/>';
    else if (type === 'range') s = '<rect x="' + x.toFixed(1) + '" y="' + yMax.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(1, yMin - yMax).toFixed(1) + '" fill="' + color + '" fill-opacity="0.45" rx="1.5"/><line x1="' + x.toFixed(1) + '" y1="' + yAvg.toFixed(1) + '" x2="' + (x + w).toFixed(1) + '" y2="' + yAvg.toFixed(1) + '" stroke="' + color + '" stroke-width="2.5"/>';
    else s = '';
    return '<g opacity="' + op + '">' + s + '</g>';
  }
  function emptyChart(label, bg, fg) {
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + bg + '"/><text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="' + fg + '" fill-opacity="0.6">' + esc(label) + '</text></svg>';
  }

  var Graph = {
    METRIC_SPECS: METRIC_SPECS, METRIC_COLORS: METRIC_COLORS, RUN_METRICS: RUN_METRICS, SWIM_METRICS: SWIM_METRICS,
    THEMES: THEMES, classifyRest: classifyRest, workTimeDomain: workTimeDomain, renderChart: renderChart,
    metricValue: metricValue, formatMetric: formatMetric,
  };
  root.Graph = Graph;
  if (typeof module !== 'undefined' && module.exports) module.exports = Graph;
})(typeof window !== 'undefined' ? window : globalThis);
