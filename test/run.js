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

// --- real files, when they happen to be present (gitignored personal data) ---

const realFiles = [
  'apps/lap-graphs/samples',
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
