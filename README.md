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
  fit/decode.js     FIT binary → message structure
  fit/encode.js     message structure → FIT binary, plus the write primitives
  fit/adapters.js   views over a decoded file (activity model, point stream)
  gpx/parse.js      GPX → point stream (read-only)
  ui/tokens.css     colour, spacing and type — the whole palette
  ui/components.css buttons, file drop, step badges, cards, messages
  ui/chart-theme.js chart palette, matched to tokens.css
docs/               FIT format reference
test/run.js         regression tests — node test/run.js
apps/
  stairinator/      src/fit.js is now just the stair-specific message layout
  lap-graphs/
  swim-corrector/
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
- [x] **Phase 3 — encoders and GPX.** Byte-level writing shared; GPX moved.
- [x] **Phase 4 — one interaction language.** Shared tokens and components.

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

Verified by capturing decoder output for every sample file before the merge and
diffing after: all 15 app/file combinations byte-identical, including the
round-trips. `test/run.js` now covers this permanently.

### Phase 3 — encoders and GPX

The two encoders still don't merge at the message layer, and shouldn't: a
rewrite is driven by the definitions already in the file, a synthesis declares
its own. But everything *below* that layer was duplicated, and now isn't — the
CRC, the byte sink, definition writing, field writing and header assembly all
live in `shared/fit/encode.js`.

What's left in `apps/stairinator/src/fit.js` is only the stair-specific part:
which messages it emits, and what goes in them.

The GPX parser had no counterpart to merge with, so it just moved to
`shared/gpx/parse.js`. Its global changed from `Stair.gpx` to `GpxParse` now
that it isn't stairinator's.

Verified the same way: the synthesised file is byte-for-byte what it was before
the refactor, pinned in the tests by a SHA-256 so it can't drift silently.

### Phase 4 — one interaction language

The three apps had drifted into three vocabularies for the same ideas —
`--ink`/`--text-primary`/`--fg` for the same colour, three different upload
controls, `button` rules that agreed on everything except a pixel of radius.
That is now one set of tokens and one set of components, and the apps keep only
their layout.

**An app overrides exactly one thing: its accent.** Strava orange in the
grapher, blue in the other two. `tokens.css` deliberately does *not* set
`--accent` in its dark blocks — those selectors carry higher specificity than a
plain `:root`, so an app setting its accent normally would be silently
overridden in dark mode. The app owns that colour in both themes.

Unified deliberately, per the brief:

- **One upload control.** The grapher's drop zone (`.filedrop`) everywhere,
  replacing stairinator's `.file-drop` and the corrector's `.dropzone`.
- **Numbered steps on every page.** All three walk the user through an ordered
  sequence, and now all three show it.
- **One chart palette.** `chart-theme.js` holds it, because the charts can't
  just read CSS: two of them bake colours into exported images. It has to be
  kept in step with `tokens.css` by hand.

### Known loose ends

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
