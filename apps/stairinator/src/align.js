// align.js — time-alignment helpers between the recorded file (GPX/FIT) and the plan.
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  // The plan's segment 1 begins at (fileStart + offsetSec).
  function planStartMs(parsed, offsetSec) {
    var t0 = parsed.points[0].timeMs;
    return t0 + (offsetSec || 0) * 1000;
  }

  // Build series (relative seconds from file start) for the alignment chart.
  // Returns { hr:[{x,y}], plan:[{x,y}], durationSec, hrMin, hrMax }.
  function buildSeries(parsed, profile, offsetSec, planKind) {
    var t0 = parsed.points[0].timeMs;
    var hr = [];
    var hrMin = Infinity, hrMax = -Infinity;
    parsed.points.forEach(function (p) {
      if (p.hr != null && !isNaN(p.hr)) {
        var x = (p.timeMs - t0) / 1000;
        hr.push({ x: x, y: p.hr });
        if (p.hr < hrMin) hrMin = p.hr;
        if (p.hr > hrMax) hrMax = p.hr;
      }
    });
    var lastMs = parsed.points[parsed.points.length - 1].timeMs;
    var durationSec = (lastMs - t0) / 1000;

    // Plan intensity sampled across the recording window, shifted by the offset.
    var plan = [];
    var startPlan = offsetSec;                 // where the plan begins (rel seconds)
    var endPlan = offsetSec + profile.totalTime;
    var lo = Math.min(0, startPlan);
    var hi = Math.max(durationSec, endPlan);
    var steps = 400;
    for (var i = 0; i <= steps; i++) {
      var x = lo + (hi - lo) * (i / steps);
      var y = profile.intensity(x - offsetSec, planKind);
      plan.push({ x: x, y: y });
    }

    return {
      hr: hr,
      plan: plan,
      durationSec: durationSec,
      hrMin: hrMin === Infinity ? 0 : hrMin,
      hrMax: hrMax === -Infinity ? 0 : hrMax,
      planStartRel: startPlan,
      planEndRel: endPlan
    };
  }

  Stair.align = { planStartMs: planStartMs, buildSeries: buildSeries };
})();
