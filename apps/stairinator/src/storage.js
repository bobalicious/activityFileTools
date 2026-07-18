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

  // Backing up and restoring lives at the top level now — see settings.html and
  // shared/ui/settings.js — so this only reads and writes.
  Stair.storage = {
    emptyDoc: emptyDoc,
    load: load,
    save: save
  };
})();
