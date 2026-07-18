// chart.js — lightweight canvas chart: HR series + plan intensity, with an
// offset the user can drag horizontally to align the plan against the recording.
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  var PAD = { top: 16, right: 54, bottom: 28, left: 46 };
  // Series colours are shared with the other tools — see shared/ui/chart-theme.js.
  // Note this uses planHeartRate rather than the usual heartRate: red against
  // the green plan line is indistinguishable for red-green colour blindness.
  var HR_COLOR = window.ChartTheme.SERIES.planHeartRate;
  var PLAN_COLOR = window.ChartTheme.SERIES.plan;
  var WINDOW_FILL = 'rgba(22, 163, 74, 0.10)';

  function create(canvas, callbacks) {
    callbacks = callbacks || {};
    var ctx = canvas.getContext('2d');
    var last = null; // { series, meta, geom }

    function fmtTime(sec) {
      var s = Math.round(sec);
      var neg = s < 0; s = Math.abs(s);
      var m = Math.floor(s / 60), r = s % 60;
      return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }

    function resize() {
      var ratio = window.devicePixelRatio || 1;
      var w = canvas.clientWidth || 640;
      var h = canvas.clientHeight || 240;
      canvas.width = w * ratio;
      canvas.height = h * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { w: w, h: h };
    }

    function render(series, meta) {
      if (series) last = { series: series, meta: meta || {} };
      if (!last) return;
      series = last.series; meta = last.meta;

      var dim = resize();
      var W = dim.w, H = dim.h;
      ctx.clearRect(0, 0, W, H);

      var plotW = W - PAD.left - PAD.right;
      var plotH = H - PAD.top - PAD.bottom;

      // X domain covers both recording and the (possibly shifted) plan window.
      var xlo = Math.min(0, series.planStartRel, series.planEndRel);
      var xhi = Math.max(series.durationSec, series.planStartRel, series.planEndRel);
      if (xhi - xlo < 1) xhi = xlo + 1;

      var planKind = meta.planKind || 'rate';
      var planMax = 0;
      series.plan.forEach(function (p) { if (p.y > planMax) planMax = p.y; });
      if (planMax <= 0) planMax = 1;
      var hrLo = Math.max(0, series.hrMin - 8);
      var hrHi = series.hrMax + 8;
      if (hrHi - hrLo < 1) hrHi = hrLo + 1;

      function xToPx(x) { return PAD.left + (x - xlo) / (xhi - xlo) * plotW; }
      function hrToPx(y) { return PAD.top + (1 - (y - hrLo) / (hrHi - hrLo)) * plotH; }
      function planToPx(y) { return PAD.top + (1 - y / (planMax * 1.1)) * plotH; }

      var geom = {
        pxPerSec: plotW / (xhi - xlo),
        xlo: xlo, xhi: xhi, plotLeft: PAD.left, plotRight: PAD.left + plotW
      };
      last.geom = geom;

      // Plan window shading.
      ctx.fillStyle = WINDOW_FILL;
      var wx0 = xToPx(series.planStartRel), wx1 = xToPx(series.planEndRel);
      ctx.fillRect(Math.min(wx0, wx1), PAD.top, Math.abs(wx1 - wx0), plotH);

      // Grid + axis frame.
      ctx.strokeStyle = 'rgba(128,128,128,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);

      // X ticks every ~1/6 of the span.
      ctx.fillStyle = window.ChartTheme.resolve().muted;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (var k = 0; k <= 6; k++) {
        var xv = xlo + (xhi - xlo) * k / 6;
        var px = xToPx(xv);
        ctx.fillText(fmtTime(xv), px, H - 10);
        ctx.beginPath();
        ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + plotH);
        ctx.strokeStyle = 'rgba(128,128,128,0.12)';
        ctx.stroke();
      }

      // Plan series (step-ish line).
      ctx.strokeStyle = PLAN_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      series.plan.forEach(function (p, i) {
        var px = xToPx(p.x), py = planToPx(p.y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Plan start marker.
      ctx.strokeStyle = PLAN_COLOR;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xToPx(series.planStartRel), PAD.top);
      ctx.lineTo(xToPx(series.planStartRel), PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // HR series.
      if (series.hr.length) {
        ctx.strokeStyle = HR_COLOR;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        series.hr.forEach(function (p, i) {
          var px = xToPx(p.x), py = hrToPx(p.y);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }

      // Left axis label (HR), right axis label (plan).
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = HR_COLOR;
      ctx.translate(12, PAD.top + plotH / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText('HR (bpm)', 0, 0);
      ctx.restore();

      ctx.save();
      ctx.fillStyle = PLAN_COLOR;
      ctx.translate(W - 14, PAD.top + plotH / 2); ctx.rotate(-Math.PI / 2);
      var planLabel = planKind === 'level' ? 'Level' : (planKind === 'altitude' ? 'Altitude (m)' : 'Climb (m/s)');
      ctx.fillText(planLabel, 0, 0);
      ctx.restore();
    }

    // Drag horizontally anywhere on the plot to shift the plan (change offset).
    var dragging = false, lastX = 0;
    function onDown(e) {
      dragging = true;
      lastX = (e.touches ? e.touches[0].clientX : e.clientX);
      canvas.style.cursor = 'ew-resize';
    }
    function onMove(e) {
      if (!dragging || !last || !last.geom) return;
      var cx = (e.touches ? e.touches[0].clientX : e.clientX);
      var dpx = cx - lastX;
      lastX = cx;
      var dSec = dpx / last.geom.pxPerSec;
      if (callbacks.onOffsetDelta) callbacks.onOffsetDelta(dSec);
      if (e.cancelable) e.preventDefault();
    }
    function onUp() { dragging = false; canvas.style.cursor = 'grab'; }

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('touchstart', onDown, { passive: true });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp);
    window.addEventListener('resize', function () { render(); });

    return { render: render };
  }

  Stair.chart = { create: create };
})();
