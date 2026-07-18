/* Swim model — reads a decoded FIT into an editable length list, detects
 * missed/false turns, applies corrections, and recomputes every dependent
 * aggregate before handing the structure back for encoding.
 *
 * Two principles run through this file:
 *
 *  1. Derive, don't trust. Devices disagree on what they record. `length.
 *     timestamp` is a flush artifact, not a length end time (a FR935 gives all
 *     29 lengths just 6 distinct values). `num_lengths` counts active lengths
 *     only on a Fenix 3 but all lengths in Garmin's own SDK example. So the
 *     length sequence and `start_time + total_elapsed_time` are the only things
 *     treated as authoritative; everything else is checked or rebuilt.
 *
 *  2. Verify a hypothesis against the file before acting on it. Several fields
 *     we want (SWOLF above all) are undocumented — absent from Garmin's
 *     official profile. Rather than guess, we compute what we believe a field
 *     means from the file's own untouched data and compare. Only fields that
 *     reproduce their stored value get rewritten; the rest are left alone.
 *
 * Field numbers are per-message in FIT: lap and session use different numbers
 * for the same idea. Verified against Garmin FIT Profile 21.208.0.
 */
(function (root) {
  'use strict';

  var LEN = {
    EVENT: 0, EVENT_TYPE: 1, START_TIME: 2, ELAPSED: 3, TIMER: 4, STROKES: 5,
    AVG_SPEED: 6, SWIM_STROKE: 7, CADENCE: 9, CALORIES: 11, LENGTH_TYPE: 12,
    TIMESTAMP: 253, MESSAGE_INDEX: 254
  };
  var LAP = {
    START_TIME: 2, ELAPSED: 7, TIMER: 8, DISTANCE: 9, CYCLES: 10, CALORIES: 11,
    AVG_SPEED: 13, MAX_SPEED: 14, AVG_CADENCE: 17, SPORT: 25, NUM_LENGTHS: 32,
    FIRST_LENGTH_INDEX: 35, AVG_STROKE_DISTANCE: 37, SWIM_STROKE: 38,
    SUB_SPORT: 39, NUM_ACTIVE_LENGTHS: 40, TIMESTAMP: 253, MESSAGE_INDEX: 254
  };
  var SES = {
    START_TIME: 2, SPORT: 5, SUB_SPORT: 6, ELAPSED: 7, TIMER: 8, DISTANCE: 9,
    CYCLES: 10, CALORIES: 11, AVG_SPEED: 14, MAX_SPEED: 15, AVG_CADENCE: 18,
    FIRST_LAP_INDEX: 25, NUM_LAPS: 26, NUM_LENGTHS: 33, AVG_STROKE_COUNT: 41,
    AVG_STROKE_DISTANCE: 42, SWIM_STROKE: 43, POOL_LENGTH: 44,
    POOL_LENGTH_UNIT: 46, NUM_ACTIVE_LENGTHS: 47, TIMESTAMP: 253, MESSAGE_INDEX: 254
  };
  var REC = { HEART_RATE: 3, CADENCE: 4, DISTANCE: 5, SPEED: 6, TIMESTAMP: 253 };

  /* Fields Garmin writes but does not document. Each names a quantity we know
   * how to compute; load() checks the file's own value before trusting one. */
  var UNDOCUMENTED = {
    session: { 79: 'avgStrokeCount10', 80: 'swolf' },
    lap: { 73: 'swolf', 90: 'avgStrokeCount10' }
  };

  var SPORT_SWIMMING = 5;
  var SUB_LAP_SWIMMING = 17;
  var SUB_OPEN_WATER = 18;
  var LENGTH_TYPE_ACTIVE = 1;

  var SWIM_STROKES = ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly',
                      'Drill', 'Mixed', 'IM', 'IM by round', 'Reverse IM'];

  function msgsOf(decoded, name) {
    return decoded.messages.filter(function (m) { return m.name === name; });
  }

  function SwimLoadError(message, detail) {
    this.name = 'SwimLoadError';
    this.message = message;
    this.detail = detail || null;
  }
  SwimLoadError.prototype = Object.create(Error.prototype);

  /* ---- Load ------------------------------------------------------------ */

  function load(decoded) {
    var sessions = msgsOf(decoded, 'session');
    if (!sessions.length) {
      throw new SwimLoadError('This FIT file has no session data.',
        'It may not be an activity file at all.');
    }
    var session = sessions[0];
    var sport = session.fields[SES.SPORT];

    if (sport !== SPORT_SWIMMING) {
      throw new SwimLoadError('This is not a swim.',
        'The file reports its sport as "' + sportName(sport) +
        '". Only swimming activities can be corrected here.');
    }

    var lengthMsgs = msgsOf(decoded, 'length');
    if (!lengthMsgs.length) {
      if (session.fields[SES.SUB_SPORT] === SUB_OPEN_WATER) {
        throw new SwimLoadError('This is an open-water swim.',
          'Open-water swims have no lengths or turns to correct — the distance comes from GPS.');
      }
      throw new SwimLoadError('This swim has no length data.',
        'Turn corrections need per-length records, which only pool swims have.');
    }

    var poolLength = session.fields[SES.POOL_LENGTH];
    if (poolLength == null || poolLength === 0xFFFF || poolLength === 0) {
      throw new SwimLoadError('This swim has no pool length recorded.',
        'Without knowing the pool length, distances cannot be recalculated.');
    }

    // message_index is authoritative for order; file order need not match, and
    // on a Fenix 3 lengths are interleaved among the record stream.
    var ordered = lengthMsgs.slice().sort(function (a, b) {
      return (a.fields[LEN.MESSAGE_INDEX] || 0) - (b.fields[LEN.MESSAGE_INDEX] || 0);
    });

    var model = {
      decoded: decoded,
      session: session,
      laps: msgsOf(decoded, 'lap').sort(function (a, b) {
        return (a.fields[LAP.MESSAGE_INDEX] || 0) - (b.fields[LAP.MESSAGE_INDEX] || 0);
      }),
      records: msgsOf(decoded, 'record').sort(function (a, b) {
        return (a.fields[REC.TIMESTAMP] || 0) - (b.fields[REC.TIMESTAMP] || 0);
      }),
      // pool_length is always metres on the wire; pool_length_unit only says
      // how to display it. A 25yd pool stores 22.86m.
      poolLengthM: poolLength / 100,
      displayUnit: session.fields[SES.POOL_LENGTH_UNIT] === 1 ? 'yd' : 'm',
      subSport: session.fields[SES.SUB_SPORT],
      isPoolSwim: session.fields[SES.SUB_SPORT] === SUB_LAP_SWIMMING,
      sourceLengths: ordered,
      lengths: ordered.map(function (m, i) { return toLength(m, i); }),
      original: null,
      lapSpans: [],
      recordsDerivable: false,
      trusted: { session: {}, lap: {} },
      countsActiveOnly: { session: false, lap: false }
    };

    model.original = model.lengths.map(cloneLength);
    model.lapSpans = computeLapSpans(model);
    calibrate(model);
    return model;
  }

  function toLength(m, srcIdx) {
    return {
      msg: m,
      srcIdx: srcIdx,             // index of the original length this came from
      startTime: m.fields[LEN.START_TIME],
      elapsedMs: m.fields[LEN.ELAPSED],
      timerMs: m.fields[LEN.TIMER],
      strokes: nullIfInvalid(m.fields[LEN.STROKES], 0xFFFF),
      calories: nullIfInvalid(m.fields[LEN.CALORIES], 0xFFFF),
      cadence: nullIfInvalid(m.fields[LEN.CADENCE], 0xFF),
      swimStroke: nullIfInvalid(m.fields[LEN.SWIM_STROKE], 0xFF),
      lengthType: m.fields[LEN.LENGTH_TYPE],
      active: m.fields[LEN.LENGTH_TYPE] === LENGTH_TYPE_ACTIVE,
      origin: 'original',
      edit: null
    };
  }

  function cloneLength(l) {
    var c = {};
    for (var k in l) if (Object.prototype.hasOwnProperty.call(l, k)) c[k] = l[k];
    return c;
  }

  function nullIfInvalid(v, invalid) {
    return (v == null || v === invalid) ? null : v;
  }

  /* Lap i owns lengths [lap[i].first_length_index, lap[i+1].first_length_index).
   * Using first_length_index + num_lengths instead desynchronises at the first
   * idle length — it breaks 18 of 38 laps in a real Fenix 3 file. */
  function computeLapSpans(model) {
    var n = model.sourceLengths.length;
    return model.laps.map(function (lap, i) {
      var start = lap.fields[LAP.FIRST_LENGTH_INDEX];
      if (start == null || start === 0xFFFF) start = i === 0 ? 0 : null;
      var next = model.laps[i + 1];
      var end = next ? next.fields[LAP.FIRST_LENGTH_INDEX] : n;
      if (end == null || end === 0xFFFF) end = n;
      if (start == null) start = 0;
      return { lap: lap, start: Math.min(start, n), end: Math.min(Math.max(end, start), n) };
    });
  }

  /* Works out this device's conventions by testing our derivations against the
   * file's own untouched values. Anything that fails is left alone on write. */
  function calibrate(model) {
    var all = model.lengths;
    var actives = all.filter(function (l) { return l.active; });

    // Does num_lengths mean "all lengths" or "active lengths only"?
    var sesN = model.session.fields[SES.NUM_LENGTHS];
    model.countsActiveOnly.session =
      sesN != null && sesN === actives.length && actives.length !== all.length;

    var lapActiveOnly = 0, lapAll = 0;
    model.lapSpans.forEach(function (span) {
      var slice = all.slice(span.start, span.end);
      var act = slice.filter(function (l) { return l.active; }).length;
      var stored = span.lap.fields[LAP.NUM_LENGTHS];
      if (stored == null) return;
      if (stored === act && act !== slice.length) lapActiveOnly++;
      else if (stored === slice.length) lapAll++;
    });
    model.countsActiveOnly.lap = lapActiveOnly > lapAll;

    // Can records be regenerated from lengths?
    model.recordsDerivable = verifyRecordDerivation(model);

    // Do the undocumented fields mean what we think they mean?
    var total = summarise(model, all);
    model.trusted.session = checkUndocumented(model.session.fields, UNDOCUMENTED.session, total);

    model.trusted.lap = {};
    model.lapSpans.forEach(function (span, i) {
      var sum = summarise(model, all.slice(span.start, span.end));
      model.trusted.lap[i] = checkUndocumented(span.lap.fields, UNDOCUMENTED.lap, sum);
    });
  }

  function checkUndocumented(fields, map, sum) {
    var out = {};
    Object.keys(map).forEach(function (num) {
      var stored = fields[num];
      if (stored == null) return;
      var expected = undocumentedValue(map[num], sum);
      // Allow 1 unit of slack for the device's own rounding.
      out[num] = expected != null && Math.abs(stored - expected) <= 1;
    });
    return out;
  }

  function undocumentedValue(kind, sum) {
    if (kind === 'swolf') return sum.swolf;
    if (kind === 'avgStrokeCount10') return Math.round(sum.avgStrokeCount * 10);
    return null;
  }

  /* ---- Derived values -------------------------------------------------- */

  function endTime(l) { return l.startTime + l.elapsedMs / 1000; }

  function activeLengths(model) {
    return model.lengths.filter(function (l) { return l.active; });
  }

  // A length always covers exactly one pool length; FIT stores no per-length
  // distance. Speed is mm/s.
  function speedOf(model, l) {
    if (!l.active || !l.timerMs) return 0;
    return Math.round(model.poolLengthM / (l.timerMs / 1000) * 1000);
  }

  function cadenceOf(l) {
    if (!l.active || !l.timerMs || l.strokes == null) return null;
    return Math.round(l.strokes / (l.timerMs / 1000) * 60);
  }

  function deriveRecord(model, ts) {
    var done = 0, last = null;
    for (var i = 0; i < model.lengths.length; i++) {
      var l = model.lengths[i];
      if (endTime(l) > ts + 0.5) break;
      if (l.active) { done++; last = l; }
    }
    return {
      distance: Math.round(done * model.poolLengthM * 100),
      speed: last ? speedOf(model, last) : null,
      cadence: last ? cadenceOf(last) : null
    };
  }

  /* Records vary wildly by device — 1/second on a Fenix 3, 1/length in Garmin's
   * SDK example, 1 per 250s on a FR935. Rather than assume, check whether our
   * model reproduces this file's records exactly; if not, only nudge distance. */
  function verifyRecordDerivation(model) {
    if (!model.records.length) return false;
    return model.records.every(function (r) {
      var d = deriveRecord(model, r.fields[REC.TIMESTAMP]);
      var dist = r.fields[REC.DISTANCE];
      if (dist != null && dist !== 0xFFFFFFFF && dist !== d.distance) return false;
      var sp = r.fields[REC.SPEED];
      if (sp != null && sp !== 0xFFFF && d.speed != null && Math.abs(sp - d.speed) > 1) return false;
      return true;
    });
  }

  /* ---- Anomaly detection ----------------------------------------------- */

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Median of nearby active lengths, so a pace that drifts across a long swim
   * doesn't drag the baseline. Falls back to the whole swim when short. */
  function localMedian(actives, idx, windowSize) {
    var w = windowSize || 9;
    var half = Math.floor(w / 2);
    var hi = Math.min(actives.length, Math.max(idx - half, 0) + w);
    var lo = Math.max(0, hi - w);
    var vals = [];
    for (var i = lo; i < hi; i++) if (i !== idx) vals.push(actives[i].elapsedMs);
    return median(vals.length ? vals : actives.map(function (l) { return l.elapsedMs; }));
  }

  /* sensitivity 0..1: 0 = strict (only blatant cases), 1 = loose (more flags). */
  function thresholds(sensitivity) {
    var s = sensitivity == null ? 0.5 : sensitivity;
    return { longRatio: 1.9 - 0.6 * s, shortRatio: 0.45 + 0.3 * s };
  }

  function detect(model, opts) {
    opts = opts || {};
    var t = thresholds(opts.sensitivity);
    var useStrokes = opts.useStrokes !== false;
    var actives = activeLengths(model);
    var strokeMedian = median(actives.filter(function (x) { return x.strokes != null; })
                                     .map(function (x) { return x.strokes; }));
    var out = [];

    actives.forEach(function (l, i) {
      if (l.edit) return; // corrected or dismissed already
      var med = localMedian(actives, i, opts.window);
      if (!med) return;
      var ratio = l.elapsedMs / med;
      var strokeRatio = (useStrokes && l.strokes != null && strokeMedian)
        ? l.strokes / strokeMedian : null;

      var kind = ratio >= t.longRatio ? 'missed_turn'
               : ratio <= t.shortRatio ? 'false_turn' : null;
      if (!kind) return;

      var missed = kind === 'missed_turn';
      out.push({
        kind: kind,
        length: l,
        index: model.lengths.indexOf(l),
        ratio: ratio,
        strokeRatio: strokeRatio,
        medianMs: med,
        confidence: confidenceFor(missed ? ratio : 1 / ratio,
                                  strokeRatio == null ? null : (missed ? strokeRatio : 1 / strokeRatio)),
        title: missed ? 'Missed turn' : 'Turn that never happened',
        detail: missed
          ? 'Took ' + fmtDur(l.elapsedMs) + ' — ' + ratio.toFixed(2) + '× the ' +
            fmtDur(med) + ' median of nearby lengths' +
            (strokeRatio ? ', with ' + strokeRatio.toFixed(2) + '× the strokes' : '') +
            '. Probably two lengths with the turn missed.'
          : 'Took only ' + fmtDur(l.elapsedMs) + ' — ' + ratio.toFixed(2) + '× the ' +
            fmtDur(med) + ' median of nearby lengths' +
            (strokeRatio ? ', with ' + strokeRatio.toFixed(2) + '× the strokes' : '') +
            '. The watch probably registered a turn mid-length.'
      });
    });

    return out;
  }

  /* Both a missed and a false turn should show a 2x discrepancy. Confidence
   * rises as the observed ratios close on 2, and stroke count agreeing with
   * time is the strongest signal there is — it's an independent measurement. */
  function confidenceFor(ratio, strokeRatio) {
    var timeScore = 1 - Math.min(1, Math.abs(ratio - 2) / 2);
    if (strokeRatio == null) return clamp(timeScore * 0.75);
    var strokeScore = 1 - Math.min(1, Math.abs(strokeRatio - 2) / 2);
    return clamp(timeScore * 0.5 + strokeScore * 0.5);
  }

  function clamp(v) { return Math.max(0, Math.min(1, v)); }

  /* ---- Corrections ----------------------------------------------------- */

  /* Splits a length in two at splitMs from its start — the missed-turn fix.
   * FIT holds no per-stroke timing, so strokes divide in proportion to time
   * unless the swimmer knows better; the total is preserved either way. */
  function splitLength(model, index, splitMs, strokesFirst) {
    var l = model.lengths[index];
    if (!l) throw new Error('No length at index ' + index);
    if (splitMs <= 0 || splitMs >= l.elapsedMs) {
      throw new Error('The turn must fall inside the length.');
    }

    var a = cloneLength(l), b = cloneLength(l);
    var frac = splitMs / l.elapsedMs;

    a.elapsedMs = splitMs;
    a.timerMs = Math.round(l.timerMs * frac);
    b.elapsedMs = l.elapsedMs - splitMs;
    b.timerMs = l.timerMs - a.timerMs;

    a.startTime = l.startTime;
    b.startTime = Math.round(l.startTime + splitMs / 1000);

    if (l.strokes != null) {
      var first = strokesFirst != null ? strokesFirst : Math.round(l.strokes * frac);
      a.strokes = Math.max(0, Math.min(l.strokes, first));
      b.strokes = l.strokes - a.strokes;
    }

    // The watch's calorie figure for a missed-turn length can't be trusted —
    // it recorded half its neighbours' despite taking twice as long — so both
    // halves are re-estimated from the surrounding lengths' burn rate.
    var rate = medianCalorieRate(model, index);
    if (rate != null && l.calories != null) {
      a.calories = Math.max(1, Math.round(a.timerMs / 1000 * rate));
      b.calories = Math.max(1, Math.round(b.timerMs / 1000 * rate));
    } else if (l.calories != null) {
      a.calories = Math.round(l.calories * frac);
      b.calories = l.calories - a.calories;
    }

    a.cadence = cadenceOf(a);
    b.cadence = cadenceOf(b);
    a.origin = b.origin = 'split';
    a.edit = { type: 'split', at: splitMs, half: 'first' };
    b.edit = { type: 'split', at: splitMs, half: 'second' };

    model.lengths.splice(index, 1, a, b);
    return [a, b];
  }

  /* Merges a length into the one after it — the false-turn fix. The result is
   * exactly what the watch would have recorded had it not seen a turn. */
  function mergeLength(model, index) {
    var a = model.lengths[index], b = model.lengths[index + 1];
    if (!a || !b) throw new Error('Need two lengths to merge.');
    if (a.active !== b.active) throw new Error('A swum length cannot merge with a rest.');
    if (!sameLap(model, a, b)) throw new Error('These lengths are in different laps.');

    var m = cloneLength(a);
    m.elapsedMs = a.elapsedMs + b.elapsedMs;
    m.timerMs = a.timerMs + b.timerMs;
    m.startTime = a.startTime;
    m.strokes = (a.strokes == null && b.strokes == null) ? null : (a.strokes || 0) + (b.strokes || 0);
    m.calories = (a.calories == null && b.calories == null) ? null : (a.calories || 0) + (b.calories || 0);
    m.cadence = cadenceOf(m);
    m.origin = 'merged';
    m.edit = { type: 'merge' };
    m.mergedSrc = [a.srcIdx, b.srcIdx];

    model.lengths.splice(index, 2, m);
    return m;
  }

  function sameLap(model, a, b) {
    if (!model.lapSpans.length) return true;
    return lapIndexOf(model, a.srcIdx) === lapIndexOf(model, b.srcIdx);
  }

  function lapIndexOf(model, srcIdx) {
    for (var i = 0; i < model.lapSpans.length; i++) {
      if (srcIdx >= model.lapSpans[i].start && srcIdx < model.lapSpans[i].end) return i;
    }
    return model.lapSpans.length - 1;
  }

  function medianCalorieRate(model, excludeIndex) {
    var rates = [];
    model.lengths.forEach(function (l, i) {
      if (i === excludeIndex || !l.active || l.calories == null || !l.timerMs) return;
      rates.push(l.calories / (l.timerMs / 1000));
    });
    return rates.length ? median(rates) : null;
  }

  function dismiss(model, index) {
    var l = model.lengths[index];
    if (l) l.edit = { type: 'dismissed' };
  }

  function undo(model, index) {
    var l = model.lengths[index];
    if (!l) return;
    if (l.edit && l.edit.type === 'dismissed') { l.edit = null; return; }
    resetAll(model);
  }

  function resetAll(model) {
    model.lengths = model.original.map(cloneLength);
  }

  function corrections(model) {
    return model.lengths.filter(function (l) {
      return l.edit && l.edit.type !== 'dismissed' && l.edit.half !== 'second';
    }).length;
  }

  function isEdited(model) {
    return model.lengths.some(function (l) { return l.edit && l.edit.type !== 'dismissed'; });
  }

  /* ---- Summary --------------------------------------------------------- */

  function summarise(model, lengths) {
    var ls = lengths || model.lengths;
    var act = ls.filter(function (l) { return l.active; });
    var strokes = act.reduce(function (s, l) { return s + (l.strokes || 0); }, 0);
    var calories = ls.reduce(function (s, l) { return s + (l.calories || 0); }, 0);
    var timerMs = act.reduce(function (s, l) { return s + l.timerMs; }, 0);
    var elapsedMs = ls.reduce(function (s, l) { return s + l.elapsedMs; }, 0);
    var distanceM = act.length * model.poolLengthM;

    return {
      lengths: ls.length,
      activeLengths: act.length,
      distanceM: distanceM,
      strokes: strokes,
      calories: calories,
      timerMs: timerMs,
      elapsedMs: elapsedMs,
      // SWOLF = average length time in seconds + average strokes per length.
      // Not a real FIT field; Garmin keeps it in an undocumented one.
      swolf: act.length ? Math.round(timerMs / act.length / 1000 + strokes / act.length) : null,
      avgSpeed: timerMs ? distanceM / (timerMs / 1000) : 0,
      avgStrokeDistance: strokes ? distanceM / strokes : 0,
      avgStrokeCount: act.length ? strokes / act.length : 0,
      pacePer100: distanceM ? (timerMs / 1000) / (distanceM / 100) : 0
    };
  }

  /* Compares the corrected swim against the file as it arrived, for the
   * pre-export summary — every number that will change, stated up front. */
  function diff(model) {
    var before = summarise(model, model.original);
    var after = summarise(model, model.lengths);
    return {
      before: before, after: after,
      changed: Object.keys(after).filter(function (k) {
        return typeof after[k] === 'number' && Math.abs(after[k] - before[k]) > 1e-9;
      })
    };
  }

  /* ---- Write back ------------------------------------------------------ */

  /* Rewrites length/lap/session/record messages from the edited model, reusing
   * each message's original definition so untouched fields keep their values
   * and the file's structure survives. Length messages are replaced in place,
   * which matters: a Fenix 3 interleaves them through the record stream, and
   * gathering them together would reorder the file.
   *
   * opts.densifyRecords rebuilds the record stream as one record per length —
   * see rebuildRecords() for why that is often the only way to get a sane
   * graph out of the result. */
  function apply(model, opts) {
    opts = opts || {};
    var decoded = model.decoded;
    var densify = !!opts.densifyRecords && model.records.length > 0;

    // Group edited lengths by the original length they came from.
    var bySrc = {};
    model.lengths.forEach(function (l) {
      (bySrc[l.srcIdx] = bySrc[l.srcIdx] || []).push(l);
    });

    var srcIndexOf = new Map();
    model.sourceLengths.forEach(function (m, i) { srcIndexOf.set(m, i); });

    var msgIndex = 0;
    var activeSoFar = 0;
    var out = [];

    decoded.records.forEach(function (rec) {
      // When densifying we drop the device's own sparse records and emit our
      // own; otherwise they pass through and get their distance corrected below.
      if (rec.kind === 'data' && rec.message.name === 'record') {
        if (!densify) out.push(rec);
        return;
      }
      if (!(rec.kind === 'data' && rec.message.name === 'length')) {
        out.push(rec);
        return;
      }

      var replacements = bySrc[srcIndexOf.get(rec.message)];
      if (!replacements) return; // consumed by a merge

      replacements.forEach(function (l) {
        var endTs = Math.round(endTime(l));
        out.push(buildLengthRecord(model, l, msgIndex++, densify ? endTs : null));
        if (densify) {
          if (l.active) activeSoFar++;
          out.push(buildRecordFor(model, l, endTs,
                                  Math.round(activeSoFar * model.poolLengthM * 100)));
        }
      });
    });

    decoded.records = ensureDefinitions(out);
    decoded.messages = decoded.records.filter(function (r) { return r.kind === 'data'; })
                                      .map(function (r) { return r.message; });

    if (!densify) {
      // Records: regenerate where verified, else only correct distance.
      model.records.forEach(function (r) {
        var d = deriveRecord(model, r.fields[REC.TIMESTAMP]);
        if (r.fields[REC.DISTANCE] != null && r.fields[REC.DISTANCE] !== 0xFFFFFFFF) {
          r.fields[REC.DISTANCE] = d.distance;
        }
        if (!model.recordsDerivable) return;
        if (r.fields[REC.SPEED] != null && r.fields[REC.SPEED] !== 0xFFFF && d.speed != null) {
          r.fields[REC.SPEED] = d.speed;
        }
        if (r.fields[REC.CADENCE] != null && r.fields[REC.CADENCE] !== 0xFF && d.cadence != null) {
          r.fields[REC.CADENCE] = d.cadence;
        }
      });
    }

    applyLaps(model);
    applySession(model);
    return decoded;
  }

  /* One record per length, stamped at the length's true end.
   *
   * Some devices write a usable record stream and some don't: a Fenix 3 emits
   * one per second, Garmin's own SDK example one per length, and a FR935 one
   * per ~250 seconds — six for a 22-minute swim. Anything reading the file has
   * to draw its graphs from that, and across four-minute gaps there is nothing
   * to draw. Rebuilding at one per length matches the SDK example's shape
   * (record.timestamp == length.timestamp) and is the finest resolution FIT
   * actually holds, since a length is the smallest unit the watch measures.
   *
   * Fields we can't derive per length — temperature, heart rate — are taken
   * from whichever original record sat nearest in time, so those curves survive
   * rather than being flattened to a single value. */
  function buildRecordFor(model, l, ts, distanceCm) {
    var tmpl = nearestRecord(model, ts);
    var def = tmpl.def;
    var fields = {};
    for (var k in tmpl.fields) fields[k] = tmpl.fields[k];

    fields[REC.TIMESTAMP] = ts;
    if (fields[REC.DISTANCE] != null) fields[REC.DISTANCE] = distanceCm;
    // A rest length covers no ground: speed and cadence are genuinely absent,
    // not zero, so they get the base type's invalid sentinel.
    if (fields[REC.SPEED] != null) {
      fields[REC.SPEED] = l.active ? speedOf(model, l) : 0xFFFF;
    }
    if (fields[REC.CADENCE] != null) {
      fields[REC.CADENCE] = (l.active && l.cadence != null) ? l.cadence : 0xFF;
    }

    var msg = { global: tmpl.global, name: 'record', fields: fields,
                devFields: tmpl.devFields, def: def };
    var rec = { kind: 'data', compressed: false, localType: def.localType,
                def: def, message: msg };
    msg._record = rec;
    return rec;
  }

  /* FIT definitions are positional and stateful: a data message means nothing
   * without the definition currently bound to its local type, and local types
   * get rebound as the file goes on (local 0 is file_id early and battery
   * later). Moving a data message can therefore strand it behind its own
   * definition — inserting a record next to a length lands it before the record
   * definition, which sits after the first batch of lengths.
   *
   * So rather than reason about placement, assert the invariant: walk the
   * stream tracking what each local type is bound to, and re-issue a definition
   * whenever a data message would otherwise be misread. Re-issuing is legal and
   * a no-op on a stream that was already correct. */
  function ensureDefinitions(records) {
    var bound = {};
    var out = [];
    records.forEach(function (r) {
      if (r.kind === 'definition') {
        bound[r.localType] = r;
        out.push(r);
        return;
      }
      if (bound[r.localType] !== r.def) {
        out.push(r.def);
        bound[r.def.localType] = r.def;
      }
      out.push(r);
    });
    return out;
  }

  function nearestRecord(model, ts) {
    var best = model.records[0], bestGap = Infinity;
    model.records.forEach(function (r) {
      var gap = Math.abs((r.fields[REC.TIMESTAMP] || 0) - ts);
      if (gap < bestGap) { bestGap = gap; best = r; }
    });
    return best;
  }

  function buildLengthRecord(model, l, messageIndex, timestamp) {
    var src = l.msg;
    var def = src.def;   // per-length: idle lengths often use a leaner definition
    var fields = {};
    for (var k in src.fields) fields[k] = src.fields[k];

    fields[LEN.MESSAGE_INDEX] = messageIndex;
    fields[LEN.START_TIME] = l.startTime;
    fields[LEN.ELAPSED] = Math.round(l.elapsedMs);
    fields[LEN.TIMER] = Math.round(l.timerMs);
    if (l.strokes != null) fields[LEN.STROKES] = l.strokes;
    if (l.calories != null) fields[LEN.CALORIES] = l.calories;
    if (l.cadence != null) fields[LEN.CADENCE] = l.cadence;
    if (fields[LEN.AVG_SPEED] != null) fields[LEN.AVG_SPEED] = speedOf(model, l);

    // By default the timestamp is left exactly as the device wrote it: it marks
    // when the message was flushed, not when the length ended (a FR935 gives 29
    // lengths just 6 distinct values, up to 253s late), and keeping it preserves
    // file order. When rebuilding the record stream we replace it with the true
    // end, so lengths and records agree and the whole stream runs in real time.
    if (timestamp != null) fields[LEN.TIMESTAMP] = timestamp;

    var msg = { global: src.global, name: 'length', fields: fields,
                devFields: src.devFields, def: def };
    var rec = { kind: 'data', compressed: false, localType: def.localType,
                def: def, message: msg };
    msg._record = rec;
    return rec;
  }

  function applyLaps(model) {
    var cursor = 0;
    model.lapSpans.forEach(function (span, i) {
      // Map this lap's original length range onto the edited list.
      var slice = model.lengths.filter(function (l) {
        return l.srcIdx >= span.start && l.srcIdx < span.end;
      });
      var sum = summarise(model, slice);
      var f = span.lap.fields;

      f[LAP.FIRST_LENGTH_INDEX] = cursor;
      f[LAP.NUM_LENGTHS] = model.countsActiveOnly.lap ? sum.activeLengths : slice.length;
      if (f[LAP.NUM_ACTIVE_LENGTHS] != null) f[LAP.NUM_ACTIVE_LENGTHS] = sum.activeLengths;
      // Strava reads lap distance, not lengths — this line is what makes a
      // correction visible after re-upload.
      if (f[LAP.DISTANCE] != null) f[LAP.DISTANCE] = Math.round(sum.distanceM * 100);
      if (f[LAP.CYCLES] != null) f[LAP.CYCLES] = sum.strokes;
      if (f[LAP.CALORIES] != null) f[LAP.CALORIES] = sum.calories;
      if (f[LAP.AVG_SPEED] != null) f[LAP.AVG_SPEED] = Math.round(sum.avgSpeed * 1000);
      if (f[LAP.MAX_SPEED] != null) f[LAP.MAX_SPEED] = maxSpeed(model, slice);
      if (f[LAP.AVG_STROKE_DISTANCE] != null) {
        f[LAP.AVG_STROKE_DISTANCE] = Math.round(sum.avgStrokeDistance * 100);
      }
      writeUndocumented(f, UNDOCUMENTED.lap, model.trusted.lap[i] || {}, sum);
      cursor += slice.length;
    });
  }

  function applySession(model) {
    var sum = summarise(model);
    var f = model.session.fields;

    f[SES.NUM_LENGTHS] = model.countsActiveOnly.session ? sum.activeLengths : model.lengths.length;
    if (f[SES.NUM_ACTIVE_LENGTHS] != null) f[SES.NUM_ACTIVE_LENGTHS] = sum.activeLengths;
    if (f[SES.DISTANCE] != null) f[SES.DISTANCE] = Math.round(sum.distanceM * 100);
    if (f[SES.CYCLES] != null) f[SES.CYCLES] = sum.strokes;
    if (f[SES.CALORIES] != null) f[SES.CALORIES] = sum.calories;
    if (f[SES.AVG_SPEED] != null) f[SES.AVG_SPEED] = Math.round(sum.avgSpeed * 1000);
    if (f[SES.MAX_SPEED] != null) f[SES.MAX_SPEED] = maxSpeed(model, model.lengths);
    if (f[SES.AVG_STROKE_DISTANCE] != null) {
      f[SES.AVG_STROKE_DISTANCE] = Math.round(sum.avgStrokeDistance * 100);
    }
    if (f[SES.AVG_STROKE_COUNT] != null) {
      f[SES.AVG_STROKE_COUNT] = Math.round(sum.avgStrokeCount * 10);
    }
    // total_elapsed_time and total_timer_time are deliberately untouched: the
    // swim took exactly as long as it took.
    writeUndocumented(f, UNDOCUMENTED.session, model.trusted.session, sum);
  }

  function writeUndocumented(fields, map, trusted, sum) {
    Object.keys(map).forEach(function (num) {
      if (!trusted[num]) return; // meaning unconfirmed for this file — leave it
      var v = undocumentedValue(map[num], sum);
      if (v != null) fields[num] = v;
    });
  }

  function maxSpeed(model, lengths) {
    return lengths.reduce(function (m, l) {
      return l.active ? Math.max(m, speedOf(model, l)) : m;
    }, 0);
  }

  /* ---- Formatting ------------------------------------------------------ */

  function fmtDur(ms) {
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }

  function fmtClock(ms) {
    var total = Math.round(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (h && m < 10 ? '0' : '') + m;
    return (h ? h + ':' : '') + mm + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtPace(secPer100, unit) {
    if (!secPer100 || !isFinite(secPer100)) return '–';
    var m = Math.floor(secPer100 / 60);
    var s = Math.round(secPer100 - m * 60);
    if (s === 60) { m++; s = 0; }
    return m + ':' + (s < 10 ? '0' : '') + s + ' /100' + (unit || 'm');
  }

  function fmtDistance(m, unit) {
    if (unit === 'yd') return Math.round(m / 0.9144) + ' yd';
    return Math.round(m) + ' m';
  }

  function strokeName(s) {
    return SWIM_STROKES[s] || (s == null ? 'Unknown' : 'Stroke ' + s);
  }

  function sportName(s) {
    var names = { 0: 'generic', 1: 'running', 2: 'cycling', 3: 'transition',
                  4: 'fitness equipment', 5: 'swimming', 11: 'walking',
                  17: 'hiking', 48: 'floor climbing' };
    return names[s] || ('sport code ' + s);
  }

  var api = {
    load: load, detect: detect, splitLength: splitLength, mergeLength: mergeLength,
    dismiss: dismiss, undo: undo, resetAll: resetAll, isEdited: isEdited,
    corrections: corrections, summarise: summarise, diff: diff, apply: apply,
    deriveRecord: deriveRecord, speedOf: speedOf, cadenceOf: cadenceOf,
    endTime: endTime, activeLengths: activeLengths, median: median,
    thresholds: thresholds, lapIndexOf: lapIndexOf,
    strokeName: strokeName, sportName: sportName,
    fmtDur: fmtDur, fmtClock: fmtClock, fmtPace: fmtPace, fmtDistance: fmtDistance,
    SwimLoadError: SwimLoadError,
    LEN: LEN, LAP: LAP, SES: SES, REC: REC, SWIM_STROKES: SWIM_STROKES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwimModel = api;

})(typeof self !== 'undefined' ? self : this);
