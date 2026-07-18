# Architecture & Design

> How the app is built. Follows from the decision in the
> [Project Overview §4a](project-overview.md#4a-findings-so-far-from-the-investigations):
> read from a downloaded **`.FIT`** file, client-side only.
> Build steps: [Implementation Plan](implementation-plan.md).

## 1. Shape in one line

A **static, client-side web app**: the user drops in a `.FIT` file; the browser
parses it, classifies work vs rest laps, renders the interval graphs as SVG, and
lets the user export any graph to PNG to drop onto Strava manually. **No backend,
no server, no auth, no secrets** — it can be hosted as static files (or just opened
locally).

```
 .FIT file ──▶ parse ──▶ normalise ──▶ analyse ──▶ render (SVG) ──▶ export (PNG)
              (fit sdk)   (model)     (rest/metrics)  (charts)       (download)
```

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Types matter for the FIT→model mapping and metric maths |
| Build/dev | **Vite** | Zero-config, fast dev server, builds to static files |
| UI | **React** | The UI is stateful (lap toggles, preset selection, live preview) |
| FIT parsing | **`@garmin/fitsdk`** (official Garmin JS SDK) | Authoritative decode of records, laps, sessions, `intensity`, `step_length`; runs in-browser. Alternative considered: `fit-file-parser` (lighter, looser typings) |
| Charts | **Hand-rolled SVG** (React components) | The hero graph is a *variable-width* bar chart on a time axis with gaps — awkward in charting libs, trivial in raw SVG, and SVG→PNG export is clean |
| PNG export | SVG → `canvas` → `toBlob` → download | No dependency needed |
| Presets | `localStorage` | Personal tool; no accounts |
| Styling | Plain CSS (+ CSS variables for theme) | Keep it light |

Everything is static — deploy to GitHub Pages / Netlify / a local file. No FIT data
ever leaves the browser (nice privacy property, and it means no ToS concerns).

## 3. Normalised data model

The parser converts FIT into this source-agnostic model; **everything downstream
depends only on this**, so a GPX or Strava-API importer could produce the same
shape later.

```ts
// src/model.ts
export type LapIntensity = 'active' | 'rest' | 'warmup' | 'cooldown' | 'recovery';

export interface Sample {          // one FIT `record` message (~1/sec)
  t: number;                       // seconds since activity start
  distance?: number;               // metres, cumulative
  speed?: number;                  // m/s (enhanced_speed preferred)
  heartRate?: number;              // bpm
  cadence?: number;                // steps/min (already doubled from FIT — see §5)
  stepLength?: number;             // metres (FIT step_length, mm→m)
}

export interface Lap {
  index: number;                   // 0-based
  startTime: number;               // s since activity start
  elapsedTime: number;             // s (wall clock) — default bar WIDTH
  movingTime?: number;             // s (timer time)
  distance?: number;               // metres
  avgSpeed?: number;               // m/s        — bar HEIGHT (pace) source
  maxSpeed?: number;
  avgCadence?: number;             // steps/min
  avgHeartRate?: number;           // bpm
  maxHeartRate?: number;
  avgStepLength?: number;          // metres
  fitIntensity?: LapIntensity;     // from FIT, if present
  startIndex: number;              // into samples[]
  endIndex: number;                // into samples[] (inclusive)

  // computed by analysis, user-overridable:
  isRest: boolean;
  restSource: 'fit-intensity' | 'pace-cluster' | 'manual' | 'none';
}

export interface Activity {
  sport?: string;                  // 'running' etc.
  startTime: Date;
  totalElapsedTime: number;        // s
  totalDistance?: number;          // metres
  laps: Lap[];
  samples: Sample[];
}
```

### FIT → model mapping (key fields)

| Model field | FIT source |
|---|---|
| `Lap.elapsedTime` | `lap.total_elapsed_time` |
| `Lap.movingTime` | `lap.total_timer_time` |
| `Lap.avgSpeed` | `lap.enhanced_avg_speed` ?? `lap.avg_speed` |
| `Lap.avgHeartRate` | `lap.avg_heart_rate` |
| `Lap.avgCadence` | `(lap.avg_running_cadence ?? lap.avg_cadence) × 2` (+ fractional) |
| `Lap.avgStepLength` | `lap.avg_step_length` (mm → m) — **native, no derivation** |
| `Lap.fitIntensity` | `lap.intensity` |
| `Lap.start/endIndex` | match `record.timestamp` into the lap's time window |
| `Sample.speed` | `record.enhanced_speed` ?? `record.speed` |
| `Sample.stepLength` | `record.step_length` (mm → m) |

## 4. Rest / interval detection

Implemented in `src/analysis/restDetection.ts`, run once after parsing, re-runnable
when the sensitivity changes. Priority:

1. **FIT `intensity` (authoritative *when present*).** If **any** lap has an
   intensity of `rest`/`recovery`, trust the flags → `restSource: 'fit-intensity'`.
   **⚠ Reality check:** the test-device FIT files (`samples/`) carry **no
   `intensity` field at all**, so in practice path 2 is the primary route, not a
   fallback. Don't assume intensity exists.
2. **Pace clustering (primary in practice).** 1-D **2-means** on lap `avgSpeed`
   (best split of the sorted speeds). Compute the relative gap between cluster
   centres `(highMean − lowMean) / highMean`; if it exceeds a sensitivity-derived
   threshold, the slower cluster = rest → `restSource: 'pace-cluster'`. If the
   clusters are too close (a steady run — the `Strictly_Zone_2` fixture sits at
   2.25–2.64 m/s, gap ≈ 0.12), classify **nothing** as rest. *(Validated: the
   interval fixture's gap ≈ 0.74 splits cleanly; the steady one's ≈ 0.12 does not.)*
3. **Manual override.** The UI lists laps with their classification; clicking
   toggles `isRest` and sets `restSource: 'manual'`.

Guardrails: never let *every* lap become rest. Warmup and standing/jog recoveries
all fall into the slow cluster and read as rest (fine for the interval view — they
become gaps); a fast cooldown clusters with the reps and stays a bar.

## 5. Metric derivations (`src/analysis/metrics.ts`)

- **Pace** from speed: `paceSecPerKm = 1000 / speed`; format `mm:ss`. Guard
  `speed ≈ 0`.
- **Bar height encodes pace but is driven by speed** so *faster = taller* (matching
  Strava). The y-axis ticks are *labelled* in pace (mm:ss/km) computed from the
  speed at each tick — so the axis reads as pace while the geometry uses speed.
- **Cadence ×2 caveat — ✅ confirmed.** FIT running cadence is **per-leg RPM**;
  steps/min = `(cadence + fractional_cadence) × 2`. Normalised **once, in the
  parser**. Verified on real data: a 100/leg record = 200 spm; rep laps read
  ~175–183 spm.
- **Stride length — ⚠ usually derived, not native.** The architecture originally
  assumed FIT `step_length`, but the test device records **no `step_length`** (and
  `cycle_length16` is present-but-always-0). So: use FIT `avgStepLength` **if
  present**, else **derive** `stride = avgSpeed / (avgCadence / 60)` (avgCadence
  already in steps/min). The parser surfaces `avgStepLength` only when real;
  `metrics.strideLength()` does the derivation for the chart.
- **Smoothed HR** for the time-series graph: moving average / EWMA over the
  `heartRate` samples, window configurable (default ~10 s).

## 6. Rendering (`src/charts/`)

Two chart types, both pure SVG React components taking the normalised model:

### `LapBarChart` — the hero (and its metric variants)
- **x-axis = time.** Each lap occupies a slot of width ∝ `elapsedTime`.
- **Work laps** render a bar; **rest laps** render an **empty gap** of their width
  (the timeline stays continuous — you *see* the recovery as space, per the brief).
- **Bar height** = the chosen metric: **pace** (default, via speed), **cadence**,
  **stride length**, or **avg HR**. Same component, `metric` prop.
- Per-bar label (pace/value) optional; warmup/cooldown shaded differently.

### `SmoothedHrChart` — HR time-series
- **x-axis = time** across the whole session; **y = smoothed bpm** line.
- Rest spans optionally greyed so you can see HR recovery between reps.

### Export (`src/charts/export.ts`)
- Serialise the target `<svg>`, draw onto a `<canvas>` at 2× for crispness,
  `canvas.toBlob('image/png')`, trigger download. One graph per file (and/or a
  combined stack).

## 7. Presets (`src/presets/`)

A preset is a named template stored in `localStorage`:

```ts
interface Preset {
  name: string;                    // "Interval session", "Race", ...
  graphs: MetricKind[];            // which graphs to render
  restSensitivity: number;
  smoothingWindowSec: number;
  showLabels: boolean;
  theme: 'light' | 'dark';
}
```

Selecting a preset reconfigures which graphs show and the analysis params, so
"this is an interval session → these four graphs" is one click. Ships with a couple
of built-in defaults; user can add/edit.

## 8. Proposed file layout

```
strava-lap-graphs/
├─ docs/…                     # these documents
├─ index.html
├─ package.json · tsconfig.json · vite.config.ts
└─ src/
   ├─ main.tsx · App.tsx
   ├─ model.ts                # the normalised types (§3)
   ├─ fit/parseFit.ts         # FIT → Activity
   ├─ analysis/
   │  ├─ restDetection.ts     # §4
   │  └─ metrics.ts           # §5
   ├─ charts/
   │  ├─ LapBarChart.tsx      # §6
   │  ├─ SmoothedHrChart.tsx
   │  └─ export.ts            # SVG → PNG
   ├─ presets/presets.ts      # §7
   └─ ui/
      ├─ FileDrop.tsx         # drag-and-drop .fit
      └─ LapTable.tsx         # lap list + rest toggles
```

## 9. Deliberately out of scope (for now)

- Strava/Garmin API import (kept behind the same model interface if ever added).
- Playwright auto-upload (see overview §4a — a maybe-later, own-account extra).
- Accounts, cloud storage, multi-user — none needed for a personal static app.

## 10. Risks / things to validate against real data

- **Cadence ×2** — confirm the doubling on a real FIT before trusting stride/cadence.
- **`step_length` presence** — not every device writes it; fall back to
  `speed/cadence` derivation if the field is absent, and surface when it's missing.
- **Lap ↔ sample index alignment** — match on `record.timestamp` vs lap time window;
  watch for the FIT epoch (seconds since 1989-12-31) and paused-time gaps.
- **`intensity` reliability** — button-lap interval runs may tag everything
  `active`; the pace-cluster fallback must kick in there.
