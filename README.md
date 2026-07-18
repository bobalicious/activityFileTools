# Activity File Tools

Three browser-based tools for reading, graphing, correcting and building FIT and
GPX activity files. No build, no server, no network.

**→ [bobalicious.github.io/activityFileTools](https://bobalicious.github.io/activityFileTools/)**

Or clone it and open `index.html` directly — it runs the same from `file://`,
and your files never leave the machine either way.

| App | What it does |
|---|---|
| [Stairinator](apps/stairinator/) | Builds a FIT activity file from a stair-machine workout plan, with altitude, distance, cadence and optional recorded HR |
| [bd-licious graphs](apps/bd-licious-graphs/) | Charts a FIT file — metric rows, HR zones, rest detection, per-length swim data, PNG export |
| [Swim FIT Corrector](apps/swim-corrector/) | Finds missed and false pool turns, lets you fix them, and rewrites the file byte-faithfully |

Each app has its own README with fuller detail.

## Layout

```
index.html          landing page — links to the three apps
settings.html       saved settings for every tool: view, export, import, clear
style.css           landing and settings page styling
shared/
  fit/decode.js     FIT binary → message structure
  fit/encode.js     message structure → FIT binary, plus the write primitives
  fit/adapters.js   views over a decoded file (activity model, point stream)
  gpx/parse.js      GPX → point stream (read-only)
  ui/tokens.css     colour, spacing and type — the whole palette
  ui/components.css buttons, file panel, step badges, cards, messages
  ui/filepanel.js   opening a file: picker, drag/drop, filename, errors
  ui/help.js        the help modal
  ui/markdown.js    the tiny renderer behind it
  ui/chart-theme.js chart palette, matched to tokens.css
  ui/settings.js    the registry of everything the suite stores
  ui/icons.js       the app icons, drawn to one recipe
docs/               FIT format reference
test/run.js         FIT and settings tests — node test/run.js
test/behaviour.js   UI behaviour, in a real browser
apps/
  stairinator/      src/fit.js is now just the stair-specific message layout
  bd-licious-graphs/
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
- [x] **Phase 5 — one set of behaviours.** The apps now *act* alike, not just
      look alike.
- [x] **Phase 6 — one set of chrome, one place for settings.**

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

**An app overrides exactly one thing: its accent.** Green for Stairinator,
Strava orange for the grapher, blue for the corrector — named once in
`tokens.css` as `--accent-stairinator` and friends, so the landing card and the
tool itself cannot end up showing different colours for the same thing. A test
compares the two. `tokens.css` deliberately does *not* set
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

### Phase 5 — one set of behaviours

Looking alike is not the same as behaving alike. An audit of all three found
they had each invented their own answer to the same questions:

| | was | now |
|---|---|---|
| Panel after a file loads | unchanged / unchanged / **vanished** | shrinks to a compact bar |
| Filename | in the drop label / **nowhere** / topbar | in the bar |
| Change or close the file | none / none / topbar button | in the bar |
| Failures | **`alert()`** / raw message / title + detail | title + detail, inline |
| Help | modal / none / none | modal in all three |
| Theme | OS / OS / **toggle** | OS everywhere |
| Keyboard file open | ✗ / focusable but **inert** / via inner button | works |

`shared/ui/filepanel.js` owns the whole file interaction, which is what stops
this drifting again. The panel is deliberately never hidden — a loaded file
shrinks it rather than replacing it with a button somewhere else.

The error region sits *outside* the swappable part of the panel on purpose.
That is what fixed the export bug below: an app that hides its drop zone has
nowhere to put a failure that happens later.

**Bugs the audit turned up, all fixed:**

- The corrector wrote export errors into an element inside its landing section,
  which was hidden whenever a file was open — so a failed export silently did
  nothing.
- The grapher destroyed the graph you were looking at when the *next* file
  failed to parse.
- Stairinator kept showing the previous filename after a failed load, while
  holding no file at all.
- The grapher's `arrayBuffer()` had no rejection handler, so an unreadable file
  showed nothing whatsoever.
- The grapher silently discarded your metric choices when a file's sport didn't
  match them; it now says so.

`test/behaviour.js` asserts all of this in a real browser, because it is DOM
behaviour and cannot be checked any other way.

### Phase 6 — chrome and settings

Every page now carries the same bar (back link, **Help**, **Settings**), the
same title block, and the same content width — `--page-max`, applied through
`.page`. Screens were 880 / 900 / 1120px wide before, so moving between tools
shifted the whole layout.

**Settings moved up.** Stairinator had Export all / Import buttons; the other
two had no way to back anything up at all, so half your saved work could not be
moved between browsers. `settings.html` now shows what each tool has stored and
exports or imports the lot as one file. `shared/ui/settings.js` is the registry
that makes that possible — **an app that starts saving something new must add
its key there, or that data is silently missing from every backup.** A test
asserts the registry only lists keys the apps actually use.

Storage keys follow one scheme — `activity-tools.<app>.<thing>`. They were
renamed outright rather than migrated, on the basis that there was nothing
stored worth keeping; anything saved under the old keys is orphaned.

An import replaces whole keys rather than merging inside them; a half-merged
set of machines and plans is harder to reason about than a clean swap, and
exporting first is cheap. Old bare Stairinator exports (`{machines, plans}`)
are still recognised, so existing backups aren't stranded.

The grapher is called **bd-licious graphs** everywhere now, including its
directory, rather than "Lap Graphs" in some places.

**Icons** come from `shared/ui/icons.js`, so the mark on a landing card and the
one in that app's header cannot drift apart. They follow one recipe, taken from
the swim corrector's original: 20x20, 1.6 stroke, round caps, everything drawn
in `var(--accent)` so each icon takes its app's colour and follows light/dark
for free, one element at 0.45 opacity for depth, and exactly one filled circle
as the focal point. Tests assert the recipe holds and that no page references an
icon name that doesn't exist — a typo there renders nothing, silently.

Stairinator's chart follows the green accent, and its heart-rate trace moved
from red to purple to go with it. Green against red measures ΔE 13 under
deuteranopia and 18 under protanopia — effectively the same colour for the ~8%
of men with red-green colour blindness. Against purple it is 111 and 132. The
grapher's own `heartRate` stays red, because it is plotted against a different
set of series; the stair chart uses a separate `planHeartRate` entry. A test
simulates both conditions and fails if the pair ever drifts back together.

The app bar is a constant height everywhere. It had been shorter on
`settings.html`, because the bar takes its height from its tallest child and
that page has no Help/Settings buttons to set it; `.app-nav` now carries the
same min-height as a small button.

### Known loose ends

- `apps/bd-licious-graphs/docs/` still describes the original TypeScript/React version
  (`src/fit/parseFit.ts` and similar). Stale, but historical rather than wrong.

## Tests

```
node test/run.js         # FIT decode / encode / adapters — 26 tests
node test/behaviour.js   # UI behaviour, driven in headless Chrome
```

`run.js` fixtures are synthesised by the encoder rather than read from disk,
because the real activity files are personal data and gitignored — so the suite
runs from a clean checkout. If those files happen to be present they get
exercised too.

`behaviour.js` needs Chrome and skips cleanly without it. It drives the real
pages: loads a good file and a deliberately bad one into each app and asserts
what the user actually ends up looking at.

## Personal data

`apps/bd-licious-graphs/samples/` and `apps/swim-corrector/test-data/` hold real activity
files and are gitignored, along with `*.fit` generally. Nothing in the apps
references them — they read whatever you open through the file picker.

## Your files, and no warranty

These tools read and write activity files entirely on your own machine — nothing
is uploaded anywhere. A file you open is only ever read; anything a tool produces
is written fresh alongside it.

Even so: **keep your own copy of any file you care about.** A generated or
corrected file cannot really be inspected by eye — it is binary — so the original
is your only way back if the result turns out wrong. That matters most with the
swim corrector, where getting a correction onto Strava means deleting the
original activity there first.

Provided **as-is, with no warranty of any kind, express or implied**. You are
responsible for your own data. No liability is accepted for corrupted files,
lost activities, incorrect results, or any other loss arising from use of these
tools.
