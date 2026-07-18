# Stairinator — Design & Architecture Plan

> A zero-backend, self-contained web app for turning stair-machine workouts into
> **FIT activity files**: define your machine and workout plan, optionally upload a
> heart-rate GPX or FIT file, align the two on a graph, and export a FIT activity
> with altitude, forward distance, cadence and heart rate — and only a tiny
> placeholder location (needed so Strava will display the climb).

**Status:** Implemented.
**Last updated:** 2026-07-09

---

## 1. Purpose & core idea

Stair machines record heart rate but no elevation, distance or location, so the
resulting activity looks flat and goes nowhere. The user knows what they *did* —
e.g. "level 6 for 10 minutes, level 8 for 5 minutes" on a specific machine — which
is enough to reconstruct how far they climbed and how far they travelled.

Stairinator lets the user:

1. Describe their **stair machine(s)** — the riser and tread, and what each level means.
2. Build an **activity plan** — an ordered list of `(level, minutes)` segments.
3. *(Optional)* Upload a **GPX or FIT file** containing heart-rate data.
4. **Align** the plan against the recorded HR data on an overlaid graph.
5. **Generate** a **FIT activity** with per-record altitude, distance, cadence and HR.
6. **Download** the `.fit`, save the plan for reuse, and re-apply it to future files.

Everything runs in the browser from local files. No install, no backend, no network.

### Why FIT, not GPX?

GPX is a *route* format built around latitude/longitude. Two problems for us:
a stair machine has **no location**, and platforms such as Strava **discard the
elevation** in a GPS track and recompute it from their own terrain basemap — which
would erase the synthesized climb. FIT is an *activity* format: it carries
altitude/distance/cadence/HR directly, and lets us tag the activity as
fitness-equipment / stair-climbing so it is recognised correctly.

**Location caveat.** We would prefer no coordinates, but Strava only *displays*
elevation for activities that have a map (GPS). A barometric device makes Strava
*trust* the file's altitude; a map makes it *show* it — both are needed. So each
record carries a **tiny placeholder loop** (5 m radius at null-island, arc length
equal to the forward distance so distance stays consistent). It is a meaningless
placeholder, not a real place. See §6.4.

---

## 2. Design decisions (confirmed)

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Packaging** | Small folder of static files. Double-click `index.html`; no server. |
| 2 | **Output format** | Binary **FIT** activity (hand-written encoder, no deps). Only a tiny placeholder location (required for Strava to show elevation). |
| 3 | **Input** | GPX **or** FIT with heart-rate data; auto-detected by file signature. Optional. |
| 4 | **Records** | One record per HR datapoint when a file has HR; otherwise a record every **5 s**. |
| 5 | **Laps** | One lap per plan segment. |
| 6 | **Duration mismatch** | Plan runs in **real time** anchored at a user-chosen start point (HR case). Before start → hold 0; after end → hold final. |
| 7 | **Altitude** | Monotonic non-decreasing (climb rate clamped ≥ 0). |
| 8 | **Distance** | Forward distance = tread × steps; altitude = riser × steps. |

---

## 3. Glossary

- **Stair machine** — a saved profile: a **riser**, a **tread**, and a table of levels.
- **Riser** — vertical rise per step (metres).
- **Tread** — forward depth per step (metres).
- **Level** — a machine setting; each maps to a cadence in **steps per minute** and has an editable **name**.
- **Climb rate** — derived m/s: `stepsPerMin × riser ÷ 60`.
- **Forward rate** — derived m/s: `stepsPerMin × tread ÷ 60`.
- **Plan / Activity** — an ordered list of segments, each `(level, minutes)`.
- **Alignment offset** — the real timestamp at which segment 1 begins (HR case).
- **E(t) / D(t)** — cumulative altitude / forward distance vs. elapsed plan time.

---

## 4. Architecture

### 4.1 Shape

A **single-page, backend-free web app**. All logic is client-side JavaScript, no
frameworks, one small custom canvas chart.

> **`file://` constraint:** browsers block ES modules and `fetch()` when a page is
> opened directly from disk. So we use **classic `<script>` tags** — each file
> attaches to one global `Stair` namespace — and no fetched data files. This keeps
> "double-click `index.html`" working everywhere.

```
stairinator/
├── index.html        ← markup + section scaffolding, loads scripts in order
├── style.css         ← all styling
├── src/
│   ├── model.js      ← data model, defaults, validation, migration
│   ├── storage.js    ← localStorage persistence + JSON import/export
│   ├── elevation.js  ← climb/forward rates; E(t), D(t), cadence, segment index
│   ├── gpx.js        ← GPX parse (HR/time extraction) — input only
│   ├── fit.js        ← FIT encoder (write activity) + decoder (read HR) 
│   ├── align.js      ← time-alignment maths + chart series
│   ├── chart.js      ← lightweight canvas graph (HR + plan overlay, drag offset)
│   └── markdown.js   ← tiny Markdown renderer for the in-app README viewer
├── app.js            ← application entry point + UI wiring (loaded last)
├── sample.gpx        ← a heart-rate-only sample for trying the app
└── DESIGN.md         ← this document
```

### 4.2 Data flow

```
  Machine (riser, tread, levels) ─┐
                                  ├─► Plan ─► profile: E(t), D(t), cadence(t) ─┐
  Activity segments ──────────────┘                                            │
                                                                               ▼
  GPX/FIT file ─► parse/decode ─► points[{timeMs, hr}] ─► ALIGN (offset) ──► build
                                        (optional)                            records
                                                                               │
        HR present → one record per HR point       no HR → record every 5 s    │
                                                                               ▼
                    group records by segment → laps ─► FIT encode ─► download .fit
```

### 4.3 Charting

No external chart library. A canvas renderer draws heart rate (from the file) and
the plan series (climb rate, altitude, or level, via a toggle — default climb rate)
on a shared time axis. A drag gesture (or numeric input) shifts the plan to align it
with the HR trace. Outside the plan window the climb rate and level read 0 (no
activity); altitude holds 0 before the start and its final value after the end.

---

## 5. Data model

Persisted as JSON (localStorage + export files), versioned.

```jsonc
// A stair machine profile
{
  "id": "uuid",
  "name": "Gym StairMaster 4G",
  "riser": 0.203,             // metres climbed per step
  "tread": 0.255,             // metres travelled forward per step
  "levels": [
    // `level` is the stable id; `name` is the editable label (defaults to the number)
    { "level": 1,  "name": "1", "stepsPerMin": 26 },
    { "level": 10, "name": "10", "stepsPerMin": 162 }
  ]
}

// An activity plan
{
  "id": "uuid",
  "name": "Tuesday climb",
  "machineId": "uuid",
  "segments": [ { "level": 4, "minutes": 5, "seconds": 0 }, { "level": 6, "minutes": 10, "seconds": 30 } ]
}

// Top-level document (export/import unit)
{ "schemaVersion": 1, "machines": [ ... ], "plans": [ ... ] }
```

Migration (`model.normalizeDoc`): old machines with `stepHeight` get `riser =
stepHeight` and a default `tread`; unnamed levels get `name = String(level)`.

---

## 6. Core algorithms

### 6.1 Rates per level

```
climbRate(level)   = stepsPerMin × riser ÷ 60     (m/s up)
forwardRate(level) = stepsPerMin × tread ÷ 60      (m/s forward)
```

### 6.2 Cumulative curves `E(t)` (altitude) and `D(t)` (forward distance)

`t` = seconds elapsed since plan start. Segments expand into constant-rate
intervals; boundary values are pre-summed. Both curves hold at the edges:

```
E(t): t≤0 → 0 ; t≥planEnd → totalClimb ; else elevStart_i + climbRate_i·(t−start_i)
D(t): t≤0 → 0 ; t≥planEnd → totalDistance ; else distStart_i + fwdRate_i·(t−start_i)
```

Climb/forward rates are clamped to ≥ 0, so both curves are monotonic
non-decreasing for any input — the activity is always going up and forward.

`cadenceAt(t)` returns the segment's steps/min inside `[0, planEnd)` and 0 outside.
`segIndexAt(t)` returns which segment a time falls in (clamped).

### 6.3 Record generation

- **HR present** (uploaded GPX/FIT has heart rate): the activity spans the **union**
  of the recording and the plan window — `[min(fileStart, planStart),
  max(fileEnd, planEnd)]` — where `planStart = fileStart + offset` from the alignment
  slider. Records:
  - each HR point → `{ time: gt, hr, cadence: cadenceAt(e), distance: D(e),
    altitude: E(e) }` with `e = (gt − planStart)/1000`. HR recorded before the climb
    (`e < 0`) or after it (`e > total`) has flat altitude and zero cadence.
  - a plan **lead-in / lead-out** (5 s records, no HR) fills any part of the plan
    outside the recording — e.g. the climb began before HR recording started
    (negative offset) or continued after it stopped.
- **No HR**: a record every 5 s for `t = 0 … totalTime`, timestamped from the
  user-chosen **start date/time** (defaults to now).

The **Activity Start Time** is shown in step 4: editable when no file is uploaded;
read-only and equal to `min(fileStart, planStart)` — the activity's true first
record — when a file is loaded, updating live as the offset changes.

### 6.4 Placeholder location

Each record gets a synthetic lat/lon on a **small loop** (5 m radius, centred at
0,0) parameterised by the forward distance: `angle = distance / R`, so the loop's
**arc length equals the forward distance**. This means Strava gets a map (so it
displays elevation) and any GPS-derived distance matches our `distance` field. The
altitude is *not* derived from these coordinates — it comes straight from `E(t)` —
and because the file declares a trusted barometric device, Strava keeps it rather
than replacing it with terrain elevation at 0,0.

### 6.5 Laps & session

Records are grouped into laps by **phase**: an optional **pre** lap (HR recorded
before the climb starts — standing still), one lap **per climbing segment**, and an
optional **post** lap (HR recorded after the climb finishes — standing still). So a
recording with a warm-up and cool-down yields the segment laps plus up to two extra
"not moving" laps (zero ascent, zero cadence). Each lap carries elapsed time, total
distance, total ascent, avg/max HR, avg cadence. The **session** summarises the whole
activity (totals, avg/max HR, avg cadence, sport = fitness_equipment,
sub_sport = stair_climbing, lap count).

### 6.6 Input parsing

- **GPX** (`gpx.parse`): `DOMParser`; extracts `<trkpt>` time + heart rate
  (Garmin `TrackPointExtension` or bare `<hr>`). Missing timestamps → synthesized
  1 s samples.
- **FIT** (`fit.decode`): reads the binary format — header, definition and data
  messages (including compressed-timestamp records) — and extracts `record`
  timestamp (field 253) + heart_rate (field 3). Position/other fields are skipped.

The uploader sniffs the file: bytes 8–11 = `.FIT` → FIT decode; otherwise GPX.

### 6.7 FIT encoding (`fit.encodeActivity`)

Hand-written encoder producing a valid FIT 2.0 activity:

- **Header** (14 bytes) with data size + header CRC; trailing file CRC (FIT CRC-16).
- Messages, each a definition then data record(s): `file_id`, `device_info`,
  start `event`, `record`×N, stop `event`, `lap`×N, `session`, `activity`.
- **Barometric device declaration.** Strava only trusts elevation from devices it
  knows are barometric; otherwise it recalculates, and for a no-GPS "indoor"
  activity it shows little or none. So `file_id`/`device_info` declare **Garmin
  (1) / Fenix 6 (3290)** — a barometric, Strava-trusted device — so the computed
  altitude is honoured. (Fallback: remove the indoor tag on strava.com.)
- **Record fields**: timestamp, position_lat/position_long (semicircles, the
  placeholder loop — §6.4), heart_rate (0xFF when absent), cadence, distance
  (scale 100, cm), altitude (scale 5, offset 500).
- Timestamps are FIT seconds (Unix − 631065600).

Validated against the **official Garmin FIT SDK** decoder (`isFIT`, CRC integrity,
zero decode errors) and a third-party parser, plus a round-trip through our own
decoder.

---

## 7. User interface

**Two tabs** — **Stair machines** and **Activity**. First-time users (no machines)
land on Machines; once a machine exists it opens on Activity.

### 7.1 Stair Machines (tab)
- Selector to choose which machine to edit, with Add / Delete.
- Editor: name, **riser (m)**, **tread (m)**, and a levels table (editable name +
  steps/min). A derived column shows climb and forward rates (m/min).

### 7.2 Activity Plan
- Choose a machine (wide selector).
- Segment editor: rows of `(level, minutes)` shown by level name; **drag-and-drop
  to reorder**; add/remove.
- Summary: total time, total climb, forward distance, avg climb rate.

### 7.3 Align & preview *(optional)*
- Upload a GPX or FIT file. If it has HR, an overlaid graph (HR + plan) with a
  draggable offset lets you line them up. Toggle the plan series between climb rate,
  altitude and level. A file summary shows HR / GPS / timestamp presence.

### 7.4 Generate & download
- **Start date/time** field (§6.3): editable + defaults to now with no file;
  read-only and file-derived (offset-adjusted) with a file.
- One button: **Download FIT file**, enabled for any valid plan (with or without an
  uploaded file). Status text states whether it will use HR datapoints or 5 s ticks.

### 7.5 Persistence
- Auto-save to `localStorage`; **Export all** / **Import** JSON for portability.

### 7.6 Help / README viewer
- A **Help** button (and footer "Read me" link) opens a modal that renders the
  README. The markdown is **embedded** in `index.html` (a `text/markdown` script
  block) and rendered by `markdown.js` — no `fetch`, so it works from `file://`.
  The embedded copy mirrors `README.md` except the **Installation** section, which
  is omitted in-app (the user is already running it).

---

## 8. Edge cases

| Case | Handling |
|------|----------|
| No file uploaded | Elevation/distance/cadence still generated; records every 5 s, no HR. |
| File has GPS but no HR | Treated as no-HR (5 s ticks). |
| GPX without timestamps | Synthesize 1 s samples; warn. |
| FIT with compressed-timestamp records | Decoder reconstructs absolute times. |
| HR recorded before/after plan window | Altitude/distance hold at 0 / final. |
| Level referenced by plan missing from machine | Validation error blocks generate. |
| Negative/garbage rate inputs | Clamped to ≥ 0; altitude never decreases. |

---

## 9. Non-goals (v1)

- No *meaningful* location — only a tiny placeholder loop, required for Strava to
  display elevation (see §1, §6.4).
- No GPX **output** (input only). No cloud sync or accounts.
- No TCX. FIT is the sole output format.

---

## 10. Testing

- **Unit:** rate/curve maths, GPX parse, FIT encode/decode round-trip.
- **Format validation:** generated FIT checked with the official Garmin FIT SDK
  decoder (integrity + zero errors) and a third-party parser.
- **App boot:** headless load exercising tab defaults, riser/tread editor, drag
  reorder, FIT generation, and FIT/GPX upload → HR detection.

---

## 11. Possible future work

- TCX export; a downloadable sample `.fit`; per-machine cadence presets;
  calories estimation in the session summary.
