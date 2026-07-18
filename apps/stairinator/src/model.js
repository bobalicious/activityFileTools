// model.js — data model, defaults, id generation, validation.
// Classic script: attaches to the global `Stair` namespace.
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) +
      '-' + (globalCounter++).toString(36);
  }
  let globalCounter = 0;

  // Sensible default machine: a 10-level StairMaster-style device.
  function defaultMachine() {
    var levels = [];
    // steps/min ramps roughly linearly from 26 (L1) to 162 (L10).
    // `level` is the stable identifier; `name` is the editable display label.
    for (var i = 1; i <= 10; i++) {
      levels.push({ level: i, name: String(i), stepsPerMin: Math.round(26 + (i - 1) * (162 - 26) / 9) });
    }
    return {
      id: uid(),
      name: 'New stair machine',
      riser: 0.203, // metres climbed per step (~8 inches, typical)
      tread: 0.255, // metres travelled forward per step (~10 inches, typical)
      levels: levels
    };
  }

  function defaultPlan(machineId) {
    return {
      id: uid(),
      name: 'New activity',
      machineId: machineId || null,
      segments: [{ level: 5, minutes: 10, seconds: 0 }]
    };
  }

  function levelCadence(machine, level) {
    if (!machine) return null;
    var lvl = machine.levels.find(function (l) { return Number(l.level) === Number(level); });
    return lvl ? Number(lvl.stepsPerMin) : null;
  }

  // Validate a plan against its machine. Returns an array of human-readable errors.
  function validatePlan(plan, machine) {
    var errors = [];
    if (!plan) { return ['No activity selected.']; }
    if (!machine) { errors.push('This activity has no stair machine assigned.'); }
    if (!plan.segments || plan.segments.length === 0) {
      errors.push('Add at least one segment (level + minutes).');
    }
    (plan.segments || []).forEach(function (seg, i) {
      var n = i + 1;
      var durSec = (Number(seg.minutes) || 0) * 60 + (Number(seg.seconds) || 0);
      if (!(durSec > 0)) errors.push('Segment ' + n + ': duration must be greater than 0.');
      if (machine && levelCadence(machine, seg.level) == null) {
        errors.push('Segment ' + n + ': level ' + seg.level + ' is not defined on "' + machine.name + '".');
      }
    });
    return errors;
  }

  function levelName(machine, level) {
    if (!machine) return String(level);
    var lvl = machine.levels.find(function (l) { return Number(l.level) === Number(level); });
    return lvl ? (lvl.name || String(lvl.level)) : String(level);
  }

  // Backfill fields on data loaded from older versions (unnamed levels;
  // stepHeight → riser; missing tread).
  function normalizeDoc(doc) {
    (doc.machines || []).forEach(function (m) {
      if (m.riser == null) m.riser = (m.stepHeight != null ? m.stepHeight : 0.203);
      if (m.tread == null) m.tread = 0.255;
      (m.levels || []).forEach(function (lv) {
        if (lv.name == null || lv.name === '') lv.name = String(lv.level);
      });
    });
    // Segments gain a seconds field; convert any old fractional minutes to min+sec.
    (doc.plans || []).forEach(function (p) {
      (p.segments || []).forEach(function (s) {
        if (s.seconds == null) {
          var total = (Number(s.minutes) || 0) * 60;
          s.minutes = Math.floor(total / 60);
          s.seconds = Math.round(total - s.minutes * 60);
        }
      });
    });
    return doc;
  }

  Stair.model = {
    uid: uid,
    defaultMachine: defaultMachine,
    defaultPlan: defaultPlan,
    levelCadence: levelCadence,
    levelName: levelName,
    normalizeDoc: normalizeDoc,
    validatePlan: validatePlan,
    SCHEMA_VERSION: 1
  };
})();
