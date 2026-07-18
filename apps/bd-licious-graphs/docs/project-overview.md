# Project Overview — bd-licious graphs (interval lap graphs)

> Status: **Draft / investigation phase.** This document captures *what* we are
> trying to build and *why*. The technical feasibility of each data source is
> covered in the companion investigation documents:
> - [Strava API Investigation](investigations/strava-api.md)
> - [Garmin API Investigation](investigations/garmin-api.md)

## 1. The problem / the itch

Strava's paid plans include a really nice per-lap **average-pace bar graph**. It
is especially good for reviewing interval sessions. If you run, say, 5 × 3-minute
reps with 90 seconds recovery, you get a bar chart where:

- the **x-axis is time** (or distance), and each bar's **width** is the duration
  of that lap — a 3-minute rep is a wide bar, a 90-second recovery is a thin one;
- the **height** of each bar is the **average pace** for that lap.

We want to **replicate and extend** that graph from our own activity data (Strava
and/or Garmin), render it ourselves, and **upload the finished image back onto the
correct Strava activity as media** — so the graph lives alongside the run.

## 2. Goals

1. **Connect** to a running-data source (Strava or Garmin — whichever is the
   simplest to integrate) and pull a session's data.
2. **Render** an interval bar graph of **average pace per lap**, with bar width
   proportional to lap duration.
3. **Detect and skip rest laps.** If a lap's pace is clearly out of whack (a
   recovery jog / standing rest), we should recognise it as rest and render a
   **gap** rather than a misleading bar — the average pace of a rest isn't useful.
4. **Render the same style of graph for additional metrics:**
   - average cadence per lap
   - average stride length per lap (if the data is available)
   - average heart rate per lap
   - a **smoothed heart-rate time-series** graph across the interval
5. **Upload** the rendered graph(s) to the right Strava activity as media/photos.
6. Provide a **simple UI** to: authenticate, pick a recent activity, preview the
   graphs, choose which to generate, and upload.
7. Support **saved configurations / presets** by session type — e.g. an
   "interval session" preset vs a "race" preset — so a session can be graphed and
   uploaded with the appropriate template in one action.

## 3. Non-goals (for now)

- Not a general-purpose training-analytics platform — this is focused on the
  per-lap interval graph and its variants.
- Not real-time / on-device — this works on completed activities.
- Not a multi-tenant public product initially — first target is personal use
  (which also matters for Strava's app-approval limits; see the Strava doc).

## 4. Key open questions (drive the investigation)

These are the questions the investigation documents must answer before we commit
to an architecture:

- **Which source is simplest?** Strava's API is self-serve; Garmin's developer
  program has historically been a gated B2B partner arrangement. (See findings.)
- **Is per-lap data available?** We need laps/splits with per-lap average pace,
  cadence, HR — and ideally a time-series (streams/samples) for smoothed HR and
  for rest detection.
- **Is stride length available**, or must it be derived (from cadence + speed)?
- **Can we actually upload a photo to a Strava activity via the API?** This is the
  historically weakest link and may be the deciding constraint on the whole
  "upload back to Strava" goal. (See findings — flagged as high-risk.)
- **Can we correlate a Garmin activity with its Strava counterpart** (if we read
  from Garmin but upload to Strava)?

## 4a. Findings so far (from the investigations)

The API investigations are complete. Headline conclusions:

- **✅ Data source: a downloaded `.FIT` file (no API).** The Strava *API* would
  require a paid subscription (Standard-tier, 2026) — **not an option here** — so we
  read from the **FIT file** instead. Strava's **"Export Original"** (··· menu on
  any activity, free) hands back the original device file, which for a watch is a
  FIT. FIT contains **everything we need and more than the API would give**:
  per-lap aggregates (avg pace/HR/cadence), the full per-second sample stream, a
  **native `intensity` flag per lap** (active/rest/warmup/cooldown), and **native
  `step_length`** (stride length — no derivation needed). Garmin's own "Export
  Original" works identically. This makes the whole app a local **file-in →
  image-out** tool: no OAuth, no API keys, no rate limits, no subscription, no ToS
  grey area. See the [Architecture](architecture.md) doc for the design.
  - *Fallback:* **GPX** export (also free) if only that exists — but GPX **strips
    laps**, so we'd infer intervals from the pace signal. FIT is strictly better;
    GPX is the exception path for phone-recorded runs.
- **🚫 The upload-to-Strava goal is the hard constraint.** Strava's public API has
  **no way to attach a photo/image to an activity** — media upload is a restricted
  partner-only endpoint (confirmed by Strava staff, 2026-04-04). Since this is a
  **personal project for fun**, the plan is:
  1. **Primary — generate a downloadable/shareable image.** The graph is a
     first-class output of our own app; adding it to Strava is a one-off manual
     drag-and-drop. Fully sanctioned, zero risk. This is the goal that matters.
  2. **Maybe-someday — Playwright auto-upload.** Browser-automate Strava's web UI
     to drop the image onto the activity, driving a **manually-saved logged-in
     session** (Playwright `storageState`) rather than scripting login. Own account
     only; unofficial and against Strava's ToS at scale, but defensible for
     automating your own manual actions. Nice-to-have, may never be built.
- **Stride length comes free from FIT** (`step_length`, per-record and per-lap) — no
  cadence×2 derivation needed (that would only matter on the GPX fallback, where we
  compute stride from cadence + speed).
- **The Strava/Garmin APIs are demoted to optional.** They aren't needed for the
  core tool. If a subscription is ever taken, a Strava-API importer could be added
  behind the same normalised model — but it's not on the build path.

Full detail and sources: [Strava](investigations/strava-api.md) ·
[Garmin](investigations/garmin-api.md).

## 5. Proposed shape of the solution

A **client-side web app** — no backend, nothing to host, no secrets. Everything
runs in the browser: drop in a `.FIT` file, get graphs out. Full technical design
is in [Architecture](architecture.md); in brief:

- **Parse** the FIT file in-browser into a normalised
  `activity → laps[] → samples[]` model.
- **Analyse**: classify each lap as work/rest (FIT `intensity` flag first, pace
  heuristic as fallback), user-overridable.
- **Render** the graphs as SVG in the page; **export** any of them to PNG for the
  manual drop onto Strava.
- **Presets**: named session-type templates (interval / race / …) in `localStorage`
  choosing which graphs to show and the rest-detection sensitivity.

The analysis + rendering operate on the normalised model, so a Strava-API or GPX
importer could be slotted in behind the same interface later without touching the
graph code.

## 6. Rest / interval detection (approach sketch)

The core "smarts" is distinguishing work laps from recovery so rest bars become
gaps. In priority order:

1. **FIT `lap.intensity` flag (best).** Structured/interval workouts tag each lap
   `active` / `rest` / `warmup` / `cooldown` / `recovery`. When present this is
   authoritative — just read it. (Only available via FIT, not GPX.)
2. **Pace/speed clustering (fallback).** With no intensity tags, recovery laps
   cluster at a markedly slower pace — detect the bimodal split (e.g. 2-means on
   avg speed) rather than a fixed threshold, guarding against all-work sessions.
3. **Heart-rate recovery shape** within a lap can corroborate a rest.

The sensitivity is configurable and the classification is **shown and
per-lap-overridable** in the UI.

## 7. Workflow / deliverables plan

1. **This project overview** — the vision and scope. ✅
2. **Investigation: Strava API** — laps, streams, media upload, OAuth, terms. ✅
3. **Investigation: Garmin API** — access model, data, push/pull, correlation. ✅
4. **Decision: read from FIT files, client-side app.** ✅ (see §4a)
5. **[Architecture](architecture.md)** — data model, rest detection, rendering,
   stack. ✅
6. **[Implementation plan](implementation-plan.md)** — concrete phased steps. ✅
7. **Build** — walk the implementation plan, milestone by milestone.

## 8. Success criteria

- From a real interval session, we can produce a per-lap average-pace bar graph
  that visually matches the intent of Strava's version, with rests correctly shown
  as gaps.
- We can produce the cadence / stride-length / HR / smoothed-HR variants where the
  underlying data exists.
- We can export the finished graph as an image ready to drop onto the Strava
  activity. (Optional stretch: Playwright auto-upload onto our own account.)
