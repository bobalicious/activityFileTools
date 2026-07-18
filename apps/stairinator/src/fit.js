// fit.js — minimal FIT encoder (write a stair-climb activity) and decoder
// (read heart-rate records from an uploaded FIT). No dependencies; works from
// file://. See https://developer.garmin.com/fit/protocol/ for the format.
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  var FIT_EPOCH = 631065600; // Unix seconds at 1989-12-31T00:00:00Z
  function toFitSeconds(ms) { return Math.round(ms / 1000) - FIT_EPOCH; }
  function fromFitSeconds(s) { return (s + FIT_EPOCH) * 1000; }

  // FIT CRC-16.
  var CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  function crc16(crc, byte) {
    var tmp = CRC_TABLE[crc & 0xF];
    crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[byte & 0xF];
    tmp = CRC_TABLE[crc & 0xF];
    crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF];
    return crc & 0xFFFF;
  }

  // Base types.
  var ENUM = 0x00, UINT8 = 0x02, SINT32 = 0x85, UINT16 = 0x84, UINT32 = 0x86, UINT32Z = 0x8C;
  var INV_U8 = 0xFF, INV_U16 = 0xFFFF, INV_U32 = 0xFFFFFFFF, INV_S32 = 0x7FFFFFFF;

  function semicircles(deg) { return Math.round(deg * (2147483648 / 180)); }

  // Declare a device Strava recognises as barometric, so it trusts (and displays)
  // the elevation in this no-GPS activity instead of discarding it as untrusted
  // indoor data. Garmin (1) / Fenix 6 (3290) has a barometric altimeter.
  var MANUFACTURER = 1;   // garmin
  var PRODUCT = 3290;     // fenix6
  var SERIAL = 0x53544149; // "STAI"

  // ---------- Encoder ----------
  function Writer() { this.b = []; }
  Writer.prototype.u8 = function (v) { this.b.push(v & 0xFF); };
  Writer.prototype.u16 = function (v) { v = v & 0xFFFF; this.b.push(v & 0xFF, (v >> 8) & 0xFF); };
  Writer.prototype.u32 = function (v) { v = v >>> 0; this.b.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); };

  function writeDef(w, local, global, fields) {
    w.u8(0x40 | local); // definition message
    w.u8(0);            // reserved
    w.u8(0);            // architecture: little-endian
    w.u16(global);
    w.u8(fields.length);
    fields.forEach(function (f) { w.u8(f.num); w.u8(f.size); w.u8(f.base); });
  }
  function writeData(w, local, fields, values) {
    w.u8(local);
    fields.forEach(function (f) {
      var v = values[f.num];
      if (v == null) { // invalid marker for this size
        v = f.base === UINT16 ? INV_U16
          : f.base === SINT32 ? INV_S32
          : (f.base === UINT32 || f.base === UINT32Z ? INV_U32 : INV_U8);
      }
      if (f.base === UINT16) w.u16(v);
      else if (f.base === UINT32 || f.base === UINT32Z || f.base === SINT32) w.u32(v);
      else w.u8(v); // ENUM / UINT8
    });
  }

  var DEF = {
    fileId: { local: 0, global: 0, fields: [
      { num: 0, size: 1, base: ENUM }, { num: 1, size: 2, base: UINT16 },
      { num: 2, size: 2, base: UINT16 }, { num: 3, size: 4, base: UINT32Z },
      { num: 4, size: 4, base: UINT32 } ] },
    deviceInfo: { local: 6, global: 23, fields: [
      { num: 253, size: 4, base: UINT32 }, { num: 0, size: 1, base: UINT8 },
      { num: 2, size: 2, base: UINT16 }, { num: 4, size: 2, base: UINT16 },
      { num: 5, size: 2, base: UINT16 }, { num: 3, size: 4, base: UINT32Z } ] },
    event: { local: 1, global: 21, fields: [
      { num: 253, size: 4, base: UINT32 }, { num: 0, size: 1, base: ENUM },
      { num: 1, size: 1, base: ENUM } ] },
    record: { local: 2, global: 20, fields: [
      { num: 253, size: 4, base: UINT32 }, { num: 0, size: 4, base: SINT32 },
      { num: 1, size: 4, base: SINT32 }, { num: 3, size: 1, base: UINT8 },
      { num: 4, size: 1, base: UINT8 }, { num: 5, size: 4, base: UINT32 },
      { num: 2, size: 2, base: UINT16 } ] },
    lap: { local: 3, global: 19, fields: [
      { num: 254, size: 2, base: UINT16 }, { num: 253, size: 4, base: UINT32 },
      { num: 2, size: 4, base: UINT32 }, { num: 7, size: 4, base: UINT32 },
      { num: 8, size: 4, base: UINT32 }, { num: 9, size: 4, base: UINT32 },
      { num: 21, size: 2, base: UINT16 }, { num: 15, size: 1, base: UINT8 },
      { num: 16, size: 1, base: UINT8 }, { num: 17, size: 1, base: UINT8 },
      { num: 0, size: 1, base: ENUM }, { num: 1, size: 1, base: ENUM } ] },
    session: { local: 4, global: 18, fields: [
      { num: 254, size: 2, base: UINT16 }, { num: 253, size: 4, base: UINT32 },
      { num: 2, size: 4, base: UINT32 }, { num: 7, size: 4, base: UINT32 },
      { num: 8, size: 4, base: UINT32 }, { num: 9, size: 4, base: UINT32 },
      { num: 22, size: 2, base: UINT16 }, { num: 5, size: 1, base: ENUM },
      { num: 6, size: 1, base: ENUM }, { num: 25, size: 2, base: UINT16 },
      { num: 26, size: 2, base: UINT16 }, { num: 16, size: 1, base: UINT8 },
      { num: 17, size: 1, base: UINT8 }, { num: 18, size: 1, base: UINT8 },
      { num: 0, size: 1, base: ENUM }, { num: 1, size: 1, base: ENUM } ] },
    activity: { local: 5, global: 34, fields: [
      { num: 253, size: 4, base: UINT32 }, { num: 0, size: 4, base: UINT32 },
      { num: 1, size: 2, base: UINT16 }, { num: 2, size: 1, base: ENUM },
      { num: 3, size: 1, base: ENUM }, { num: 4, size: 1, base: ENUM } ] }
  };

  function ms1000(sec) { return Math.round(sec * 1000); }
  function cm(m) { return Math.round(m * 100); }
  function altStore(m) { return Math.round((m + 500) * 5); } // scale 5, offset 500

  // Encode an activity. opts:
  //   records: [{ timeMs, hr|null, cadence, distanceM, altitudeM }]
  //   laps:    [{ startTimeMs, endTimeMs, totalDistanceM, totalAscentM, avgHr|null, maxHr|null, avgCadence }]
  //   session: { sport, subSport, totalDistanceM, totalAscentM, avgHr|null, maxHr|null, avgCadence, numLaps }
  function encodeActivity(opts) {
    var recs = opts.records, laps = opts.laps, ses = opts.session;
    if (!recs || !recs.length) throw new Error('No records to write.');
    var firstMs = recs[0].timeMs, lastMs = recs[recs.length - 1].timeMs;
    var w = new Writer();

    // file_id
    writeDef(w, DEF.fileId.local, DEF.fileId.global, DEF.fileId.fields);
    writeData(w, DEF.fileId.local, DEF.fileId.fields,
      { 0: 4 /*activity*/, 1: MANUFACTURER, 2: PRODUCT, 3: SERIAL, 4: toFitSeconds(firstMs) });

    // device_info: reinforces the barometric-device identity for Strava
    writeDef(w, DEF.deviceInfo.local, DEF.deviceInfo.global, DEF.deviceInfo.fields);
    writeData(w, DEF.deviceInfo.local, DEF.deviceInfo.fields,
      { 253: toFitSeconds(firstMs), 0: 0 /*creator*/, 2: MANUFACTURER, 4: PRODUCT, 5: 100 /*sw 1.00*/, 3: SERIAL });

    // start event
    writeDef(w, DEF.event.local, DEF.event.global, DEF.event.fields);
    writeData(w, DEF.event.local, DEF.event.fields, { 253: toFitSeconds(firstMs), 0: 0 /*timer*/, 1: 0 /*start*/ });

    // records
    writeDef(w, DEF.record.local, DEF.record.global, DEF.record.fields);
    recs.forEach(function (r) {
      writeData(w, DEF.record.local, DEF.record.fields, {
        253: toFitSeconds(r.timeMs),
        0: (r.latDeg == null ? null : semicircles(r.latDeg)),
        1: (r.lonDeg == null ? null : semicircles(r.lonDeg)),
        3: (r.hr == null ? null : Math.round(r.hr)),
        4: Math.round(r.cadence || 0),
        5: cm(r.distanceM || 0),
        2: altStore(r.altitudeM || 0)
      });
    });

    // stop event (reuse event definition)
    writeData(w, DEF.event.local, DEF.event.fields, { 253: toFitSeconds(lastMs), 0: 0, 1: 4 /*stop_all*/ });

    // laps
    writeDef(w, DEF.lap.local, DEF.lap.global, DEF.lap.fields);
    laps.forEach(function (lp, i) {
      var elapsed = (lp.endTimeMs - lp.startTimeMs) / 1000;
      writeData(w, DEF.lap.local, DEF.lap.fields, {
        254: i, 253: toFitSeconds(lp.endTimeMs), 2: toFitSeconds(lp.startTimeMs),
        7: ms1000(elapsed), 8: ms1000(elapsed), 9: cm(lp.totalDistanceM),
        21: Math.round(lp.totalAscentM),
        15: (lp.avgHr == null ? null : Math.round(lp.avgHr)),
        16: (lp.maxHr == null ? null : Math.round(lp.maxHr)),
        17: Math.round(lp.avgCadence || 0),
        0: 9 /*lap*/, 1: 1 /*stop*/
      });
    });

    // session
    var sesElapsed = (lastMs - firstMs) / 1000;
    writeDef(w, DEF.session.local, DEF.session.global, DEF.session.fields);
    writeData(w, DEF.session.local, DEF.session.fields, {
      254: 0, 253: toFitSeconds(lastMs), 2: toFitSeconds(firstMs),
      7: ms1000(sesElapsed), 8: ms1000(sesElapsed), 9: cm(ses.totalDistanceM),
      22: Math.round(ses.totalAscentM), 5: ses.sport, 6: ses.subSport,
      25: 0, 26: ses.numLaps,
      16: (ses.avgHr == null ? null : Math.round(ses.avgHr)),
      17: (ses.maxHr == null ? null : Math.round(ses.maxHr)),
      18: Math.round(ses.avgCadence || 0),
      0: 8 /*session*/, 1: 1 /*stop*/
    });

    // activity
    writeDef(w, DEF.activity.local, DEF.activity.global, DEF.activity.fields);
    writeData(w, DEF.activity.local, DEF.activity.fields, {
      253: toFitSeconds(lastMs), 0: ms1000(sesElapsed), 1: 1, 2: 0 /*manual*/,
      3: 26 /*activity*/, 4: 1 /*stop*/
    });

    // Assemble: 14-byte header + data + CRC.
    var data = w.b;
    var header = [14, 0x20, 0x5C, 0x08]; // size, protocol 2.0, profile 2140 (LE)
    var ds = data.length;
    header.push(ds & 0xFF, (ds >>> 8) & 0xFF, (ds >>> 16) & 0xFF, (ds >>> 24) & 0xFF);
    header.push(0x2E, 0x46, 0x49, 0x54); // ".FIT"
    var hc = 0; for (var i = 0; i < 12; i++) hc = crc16(hc, header[i]);
    header.push(hc & 0xFF, (hc >> 8) & 0xFF);

    var all = header.concat(data);
    var fc = 0; for (var j = 0; j < all.length; j++) fc = crc16(fc, all[j]);
    all.push(fc & 0xFF, (fc >> 8) & 0xFF);
    return new Uint8Array(all);
  }

  // ---------- Decoder (read HR + timestamps from an uploaded FIT) ----------
  // The decoding itself lives in shared/fit — this app only needs the GPX-shaped
  // point stream, so it goes through the shared adapter. Kept on Stair.fit so
  // callers don't care where it came from.
  // Returns { points:[{timeMs, hr, lat:null, lon:null, ele:null}], hasHr, hasGps, hasTime, name }.
  function decode(arrayBuffer) {
    // tolerant: a file that stops making sense partway through should still
    // yield the heart rate it did record.
    return window.FitAdapters.toPointStream(
      window.FitDecode.decode(arrayBuffer, { nullifyInvalid: true, tolerant: true }));
  }

  Stair.fit = { encodeActivity: encodeActivity, decode: decode, toFitSeconds: toFitSeconds, fromFitSeconds: fromFitSeconds };
})();
