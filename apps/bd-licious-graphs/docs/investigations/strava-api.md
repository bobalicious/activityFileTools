# Investigation — Strava API

> Verified against the official Strava developer docs (developers.strava.com) and
> the Strava Community Hub, **July 2026**. Uncertainties are flagged inline.
> Companion docs: [Project Overview](../project-overview.md) ·
> [Garmin API Investigation](garmin-api.md)

> **⚠ Decision update (superseding this doc's recommendation):** we are **not
> using the Strava API** for the build. The API now requires a paid Standard-tier
> subscription (2026), which is off the table for this personal project. Instead we
> read from a downloaded **`.FIT` file** ("Export Original") — richer data, no auth,
> no subscription. This doc is retained as reference in case the API is ever added
> later. See [Architecture](../architecture.md) and the overview's
> [§4a](../project-overview.md#4a-findings-so-far-from-the-investigations).

## TL;DR — the one finding that shapes the whole project

**Reading everything we need is fully supported. Uploading the finished graph as a
photo to an activity is NOT supported for standard ("vanilla") API developers.**

- Auth, activity listing/selection, per-lap pace/cadence/HR, and time-series
  streams for smoothed-HR and rest detection are all **fully available** with
  `activity:read_all`.
- There is **no public endpoint to attach a photo/image to an activity.** Media
  upload exists only as a **restricted endpoint for approved partners** (Zwift,
  Peloton, Rouvy, TrainerRoad, …), and Strava does not publish how to get access.
  Confirmed by an official Strava staff answer dated **2026-04-04**.
- The documented `/uploads` endpoint uploads **activity data files (GPX/TCX/FIT)**
  to *create activities* — it does **not** accept images.

**Implication:** we can build the entire read-and-render pipeline on the public
API, but the "upload the graph back onto the Strava activity" goal needs a
redesign. See [§5](#5-uploading-media--photos--the-blocker) for options.

---

## 1. Authentication & app registration

**OAuth 2.0 Authorization Code grant.**

1. Register an app in Strava's API settings → get **Client ID** + **Client Secret**
   (secret stays server-side).
2. **Authorize:** redirect user to `GET https://www.strava.com/oauth/authorize`
   with `client_id`, `redirect_uri`, `response_type=code`, and comma-separated
   `scope`.
3. **Token exchange:** `POST https://www.strava.com/oauth/token` with `client_id`,
   `client_secret`, `code`, `grant_type=authorization_code` → returns
   **access token**, **refresh token**, **expires_at**.
4. **Call the API** with `Authorization: Bearer {access_token}`.
5. **Refresh:** access tokens **expire after 6 hours**. Refresh via
   `POST /oauth/token` with `grant_type=refresh_token`. The refresh token can
   rotate — always persist whatever comes back.

### Scopes

| Scope | Grants |
|---|---|
| `read` | public segments, routes, profile, posts, events |
| `read_all` | private routes, segments, events |
| `activity:read` | activities visible to Everyone/Followers |
| `activity:read_all` | **all** activities incl. privacy-zone + "Only You" |
| `activity:write` | create manual activities & uploads, edit any activity |
| `profile:read_all` / `profile:write` | full profile / weight, FTP, star segments |

**What we need:** `activity:read_all` (to read the user's runs, laps, and streams
including private ones). **Note:** there is *no* scope that grants photo upload;
`activity:write` covers activity *files* and edits, not images.

Source: https://developers.strava.com/docs/authentication/

## 2. Retrieving & selecting activities

- **List:** `GET /athlete/activities` — params `before`, `after` (epoch), `page`,
  `per_page` (default 30). **Offset pagination** — increment `page` until empty.
  Returns `SummaryActivity` objects (`id`, `name`, `sport_type`, `distance`,
  `moving_time`, `elapsed_time`, `start_date_local`, `average_speed`,
  `average_cadence`, `has_heartrate`, `average_heartrate`, `external_id`,
  `upload_id`, …). Does **not** include `description`, `laps`, `splits`, `photos`.
- **Detail:** `GET /activities/{id}` (opt. `include_all_efforts`) → full
  `DetailedActivity` incl. `description`, `laps`, `splits_metric`,
  `splits_standard`, `photos` (summary), `device_name`.

**Selection flow:** list activities → filter `sport_type == "Run"` by date → user
picks by `id`/`name`/`start_date_local` → fetch laps + streams by `id`.

Source: https://developers.strava.com/docs/reference/ (Activities)

## 3. Laps — the core data for the per-lap pace graph ✅

Endpoint: **`GET /activities/{id}/laps`** — fully supported.

Documented `Lap` fields: `id`, `name`, `elapsed_time`, `moving_time`,
`start_date`, `start_date_local`, `distance`, `start_index`, `end_index`,
`total_elevation_gain`, `average_speed`, `max_speed`, `average_cadence`,
`average_watts`, `device_watts`, `lap_index`, `pace_zone`, `split`.

Everything the pace graph needs is here:
- **Pace** from `average_speed` (m/s), or `distance / moving_time` (or
  `/ elapsed_time`).
- **Bar width** from `elapsed_time` (or `moving_time`).
- `average_cadence`, `lap_index`, and `start_index`/`end_index` (which map each
  lap onto the stream arrays — see §4 — so we can slice streams per lap).

**⚠ Per-lap heart rate — documented-vs-actual mismatch.** `average_heartrate` /
`max_heartrate` are **not** in the official `Lap` schema, but the **live API does
return them on lap objects when HR data exists**. Read them defensively (may be
absent) and, for a guaranteed value, compute per-lap HR ourselves by slicing the
`heartrate` stream with `start_index`/`end_index`. That also gives us full control
over the smoothing.

**Rest-lap detection:** a lap with near-zero `distance`/`average_speed`, or
`moving_time` ≪ `elapsed_time`, indicates rest/recovery. Corroborate with the
`moving` stream (§4).

Source: https://developers.strava.com/docs/reference/ (getLapsById)

## 4. Streams (time-series) ✅

Endpoint: **`GET /activities/{id}/streams`**

Params: `keys` (comma-separated, required); `key_by_type=true` (recommended — keys
result by type); `resolution` (`low`/`medium`/`high`/`all` — **deprecated but
functional**); `series_type` (`time`/`distance`).

**Use full resolution (`all`, the default) so lap `start_index`/`end_index` align
1:1 with the stream arrays.**

Valid keys: `time`, `distance`, `latlng`, `altitude`, `velocity_smooth`,
`heartrate`, `cadence`, `watts`, `temp`, `moving`, `grade_smooth`.

For our use cases:
- **Smoothed HR graph:** request `heartrate` (+ `time`/`distance`). HR is raw — we
  apply our own smoothing (`velocity_smooth`/`grade_smooth` are pre-smoothed by
  Strava, but there is no smoothed-HR stream).
- **Rest detection:** `moving` (bool/sample) and/or `velocity_smooth` (m/s),
  combined with lap indices.

**⚠ Stride length is NOT available as a stream or field anywhere in the API.** It
must be **derived**:

```
stride_length (m) = velocity_smooth (m/s) / (steps_per_second)
steps_per_second  = (cadence × 2) / 60
```

Strava's running `cadence` (stream *and* `average_cadence`) is reported **per leg**
(~85–95 rpm), i.e. one foot — **multiply by 2 for total steps/min**. Validate the
×2 against a known activity; it's a frequent source of error.

Source: https://developers.strava.com/docs/reference/ (getActivityStreams)

## 5. Uploading media / photos — the blocker 🚫

**Photo/image upload to an activity is not available to standard developers.**

- Official Strava staff answer (**2026-04-04**): *"Uploading media is not available
  to vanilla developers. You could insert links to images in the activity
  description."* Restricted photo endpoints exist for partner integrations, but
  staff stated they *"do not know how to get access to the restricted API
  endpoints."*
- There is **no public `POST /activities/{id}/photos`** (or equivalent). This is
  long-standing and still true in 2026.

**`/uploads` is a different thing** — it uploads an **activity data file** to
*create a new activity*: `POST /uploads` with `file` (multipart), `data_type`
(`fit`/`fit.gz`/`tcx`/`tcx.gz`/`gpx`/`gpx.gz`), optional `name`, `description`,
`sport_type`, `external_id`. Returns an `Upload` status object; poll
`GET /uploads/{uploadId}` until `activity_id` is populated. Requires
`activity:write`. **It cannot attach an image to an existing activity.**

### Chosen approach (personal project)

1. **Primary — deliver the image from our own app.** Produce the graph as a
   first-class downloadable/shareable output; add it to Strava with a one-off
   manual drag-and-drop. Fully sanctioned, robust, zero API dependency. **This is
   the goal that matters.**
2. **Maybe-someday — Playwright auto-upload.** Strava's **web** activity-edit page
   *does* let you add photos to an existing activity, so a browser-automation step
   can drop the image on the activity. Key design point: **don't script the login**
   (Cloudflare / CAPTCHA / 2FA / social-login make that fragile) — log in once
   manually in a Playwright browser and persist the session via `storageState`,
   then reuse it. **Own account only.** It's unofficial and against Strava's ToS at
   scale (the 2024+ crackdown targets exactly this — see §7), but defensible as
   automating your own manual actions on your own data. Nice-to-have; may never be
   built.

Other options considered and **dropped**: hosting the image and putting a *link*
in the activity `description` (`PUT /activities/{id}`) — renders as a link, not a
photo, so not worth it; and applying for Strava **partner/restricted** media
access — undocumented and aimed at hardware/platform partners, a non-starter for a
hobby project.

Sources:
https://communityhub.strava.com/developers-api-7/how-to-upload-a-photo-to-an-activity-13044 ·
https://developers.strava.com/docs/uploads/

## 6. Rate limits (2026)

- **Overall: 200 req / 15 min, 2,000 / day.**
- **Read (non-upload): 100 req / 15 min, 1,000 / day.** Our read-heavy flow (list
  → laps → streams) counts here.

Response headers carry two comma-separated values (15-min, then daily):
`X-RateLimit-Limit`/`X-RateLimit-Usage` (overall),
`X-ReadRateLimit-Limit`/`X-ReadRateLimit-Usage` (read). Over-limit → **HTTP 429**;
respect the headers and back off.

Source: https://developers.strava.com/docs/rate-limits/

## 7. 2024–2026 API terms changes (read before building) ⚠

Strava tightened its API terms significantly (data-scraping/AI concerns; it filed
confidentially for IPO in early Jan 2026). Verify the live agreement before launch:

- **Nov 2024 agreement update:** third-party apps may display a user's Strava data
  **only to that same user** (no cross-user leaderboards/coach dashboards). **Using
  Strava API data to train/feed AI/ML models is explicitly prohibited.** Added
  protections for Strava's "look, feel, and functionality."
- **Paid Standard tier (2026):** a Strava subscription is now required for
  Standard-tier API developers — **new** devs from **2026-06-01**, **existing**
  devs from **2026-06-30**; ~**$11.99/month** (region-varying). Confirm current
  price/requirement for your account — recent and evolving.

**For this app:** showing the authenticated user their *own* run's graph is within
terms. Do **not** aggregate/expose other users' data or feed Strava data into any
AI/ML pipeline.

Sources: https://developers.strava.com/docs/rate-limits/ ·
https://communityhub.strava.com/developers-api-7/new-strava-api-update-what-the-message-means-13433

## 8. Practical gotchas

- **1-athlete cap until approved.** A new app can only pull data for the **owning
  athlete** (you) plus a few test users until you request higher access. Build/test
  against your own account first.
- **Branding/attribution.** Display **"Powered by Strava"**, use the official
  **"Connect with Strava"** OAuth button, don't restyle Strava marks, link shown
  activities back to Strava.
- **Cadence ×2** for stride length (per-leg → steps/min).
- **Lap HR** is present-but-undocumented; fall back to slicing the HR stream.
- **Token lifecycle:** 6-hour access tokens; persist the (rotating) refresh token.
- **Full-resolution streams** so lap indices line up with stream arrays.

## 9. Feasibility verdict

| Capability | Status |
|---|---|
| OAuth, activity selection | ✅ Fully supported |
| Per-lap pace / cadence / HR | ✅ Supported (HR via lap field or stream slice) |
| Stream-based smoothed HR + rest detection | ✅ Supported |
| Stride length | ⚠ Derivable (cadence×2 + speed), not native |
| Render interval bar graph | ✅ All data available |
| **Upload graph as photo to activity** | 🚫 **Not possible via public API** |

Strava is the **simplest source to read from** and covers all our *data* needs.
The only gap is the media-upload step, which we design around (§5).
