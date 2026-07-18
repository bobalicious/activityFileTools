/* Saved settings, for all the tools at once.
 *
 * Each app used to own its own backup story — stairinator had Export all /
 * Import buttons, the others had nothing, so half your saved work could not be
 * moved between browsers at all. Everything now goes through here and is
 * reachable from one place: settings.html.
 *
 * This is the single list of what the suite stores. An app that starts saving
 * something new must add its key here, or that data will be silently missing
 * from every backup.
 */
(function (root) {
  'use strict';

  var KEYS = [
    { key: 'activity-tools.stairinator.doc', app: 'Stairinator',
      label: 'Stair machines and activities',
      describe: function (v) {
        if (!v || typeof v !== 'object') return null;
        var m = (v.machines || []).length, p = (v.plans || []).length;
        return m + (m === 1 ? ' machine' : ' machines') + ', ' +
               p + (p === 1 ? ' activity' : ' activities');
      } },
    { key: 'activity-tools.graphs.configs', app: 'bd-licious graphs',
      label: 'Saved graph configurations',
      describe: function (v) {
        if (!Array.isArray(v)) return null;
        return v.length + (v.length === 1 ? ' configuration' : ' configurations');
      } },
    { key: 'activity-tools.graphs.hr-zones', app: 'bd-licious graphs',
      label: 'Heart-rate zones',
      describe: function (v) {
        return Array.isArray(v) ? v.join(' · ') + ' bpm' : null;
      } }
  ];

  var FORMAT = 'activity-file-tools/settings';
  var VERSION = 1;

  function read(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch (e) { return undefined; }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  function remove(key) {
    try { localStorage.removeItem(key); return true; } catch (e) { return false; }
  }

  /* What is currently stored, for display. `present` is false for a key the
   * user has simply never used. */
  function summary() {
    return KEYS.map(function (k) {
      var v = read(k.key);
      var present = v !== undefined;
      return {
        key: k.key, app: k.app, label: k.label, present: present,
        detail: present && k.describe ? k.describe(v) : null
      };
    });
  }

  function exportAll() {
    var data = {};
    KEYS.forEach(function (k) {
      var v = read(k.key);
      if (v !== undefined) data[k.key] = v;
    });
    return { format: FORMAT, version: VERSION, data: data };
  }

  /* Accepts this suite's own export, and also a bare Stairinator export from
   * before settings moved up here — those are just {machines, plans} and would
   * otherwise be stranded. */
  function normalise(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('That file does not contain any settings.');
    }
    if (parsed.format === FORMAT && parsed.data && typeof parsed.data === 'object') {
      return parsed.data;
    }
    if (Array.isArray(parsed.machines) || Array.isArray(parsed.plans)) {
      var doc = { schemaVersion: parsed.schemaVersion || 1,
                  machines: parsed.machines || [], plans: parsed.plans || [] };
      return { 'activity-tools.stairinator.doc': doc };
    }
    throw new Error('That file is not an Activity File Tools settings export.');
  }

  /* Replaces whole keys rather than merging inside them: a half-merged set of
   * machines and plans is harder to reason about than a clean swap, and the
   * export is cheap to take first. Keys absent from the file are left alone. */
  function importAll(parsed) {
    var data = normalise(parsed);
    var known = {};
    KEYS.forEach(function (k) { known[k.key] = k; });

    var applied = [], skipped = [], failed = [];
    Object.keys(data).forEach(function (key) {
      if (!known[key]) { skipped.push(key); return; }
      if (write(key, data[key])) applied.push(known[key]);
      else failed.push(known[key]);
    });
    return { applied: applied, skipped: skipped, failed: failed };
  }

  function clear(key) {
    if (key) return remove(key);
    KEYS.forEach(function (k) { remove(k.key); });
    return true;
  }

  function filename() {
    // Callers pass the date in — this module has no business inventing one.
    return 'activity-file-tools-settings';
  }

  var api = {
    KEYS: KEYS, FORMAT: FORMAT, VERSION: VERSION,
    summary: summary, exportAll: exportAll, importAll: importAll,
    clear: clear, filename: filename
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Settings = api;

})(typeof self !== 'undefined' ? self : this);
