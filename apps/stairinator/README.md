# Stairinator

Turn a stair-machine workout into a **FIT activity file** with accurate altitude, distance, cadence and (optionally) your recorded heart rate — all in your browser, with nothing to install and no real location data.

## Installation

Stairinator is delivered as a single **zip file** (e.g. `stairinator-YYYYMMDD.zip`)
and runs entirely in your web browser — there is nothing to install and no internet
connection is needed.

1. **Save the zip** somewhere you'll find it, such as your Desktop or Documents folder.
2. **Unzip it:**
  - **Windows:** right-click the file, choose *Extract All…*, then *Extract*.
  - **macOS:** double-click the file; a `stairinator` folder appears next to it.
  - **Linux:** right-click and *Extract Here*, or run `unzip stairinator-*.zip`.
   This creates a `stairinator` **folder** containing all of the app's files. Keep
   them together — the app needs every file in the folder.
3. **Open the app:** open the `stairinator` folder and **double-click** `index.html`.
  It opens in your default web browser. That's it — nothing is uploaded anywhere.
4. *(Optional)* Bookmark the page, or make a desktop shortcut to `index.html`, so
  you can reopen it easily.

Your stair machines and activities are saved automatically in this browser, on this
computer. Use **Export all** to back them up to a file, and **Import** to restore
them (or move them to another computer or browser).

### Updating

To move to a newer version, unzip the new bundle and open its `index.html`. Your
saved machines and activities stay in your browser. To be safe, **Export all**
before updating and **Import** afterwards if needed.

## How to use it

1. **Stair machines** — Describe your machine: the **riser** (how far up each step
  takes you) and the **tread** (how far forward each step is), plus how many steps
   per minute each level runs at. You can name each level. Climb rate and forward
   rate are worked out for you.
2. **Activity plan** — Pick a machine and list your workout as level-and-duration
  (minutes and seconds) rows. Drag to reorder.
3. **Align & preview** *(optional)* — Upload the **GPX or FIT** file from your
  watch/app. If it has heart rate, slide the plan to line it up with the HR trace.
4. **Generate & download** — Set the start date/time, then download a **FIT** file
  containing one lap per plan segment, with timestamp, cadence, distance and
   altitude on every record — plus heart rate if you uploaded a file that had it.

A **Help** button (and the "Read me" footer link) opens this document inside the app.

## Why FIT (and not GPX)?

Stair machines don't move you across the ground, so there's no location to record.
GPX is really a *route* format and platforms like Strava will **overwrite** the
elevation in a GPS track with their own terrain map — which would erase your climb.
FIT is an *activity* format: it carries altitude/distance/cadence directly, needs
no coordinates, and marks the activity as a stair-climb (fitness-equipment /
stair-climbing) so it's recognised correctly. Upload the `.fit` file to Strava,
Garmin Connect, etc. as you would any activity.

### A note on Strava and elevation

Getting Strava to show your climb needs **two** things, and the generated FIT does
both automatically:

1. **A trusted barometric device.** Strava only trusts elevation from a device with
  a barometric altimeter, so the file identifies itself as a Garmin Fenix 6 (a
   trusted device). This stops Strava replacing your climb with ground terrain.
2. **A map.** Strava only *displays* elevation for activities that have GPS
  coordinates, so the file includes a **tiny placeholder loop** (a few metres
   across, at a meaningless location — not a real place you went). Without it,
   Strava treats the activity as indoor and shows no elevation at all.

If Strava still shows reduced elevation, open the activity on **strava.com** and
remove the indoor tag.

### Known limitation: Strava "Moving Time" shows 0

A stair machine moves you forward very slowly (~0.14 m/s), which is **below
Strava's "moving" speed threshold** (roughly a 30-minute-mile pace). Once a GPS
track is present, Strava recomputes moving time from speed and counts the whole
activity as "resting", so the summary shows **Moving Time 0:00**. This can't be
fixed from the file — Strava's Race tag (which would force elapsed time) isn't
available for the Stair-Stepper type. Your **elapsed time** and **per-lap times**
are correct; only the "Moving Time" summary is affected.

## Records: heart rate vs. 5-second ticks

- If your uploaded file **has heart rate**, one record is written per heart-rate
datapoint, aligned to the plan by the offset you set in step 3.
- If you **don't** upload a file (or it has no heart rate), a record is written
**every 5 seconds** across the plan.



## Trying it out

`sample.gpx` is a short heart-rate-only recording (5 minutes) you can upload in
step 3 to see the whole thing work.

## For developers

See [DESIGN.md](DESIGN.md). The app is plain HTML/CSS/JS with no build step and no
dependencies; everything attaches to a single global `Stair` namespace. It uses
classic `<script>` tags (not ES modules) so it works when opened directly from disk
(`file://`). `src/fit.js` contains a self-contained FIT encoder and decoder.