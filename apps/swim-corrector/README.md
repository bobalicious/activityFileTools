# Swim FIT Corrector

Fixes pool-swim FIT files where the watch missed a turn — or saw one that never
happened — and writes a corrected file you can re-upload.

When a turn goes unregistered you get one length of roughly double the time and
double the strokes. Your distance drops by a pool length, and pace, SWOLF and
every graph are wrong with it. A phantom turn does the same in reverse. This app
finds those lengths, lets you fix them, and rebuilds the file.

## Running it

Open `index.html` in a browser. That's it.

No build, no install, no server, no network. Copy the folder anywhere and it
works — it uses plain `<script>` tags rather than ES modules precisely so it runs
from `file://`. Your file is read, edited and rewritten entirely in the page; it
is never uploaded anywhere.

```
index.html                  markup
app.css                     styling, light + dark
js/swim-model.js            swim semantics: detection, corrections, recalculation
js/chart.js                 the per-length bar chart (hand-rolled SVG)
js/ui.js                    everything the user touches

../../shared/fit/decode.js  FIT binary → message structure
../../shared/fit/encode.js  message structure → FIT binary
```

## What it does

1. **Open** a pool-swim `.fit` file. Anything else is refused with a reason —
   a run, an open-water swim, a file with no lengths.
2. **Review** the per-length chart. Suspected missed and false turns are flagged
   on the chart and listed with a confidence score.
3. **Correct** them. A missed turn opens a slider to place the turn; a false turn
   merges two lengths into one. Any length can be edited, flagged or not.
4. **Export** a corrected file, after a summary of every number that changes.

To get it onto Strava: delete the old activity, then upload the corrected file.
Strava cannot update an activity in place.

## How it decides

Each length is compared against the **median of the nine lengths around it**, so a
pace that drifts over a long swim doesn't skew the baseline. Roughly 1.6× median
suggests a missed turn, 0.6× a false one; the sensitivity slider moves that band.
Stroke count is checked independently — a missed turn should show about double
the strokes as well as double the time, and when both agree confidence is high.
Rest lengths are never flagged.

A turn that never happened splits **one** length into two, so the evidence is a
*pair* of short lengths whose times add back up to about one normal length. The
pair is reported as a single anomaly and the turn removed is the one **between
them** — never between a short length and whatever happens to follow it. A short
length with no matching partner is still listed, but with low confidence: there
is no second half to corroborate it.

## Design notes

Two rules govern the code, both learned the hard way from real files.

**Derive, don't trust.** Devices disagree about what they record.

- `length.timestamp` is *not* when the length ended — it's when the message was
  flushed to disk. A Forerunner 935 gives all 29 lengths just six distinct
  timestamps, batched with the record messages, up to 253 seconds late. Garmin
  say so themselves. Length timing comes from `start_time + total_elapsed_time`,
  which chains exactly.
- `num_lengths` counts *active* lengths on a Fenix 3 but *all* lengths in
  Garmin's own SDK example. Counts are derived by walking the length messages;
  the recorded field is treated as advisory, and written back in whichever
  convention the file already used.
- `record` messages vary wildly — one per second on a Fenix 3, one per length in
  the SDK example, one per 250 seconds on a FR935.
- A lap owns lengths `[first_length_index, next_lap.first_length_index)`. Using
  `first_length_index + num_lengths` desynchronises at the first idle length.

**Verify a hypothesis against the file before acting on it.** Some fields we
need are undocumented — absent from Garmin's official profile. SWOLF is not a
real FIT field at all; Garmin keep it in session field 80 and lap field 73, and
average stroke count in session 79 / lap 90. Rather than guess, the app computes
what it believes each field means from the file's own untouched data and compares.
Only fields that reproduce their stored value get rewritten. The same check runs
on the record messages: distance, speed and cadence are regenerated from the
lengths only if that derivation reproduces the original file exactly, and
otherwise it falls back to correcting distance alone.

Everything else is preserved. `encode(decode(file))` is byte-for-byte identical
to the input, including undocumented messages, developer fields and big-endian
definitions — so anything the app doesn't understand survives untouched, and the
file still looks like it came from your watch.

### What a correction touches

`length` (split or merged, `message_index` renumbered), then every dependent
aggregate: lap `first_length_index`, `num_lengths`, `num_active_lengths`,
`total_distance`, `total_cycles`, `total_calories`, `avg_speed`, `max_speed`,
`avg_stroke_distance`; the same on `session`; and the cumulative distance in
`record`. Lap distance matters more than it looks — **Strava sums lap distances,
not lengths**, so a fix that skipped it would appear to do nothing.

Deliberately left alone: `total_elapsed_time` and `total_timer_time` (the swim
took as long as it took), `file_id` and `device_info` (so it uploads as the same
watch), and every message the app has no business editing.

### Rebuilding the record stream

Sites like Strava draw their pace graph from `record` messages, not from lengths
— and devices disagree wildly about how many to write. A Fenix 3 writes one per
second; Garmin's SDK example writes one per length; the FR935 in the test file
writes **six for a 22-minute swim**, one every ~250 seconds. Nothing can draw a
sensible graph across four-minute gaps, so it interpolates and invents a shape.

The export therefore offers **one record per length** (on by default, and shown
as a line item in the change summary). It emits a record at each length's true
end time carrying cumulative distance, that length's speed and its cadence —
the same shape as Garmin's own SDK pool-swim example, in which
`record.timestamp == length.timestamp`. A length is the finest resolution FIT
holds, so this is as dense as the data can honestly go. Temperature and heart
rate, which can't be derived per length, are taken from whichever original
record sat nearest in time so those curves survive rather than flattening.

On the test file this turns six records into thirty, with every distance step
exactly 25 m and segment paces spanning a believable 2:40–3:20 instead of a
2:10 tail and a 4:10 spike.

When this option is on, `length.timestamp` is also set to the length's true end
rather than the device's flush time — otherwise the lengths and the records
would disagree about when the swim happened. Turn the option off to keep the
watch's own records and timestamps exactly as they were; only their distances
are then corrected.

Two details this exposed, both handled:

- **Definitions are positional.** A data message is meaningless without the
  definition currently bound to its local type, and local types get rebound as a
  file goes on (local 0 is `file_id` early and `battery` later). The record
  definition in the test file sits *after* the first batch of lengths, so
  inserting a record beside a length strands it before its own definition. The
  encoder therefore walks the finished stream, tracks every binding, and
  re-issues a definition wherever a data message would otherwise be misread.
- **This file's ordering was never pristine.** Its `global_125` messages carry
  timestamps half an hour after the session ends, and the original stream
  already contains five timestamp decreases. The rebuilt record stream is
  monotonic — for the first time.

### Judgement calls

- **Strokes** divide in proportion to the split, with a manual override. FIT
  records only a stroke *total* per length — there is no per-stroke timing to do
  better. The total is always preserved.
- **Calories** are re-estimated from the surrounding lengths' burn rate, because
  the watch's own figure for a missed-turn length is unreliable: in the test file
  it recorded 3 kcal for a length that took twice as long as its 6 kcal
  neighbours. This does move the session total.
- **Split then merge is not a perfect inverse**, for that reason — calories come
  back re-estimated rather than original. Time and strokes round-trip exactly.
  Use "Reset all" for a true undo.

## Verification

Correcting the test file — a 750 m breaststroke swim with one missed turn at
length 15 (93.4 s and 40 strokes against a 46 s / 18 stroke median):

| | Before | After |
|---|---|---|
| Lengths | 29 | 30 |
| Distance | 725 m | 750 m |
| SWOLF | 66 | 64 |
| Pace | 3:08 /100m | 3:02 /100m |
| Strokes | 542 | 542 |
| Swim time | 22:44 | 22:44 |

The output is validated with **Garmin's official FIT SDK**: `isFIT` true,
`checkIntegrity` (CRC) true, zero decode errors, `message_index` contiguous, and
`start_time + total_elapsed_time == next.start_time` across all 30 lengths.

## Limits

- Pool swims only. Open water has no lengths to correct.
- Heart rate is passed through untouched and shown when present. The test device
  records none in the pool; HRM-Swim/Tri straps store HR in separate `hr`
  messages that some devices append as a chained FIT file, which this app
  preserves but does not merge into the per-length view.
- The undocumented SWOLF and stroke-count fields are inferred from one FR935
  file. If they don't validate against your file, they're left alone rather than
  guessed at.

## Your files, and no warranty

**Keep your own copy of any file you care about.** A FIT file cannot really be
checked by eye, so the original is your only way back if a result turns out
wrong.

Provided **as-is, with no warranty of any kind, express or implied**. You are
responsible for your own data. No liability is accepted for corrupted files,
lost activities, incorrect results, or any other loss arising from use of this
tool.
