/* Per-length bar chart, hand-rolled SVG.
 *
 * The bar's job is magnitude (how long each length took) with state layered on
 * top. Colour never carries state alone: every flagged bar also gets a marker
 * glyph, and every state is named in the legend and the table below the chart.
 * That matters here because "suspected missed turn" and "corrected" would
 * otherwise be red vs green — a pair a red-green colourblind swimmer cannot
 * separate (ΔE 4.1 under deuteranopia).
 */
(function (root) {
  'use strict';

  var S = root.SwimModel;
  var NS = 'http://www.w3.org/2000/svg';

  var PAD = { top: 26, right: 12, bottom: 26, left: 42 };
  var MIN_BAR = 9;
  var MAX_BAR = 34;
  var GAP = 2;              // 2px surface gap between adjacent bars
  var HEIGHT = 260;

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  /* The top tick must cover the tallest bar, or bars overflow the plot and get
   * clipped by the scroll container — taking the markers drawn above them with
   * it. Round the ceiling up to a whole step rather than trusting the divisor. */
  function niceTicks(max, count) {
    var raw = Math.max(max, 1e-6) / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var top = Math.ceil(max / step) * step;
    var out = [];
    for (var i = 0; i * step <= top + 1e-9; i++) out.push(i * step);
    return out;
  }

  /* state per length: 'rest' | 'missed' | 'false' | 'corrected' | 'normal' */
  function stateOf(l, flagged) {
    if (!l.active) return 'rest';
    if (l.edit && l.edit.type === 'split') return 'corrected';
    if (l.edit && l.edit.type === 'merge') return 'corrected';
    var f = flagged[l._idx];
    if (f && (!l.edit || l.edit.type !== 'dismissed')) {
      return f.kind === 'missed_turn' ? 'missed' : 'false';
    }
    return 'normal';
  }

  var FILL = {
    rest: 'var(--rest)',
    missed: 'var(--critical)',
    'false': 'var(--warning)',
    corrected: 'var(--series-1)',
    normal: 'var(--series-1)'
  };

  function render(svg, model, issues, opts) {
    opts = opts || {};
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var lengths = model.lengths;
    lengths.forEach(function (l, i) { l._idx = i; });

    var flagged = {};
    issues.forEach(function (a) { flagged[a.index] = a; });

    var barW = Math.max(MIN_BAR, Math.min(MAX_BAR,
      Math.floor((svg.parentNode.clientWidth - PAD.left - PAD.right) / Math.max(1, lengths.length)) - GAP));
    var plotW = lengths.length * (barW + GAP);
    var width = PAD.left + plotW + PAD.right;
    var plotH = HEIGHT - PAD.top - PAD.bottom;

    svg.setAttribute('width', width);
    svg.setAttribute('height', HEIGHT);
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + HEIGHT);

    var maxSec = Math.max.apply(null, lengths.map(function (l) { return l.elapsedMs / 1000; }));
    var ticks = niceTicks(maxSec, 4);
    var top = ticks[ticks.length - 1];
    var y = function (sec) { return PAD.top + plotH - (sec / top) * plotH; };

    // Gridlines behind everything, recessive.
    var grid = el('g', { 'class': 'grid' }, svg);
    var axis = el('g', { 'class': 'axis' }, svg);
    ticks.forEach(function (t) {
      if (t === 0) return;
      el('line', { x1: PAD.left, x2: PAD.left + plotW, y1: y(t), y2: y(t) }, grid);
      el('text', { x: PAD.left - 7, y: y(t) + 3, 'text-anchor': 'end' }, axis)
        .textContent = fmtTick(t);
    });

    // Median reference — the baseline the detector actually compares against.
    var actives = lengths.filter(function (l) { return l.active; });
    if (actives.length > 2) {
      var med = S.median(actives.map(function (l) { return l.elapsedMs / 1000; }));
      el('line', { 'class': 'median-line', x1: PAD.left, x2: PAD.left + plotW,
                   y1: y(med), y2: y(med) }, svg);
      el('text', { 'class': 'median-label', x: PAD.left + 3, y: y(med) - 4 }, svg)
        .textContent = 'median ' + med.toFixed(1) + 's';
    }

    el('line', { 'class': 'baseline', x1: PAD.left, x2: PAD.left + plotW,
                 y1: y(0), y2: y(0) }, svg);

    var bars = el('g', {}, svg);
    lengths.forEach(function (l, i) {
      var st = stateOf(l, flagged);
      var sec = l.elapsedMs / 1000;
      var x = PAD.left + i * (barW + GAP);
      var h = Math.max(2, y(0) - y(sec));

      var g = el('g', { 'class': 'bar' + (opts.selected === i ? ' selected' : ''),
                        tabindex: 0, role: 'listitem' }, bars);
      g.dataset.index = i;

      // 4px rounded top, anchored to the baseline.
      el('path', {
        'class': 'fill',
        d: roundedTop(x, y(sec), barW, h, Math.min(4, barW / 2)),
        fill: FILL[st],
        opacity: st === 'rest' ? 0.55 : 1
      }, g);

      // A corrected length reads as blue like any other, so the underline and
      // the tick below carry the state instead — shape and position, not hue.
      // (Colouring it green would collide with the red of a flagged bar for a
      // red-green colourblind reader: ΔE 4.1 under deuteranopia.)
      if (st === 'corrected') {
        el('rect', { 'class': 'edit-underline', x: x, y: y(0) + 2, width: barW, height: 2 }, g);
      }

      // Icon above flagged bars: colour is never the only signal.
      if (st === 'missed' || st === 'false') {
        el('text', { 'class': 'flag', x: x + barW / 2, y: y(sec) - 6,
                     'text-anchor': 'middle', fill: FILL[st] }, g)
          .textContent = '▲';
      } else if (st === 'corrected' && l.edit.half !== 'second') {
        el('text', { 'class': 'flag', x: x + barW / 2, y: y(sec) - 6,
                     'text-anchor': 'middle', fill: 'var(--good-text)' }, g)
          .textContent = '✓';
      }

      // Hit target spans the full plot height, bigger than the mark itself.
      el('rect', { 'class': 'hit', x: x, y: PAD.top, width: barW, height: plotH,
                   fill: 'transparent' }, g);

      g._length = l;
      g._state = st;
      g._issue = flagged[i];
    });

    // X labels thin out to whatever fits.
    var every = Math.max(1, Math.ceil(lengths.length / Math.floor(plotW / 26)));
    lengths.forEach(function (l, i) {
      if (i % every !== 0 && i !== lengths.length - 1) return;
      el('text', { x: PAD.left + i * (barW + GAP) + barW / 2, y: HEIGHT - 9,
                   'text-anchor': 'middle' }, axis).textContent = (i + 1);
    });

    el('text', { x: PAD.left - 7, y: y(0) + 3, 'text-anchor': 'end' }, axis).textContent = '0';

    return { barW: barW, y: y };
  }

  function roundedTop(x, y, w, h, r) {
    r = Math.min(r, h);
    return 'M' + x + ',' + (y + h) +
           'V' + (y + r) +
           'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + -r +
           'h' + (w - 2 * r) +
           'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
           'V' + (y + h) + 'Z';
  }

  function fmtTick(sec) {
    if (sec >= 60) {
      var m = Math.floor(sec / 60), s = Math.round(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    return Math.round(sec) + 's';
  }

  var LEGEND = [
    { key: 'normal', label: 'Length', swatch: 'var(--series-1)' },
    { key: 'missed', label: '▲ Suspected missed turn', swatch: 'var(--critical)' },
    { key: 'false', label: '▲ Suspected false turn', swatch: 'var(--warning)' },
    { key: 'corrected', label: '✓ Corrected', swatch: 'var(--series-1)' },
    { key: 'rest', label: 'Rest', swatch: 'var(--rest)' }
  ];

  function renderLegend(node, present) {
    node.innerHTML = '';
    LEGEND.forEach(function (item) {
      if (present && !present[item.key]) return;
      var d = document.createElement('div');
      d.className = 'item';
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = item.swatch;
      if (item.key === 'rest') sw.style.opacity = '0.55';
      d.appendChild(sw);
      d.appendChild(document.createTextNode(item.label));
      node.appendChild(d);
    });
  }

  root.SwimChart = { render: render, renderLegend: renderLegend, stateOf: stateOf, FILL: FILL };

})(typeof self !== 'undefined' ? self : this);
