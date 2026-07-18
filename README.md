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
shared/
  fit/decode.js     the FIT decoder, used by all three apps
  fit/adapters.js   views over a decoded file (activity model, point stream)
test/run.js         regression tests — node test/run.js
apps/
  stairinator/      + its own FIT *encoder* (synthesises a file)
  lap-graphs/
  swim-corrector/   + its own FIT *encoder* (byte-faithful rewrite)
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
- [x] **Phase 2 — merge the FIT decoder.** Three decoders became one.
- [ ] **Phase 3 — encoders and GPX.**
- [ ] **Phase 4 — shared CSS design tokens.**

### Phase 2 — how the decoders were merged

They were not peers, so this was a "promote one, delete two" job. The swim
corrector's decoder was a near-strict superset — base-type table, string and
array fields, 64-bit ints, CRC validation, definition-record preservation — so it
became `shared/fit/decode.js`. The other two were deleted.

Two things were folded in on top, both **opt-in so the default is unchanged**:

- `nullifyInvalid` — maps each base type's "no data" sentinel to null as it is
  read, which is what the grapher's decoder used to do. It must stay off for
  anything that re-encodes: **the byte-faithful round-trip depends on sentinels
  surviving as literal integers.**
- `tolerant` — stops cleanly at a malformed record instead of throwing, so the
  grapher still charts what parsed. Both reading apps pass it; the corrector does
  not, because a file it cannot fully parse is one it must not rewrite.

The three apps want three different *views* of a decoded file, so the output
shapes stayed separate. `shared/fit/adapters.js` holds `toActivityModel()` (the
grapher) and `toPointStream()` (GPX-shaped, for the stair builder). The corrector
has no adapter — it works on the raw structure because it mutates and re-encodes
it.

The two **encoders were deliberately not merged**: stairinator's synthesises a
file from an app model, the corrector's replays a decoded structure. They share
only CRC and the 14-byte header. That is Phase 3.

Verified by capturing decoder output for every sample file before the merge and
diffing after: all 15 app/file combinations byte-identical, including the
round-trips. `test/run.js` now covers this permanently.

### Known loose ends

- `FIT_FORMAT_REFERENCE.md` exists three times. The lap-graphs and swim-corrector
  copies are byte-identical; stairinator's is a divergent variant that needs a
  manual reconcile before they collapse into one `docs/`.
- `apps/stairinator/build-release.sh` still bundles Stairinator alone, and now
  under-bundles it — the zip needs `shared/` too, or the released app breaks.
  **Fix this before the next release.**
- `apps/lap-graphs/docs/` still describes the original TypeScript/React version
  (`src/fit/parseFit.ts` and similar). Stale, but historical rather than wrong.

## Tests

```
node test/run.js
```

Fixtures are synthesised by the encoder rather than read from disk, because the
real activity files are personal data and gitignored — so the suite runs from a
clean checkout. If those files happen to be present they get exercised too.

## Personal data

`apps/lap-graphs/samples/` and `apps/swim-corrector/test-data/` hold real activity
files and are gitignored, along with `*.fit` generally. Nothing in the apps
references them — they read whatever you open through the file picker.
