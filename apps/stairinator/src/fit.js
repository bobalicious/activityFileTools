// fit.js — minimal FIT encoder (write a stair-climb activity) and decoder
// (read heart-rate records from an uploaded FIT). No dependencies; works from
// file://. See https://developer.garmin.com/fit/protocol/ for the format.
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  var FIT_EPOCH = 631065600; // Unix seconds at 1989-12-31T00:00:00Z
  function toFitSeconds(ms) { return Math.round(ms / 1000) - FIT_EPOCH; }
  function fromFitSeconds(s) { return (s + FIT_EPOCH) * 1000; }

  // Byte-level FIT writing (CRC, header, field encoding) lives in shared/fit.
  var Enc = window.FitEncode;

  // Base types.
  var ENUM = 0x00, UINT8 = 0x02, SINT32 = 0x85, UINT16 = 0x84, UINT32 = 0x86, UINT32Z = 0x8C;

  function semicircles(deg) { return Math.round(deg * (2147483648 / 180)); }

  // Declare a device Strava recognises as barometric, so it trusts (and displays)
  // the elevation in this no-GPS activity instead of discarding it as untrusted
  // indoor data. Garmin (1) / Fenix 6 (3290) has a barometric altimeter.
  var MANUFACTURER = 1;   // garmin
  var PRODUCT = 3290;     // fenix6
  var SERIAL = 0x53544149; // "STAI"

  // ---------- Encoder ----------
  // Byte-level writing is shared; what's left here is the stair-specific part —
  // which messages this app emits, and what goes in them.

  var DEF = {
    fileId: { localType: 0, global: 0, fields: [
      { num: 0, size: 1, baseType: ENUM }, { num: 1, size: 2, baseType: UINT16 },
      { num: 2, size: 2, baseType: UINT16 }, { num: 3, size: 4, baseType: UINT32Z },
      { num: 4, size: 4, baseType: UINT32 } ] },
    deviceInfo: { localType: 6, global: 23, fields: [
      { num: 253, size: 4, baseType: UINT32 }, { num: 0, size: 1, baseType: UINT8 },
      { num: 2, size: 2, baseType: UINT16 }, { num: 4, size: 2, baseType: UINT16 },
      { num: 5, size: 2, baseType: UINT16 }, { num: 3, size: 4, baseType: UINT32Z } ] },
    event: { localType: 1, global: 21, fields: [
      { num: 253, size: 4, baseType: UINT32 }, { num: 0, size: 1, baseType: ENUM },
      { num: 1, size: 1, baseType: ENUM } ] },
    record: { localType: 2, global: 20, fields: [
      { num: 253, size: 4, baseType: UINT32 }, { num: 0, size: 4, baseType: SINT32 },
      { num: 1, size: 4, baseType: SINT32 }, { num: 3, size: 1, baseType: UINT8 },
      { num: 4, size: 1, baseType: UINT8 }, { num: 5, size: 4, baseType: UINT32 },
      { num: 2, size: 2, baseType: UINT16 } ] },
    lap: { localType: 3, global: 19, fields: [
      { num: 254, size: 2, baseType: UINT16 }, { num: 253, size: 4, baseType: UINT32 },
      { num: 2, size: 4, baseType: UINT32 }, { num: 7, size: 4, baseType: UINT32 },
      { num: 8, size: 4, baseType: UINT32 }, { num: 9, size: 4, baseType: UINT32 },
      { num: 21, size: 2, baseType: UINT16 }, { num: 15, size: 1, baseType: UINT8 },
      { num: 16, size: 1, baseType: UINT8 }, { num: 17, size: 1, baseType: UINT8 },
      { num: 0, size: 1, baseType: ENUM }, { num: 1, size: 1, baseType: ENUM } ] },
    session: { localType: 4, global: 18, fields: [
      { num: 254, size: 2, baseType: UINT16 }, { num: 253, size: 4, baseType: UINT32 },
      { num: 2, size: 4, baseType: UINT32 }, { num: 7, size: 4, baseType: UINT32 },
      { num: 8, size: 4, baseType: UINT32 }, { num: 9, size: 4, baseType: UINT32 },
      { num: 22, size: 2, baseType: UINT16 }, { num: 5, size: 1, baseType: ENUM },
      { num: 6, size: 1, baseType: ENUM }, { num: 25, size: 2, baseType: UINT16 },
      { num: 26, size: 2, baseType: UINT16 }, { num: 16, size: 1, baseType: UINT8 },
      { num: 17, size: 1, baseType: UINT8 }, { num: 18, size: 1, baseType: UINT8 },
      { num: 0, size: 1, baseType: ENUM }, { num: 1, size: 1, baseType: ENUM } ] },
    activity: { localType: 5, global: 34, fields: [
      { num: 253, size: 4, baseType: UINT32 }, { num: 0, size: 4, baseType: UINT32 },
      { num: 1, size: 2, baseType: UINT16 }, { num: 2, size: 1, baseType: ENUM },
      { num: 3, size: 1, baseType: ENUM }, { num: 4, size: 1, baseType: ENUM } ] }
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
    var w = new Enc.ByteSink();

    // file_id
    Enc.writeDefinition(w, DEF.fileId);
    Enc.writeDataMessage(w, DEF.fileId,
      { 0: 4 /*activity*/, 1: MANUFACTURER, 2: PRODUCT, 3: SERIAL, 4: toFitSeconds(firstMs) });

    // device_info: reinforces the barometric-device identity for Strava
    Enc.writeDefinition(w, DEF.deviceInfo);
    Enc.writeDataMessage(w, DEF.deviceInfo,
      { 253: toFitSeconds(firstMs), 0: 0 /*creator*/, 2: MANUFACTURER, 4: PRODUCT, 5: 100 /*sw 1.00*/, 3: SERIAL });

    // start event
    Enc.writeDefinition(w, DEF.event);
    Enc.writeDataMessage(w, DEF.event, { 253: toFitSeconds(firstMs), 0: 0 /*timer*/, 1: 0 /*start*/ });

    // records
    Enc.writeDefinition(w, DEF.record);
    recs.forEach(function (r) {
      Enc.writeDataMessage(w, DEF.record, {
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
    Enc.writeDataMessage(w, DEF.event, { 253: toFitSeconds(lastMs), 0: 0, 1: 4 /*stop_all*/ });

    // laps
    Enc.writeDefinition(w, DEF.lap);
    laps.forEach(function (lp, i) {
      var elapsed = (lp.endTimeMs - lp.startTimeMs) / 1000;
      Enc.writeDataMessage(w, DEF.lap, {
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
    Enc.writeDefinition(w, DEF.session);
    Enc.writeDataMessage(w, DEF.session, {
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
    Enc.writeDefinition(w, DEF.activity);
    Enc.writeDataMessage(w, DEF.activity, {
      253: toFitSeconds(lastMs), 0: ms1000(sesElapsed), 1: 1, 2: 0 /*manual*/,
      3: 26 /*activity*/, 4: 1 /*stop*/
    });

    // 14-byte header + data + CRC.
    return Enc.assembleFile(w.toUint8Array(), {
      headerSize: 14, protocolVersion: 0x20, profileVersion: 2140
    });
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
