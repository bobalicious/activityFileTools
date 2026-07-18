// elevation.js — climb rate, forward-distance rate, and the cumulative curves
// E(t) (altitude) and D(t) (forward distance) plus cadence, over plan time.
(function () {
  'use strict';
  window.Stair = window.Stair || {};
  var model = Stair.model;

  function riserOf(machine) {
    return machine.riser != null ? Number(machine.riser)
      : (machine.stepHeight != null ? Number(machine.stepHeight) : 0); // back-compat
  }
  function treadOf(machine) {
    return machine.tread != null ? Number(machine.tread) : 0;
  }

  // Metres climbed per second at a given level.
  function climbRate(machine, level) {
    var spm = model.levelCadence(machine, level);
    if (spm == null) return null;
    return spm * riserOf(machine) / 60; // (steps/min * m/step) / 60 = m/s
  }
  // Metres travelled forward per second at a given level.
  function forwardRate(machine, level) {
    var spm = model.levelCadence(machine, level);
    if (spm == null) return null;
    return spm * treadOf(machine) / 60;
  }

  // Build the full profile for a plan on its machine.
  // t is seconds elapsed since the plan start.
  function buildProfile(plan, machine) {
    var elev = 0, dist = 0, t = 0;
    var intervals = [];
    (plan.segments || []).forEach(function (seg) {
      var cr = climbRate(machine, seg.level); if (cr == null || isNaN(cr) || cr < 0) cr = 0;
      var fr = forwardRate(machine, seg.level); if (fr == null || isNaN(fr) || fr < 0) fr = 0;
      var spm = model.levelCadence(machine, seg.level); if (spm == null || isNaN(spm)) spm = 0;
      var dur = (Number(seg.minutes) || 0) * 60 + (Number(seg.seconds) || 0); if (!(dur > 0)) dur = 0;
      intervals.push({
        start: t, end: t + dur, climbRate: cr, fwdRate: fr,
        stepsPerMin: spm, elevStart: elev, distStart: dist, level: seg.level
      });
      elev += cr * dur; dist += fr * dur; t += dur;
    });
    var totalTime = t, finalElev = elev, finalDist = dist;

    function find(time) {
      for (var i = 0; i < intervals.length; i++) {
        if (time >= intervals[i].start && time < intervals[i].end) return intervals[i];
      }
      return null;
    }
    // Altitude (metres): monotonic non-decreasing, holds at both ends.
    function E(time) {
      if (time <= 0) return 0;
      if (time >= totalTime) return finalElev;
      var iv = find(time);
      return iv ? iv.elevStart + iv.climbRate * (time - iv.start) : finalElev;
    }
    // Forward distance (metres): monotonic non-decreasing, holds at both ends.
    function D(time) {
      if (time <= 0) return 0;
      if (time >= totalTime) return finalDist;
      var iv = find(time);
      return iv ? iv.distStart + iv.fwdRate * (time - iv.start) : finalDist;
    }
    // Cadence (steps/min): 0 outside the workout window.
    function cadenceAt(time) {
      if (time <= 0 || time >= totalTime) return 0;
      var iv = find(time);
      return iv ? iv.stepsPerMin : 0;
    }
    // Which segment (0-based) a time falls in, clamped into [0, n-1].
    function segIndexAt(time) {
      if (!intervals.length) return 0;
      if (time <= 0) return 0;
      if (time >= totalTime) return intervals.length - 1;
      for (var i = 0; i < intervals.length; i++) {
        if (time >= intervals[i].start && time < intervals[i].end) return i;
      }
      return intervals.length - 1;
    }
    // Plan series for graphing: 'rate' (climb m/s), 'level', or 'altitude' (m).
    // Outside the plan window there is no activity, so rate and level are 0.
    // Altitude follows E(t) (holds 0 before the start, final after the end).
    function intensity(time, kind) {
      if (kind === 'altitude') return E(time);
      if (totalTime === 0 || time <= 0 || time >= totalTime) return 0;
      var iv = find(time);
      if (!iv) return 0;
      return kind === 'level' ? Number(iv.level) : iv.climbRate;
    }

    return {
      E: E, D: D, cadenceAt: cadenceAt, segIndexAt: segIndexAt, intensity: intensity,
      intervals: intervals, totalTime: totalTime,
      totalClimb: finalElev, totalDistance: finalDist
    };
  }

  Stair.elevation = { climbRate: climbRate, forwardRate: forwardRate, buildProfile: buildProfile };
})();
