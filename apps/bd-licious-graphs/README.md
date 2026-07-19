# bd-licious graphs — standalone (no build, no server)

A dependency-free version of the app: plain `index.html` + classic `<script>`
files. **No Node, no npm, no build step, no server.**

## Run it

Just **open `index.html` in a browser** — double-click it, or drag it into a tab.
It runs from `file://`. Works offline.

## What's here

| File | Role |
|---|---|
| `index.html` | Shell — loads the three scripts as classic `<script>` tags |
| `fit.js` | Dependency-free FIT decoder (replaces `@garmin/fitsdk`) |
| `graph.js` | Metrics, rest detection, and the SVG chart generator |
| `app.js` | The vanilla-JS UI (state, controls, PNG export, `localStorage`) |
| `styles.css` | Styling |

Nothing else is fetched at runtime — no CDN, no modules, no network.

## How it's built

Hand-written plain JavaScript with its own FIT decoder — no TypeScript, JSX, or
bundler, so it needs no toolchain. Features: metric rows, line/bar/range/trace,
HR zones, swim support, saved configs, PNG export.

> The original TypeScript/React version (Vite, needs a build) lives on the `main`
> branch; this `standalone-no-build` branch is the toolchain-free equivalent.

## Notes / limits

- **Saved configs & HR zones** use `localStorage`, which on `file://` is per-browser
  and not shared with the built version on `main`. Fine for personal use.
- Runs graph pace, cadence, stride length, heart rate, ground contact time,
  vertical oscillation and vertical ratio; swims graph per-length pace, time,
  strokes and SWOLF.
- The run-dynamics fields (ground contact, vertical oscillation, step length) are
  not in the format reference, so their scales were established against a real
  file rather than assumed — see `shared/fit/adapters.js`. A device that doesn't
  record them just leaves those metrics empty. Vertical ratio is read from the
  device where present and derived from oscillation and step length where not —
  it is oscillation over *step* length, not over a two-step stride, which was
  confirmed against a real file. Stance-time balance is decoded by neither.
- Stride length uses the device's own step length where it records one, and falls
  back to deriving it from speed and cadence where it doesn't.
- Verified headlessly (decoder vs the Garmin SDK values; chart output; UI wiring).
  The PNG export uses browser canvas APIs — confirm it in your browser.

## Your files, and no warranty

**Keep your own copy of any file you care about.** A FIT file cannot really be
checked by eye, so the original is your only way back if a result turns out
wrong.

Provided **as-is, with no warranty of any kind, express or implied**. You are
responsible for your own data. No liability is accepted for corrupted files,
lost activities, incorrect results, or any other loss arising from use of this
tool.
