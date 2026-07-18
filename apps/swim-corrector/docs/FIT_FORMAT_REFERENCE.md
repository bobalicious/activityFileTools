# FIT File Format — Practical Reference

A hands-on reference for reading and writing **FIT** (Flexible and Interoperable
Data Transfer) files, distilled from building a dependency-free encoder **and**
decoder and validating the output against the **official Garmin FIT SDK**.

It is deliberately practical: enough of the spec to implement against, plus the
field numbers, enum values, conventions, and real-world interop gotchas that cost
time to discover. The authoritative source is Garmin's **FIT SDK** (the
`Profile.xlsx` / generated profile and the protocol docs at
<https://developer.garmin.com/fit/>). Where a value matters, verify it there.

---

## Contents

1. What FIT is
2. Overall file structure
3. The file header
4. CRC-16
5. Records: definition vs data messages
6. The record header byte
7. Definition message layout
8. Data message layout
9. Base types
10. Scale, offset, and invalid values
11. Timestamps (the FIT epoch)
12. Positions (semicircles)
13. Local vs global message numbers
14. Common messages and their field numbers
15. Message ordering for a valid activity
16. Compressed-timestamp records
17. Developer fields
18. Encoding recipe (minimal valid activity)
19. Decoding recipe
20. Reference enum values
21. Gotchas and hard-won lessons
22. Platform interop (Strava / Garmin Connect)
23. Validating your output
24. FIT vs GPX vs TCX
25. Pool swimming — lengths, laps, and turns

---

## 1. What FIT is

- **Binary**, compact, fast to parse. Native format for Garmin, Wahoo, and many
  other devices/apps.
- **Self-describing**: a file declares the *shape* of each record type before
  emitting rows of that type, so new fields can be added without breaking old
  parsers.
- **Activity-oriented**: first-class concepts for *file*, *device*, *session*,
  *lap*, *record* (sample), *event*. Carries altitude / distance / cadence /
  power / HR directly, with or without GPS.

## 2. Overall file structure

```
┌────────────┐
│  Header    │  12 or 14 bytes
├────────────┤
│  Data      │  a stream of messages (definition + data), variable length
├────────────┤
│  CRC       │  2 bytes (uint16 LE), over the entire file before it
└────────────┘
```

## 3. The file header

14-byte form (recommended; 12-byte omits the header CRC):

| Offset | Size | Meaning |
|---|---|---|
| 0 | 1 | Header size (`12` or `14`) |
| 1 | 1 | Protocol version (`0x20` = 2.0) |
| 2 | 2 | Profile version (uint16 **LE**), informational |
| 4 | 4 | **Data size** (uint32 LE) — length of the data section only (excludes header and trailing CRC) |
| 8 | 4 | ASCII `.FIT` = `0x2E 0x46 0x49 0x54` |
| 12 | 2 | Header CRC (uint16 LE) over bytes 0–11 (14-byte header only) |

**Detecting a FIT file:** check bytes 8–11 for `.FIT`. (Byte 0 being 12 or 14 is a
secondary hint.)

After the header comes the data section, then a final **2-byte file CRC** computed
over *everything before it* (header + data).

## 4. CRC-16

FIT uses a specific nibble-table CRC-16. Feed every byte through it.

```js
const CRC_TABLE = [0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,
                   0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400];
function crc16(crc, byte) {
  let tmp = CRC_TABLE[crc & 0xF];
  crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[byte & 0xF];
  tmp = CRC_TABLE[crc & 0xF];
  crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF];
  return crc & 0xFFFF;
}
```

- **Header CRC** (14-byte header): `crc` over bytes 0–11, stored LE at bytes 12–13.
- **File CRC**: `crc` over the full header + data, appended LE at the end.

## 5. Records: definition vs data messages

The data section is a stream of **messages**, each starting with a 1-byte **record
header**. Two kinds:

- **Definition message** — declares a record layout: which fields, sizes, base
  types. Carries no values.
- **Data message** — one row of values, laid out per a previously-seen definition.

The definition binds a **local message type** (0–15) to a layout; subsequent data
messages reference that local type. You may re-issue a definition for the same
local type later to change the layout.

## 6. The record header byte

```
bit  7 6 5 4 3 2 1 0
```

- If **bit 7 = 1** → **compressed-timestamp data message** (see §16):
  - bits 5–6 = local message type (0–3)
  - bits 0–4 = time offset (added to a rolling reference)
- If **bit 7 = 0** → normal header:
  - **bit 6**: 1 = definition message, 0 = data message
  - **bit 5**: (definition) developer-data flag; (data) reserved 0
  - **bits 0–3**: local message type (0–15)

## 7. Definition message layout

After the record header (`0x40 | localType`, plus `0x20` if developer fields):

| Bytes | Meaning |
|---|---|
| 1 | Reserved (0) |
| 1 | Architecture: `0` = little-endian, `1` = big-endian (applies to multi-byte fields *in this message*) |
| 2 | Global message number (uint16, per architecture) |
| 1 | Number of fields `n` |
| 3×n | Per field: `field_def_number` (1), `size_bytes` (1), `base_type` (1) |
| — | If dev flag: 1 byte `n_dev`, then 3×n_dev: `field_number`, `size`, `dev_data_index` |

## 8. Data message layout

After the record header (`localType`): the field **values**, in the exact order
and sizes given by the matching definition, using that definition's architecture
(endianness). Developer field bytes (if any) follow the standard fields.

## 9. Base types

The base-type byte: **bit 7 set = multi-byte (endian-aware)**; low bits = type id.

| Byte | Type | Size | Invalid |
|---|---|---|---|
| 0x00 | enum | 1 | 0xFF |
| 0x01 | sint8 | 1 | 0x7F |
| 0x02 | uint8 | 1 | 0xFF |
| 0x83 | sint16 | 2 | 0x7FFF |
| 0x84 | uint16 | 2 | 0xFFFF |
| 0x85 | sint32 | 4 | 0x7FFFFFFF |
| 0x86 | uint32 | 4 | 0xFFFFFFFF |
| 0x07 | string | var | 0x00 (NUL-terminated UTF-8) |
| 0x88 | float32 | 4 | 0xFFFFFFFF |
| 0x89 | float64 | 8 | 0xFFFFFFFFFFFFFFFF |
| 0x0A | uint8z | 1 | 0x00 |
| 0x8B | uint16z | 2 | 0x0000 |
| 0x8C | uint32z | 4 | 0x00000000 |
| 0x0D | byte | var | 0xFF |
| 0x8E | sint64 | 8 | 0x7FFF…FF |
| 0x8F | uint64 | 8 | 0xFFFF…FF |
| 0x90 | uint64z | 8 | 0x0000…00 |

"z" types treat 0 as invalid (e.g. serial numbers).

## 10. Scale, offset, and invalid values

Many fields store integers you must convert:

```
physical_value = (stored_value / scale) − offset
stored_value   = round((physical_value + offset) × scale)
```

Common examples (record message):

| Field | Base type | Scale | Offset | Units |
|---|---|---|---|---|
| altitude | uint16 | 5 | 500 | m (→ 0.2 m resolution, allows negatives) |
| enhanced_altitude | uint32 | 5 | 500 | m |
| distance | uint32 | 100 | 0 | m (stored as cm) |
| speed / enhanced_speed | uint16 / uint32 | 1000 | 0 | m/s |
| total_elapsed_time / total_timer_time | uint32 | 1000 | 0 | s (stored as ms) |

**Invalid values** mark "no data" per field (table in §9). This is how a single
record can omit, say, heart rate while keeping every other field.

## 11. Timestamps (the FIT epoch)

`timestamp` (field 253 in most messages) is **uint32 seconds since the FIT epoch**:

```
FIT_EPOCH = 631065600           // Unix seconds at 1989-12-31T00:00:00Z
fit_seconds  = unix_seconds − FIT_EPOCH
unix_seconds = fit_seconds + FIT_EPOCH
```

Times are UTC. `local_timestamp` (e.g. activity field 5) can carry local time for
timezone display.

## 12. Positions (semicircles)

Latitude/longitude are **sint32 semicircles**:

```
semicircles = round(degrees × (2^31 / 180))      // 2^31 = 2147483648
degrees     = semicircles × (180 / 2^31)
```

Absence of position is legal — that's an indoor/no-GPS activity.

## 13. Local vs global message numbers

- **Local type (0–15):** the in-file handle used by the record header. Arbitrary;
  you assign it when you emit the definition.
- **Global message number:** identifies the real message in the FIT **Profile**
  (the shared dictionary). E.g. `record` = 20, `lap` = 19, `session` = 18.

Both sides agree on global numbers + field numbers via the Profile.

## 14. Common messages and their field numbers

Field numbers are from the FIT Profile. ⚠️ **Field numbers are per-message** — the
same concept can have different numbers in different messages (see §21).

**file_id (global 0)** — required, first:
| # | Field | Type | Notes |
|---|---|---|---|
| 0 | type | enum | 4 = activity |
| 1 | manufacturer | uint16 | see §20 |
| 2 | product | uint16 | manufacturer-specific |
| 3 | serial_number | uint32z | |
| 4 | time_created | uint32 | FIT timestamp |
| 8 | product_name | string | optional |

**device_info (global 23)**:
| # | Field | Type |
|---|---|---|
| 253 | timestamp | uint32 |
| 0 | device_index | uint8 (0 = creator) |
| 2 | manufacturer | uint16 |
| 4 | product | uint16 |
| 5 | software_version | uint16 (scale 100) |
| 3 | serial_number | uint32z |

**event (global 21)**:
| # | Field | Type |
|---|---|---|
| 253 | timestamp | uint32 |
| 0 | event | enum (0 = timer) |
| 1 | event_type | enum (0 = start, 4 = stop_all) |

**record (global 20)** — the sample stream:
| # | Field | Type | Scale/Offset |
|---|---|---|---|
| 253 | timestamp | uint32 | |
| 0 | position_lat | sint32 | semicircles |
| 1 | position_long | sint32 | semicircles |
| 2 | altitude | uint16 | /5 − 500 |
| 3 | heart_rate | uint8 | bpm |
| 4 | cadence | uint8 | rpm |
| 5 | distance | uint32 | /100 (m) |
| 6 | speed | uint16 | /1000 (m/s) |
| 7 | power | uint16 | W |
| 13 | temperature | sint8 | °C |
| 73 | enhanced_speed | uint32 | /1000 |
| 78 | enhanced_altitude | uint32 | /5 − 500 |

**lap (global 19)**:
| # | Field | Type | Notes |
|---|---|---|---|
| 254 | message_index | uint16 | 0-based lap index |
| **253** | **timestamp** | uint32 | ⚠️ **not** the lap end — it is when the message was *written*. Use `start_time + total_elapsed_time`. See §21 |
| 2 | start_time | uint32 | authoritative |
| 7 | total_elapsed_time | uint32 | /1000 |
| 8 | total_timer_time | uint32 | /1000 |
| 9 | total_distance | uint32 | /100 |
| 11 | total_calories | uint16 | |
| 13 | avg_speed | uint16 | /1000 |
| **15** | **avg_heart_rate** | uint8 | ⚠️ differs from session |
| 16 | max_heart_rate | uint8 | |
| 17 | avg_cadence | uint8 | |
| **21** | **total_ascent** | uint16 | ⚠️ differs from session |
| 22 | total_descent | uint16 | |
| 0 | event | enum (9 = lap) | |
| 1 | event_type | enum (1 = stop) | |

**session (global 18)**:
| # | Field | Type | Notes |
|---|---|---|---|
| 254 | message_index | uint16 | |
| 253 | timestamp | uint32 | |
| 2 | start_time | uint32 | |
| 5 | sport | enum | see §20 |
| 6 | sub_sport | enum | see §20 |
| 7 | total_elapsed_time | uint32 | /1000 |
| 8 | total_timer_time | uint32 | /1000 |
| 9 | total_distance | uint32 | /100 |
| 11 | total_calories | uint16 | |
| **16** | **avg_heart_rate** | uint8 | ⚠️ (lap uses 15) |
| 17 | max_heart_rate | uint8 | |
| 18 | avg_cadence | uint8 | |
| **22** | **total_ascent** | uint16 | ⚠️ (lap uses 21) |
| 23 | total_descent | uint16 | |
| 25 | first_lap_index | uint16 | |
| 26 | num_laps | uint16 | |
| 0 | event | enum (8 = session) | |
| 1 | event_type | enum (1 = stop) | |

**activity (global 34)** — required, last:
| # | Field | Type | Notes |
|---|---|---|---|
| 253 | timestamp | uint32 | |
| 0 | total_timer_time | uint32 | /1000 |
| 1 | num_sessions | uint16 | |
| 2 | type | enum | 0 = manual |
| 3 | event | enum | 26 = activity |
| 4 | event_type | enum | 1 = stop |
| 5 | local_timestamp | uint32 | optional, local time |

## 15. Message ordering for a valid activity

A widely-accepted, parser-friendly order:

```
file_id                      (required, first)
device_info                  (recommended)
event  (timer start)
record × N                   (timestamps non-decreasing)
event  (timer stop_all)
lap × M
session
activity                     (required, last)
```

Definitions must precede the data messages that use them; a common pattern is to
emit each definition once, immediately before the first data message of that type.

## 16. Compressed-timestamp records

An alternate data-message header (bit 7 = 1) packs a 5-bit time offset into the
header byte to save space. Decode against a rolling reference:

```
base   = last_full_timestamp
ts     = (base & ~0x1F) + time_offset
if (time_offset < (base & 0x1F)) ts += 0x20   // 32-second rollover
last_full_timestamp = ts
```

A full `timestamp` field (253) in any message updates the rolling reference. Only
local types 0–3 are addressable this way. Many files don't use it, but a robust
decoder must.

## 17. Developer fields

FIT 2.0 allows third-party custom fields. They're described in-band by
`developer_data_id` (global 207) and `field_description` (global 206) messages,
and referenced in definition messages after the standard fields (via the dev flag,
bit 5). If you only need standard data, you can **skip** developer field bytes
using their declared sizes.

## 18. Encoding recipe (minimal valid activity)

1. Build the **data section** in memory as a byte array:
   - For each message type, write a **definition** (once), then its **data**
     message(s).
   - Convert values: timestamps → FIT seconds; lat/lon → semicircles; scaled
     fields → `round((v + offset) × scale)`; unknown/missing → the base type's
     invalid value.
   - Emit `file_id`, `device_info`, start `event`, `record`×N, stop `event`,
     `lap`×M, `session`, `activity`.
2. Build the **14-byte header**: size, protocol, profile version, **data size**
   (length of step 1), `.FIT`, then the header CRC over the first 12 bytes.
3. Concatenate header + data; compute the **file CRC** over all of it; append LE.

**Little-endian integer writing in JS** (values fit in uint32):

```js
function u16(bytes, v){ v&=0xFFFF; bytes.push(v&0xFF, (v>>8)&0xFF); }
function u32(bytes, v){ v>>>=0; bytes.push(v&0xFF,(v>>>8)&0xFF,(v>>>16)&0xFF,(v>>>24)&0xFF); }
```

`v >>> 0` yields an unsigned 32-bit value; it also produces the correct two's-
complement bytes for **negative sint32** (e.g. negative semicircles).

## 19. Decoding recipe

```
read + validate header (.FIT signature, header size)
data_end = header_size + data_size
pos = header_size
defs = {}                       // localType -> {global, littleEndian, fields[], devFieldsTotalSize}
lastTimestamp = null
while (pos < data_end):
  h = byte[pos++]
  if (h & 0x80):                // compressed-timestamp data message
     local = (h >> 5) & 0x03; offset = h & 0x1F
     ts = reconstruct(lastTimestamp, offset); lastTimestamp = ts
     read data using defs[local]; (its timestamp is ts)
  else if (h & 0x40):           // definition
     reserved; arch = byte; global = u16(arch); n = byte
     fields = n × {num, size, baseType}
     if (h & 0x20): read dev field defs, sum their sizes
     defs[h & 0x0F] = {...}
  else:                         // data
     def = defs[h & 0x0F]
     for each field: read `size` bytes per baseType/arch
        if field.num == 253: lastTimestamp = value
     skip def.devFieldsTotalSize bytes
verify trailing CRC (optional but recommended)
```

## 20. Reference enum values

Verified against the Garmin FIT SDK where marked ✓.

**file type** (file_id.type): 1 device, 2 settings, 3 sport, **4 activity**,
5 workout, 6 course, 8 weight, 10 totals, 12 segment.

**manufacturer**: **1 = garmin** ✓, 255 = development ✓ (use for DIY files unless a
platform requires a "known" device).

**garmin_product** ✓: fenix6 = **3290**, fenix6Pro often reported as 3290/variant,
fenix7 = 3906, edge530 = 3121, edge830 = 3122, fr945 = 3113.

**sport** ✓: 0 generic, 1 running, 2 cycling, 3 transition, **4 fitness_equipment**,
5 swimming, 10 training, 11 walking, 17 hiking, 30 inline_skating,
**48 floor_climbing**.

**sub_sport** ✓: 0 generic, 1 treadmill, 5 spin, 6 indoor_cycling, 11 elliptical,
**12 hand_cycling** (⚠️ *not* stairs), **16 stair_climbing**, **17 lap_swimming**,
**18 open_water**, 41 indoor_running.
› For a stair machine: `sport = 4 (fitness_equipment)`, `sub_sport = 16
  (stair_climbing)`.
› For a pool swim: `sport = 5 (swimming)`, `sub_sport = 17 (lap_swimming)` — see §25.

**length_type** ✓ (length.field 12): **0 idle** (rest, no strokes), **1 active**.

**swim_stroke** ✓ (length.field 7): 0 freestyle, 1 backstroke, 2 breaststroke,
3 butterfly, 4 drill, 5 mixed, 6 im, **7 im_by_round**, **8 rimo** (reverse IM order).

**event**: 0 timer, 3 workout, 8 session, 9 lap, 10 course_point, 26 activity.

**event_type**: 0 start, 1 stop, 3 marker, 4 stop_all.

**activity.type**: 0 manual, 1 auto_multi_sport.

## 21. Gotchas and hard-won lessons

- **Field numbers are per-message.** The single biggest trap:
  `lap.total_ascent = 21` but `session.total_ascent = 22`; `lap.avg_heart_rate = 15`
  but `session.avg_heart_rate = 16`. Copy-pasting field numbers between messages
  silently corrupts data.
- **Definitions are stateful *and positional*.** A data message is meaningless
  without its definition; you must track `localType → layout` while decoding, and
  (re)emit definitions before use while encoding. Local types get **rebound** as a
  file goes on — in one real Garmin file local 0 is `file_id` early and `battery`
  later, local 1 is `file_creator` then `lap`. Two consequences:
  - A definition is not necessarily near "its" data. In a FR935 pool swim the
    `record` definition sits *after* the first batch of `length` messages.
  - **Moving or inserting a data message can strand it in front of its own
    definition**, or behind a rebinding of the same local type. If you rewrite a
    stream, don't reason about placement — walk the finished stream tracking
    `localType → def` and re-issue a definition wherever a data message would
    otherwise be misread. Re-issuing is legal and is a no-op on a correct stream.
- **Summary `timestamp` is a write-time artifact, not an end time.** Garmin's own
  announcement: *"the timestamp of each message represents the time it was written
  to the file… the timestamp should not be used to determine the start or end time
  of the summary message."* Always use `start_time + total_elapsed_time`. The error
  is not small — see §25 for a device giving 29 lengths only 6 distinct timestamps,
  up to 253 s late.
- **Endianness is per-definition** (the architecture byte), and can differ between
  messages in one file. Don't assume little-endian on read.
- **Invalid values, not zero.** Missing data uses the base type's sentinel; `0` is
  a real value (0 bpm, 0 m). Encode omissions as invalid; treat invalid as null on
  read.
- **Scale/offset direction.** `stored = (value + offset) × scale`. Altitude's
  offset 500 exists to allow ~−500 m; forgetting it shifts everything by 500 m.
- **JS 32-bit bitwise.** Bitwise ops coerce to 32-bit signed. Use `>>> 0` for
  uint32 and for writing negative sint32 (semicircles) as two's complement.
  `Date.now()`-derived FIT seconds fit in uint32 until 2089.
- **Compressed timestamps exist.** Some real device files use them; a decoder that
  ignores bit 7 will desync.
- **Data size vs file size.** The header's data-size field excludes the header and
  the trailing CRC — a frequent off-by-N.
- **enhanced_altitude / enhanced_speed.** Newer files may carry these (uint32)
  instead of / alongside the classic uint16 fields; read both.
- **Records must be time-ordered** (non-decreasing timestamps) for clean parsing
  and sensible graphs. ⚠️ Real device files are not always well-behaved: a FR935
  pool swim contains 5 timestamp decreases in its physical stream, and its
  undocumented `global_125` messages carry timestamps ~30 minutes *after* the
  session ends. Don't assume monotonicity on read; don't panic when you see it
  broken.
- **Record density is device-specific and can be useless.** Nothing guarantees 1 Hz.
  Same sport, same manufacturer: Fenix 3 = 1 record/second, Garmin's SDK pool-swim
  example = 1/length, FR935 = **1 per ~250 s** (six for a 22-minute swim). Anything
  drawing a graph from `record` must cope with minutes-wide gaps — see §25.
- **Counts in summary messages can contradict the messages themselves.** Derive
  counts by walking the data; treat `num_lengths` and friends as advisory (§25).
- **Not every field a device writes is in the Profile.** Garmin write fields that
  don't exist in `Profile.xlsx` at all (SWOLF is one — §25). Don't guess their
  meaning: compute what you *think* the field means from the file's own untouched
  data and compare against the stored value. Write it back only if it reproduces.

## 22. Platform interop (Strava / Garmin Connect)

These aren't part of the format but are essential when the goal is a file a
platform accepts *and displays correctly*:

- **Strava trusts elevation only from "barometric" devices.** It keys off
  `file_id`/`device_info` manufacturer+product against a known-device list. A
  development/unknown device → Strava recalculates elevation (from its terrain
  basemap for GPS files) or shows none. Declaring a real barometric device (e.g.
  Garmin Fenix 6) makes Strava honour the file's altitude.
- **Strava needs a "map" (GPS) to *display* elevation at all.** An activity with
  no position is treated as indoor → no elevation shown, even with a trusted
  device. Injecting a minimal placeholder GPS path is the common workaround (this
  is what Zwift does).
- **Distance:** for FIT with a `distance` field, Strava trusts that (device
  odometer) rather than recomputing from GPS — unlike GPX.
- **Moving time:** when GPS is present and there are no pause events, Strava
  *recomputes* moving time from point-to-point speed; below ~a 30-min-mile pace it
  counts as "resting" → moving time can be 0. The file can't force it (the "Race"
  tag that would is Run/Ride/Swim-only).
- **Activity type** comes from `sport`/`sub_sport`.
- **TCX/GPX creator trick:** for those formats Strava honours elevation if the
  `creator` string contains "with barometer" — a text analogue of the FIT device
  trust. (Not needed for FIT if you declare a barometric device.)
- **Swims: Strava sums LAP distances, not lengths.** Official: *"Distance is
  calculated by adding up the laps' distances, and moving time is calculated by
  adding up the timer time of any lap more than zero yards."* So if you edit
  `length` messages you **must** rewrite `lap.total_distance` (9) too, or Strava
  shows the old distance while the lengths say otherwise. Also: *"There is no way
  to update the pool length once the activity is on Strava"* — pool swims are
  effectively view-only there; the only fix is edit-FIT → delete → re-upload.
- **A sparse record stream produces a nonsense graph.** Strava draws pace from
  `record`, and with a FR935's six records across 22 minutes it interpolates
  across four-minute gaps. Rebuilding at one record per length (the shape Garmin's
  own SDK example uses) is the practical remedy — see §25.
- **⚠️ Auto-sync and manual upload are not the same path.** An activity that
  arrived via the Garmin Connect integration may not render identically to a
  manual upload of the very same bytes, and Strava's *"Download Original"* returns
  the stored file — which is not proof of how the activity was ingested or
  rendered. When comparing a corrected file against an auto-synced original,
  upload the **untouched** original manually first as a control; otherwise you are
  attributing a pipeline difference to your edit. *(Observed, not documented.)*

## 23. Validating your output

- **Official Garmin FIT SDK** (e.g. `@garmin/fitsdk` for JS): `new Decoder(stream)`
  → `decoder.isFIT()`, `decoder.checkIntegrity()` (verifies CRC), `decoder.read()`
  → `{ messages, errors }`. ⚠️ `isFIT()`/`checkIntegrity()` position/consume the
  stream — call them **before** `read()`.
- Cross-check with a **third-party parser** (e.g. `fit-file-parser`), but note some
  have **outdated enum tables** (one mislabels `sub_sport 16` etc.) — trust the
  official SDK for enum meanings.
- Sanity checks worth automating: header signature + sizes, CRC valid, zero decode
  errors, expected message/lap/record counts, and a round-trip through your own
  decoder.

## 24. FIT vs GPX vs TCX

| | FIT | GPX | TCX |
|---|---|---|---|
| Encoding | binary | XML | XML |
| Orientation | activity | route/track | activity |
| Location required | no | effectively yes | no |
| Native laps/session/device | yes | no | yes |
| Extensible | yes (self-describing + dev fields) | namespaces | limited |
| Elevation trusted by Strava | if barometric device declared | only via "with barometer" creator | similar to GPX |

Choose FIT when you need no-GPS activities, native lap/session structure, or
device-authoritative distance/altitude; GPX for simple shareable tracks; TCX when
a target only speaks TCX.

## 25. Pool swimming — lengths, laps, and turns

Pool swims add one message (`length`, global **101**) and a pile of traps. Field
numbers below are from **Garmin FIT Profile 21.208.0** (✓ = checked against the
generated profile). Behavioural claims are marked with the device they came from.

**Empirical corpus** for this section:

| | Device | Lengths | Records | Notes |
|---|---|---|---|---|
| **A** | Fenix 3 | 87 (68 active / 19 idle) | 3501 | 1 record/second |
| **B** | Fenix 3 + HRM | 87 | 3501 | plus 950 `hr` messages |
| **C** | Garmin SDK example | 24 (20 / 4) | 24 | 1 record/length, 25 yd pool |
| **D** | **FR935** | 29 (29 / 0) | **6** | 25 m, big-endian, 1 record/250 s |

### 25.1 The `length` message (global 101) ✓

| # | Field | Base | Scale | Units |
|---|---|---|---|---|
| 254 | message_index | uint16 | 1 | contiguous 0..n−1, **including idle** |
| 253 | timestamp | uint32 | 1 | ⚠️ flush time, **not** the length end |
| 0 | event | enum | 1 | always 28 (`length`) |
| 1 | event_type | enum | 1 | always 1 (`stop`) |
| 2 | start_time | uint32 | 1 | **authoritative** |
| 3 | total_elapsed_time | uint32 | **1000** | s |
| 4 | total_timer_time | uint32 | **1000** | s |
| 5 | total_strokes | uint16 | 1 | strokes |
| 6 | avg_speed | uint16 | **1000** | m/s |
| 7 | swim_stroke | enum | 1 | §20 |
| 9 | avg_swimming_cadence | uint8 | 1 | strokes/min |
| 10 | event_group | uint8 | 1 | |
| 11 | total_calories | uint16 | 1 | kcal |
| 12 | length_type | enum | 1 | **required on every length** |
| 18/19 | player_score / opponent_score | uint16 | 1 | |
| 20 | stroke_count | uint16 (ARRAY) | 1 | ⚠️ racket sports, **not** swimming |
| 21 | zone_count | uint16 (ARRAY) | 1 | |
| 22–25 | respiration rates | | 100 / 1 | |

**There is no `length.total_distance`.** A length *is* one `session.pool_length`.
That single fact is why a missed turn is destructive: the length count is the
distance.

**Idle lengths carry almost nothing** (observed, A): only `message_index`,
`timestamp`, `event`, `event_type`, `start_time`, the two times, and
`length_type`. No strokes/speed/stroke/cadence/calories. Devices often emit a
**separate, leaner definition** for them — so don't assume one definition covers
all lengths when rewriting. Drill lengths *do* carry `total_strokes = 0`
(present-and-zero, not absent).

### 25.2 Swim fields on `lap` (global 19) ✓

| # | Field | Base | Scale | Note |
|---|---|---|---|---|
| **10** | **total_cycles** | uint32 | 1 | ⚠️ **this is where strokes live** |
| 17 | avg_cadence | uint8 | 1 | ⚠️ **this is where swim cadence lives** |
| 9 | total_distance | uint32 | 100 | m — *Strava reads this* (§22) |
| **32** | num_lengths | uint16 | 1 | ⚠️ semantics vary — see 25.5 |
| **35** | first_length_index | uint16 | 1 | |
| **37** | avg_stroke_distance | uint16 | 100 | m |
| **38** | swim_stroke | enum | 1 | |
| **40** | num_active_lengths | uint16 | 1 | |

⚠️ **`lap.total_strokes` does not exist.** It is a *sub-field* of `total_cycles`
(**10**), active when `sport ∈ {2 cycling, 5 swimming, 15 rowing, 37 SUP}`. On the
wire you read and write **field 10**.

⚠️ **`lap.avg_swimming_cadence` does not exist.** `avg_swimming_cadence` appears
exactly once in the whole profile, on `length`. Lap swim cadence rides in
**`avg_cadence` (17)**.

Both are classic copy-paste-from-`length` traps.

### 25.3 Swim fields on `session` (global 18) ✓

| # | Field | Base | Scale | Note |
|---|---|---|---|---|
| **44** | **pool_length** | uint16 | **100** | **always metres** |
| **46** | pool_length_unit | enum | 1 | 0 metric, 1 statute — *display only* |
| **33** | num_lengths | uint16 | 1 | ⚠️ see 25.5 |
| **47** | num_active_lengths | uint16 | 1 | |
| **41** | avg_stroke_count | uint32 | **10** | strokes/lap |
| **42** | avg_stroke_distance | uint16 | 100 | m |
| **43** | swim_stroke | enum | 1 | |
| 10 | total_cycles | uint32 | 1 | strokes (sub-field, as lap) |
| 18 | avg_cadence | uint8 | 1 | |

**`pool_length` is always metres regardless of `pool_length_unit`.** Cookbook:
*"The pool length is specified in meters, and the pool_length_unit field provides
the corresponding display units."* A 25 **yard** pool stores **2286** = 22.86 m
(verified, C). ⚠️ `pool_length` is per-message: session **44**, `workout` (26) 14,
`workout_session` (158) 4.

### 25.4 Deriving distance ✓

```
total_distance = num_ACTIVE_lengths × pool_length
```

Verified in all four files: A 68×25 = 1700 ✓ · C 20×22.86 = 457.2 ✓ · D 29×25 =
725 ✓. **Never use `num_lengths`** — idle lengths carry zero distance.

### 25.5 The three big traps

**① `length.timestamp` is a flush artifact.** Devices batch length messages and
stamp them when written. Measured error vs the true end (`start_time +
total_elapsed_time`):

| File | Error |
|---|---|
| A (Fenix 3) | median **+7.2 s**, max **+242 s** |
| **D (FR935)** | **6 distinct timestamps shared across all 29 lengths**, up to **+253 s** |

In D the six values are exactly the six `record` timestamps — the flush points.
The authoritative timeline chains perfectly: `start_time + total_elapsed_time ==
next.start_time` holds **28/28** (D) and **85/86** (A).

**② `num_lengths` semantics are inconsistent between devices.**

| File | length msgs | active | idle | `session.num_lengths` | Counts |
|---|---|---|---|---|---|
| C (SDK example) | 24 | 20 | 4 | **24** | ALL — spec-conformant |
| A (Fenix 3) | 87 | 68 | 19 | **68** | **ACTIVE ONLY — deviates** |
| D (FR935) | 29 | 29 | 0 | 29 | indistinguishable |

Same split on `lap.num_lengths`. **Derive counts by walking the length messages.**
If you rewrite the field, write it back in whichever convention the file already
used, rather than "correcting" it.

**③ The lap→length rule is a RANGE, not a count.**

```
lap[i] owns lengths [ lap[i].first_length_index , lap[i+1].first_length_index )
last lap owns       [ first_length_index , length_count )
```

Using `[first_length_index, first_length_index + num_lengths)` desynchronises at
the first idle length — it breaks **18 of 38 laps** in A. Garmin's own Cookbook
sidesteps indices entirely and associates by **time overlap**.

### 25.6 Records in pool swims — wildly device-dependent

There is **no** reliable "one record per length". Field population in A (3501
records): `timestamp` 100%, `distance` 2.5% (= 87, the length count), `speed`/
`cadence` 1.9% (= 68, the *active* length count), `heart_rate` 0%. So a Fenix 3
pool swim is ~3400 near-empty records plus 87 summary-bearing ones.

The unifying model across all four files: **the device flushes length messages,
and writes a record carrying the cumulative summary at each flush**; extra records
between flushes are padding.

Verified invariants in A and C:
- `distanceRecord[i].timestamp === length[i].timestamp` → 87/87 (A), 24/24 (C)
- `record.speed == length.avg_speed` → 68/68 · `record.cadence == length.avg_swimming_cadence` → 68/68
- `record.distance` steps by exactly `pool_length` on active, **0** on idle
  (unique steps across A: `{25, 0}`); final cumulative == `session.total_distance`

In **D (FR935)** the per-length correspondence breaks (`1/29`) — records sit at 6
flush points and distance jumps by however many lengths elapsed. But a derivation
still reproduces the file **exactly**, and is worth using as a self-check:

```
record.distance = pool_length × (active lengths ended at or before this timestamp)
record.speed    = avg_speed of the last completed length
record.cadence  = cadence of the last completed length
```

All three reproduce all 6 of D's records on every field. **Verify a derivation
against the untouched file before relying on it**; fall back to something
conservative if it doesn't reproduce.

**Heart rate.** Absent from records in A and D — Garmin state HR *"is not
transmitted to paired Garmin devices while the heart rate monitor is underwater."*
HRM-Tri/HRM-Swim straps store-and-forward into separate **`hr` messages (global
132)**, appended as a **chained FIT file** (B: 950 of them); merge with the SDK's
`HrToRecordMesgBroadcast` / `mergeHeartRates`. Newer optical devices (945,
Fenix 6) do put HR directly in lap-swim records.

### 25.7 Undocumented fields — including SWOLF

**SWOLF is not in the FIT Profile at all.** Searching every message returns zero
hits. Garmin write it anyway:

| Message | Field | Meaning (inferred) |
|---|---|---|
| session (18) | **80** | SWOLF |
| session (18) | **79** | avg stroke count × 10 |
| lap (19) | **73** | SWOLF |
| lap (19) | **90** | avg stroke count × 10 |

Confirmed absent from Profile 21.208.0 by direct query; the meanings are inferred
from one FR935 file and should be treated as such. Note D writes `79` but **not**
the documented `session.avg_stroke_count` (41).

SWOLF is trivially derivable — `avg length time (s) + avg strokes per length` —
which gives the safe way to use these: **compute the value from the file's own
untouched data, compare against what's stored, and only write back if it
reproduces.** In D that check passes for all four (session 80 = 66 = computed
SWOLF; session 79 = 187 = 18.7 × 10). Fabricate a file where it shouldn't hold and
the check correctly refuses.

Other undocumented messages seen in D: `global_22`, `79`, `104` (battery), `113`,
`125`, `140`, `141`, `147` (sensor). All ≤ 7 occurrences; device/settings
bookkeeping. `global_125` carries timestamps ~30 min after session end.

### 25.8 Missed and false turns

**Missed turn** — the watch doesn't register a turn, so two lengths are recorded
as one:

```
median active length: 46.1 s, ~18 strokes
length[14]:           93.4 s (2.03× median), 40 strokes (≈ 18+20)   ← missed turn
→ 29 lengths × 25 m = 725 m, when the swim was 30 lengths = 750 m
```

Signature: ~2× time **and ~2× strokes** — strokes are *summed*, not lost, which
makes stroke count an independent confirmation of a time-based flag. `length_type`
stays `active`; `message_index` stays contiguous (no gap marks the spot).

**False turn** — a phantom turn splits one length in two: ~½ time and ~½ strokes,
adjacent pair, same lap. Causes: stopping or turning mid-length, changing stroke.

Detect against a **rolling median of nearby lengths**, not a global one, so pace
drift over a long swim doesn't skew the baseline.

⚠️ **There is no sub-length data to place a turn from.** No stroke-level message
exists anywhere in the profile; D records 542 strokes in a file whose 29 `length`
and 6 `record` messages could not possibly hold them. The finest resolution FIT
holds is per-length aggregates. The only route to per-stroke data is a Connect IQ
**watch app** sampling the high-frequency accelerometer yourself (the standard
accelerometer is disabled during swim; the high-frequency one works).

### 25.9 What a correction must touch

Splitting or merging a length is not a local edit. The full write-set:

- `length` — insert/remove, and **renumber `message_index` on every later length**
- `lap` — `first_length_index` (35) **on every later lap** (the one people miss),
  `num_lengths` (32), `num_active_lengths` (40), `total_distance` (9),
  `total_cycles` (10), `total_calories` (11), `avg_speed` (13), `max_speed` (14),
  `avg_stroke_distance` (37)
- `session` — `num_lengths` (33), `num_active_lengths` (47), `total_distance` (9),
  `total_cycles` (10), `total_calories` (11), `avg_speed` (14), `max_speed` (15),
  `avg_stroke_distance` (42), `avg_stroke_count` (41)
- `record` — the cumulative distance step function, or records contradict lengths

Leave alone: `total_elapsed_time` / `total_timer_time` (the swim took as long as
it took), and `file_id` / `device_info` (so the file still reads as the same
watch — §22).

Useful cross-checks, all verified in D:
- `avg_speed = total_distance / total_timer_time` (725/1364.176 → 531 ✓)
- `max_speed = max(length.avg_speed)` (638 ✓)
- `avg_cadence = total_strokes / total_timer_time × 60` (24 ✓)
- `avg_stroke_distance = total_distance / total_strokes` (1.337 → 134 ✓)
- **`Σ length.total_calories == session.total_calories`** (175 ✓) — a cheap,
  high-signal way to confirm you have identified the right field

⚠️ Watch out for device data that is simply *wrong* on the anomalous length: in D
the missed-turn length recorded **3 kcal** while taking twice as long as its 6 kcal
neighbours. Splitting it forces a choice between preserving the recorded total and
re-estimating from the surrounding burn rate. Neither is "correct" — decide
deliberately and say which you did.

### 25.10 Rewriting the record stream

A reader's graph is only as good as the record stream, and some devices barely
write one (25.6). Rebuilding at **one record per length** matches C's shape
(`record.timestamp == length.timestamp`) and is the finest resolution the data
honestly supports. On D this turns 6 records into 30, every distance step exactly
25 m, and segment paces into a believable 2:40–3:20 instead of a 4:10 spike and a
2:10 tail.

Practicalities:
- Stamp each record at the length's **true end**; set `length.timestamp` to match,
  or lengths and records disagree about when the swim happened.
- Idle lengths → distance step **0**, `speed`/`cadence` = the base type's *invalid*
  sentinel (they are absent, not zero) — matching A's `{25, 0}` steps.
- Fields you can't derive per length (temperature, HR) — take from whichever
  original record sits nearest in time, so those curves survive.
- Inserting records next to lengths **will** strand them in front of the `record`
  definition (§21). Re-assert definitions over the finished stream.

### 25.11 Gating and rejection

Cookbook gate: `sport == Swimming && subSport == LapSwimming && lengths.Count > 0`.
Open water (`sub_sport 18`) has no lengths — nothing to correct; distance is GPS.

Garmin Connect itself **cannot** split/merge lengths — it edits only lap count and
total distance, re-deriving distance as `laps × pool_length`. *(Forum-sourced, not
Garmin-documented; reports conflict on whether Connect's edits rewrite the file or
are a display overlay.)*

---

*Distilled from implementing a from-scratch FIT encoder/decoder and validating it
against the Garmin FIT SDK. Verify specific field numbers and enum values against
the current FIT SDK Profile before relying on them.*

*§25 adds a pool-swim corrector: decoding a real FR935 swim, building corrections
and re-encoding, validated against the official SDK (`isFIT`, `checkIntegrity`,
zero decode errors) with a byte-identical `encode(decode(file))` round trip as the
baseline. Device-behaviour claims name the device they were observed on; anything
absent from the Profile is flagged as inferred.*
