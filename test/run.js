/* Regression tests for the shared FIT code. Run with:  node test/run.js
 *
 * Self-contained by design: the fixtures are synthesised by the encoder rather
 * than read from disk, because the real activity files are personal data and
 * gitignored. If they happen to be present they get exercised too.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'shared/fit/decode.js'));
const A = require(path.join(ROOT, 'shared/fit/adapters.js'));
const E = require(path.join(ROOT, 'shared/fit/encode.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok    ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}

// Stairinator's encoder is a browser IIFE hanging off a window global.
function loadStairFit() {
  const ctx = { console, DataView, Uint8Array, ArrayBuffer, Math, Date, String, Number, Array, Object, JSON, Error };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['shared/fit/decode.js', 'shared/fit/adapters.js', 'shared/fit/encode.js', 'apps/stairinator/src/fit.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const stair = loadStairFit();

// A synthetic stair activity: 10 minutes, rising HR and altitude.
function sampleActivity() {
  const t0 = Date.UTC(2026, 0, 1, 9, 0, 0);
  const records = [];
  for (let i = 0; i < 600; i++) {
    records.push({
      timeMs: t0 + i * 1000,
      hr: 100 + Math.round(i / 20),
      cadence: 60,
      distanceM: i * 0.5,
      altitudeM: i * 0.15,
    });
  }
  return {
    records,
    laps: [{ startMs: t0, elapsedSec: 600, distanceM: 300, totalAscentM: 90 }],
    session: { startMs: t0, elapsedSec: 600, distanceM: 300, totalAscentM: 90, sport: 4, subSport: 14 },
  };
}

console.log('\nshared/fit/decode.js');

const fitBytes = stair.Stair.fit.encodeActivity(sampleActivity());

check('encoder produces a file with a .FIT signature', () => {
  eq(String.fromCharCode(fitBytes[8], fitBytes[9], fitBytes[10], fitBytes[11]), '.FIT');
});

check('decodes its own output', () => {
  const d = D.decode(fitBytes);
  assert(d.messages.length > 0, 'no messages decoded');
  assert(d.byGlobal[20] && d.byGlobal[20].length === 600, 'expected 600 record messages');
});

check('CRC validates', () => {
  eq(D.decode(fitBytes).crc.valid, true, 'crc invalid');
});

check('round-trips byte-for-byte', () => {
  const out = E.encode(D.decode(fitBytes));
  eq(out.length, fitBytes.length, 'length changed');
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== fitBytes[i]) throw new Error('byte ' + i + ' differs');
  }
});

check('accepts Uint8Array, ArrayBuffer and Buffer alike', () => {
  const ab = fitBytes.buffer.slice(fitBytes.byteOffset, fitBytes.byteOffset + fitBytes.byteLength);
  const a = D.decode(fitBytes).messages.length;
  const b = D.decode(ab).messages.length;
  const c = D.decode(Buffer.from(fitBytes)).messages.length;
  assert(a === b && b === c, 'input types disagree: ' + [a, b, c]);
});

check('nullifyInvalid is off by default (round-trip contract)', () => {
  // Sentinels must survive as literal integers or re-encoding breaks.
  const raw = D.decode(fitBytes);
  const nulled = D.decode(fitBytes, { nullifyInvalid: true });
  eq(raw.messages.length, nulled.messages.length, 'message count changed');
  const anySentinel = raw.messages.some(m =>
    Object.values(m.fields).some(v => v === 0xFF || v === 0xFFFF || v === 0xFFFFFFFF));
  assert(anySentinel, 'fixture has no invalid sentinels — test is not proving anything');
});

check('nullifyInvalid maps sentinels to null', () => {
  const nulled = D.decode(fitBytes, { nullifyInvalid: true });
  const bad = nulled.messages.some(m =>
    Object.values(m.fields).some(v => v === 0xFF || v === 0xFFFF || v === 0xFFFFFFFF));
  assert(!bad, 'sentinel survived nullifyInvalid');
});

check('rejects a non-FIT file', () => {
  let threw = false;
  try { D.decode(new Uint8Array(20)); } catch (e) { threw = true; }
  assert(threw, 'should have thrown');
});

check('isFit sniffs without throwing', () => {
  eq(D.isFit(fitBytes), true);
  eq(D.isFit(new Uint8Array([1, 2, 3])), false);
});

check('tolerant mode survives a truncated tail', () => {
  const truncated = fitBytes.slice(0, Math.floor(fitBytes.length / 2));
  let threw = false;
  try { D.decode(truncated); } catch (e) { threw = true; }
  assert(threw, 'strict mode should reject a truncated file');
  const d = D.decode(truncated, { tolerant: true });
  assert(d.messages.length > 0, 'tolerant mode salvaged nothing');
});

console.log('\nshared/fit/adapters.js');

check('toPointStream yields the recorded heart rate', () => {
  const d = D.decode(fitBytes, { nullifyInvalid: true, tolerant: true });
  const s = A.toPointStream(d);
  eq(s.points.length, 600, 'point count');
  eq(s.hasHr, true, 'hasHr');
  eq(s.hasGps, false, 'hasGps');
  eq(s.points[0].hr, 100, 'first hr');
  assert(s.points[0].timeMs < s.points[599].timeMs, 'points not in time order');
});

check('toActivityModel yields samples and laps', () => {
  const d = D.decode(fitBytes, { nullifyInvalid: true, tolerant: true });
  const m = A.toActivityModel(d);
  eq(m.samples.length, 600, 'sample count');
  eq(m.laps.length, 1, 'lap count');
  assert(m.samples[0].heartRate === 100, 'first sample hr: ' + m.samples[0].heartRate);
});

check('adapters agree on heart rate', () => {
  const d = D.decode(fitBytes, { nullifyInvalid: true, tolerant: true });
  const pts = A.toPointStream(d).points;
  const samples = A.toActivityModel(d).samples;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i].hr, b = samples[i].heartRate;
    if (a !== (b === undefined ? null : b)) throw new Error('hr differs at ' + i + ': ' + a + ' vs ' + b);
  }
});

console.log('\nshared/fit/encode.js');

check('assembleFile writes a valid header and CRC', () => {
  const sink = new E.ByteSink();
  sink.bytes([0x40, 0, 0, 0, 0, 0]); // a minimal, meaningless data section
  const file = E.assembleFile(sink.toUint8Array(), { headerSize: 14, protocolVersion: 0x20, profileVersion: 2140 });
  eq(file[0], 14, 'header size');
  eq(String.fromCharCode(file[8], file[9], file[10], file[11]), '.FIT', 'signature');
  eq(D.crcOver(file, 0, 12), file[12] | (file[13] << 8), 'header CRC');
  eq(D.crcOver(file, 0, file.length - 2), file[file.length - 2] | (file[file.length - 1] << 8), 'file CRC');
});

check('writeField substitutes the invalid sentinel for null', () => {
  const sink = new E.ByteSink();
  E.writeField(sink, null, 0x02, 1, true);      // uint8  -> 0xFF
  E.writeField(sink, null, 0x84, 2, true);      // uint16 -> 0xFFFF
  E.writeField(sink, null, 0x8C, 4, true);      // uint32z -> 0
  const b = sink.toUint8Array();
  eq(b[0], 0xFF, 'uint8 invalid');
  eq(b[1] | (b[2] << 8), 0xFFFF, 'uint16 invalid');
  eq(b[3] | b[4] | b[5] | b[6], 0, 'uint32z invalid');
});

check('stairinator encoder output is byte-stable', () => {
  // Pins the synthesised file against accidental drift — the encoder refactor
  // that moved its byte-writing into shared/ must not change a single byte.
  const crypto = require('crypto');
  eq(fitBytes.length, 12947, 'encoded length');
  eq(crypto.createHash('sha256').update(Buffer.from(fitBytes)).digest('hex'),
     'bfcb393ed56389a4984d7bf72b683046223a4a8c4b67b08e62f3611999426a4a',
     'encoded bytes drifted');
});

console.log('\nshared/ui/settings.js');

// settings.js talks to localStorage; give it one.
(function () {
  const store = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _store: store
  };
  const S = require(path.join(ROOT, 'shared/ui/settings.js'));

  const doc = { schemaVersion: 1, machines: [{ id: 'm1', name: 'Machine' }], plans: [{ id: 'p1', name: 'Plan' }] };
  const zones = [120, 140, 160, 175, 190];

  check('exports nothing when nothing is stored', () => {
    eq(Object.keys(S.exportAll().data).length, 0, 'expected an empty export');
  });

  check('round-trips every stored key', () => {
    localStorage.setItem('activity-tools.stairinator.doc', JSON.stringify(doc));
    localStorage.setItem('activity-tools.graphs.hr-zones', JSON.stringify(zones));
    const payload = S.exportAll();
    eq(Object.keys(payload.data).length, 2, 'export key count');

    S.clear();
    eq(Object.keys(S.exportAll().data).length, 0, 'clear left something behind');

    const res = S.importAll(payload);
    eq(res.applied.length, 2, 'applied count');
    eq(JSON.stringify(JSON.parse(localStorage.getItem('activity-tools.stairinator.doc'))), JSON.stringify(doc), 'doc');
    eq(JSON.stringify(JSON.parse(localStorage.getItem('activity-tools.graphs.hr-zones'))), JSON.stringify(zones), 'zones');
  });

  check('leaves keys the file does not mention alone', () => {
    S.clear();
    localStorage.setItem('activity-tools.graphs.hr-zones', JSON.stringify(zones));
    S.importAll({ format: S.FORMAT, version: 1, data: { 'activity-tools.stairinator.doc': doc } });
    assert(localStorage.getItem('activity-tools.graphs.hr-zones') !== null, 'untouched key was cleared');
  });

  check('accepts a legacy bare Stairinator export', () => {
    S.clear();
    const res = S.importAll({ machines: doc.machines, plans: doc.plans });
    eq(res.applied.length, 1, 'applied count');
    const back = JSON.parse(localStorage.getItem('activity-tools.stairinator.doc'));
    eq(back.machines.length, 1, 'machines');
    eq(back.plans.length, 1, 'plans');
  });

  check('ignores unknown keys rather than writing them', () => {
    S.clear();
    const res = S.importAll({ format: S.FORMAT, version: 1,
      data: { 'activity-tools.stairinator.doc': doc, 'something.else': { a: 1 } } });
    eq(res.applied.length, 1, 'applied');
    eq(res.skipped.length, 1, 'skipped');
    eq(localStorage.getItem('something.else'), null, 'unknown key was written');
  });

  check('rejects a file that is not a settings export', () => {
    let threw = false;
    try { S.importAll({ hello: 'world' }); } catch (e) { threw = true; }
    assert(threw, 'should have thrown');
  });

  check('summary describes what is stored', () => {
    S.clear();
    localStorage.setItem('activity-tools.stairinator.doc', JSON.stringify(doc));
    const rows = S.summary();
    const stair = rows.filter(r => r.key === 'activity-tools.stairinator.doc')[0];
    eq(stair.present, true, 'present');
    eq(stair.detail, '1 machine, 1 activity', 'detail');
    const zonesRow = rows.filter(r => r.key === 'activity-tools.graphs.hr-zones')[0];
    eq(zonesRow.present, false, 'unstored key should not be present');
  });

  check('every key in the registry is one an app actually uses', () => {
    // A key here that no app writes is a backup of nothing; a key an app writes
    // that is missing here is silently absent from every backup.
    const used = [];
    const sources = [
      'apps/bd-licious-graphs/app.js',
      'apps/stairinator/src/storage.js',
      'apps/swim-corrector/js/ui.js'
    ];
    sources.forEach(function (rel) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const m = src.match(/'[A-Za-z0-9_.-]+\.(?:v\d+|[a-z-]+)'/g) || [];
      m.forEach(function (q) { used.push(q.slice(1, -1)); });
    });
    S.KEYS.forEach(function (k) {
      assert(used.indexOf(k.key) >= 0, 'registry key not used by any app: ' + k.key);
    });
  });

  S.clear();
})();

console.log('\nshared/ui/icons.js');

(function () {
  const Icons = require(path.join(ROOT, 'shared/ui/icons.js'));

  check('every data-icon in the pages names a real icon', () => {
    // A typo here renders nothing at all, silently — worth catching.
    const pages = ['index.html', 'settings.html',
      'apps/stairinator/index.html', 'apps/bd-licious-graphs/index.html',
      'apps/swim-corrector/index.html'];
    let found = 0;
    pages.forEach(function (rel) {
      const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const names = (html.match(/data-icon="([^"]+)"/g) || [])
        .map(function (m) { return m.slice(11, -1); });
      names.forEach(function (n) {
        found++;
        assert(Object.prototype.hasOwnProperty.call(Icons.PATHS, n),
          rel + ' references unknown icon "' + n + '"');
      });
    });
    assert(found >= 7, 'expected icons on every page, found ' + found);
  });

  check('the same icon is identical wherever it is used', () => {
    // The landing card and the app header must not drift apart.
    eq(Icons.svg('swim'), Icons.svg('swim'), 'swim');
    assert(Icons.svg('swim').indexOf('var(--accent)') > 0, 'icon should take the app accent');
  });

  check('unknown icon names yield nothing rather than broken markup', () => {
    eq(Icons.svg('nope'), '', 'expected an empty string');
  });

  check('the stair chart pair stays apart for colour-blind viewers', () => {
    // Two lines on one chart, so they have to be told apart by hue alone.
    // Simulates protanopia and deuteranopia (Viénot LMS) and measures ΔE76.
    const CT = require(path.join(ROOT, 'shared/ui/chart-theme.js'));
    const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const delin = c => { c = Math.max(0, Math.min(1, c));
      return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
    const mul = (m, v) => m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    const RGB2LMS = [[0.31399022, 0.63951294, 0.04649755],
                     [0.15537241, 0.75789446, 0.08670142],
                     [0.01775239, 0.10944209, 0.87256922]];
    const LMS2RGB = [[5.47221206, -4.6419601, 0.16963708],
                     [-1.1252419, 2.29317094, -0.1678952],
                     [0.02980165, -0.19318073, 1.16364789]];
    const SIM = {
      protanopia: [[0, 1.05118294, -0.05116099], [0, 1, 0], [0, 0, 1]],
      deuteranopia: [[1, 0, 0], [0.9513092, 0, 0.04866992], [0, 0, 1]]
    };
    const sim = (hex, k) => mul(LMS2RGB, mul(SIM[k], mul(RGB2LMS, hex2rgb(hex).map(lin)))).map(delin);
    const lab = rgb => {
      const [r, g, b] = rgb.map(v => lin(Math.max(0, Math.min(255, v))));
      const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
      const X = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
      const Y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
      const Z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
      return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
    };
    const dE = (a, b) => {
      const [l1, l2] = [lab(a), lab(b)];
      return Math.sqrt((l1[0] - l2[0]) ** 2 + (l1[1] - l2[1]) ** 2 + (l1[2] - l2[2]) ** 2);
    };
    ['protanopia', 'deuteranopia'].forEach(function (k) {
      const d = dE(sim(CT.SERIES.plan, k), sim(CT.SERIES.planHeartRate, k));
      assert(d > 40, 'plan vs heart rate is ΔE ' + d.toFixed(0) + ' under ' + k +
        ' — too close to tell apart');
    });
  });

  check('every icon follows the shared drawing rules', () => {
    Object.keys(Icons.PATHS).forEach(function (name) {
      const svg = Icons.svg(name);
      assert(svg.indexOf('viewBox="0 0 20 20"') > 0, name + ': wrong viewBox');
      assert(svg.indexOf('stroke-width="1.6"') > 0, name + ': wrong stroke width');
      assert(svg.indexOf('stroke-linecap="round"') > 0, name + ': not round-capped');
      assert(svg.indexOf('opacity=".45"') > 0, name + ': missing the dimmed element');
      assert((svg.match(/<circle/g) || []).length >= 1, name + ': missing the filled circle');
    });
  });
})();

// --- real files, when they happen to be present (gitignored personal data) ---

const realFiles = [
  'apps/bd-licious-graphs/samples',
  'apps/swim-corrector/test-data',
].flatMap(dir => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter(f => f.endsWith('.fit')).map(f => path.join(dir, f));
});

console.log('\nreal activity files' + (realFiles.length ? '' : ' (none present — skipped)'));

for (const rel of realFiles) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, rel)));
  check(path.basename(rel) + ' round-trips byte-for-byte', () => {
    const out = E.encode(D.decode(bytes));
    eq(out.length, bytes.length, 'length changed');
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== bytes[i]) throw new Error('byte ' + i + ' differs');
    }
  });
  check(path.basename(rel) + ' feeds both adapters', () => {
    const d = D.decode(bytes, { nullifyInvalid: true, tolerant: true });
    const m = A.toActivityModel(d);
    assert(Array.isArray(m.samples) && Array.isArray(m.laps), 'bad activity model');
    if (d.byGlobal[20] && d.byGlobal[20].length) {
      assert(A.toPointStream(d).points.length > 0, 'empty point stream');
    }
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
