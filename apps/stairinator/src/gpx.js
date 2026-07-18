// gpx.js — parse GPX (DOMParser) to extract HR/time points. Output is FIT now,
// so this module only reads; see fit.js for writing (and FIT input).
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  function firstChildLocal(node, local) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 1 && c.localName === local) return c;
    }
    return null;
  }
  function findDescendantLocal(node, local) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType !== 1) continue;
      if (c.localName === local) return c;
      var deep = findDescendantLocal(c, local);
      if (deep) return deep;
    }
    return null;
  }

  // Parse GPX text. Returns { points:[{lat,lon,timeMs,ele,hr}], hasHr, hasGps, hasTime, name }.
  function parse(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('This does not look like valid GPX/XML.');
    }
    var trkpts = doc.getElementsByTagName('trkpt');
    if (!trkpts.length) trkpts = doc.getElementsByTagName('rtept');
    if (!trkpts.length) throw new Error('No track points (<trkpt>) found in this GPX file.');

    var points = [], hasHr = false, hasGps = false, hasTime = false;
    for (var i = 0; i < trkpts.length; i++) {
      var n = trkpts[i];
      var lat = n.getAttribute('lat'), lon = n.getAttribute('lon');
      var timeEl = firstChildLocal(n, 'time');
      var eleEl = firstChildLocal(n, 'ele');
      var hrEl = findDescendantLocal(n, 'hr');
      var timeMs = null;
      if (timeEl && timeEl.textContent) {
        var t = Date.parse(timeEl.textContent.trim());
        if (!isNaN(t)) { timeMs = t; hasTime = true; }
      }
      if (lat != null && lon != null) hasGps = true;
      if (hrEl && hrEl.textContent) hasHr = true;
      points.push({
        lat: lat != null ? parseFloat(lat) : null,
        lon: lon != null ? parseFloat(lon) : null,
        timeMs: timeMs,
        ele: eleEl ? parseFloat(eleEl.textContent) : null,
        hr: hrEl && hrEl.textContent ? parseInt(hrEl.textContent, 10) : null
      });
    }
    if (!hasTime) { // synthesize 1-second samples so the time-based pipeline works
      for (var j = 0; j < points.length; j++) points[j].timeMs = j * 1000;
    }

    var nameEl = doc.getElementsByTagName('name')[0];
    return { points: points, hasHr: hasHr, hasGps: hasGps, hasTime: hasTime, name: nameEl ? nameEl.textContent : null };
  }

  Stair.gpx = { parse: parse };
})();
