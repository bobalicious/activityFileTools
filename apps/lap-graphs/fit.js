/*
 * Dependency-free FIT decoder — enough of the format to feed the grapher.
 * Based on docs/FIT_FORMAT_REFERENCE.md (header, definition/data messages, base
 * types, scale/offset, timestamps, compressed timestamps, dev-field skipping).
 * Decodes session (18), lap (19), record (20) and length (101) into the app's
 * normalised { sport, startTime, laps[], samples[] } model.
 *
 * Exposes window.parseFit (browser) and module.exports (Node tests).
 */
(function (root) {
  'use strict';

  var FIT_EPOCH = 631065600; // Unix seconds at 1989-12-31

  // base-type byte -> { size, read(view, off, little) -> number|null }
  function u8(v) { return v === 0xff ? null : v; }
  function readScalar(view, off, bt, little) {
    switch (bt) {
      case 0x00: case 0x02: return u8(view.getUint8(off));        // enum, uint8
      case 0x0a: { var a = view.getUint8(off); return a === 0 ? null : a; } // uint8z
      case 0x01: { var s = view.getInt8(off); return s === 0x7f ? null : s; } // sint8
      case 0x0d: { var b = view.getUint8(off); return b === 0xff ? null : b; } // byte
      case 0x84: { var w = view.getUint16(off, little); return w === 0xffff ? null : w; } // uint16
      case 0x8b: { var wz = view.getUint16(off, little); return wz === 0 ? null : wz; } // uint16z
      case 0x83: { var sw = view.getInt16(off, little); return sw === 0x7fff ? null : sw; } // sint16
      case 0x86: { var l = view.getUint32(off, little); return l === 0xffffffff ? null : l; } // uint32
      case 0x8c: { var lz = view.getUint32(off, little); return lz === 0 ? null : lz; } // uint32z
      case 0x85: { var sl = view.getInt32(off, little); return sl === 0x7fffffff ? null : sl; } // sint32
      case 0x88: { var f = view.getUint32(off, little); return f === 0xffffffff ? null : view.getFloat32(off, little); } // float32
      case 0x89: return view.getFloat64(off, little); // float64
      default: return null; // strings / 64-bit ints we don't need
    }
  }
  function elemSize(bt) {
    switch (bt) {
      case 0x00: case 0x01: case 0x02: case 0x07: case 0x0a: case 0x0d: return 1;
      case 0x83: case 0x84: case 0x8b: return 2;
      case 0x85: case 0x86: case 0x88: case 0x8c: return 4;
      case 0x89: case 0x8e: case 0x8f: case 0x90: return 8;
      default: return 1;
    }
  }

  function decode(buffer) {
    var bytes = new Uint8Array(buffer);
    var view = new DataView(buffer);
    if (bytes.length < 12) throw new Error('Too short to be a FIT file');
    var headerSize = bytes[0];
    // signature ".FIT" at bytes 8..11
    if (!(bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54)) {
      throw new Error('Not a FIT file');
    }
    var dataSize = view.getUint32(4, true);
    var pos = headerSize;
    var dataEnd = Math.min(headerSize + dataSize, bytes.length);
    var defs = {};        // localType -> { global, little, fields:[{num,size,bt}], devSize }
    var collect = {};     // global -> [ {fieldNum: rawValue} ]
    var lastTs = 0;

    function stash(global, rec) { (collect[global] || (collect[global] = [])).push(rec); }

    function readData(def, headerTs) {
      var rec = {};
      for (var i = 0; i < def.fields.length; i++) {
        var f = def.fields[i];
        var es = elemSize(f.bt);
        var val = f.size >= es ? readScalar(view, pos, f.bt, def.little) : null;
        if (f.num === 253 && val != null) lastTs = val;
        rec[f.num] = val;
        pos += f.size;
      }
      pos += def.devSize;
      if (headerTs != null && rec[253] == null) rec[253] = headerTs;
      stash(def.global, rec);
    }

    while (pos < dataEnd) {
      var h = bytes[pos++];
      if (h & 0x80) {
        // compressed-timestamp data message
        var local = (h >> 5) & 0x03;
        var offset = h & 0x1f;
        var ts = (lastTs & ~0x1f) + offset;
        if (offset < (lastTs & 0x1f)) ts += 0x20;
        lastTs = ts;
        var d = defs[local];
        if (!d) break;
        readData(d, ts);
      } else if (h & 0x40) {
        // definition
        pos++; // reserved
        var little = bytes[pos++] === 0;
        var global = view.getUint16(pos, little); pos += 2;
        var n = bytes[pos++];
        var fields = [];
        for (var k = 0; k < n; k++) {
          fields.push({ num: bytes[pos++], size: bytes[pos++], bt: bytes[pos++] });
        }
        var devSize = 0;
        if (h & 0x20) {
          var nd = bytes[pos++];
          for (var j = 0; j < nd; j++) { pos++; devSize += bytes[pos++]; pos++; }
        }
        defs[h & 0x0f] = { global: global, little: little, fields: fields, devSize: devSize };
      } else {
        var def = defs[h & 0x0f];
        if (!def) break;
        readData(def, null);
      }
    }
    return collect;
  }

  // ---- normalisation into the app model ----------------------------------

  function fitDate(fitSec) { return fitSec == null ? undefined : new Date((fitSec + FIT_EPOCH) * 1000); }
  var SPORT = { 0: 'generic', 1: 'running', 2: 'cycling', 5: 'swimming', 11: 'walking' };
  function num(v) { return typeof v === 'number' ? v : undefined; }
  function div(v, s) { return typeof v === 'number' ? v / s : undefined; }

  function parseFit(buffer) {
    var msgs = decode(buffer);
    var session = (msgs[18] && msgs[18][0]) || {};
    var lapMesgs = msgs[19] || [];
    var recMesgs = msgs[20] || [];
    var lengthMesgs = msgs[101] || [];

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

  root.parseFit = parseFit;
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseFit: parseFit };
})(typeof window !== 'undefined' ? window : globalThis);
