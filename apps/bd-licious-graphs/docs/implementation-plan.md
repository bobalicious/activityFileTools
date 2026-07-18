# Implementation Plan

> Concrete, ordered build steps for the FIT-based client-side app.
> Design reference: [Architecture](architecture.md).
> Each milestone is independently runnable/testable and leaves the app working.

## Guiding approach

- **Vertical slices.** Get an end-to-end path working first (file in → *one* graph
  out), then broaden. Avoid building all the parsing before you can see anything.
- **Test against a real FIT early.** Before anything else, do the manual
  prerequisite below so we're developing against real data, not assumptions.
- **The normalised model (`src/model.ts`) is the contract.** Parser fills it;
  everything else only reads it.

## Prerequisite (manual, you) — get a real FIT file

1. On Strava, open one of your **interval sessions** → **···** → **Export
   Original**. Confirm you get a `.fit` (not `.gpx`).
2. Grab a second contrasting file too: a **steady run / race** (to test that
   rest-detection correctly finds *no* rests).
3. Drop them in `samples/` (git-ignored). These are the dev fixtures.

*(If Export Original yields GPX for a run, note it — that one only exercises the
GPX fallback, which is a later milestone.)*

---

## Milestone 0 — Scaffold ✅ *(done)*

- Vite + React + TypeScript; deps `react`, `react-dom`, `@garmin/fitsdk`.
- `tsconfig`, `vite.config.ts` (relative `base` for static hosting), `.gitignore`
  (ignores `samples/`, `dist/`, `node_modules/`), and the full `src/` skeleton from
  [Architecture §8](architecture.md#8-proposed-file-layout): `model.ts` filled in,
  everything else typed stubs, with a working `FileDrop` + `App`.
- **Verified:** `npm run typecheck` and `npm run build` are clean; `npm run dev`
  serves the "drop a `.fit` file" page.

## Milestone 1 — Parse FIT → model *(the foundation)*

- `src/fit/parseFit.ts`: `ArrayBuffer → Activity`.
  - Decode with `@garmin/fitsdk` (`Decoder`/`Stream`), pull `recordMesgs`,
    `lapMesgs`, `sessionMesgs`.
  - Map fields per [Architecture §3](architecture.md#fit--model-mapping-key-fields);
    normalise time to seconds-from-start, cadence to steps/min (**×2 + fractional**),
    `step_length` mm→m.
  - Compute each lap's `startIndex`/`endIndex` into `samples` by timestamp window.
- Wire `FileDrop.tsx` to read the dropped file as `ArrayBuffer` and parse.
- **✅ Done & verified** against both `samples/` files: correct lap counts (20 / 10),
  times, distances, speeds, HR, and sample-index ranges. **Validated risks:** cadence
  ×2 confirmed (100/leg record → 200 spm; reps ~175–183 spm); **`step_length` absent**
  on this device (and `cycle_length16` = 0) → stride is derived, not native;
  `intensity` also absent → pace-clustering is the real rest signal. Architecture §4/§5
  updated accordingly.

## Milestone 2 — The hero graph (pace) ✅

- `metrics.ts` (speed↔pace, per-metric value/format) + `LapBarChart.tsx`
  (variable-width SVG bars on a time axis, height from speed, axis labelled in pace).
- **✅ Verified:** server-rendered SVG produces the expected bars with widths ∝ lap
  duration; wired under the drop zone with a metric selector.

## Milestone 3 — Rest detection + gaps ✅

- `restDetection.ts`: FIT-`intensity` path + optimal 1-D 2-means on avg speed +
  relative-gap guardrail; `LapBarChart` renders rests as **gaps**; `LapTable` lists
  laps with per-lap toggle; sensitivity slider re-classifies.
- **✅ Verified on real data:** interval file → 10 reps as bars / 10 recoveries as
  gaps (warmup + standing + jog recoveries all rest; fast cooldown stays a bar);
  steady run → **0** rests (guardrail engaged). Manual toggle wired.

## Milestone 4 — Metric variants + smoothed HR ✅

- `LapBarChart` `metric` prop drives cadence / stride (derived) / HR; absent data
  shows an empty-state; `SmoothedHrChart.tsx` = EWMA HR line with greyed rest spans.
- **✅ Verified:** all four bar metrics + the HR line render valid SVG for the
  interval file.

## Milestone 5 — PNG export ✅

- `export.ts`: SVG → 2× canvas (white background, inlined text colour) → `toBlob` →
  download; per-chart "Download PNG" buttons wired in `App`.
- **Primary goal met:** the app produces a downloadable image ready to drop onto a
  Strava activity. *(Browser-only path — exercised via the dev server; a manual
  click-through is the final confirmation.)*

## Milestone 6 — Presets & polish *(next / not started)*

- `src/presets/presets.ts` + UI: built-in "Interval" / "Race" presets in
  `localStorage`, selecting one sets which graphs show + analysis params
  ([Architecture §7](architecture.md#7-presets-srcpresets)).
- Light/dark theme, sensible default layout, empty/error states (bad file, no
  laps, missing metrics).
- **Done when:** one click configures the whole view per session type.

---

## Backlog (explicitly later / maybe-never)

- **GPX fallback importer** — same `Activity` model, infer intervals from pace
  (no lap markers). Only if a phone-recorded run needs it.
- **Playwright auto-upload** — own-account, saved `storageState`; the overview's
  maybe-later. Would add the app's only non-static piece; keep it optional.
- **Strava-API importer** — only if a subscription is ever taken; slots behind the
  same model.

## Definition of done (v1)

Drop an interval `.fit` → see pace/cadence/stride/HR per-lap graphs with rests as
gaps + a smoothed-HR line → tweak rest classification if needed → export a crisp
PNG to put on Strava. All in the browser, no accounts, no API.
