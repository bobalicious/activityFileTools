/* Views over a decoded FIT file.
 *
 * decode.js returns the wire structure: raw, unscaled, byte-faithful. The apps
 * each want something different from it, so the scaling and the semantics live
 * here rather than in the decoder.
 *
 *   toActivityModel  {sport, startTime, laps[], samples[]} — for the grapher
 *   toPointStream    {points[], hasHr, ...}                — GPX-shaped, so FIT
 *                                                            and GPX inputs share
 *                                                            one consumer
 *
 * The swim corrector deliberately has no adapter: it works on the raw structure
 * because it mutates and re-encodes it.
 *
 * Both adapters expect a file decoded with {nullifyInvalid: true} — they treat
 * null as "no data" and do not check for sentinels themselves.
 */
(function (root) {
  'use strict';

  var FIT_EPOCH = 631065600; // Unix seconds at 1989-12-31

  /* Field access. Two wrinkles the decoder deliberately leaves to the caller:
   * an array-valued field yields its first element (these adapters only read
   * fields that are scalar in practice), and a compressed-timestamp message
   * carries its timestamp outside the field map. */
  function fv(msg, num) {
    var v = msg.fields[num];
    if (Array.isArray(v)) v = v.length ? v[0] : null;
    if (v == null && num === 253 && msg.compressedTimestamp != null) return msg.compressedTimestamp;
    return v;
  }

  function fieldMap(msg) {
    var out = {};
    for (var k in msg.fields) {
      if (Object.prototype.hasOwnProperty.call(msg.fields, k)) out[k] = fv(msg, Number(k));
    }
    if (out[253] == null && msg.compressedTimestamp != null) out[253] = msg.compressedTimestamp;
    return out;
  }

  function mapsFor(decoded, global) {
    var list = decoded.byGlobal[global] || [];
    return list.map(fieldMap);
  }

  // ---- activity model (the grapher) --------------------------------------

  function fitDate(fitSec) { return fitSec == null ? undefined : new Date((fitSec + FIT_EPOCH) * 1000); }
  var SPORT = { 0: 'generic', 1: 'running', 2: 'cycling', 5: 'swimming', 11: 'walking' };
  function num(v) { return typeof v === 'number' ? v : undefined; }
  function div(v, s) { return typeof v === 'number' ? v / s : undefined; }

  function toActivityModel(decoded) {
    var session = mapsFor(decoded, 18)[0] || {};
    var lapMesgs = mapsFor(decoded, 19);
    var recMesgs = mapsFor(decoded, 20);
    var lengthMesgs = mapsFor(decoded, 101);

    var sport = SPORT[session[5]] || (typeof session[5] === 'number' ? String(session[5]) : undefined);
    var isSwim = sport === 'swimming' && lengthMesgs.length > 0;

    var startDate = fitDate(session[2]) || fitDate((lengthMesgs[0] || {})[2]) ||
      fitDate((recMesgs[0] || {})[253]) || new Date(0);
    var startMs = startDate.getTime();
    var toSec = function (fitSec) { return fitSec == null ? 0 : (fitSec + FIT_EPOCH) * 1000 / 1000 - startMs / 1000; };

    // records -> samples (speed/cadence/HR/distance)
    var samples = recMesgs.map(function (r) {
      var cad = num(r[4]);
      var frac = num(r[53]);
      return {
        t: toSec(r[253]),
        distance: div(r[5], 100),
        speed: div(r[73], 1000) != null ? div(r[73], 1000) : div(r[6], 1000),
        heartRate: num(r[3]),
        cadence: cad != null ? (cad + (frac != null ? frac / 128 : 0)) * 2 : undefined,
      };
    });

    var laps;
    if (isSwim) {
      var poolLength = div(session[44], 100);
      laps = lengthMesgs.map(function (l, index) {
        var elapsed = div(l[3], 1000) || 0;
        var strokes = num(l[5]);
        var idle = l[12] === 0;
        return {
          index: index,
          startTime: toSec(l[2]),
          elapsedTime: elapsed,
          movingTime: div(l[4], 1000),
          distance: poolLength,
          avgSpeed: div(l[6], 1000),
          avgCadence: num(l[9]),               // strokes/min (no x2 for swim)
          strokes: strokes,
          swolf: strokes != null ? Math.round(elapsed) + strokes : undefined,
          fitIntensity: idle ? 'rest' : 'active',
          startIndex: 0, endIndex: -1,
          isRest: false, restSource: 'none',
        };
      });
    } else {
      laps = lapMesgs.map(function (l, index) {
        var startTime = toSec(l[2]);
        var elapsed = div(l[7], 1000) || 0;
        var cad = num(l[17]);
        var range = sampleRange(samples, startTime, startTime + elapsed);
        return {
          index: index,
          startTime: startTime,
          elapsedTime: elapsed,
          movingTime: div(l[8], 1000),
          distance: div(l[9], 100),
          avgSpeed: div(l[110], 1000) != null ? div(l[110], 1000) : div(l[13], 1000),
          maxSpeed: div(l[111], 1000) != null ? div(l[111], 1000) : div(l[14], 1000),
          avgCadence: cad != null ? cad * 2 : undefined,  // per-leg -> steps/min
          avgHeartRate: num(l[15]),
          maxHeartRate: num(l[16]),
          startIndex: range[0], endIndex: range[1],
          isRest: false, restSource: 'none',
        };
      });
    }

    return {
      sport: sport,
      startTime: startDate,
      totalElapsedTime: div(session[7], 1000) || (samples.length ? samples[samples.length - 1].t : 0),
      totalDistance: div(session[9], 100),
      laps: laps,
      samples: samples,
    };
  }

  function sampleRange(samples, startTime, endTime) {
    var eps = 0.5, start = -1;
    for (var i = 0; i < samples.length; i++) { if (samples[i].t >= startTime - eps) { start = i; break; } }
    if (start === -1) return [samples.length, samples.length - 1];
    var end = start;
    for (var j = start; j < samples.length && samples[j].t <= endTime + eps; j++) end = j;
    return [start, end];
  }

  // ---- point stream (GPX-shaped, for the stair activity builder) ----------

  /* lat/lon/ele are always null: this reads FIT files only for their heart rate
   * and timestamps, and the shape exists to match the GPX parser's output so
   * both file types feed the same code. */
  function toPointStream(decoded) {
    var recMesgs = decoded.byGlobal[20] || [];
    var points = [];
    var hasHr = false;

    for (var i = 0; i < recMesgs.length; i++) {
      var ts = fv(recMesgs[i], 253);
      if (ts == null) continue;
      var hr = fv(recMesgs[i], 3);
      if (hr != null) hasHr = true;
      points.push({ timeMs: (ts + FIT_EPOCH) * 1000, hr: hr == null ? null : hr,
                    lat: null, lon: null, ele: null });
    }

    if (!points.length) throw new Error('No record data found in this FIT file.');
    points.sort(function (a, b) { return a.timeMs - b.timeMs; });
    return { points: points, hasHr: hasHr, hasGps: false, hasTime: true, name: null };
  }

  var api = { toActivityModel: toActivityModel, toPointStream: toPointStream };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FitAdapters = api;

})(typeof self !== 'undefined' ? self : this);
