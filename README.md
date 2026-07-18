# Activity File Tools

Three browser-based tools for reading, graphing, correcting and building FIT and
GPX activity files. No build, no server, no network — open `index.html` and go.

| App | What it does |
|---|---|
| [Stairinator](apps/stairinator/) | Builds a FIT activity file from a stair-machine workout plan, with altitude, distance, cadence and optional recorded HR |
| [Lap Graphs](apps/lap-graphs/) | Charts a FIT file — metric rows, HR zones, rest detection, per-length swim data, PNG export |
| [Swim FIT Corrector](apps/swim-corrector/) | Finds missed and false pool turns, lets you fix them, and rewrites the file byte-faithfully |

Each app has its own README with fuller detail.

## Layout

```
index.html          landing page — links to the three apps
style.css           landing page styling only
apps/
  stairinator/      unchanged from its original repo
  lap-graphs/       unchanged from its original repo
  swim-corrector/   unchanged from its original repo
```

The apps are plain classic `<script>` tags rather than ES modules, precisely so
they run from `file://`. Keep it that way — it's a deliberate constraint, not an
oversight.

## Consolidation status

These were three separate repos, now merged into one. The apps themselves are
still standalone and share no code; that's being unpicked in phases so each step
stays verifiable.

- [x] **Phase 1 — one repo, one front page.** Git histories stripped, apps moved
      under `apps/`, landing page added. No app code merged.
- [ ] **Phase 2 — merge the FIT decoder.** There are currently three.
- [ ] **Phase 3 — encoders and GPX.**
- [ ] **Phase 4 — shared CSS design tokens.**

### Phase 2 notes — the three FIT decoders

They are not peers, so this is a "promote one, delete two" job:

- `apps/swim-corrector/js/fit-decode.js` is a near-strict superset. It alone has
  a base-type table, string fields, array fields, 64-bit ints, CRC validation,
  definition-record preservation and strict error signalling. **This is the merge
  base.**
- `apps/lap-graphs/fit.js` has the one thing swim's lacks: per-base-type
  invalid→null normalisation, including `uint8z`/`uint16z` zero-is-invalid. This
  must be added as an **opt-in flag** — swim's byte-for-byte round-trip contract
  depends on invalid sentinels surviving as literal integers.
- `apps/stairinator/src/fit.js` reads only two fields and dispatches on field
  *size* while ignoring base type. Nothing here is worth keeping.

The three apps want three different *views* of a decoded file (point stream /
activity model / raw structure), so the output shapes should stay separate: one
shared `decode()` returning the wire structure, plus thin per-app adapters.

The two **encoders do not merge** — stairinator's synthesises a file from an app
model, swim's replays a decoded structure. They share only CRC and the 14-byte
header; factor those out and keep two entry points.

### Known loose ends

- `FIT_FORMAT_REFERENCE.md` exists three times. The lap-graphs and swim-corrector
  copies are byte-identical; stairinator's is a divergent variant that needs a
  manual reconcile before they collapse into one `docs/`.
- `apps/stairinator/build-release.sh` still bundles Stairinator alone. It works
  as-is, but wants revisiting once the apps share code — the zip would need the
  shared directory too.
- There are no tests anywhere. Before Phase 2, capture golden decoder output for
  the sample files and diff after; for swim-corrector the test is a byte-identical
  round-trip.

## Personal data

`apps/lap-graphs/samples/` and `apps/swim-corrector/test-data/` hold real activity
files and are gitignored, along with `*.fit` generally. Nothing in the apps
references them — they read whatever you open through the file picker.
