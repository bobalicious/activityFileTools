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
- The decoder targets the fields these devices actually record (pace, cadence, HR,
  distance for runs; per-length pace/time/strokes/SWOLF for swims). Run-dynamics
  fields not in the format reference (ground contact, vertical osc./ratio) aren't
  decoded here — add their field numbers to `fit.js` if a device provides them.
- Verified headlessly (decoder vs the Garmin SDK values; chart output; UI wiring).
  The PNG export uses browser canvas APIs — confirm it in your browser.
