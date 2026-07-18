// storage.js — localStorage persistence + JSON export/import.
(function () {
  'use strict';
  window.Stair = window.Stair || {};
  var model = Stair.model;
  var KEY = 'stairinator.doc.v1';

  function emptyDoc() {
    return { schemaVersion: model.SCHEMA_VERSION, machines: [], plans: [] };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return emptyDoc();
      var doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object') return emptyDoc();
      doc.machines = doc.machines || [];
      doc.plans = doc.plans || [];
      doc.schemaVersion = doc.schemaVersion || model.SCHEMA_VERSION;
      return doc;
    } catch (e) {
      console.warn('Could not load saved data:', e);
      return emptyDoc();
    }
  }

  function save(doc) {
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
      return true;
    } catch (e) {
      console.warn('Could not save data:', e);
      return false;
    }
  }

  function exportBlob(doc) {
    return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  }

  // Merge an imported doc into the current one (by id; imported wins on clash).
  function mergeImport(current, imported) {
    var out = emptyDoc();
    var byId = {};
    (current.machines || []).concat(imported.machines || []).forEach(function (m) { byId[m.id] = m; });
    out.machines = Object.keys(byId).map(function (k) { return byId[k]; });
    byId = {};
    (current.plans || []).concat(imported.plans || []).forEach(function (p) { byId[p.id] = p; });
    out.plans = Object.keys(byId).map(function (k) { return byId[k]; });
    return out;
  }

  Stair.storage = {
    emptyDoc: emptyDoc,
    load: load,
    save: save,
    exportBlob: exportBlob,
    mergeImport: mergeImport
  };
})();
