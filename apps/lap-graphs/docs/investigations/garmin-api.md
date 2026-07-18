# Investigation — Garmin API

> Verified against Garmin's developer portal (developer.garmin.com) and community
> sources, **July 2026**. Uncertainties flagged inline.
> Companion docs: [Project Overview](../project-overview.md) ·
> [Strava API Investigation](strava-api.md)

## TL;DR — feasibility verdict

**For a hobby / individual project, Garmin is the hard path.** Garmin's official
APIs (Health, Activity, Training) are a **gated, business-only B2B partner
program** — not self-serve like Strava. You must apply as a company with a
commercial use case and be approved. Worse, **as of 2025–2026 the program appears
paused / "under construction," with the access-request form removed** (multiple
Garmin forum threads confirm; no official reopen date found — *uncertain but
strongly indicated*).

Realistic hobbyist routes if you need Garmin data anyway:
1. **Unofficial Python libs** that log in with your own Garmin Connect credentials
   (ToS-gray, single-user, fragile, unsupported).
2. **Manual `.fit` export + local parse** with the official FIT SDK (fully
   sanctioned for your own data; the only route that gives **native per-lap step
   length** without a partnership).

The data is all *there* and rich — the barrier is **access**, not capability.

---

## 1. Programs & the access model

Garmin's modern offering is the **Garmin Connect Developer Program**:

| API | What it gives | Relevant? |
|---|---|---|
| **Health API** | All-day wellness: steps, HR, sleep, stress, respiration, body comp | Partial (daily HR, not per-lap) |
| **Activity API** | **Per-activity detail: summaries, time-series samples, laps, downloadable .FIT/.TCX/.GPX** | ✅ **This is the one we'd need** |
| Training API | Push workouts *to* devices | No (write) |
| Women's Health / Courses | Cycle tracking / navigation courses | No |

The legacy **"Garmin Connect API"** name is the older branding now split into
Health/Activity/Training; the wellness REST endpoints (`/wellness-api/rest/...`)
carry that lineage.

**Access is NOT self-serve.** Per Garmin's Program FAQ the program is *"only for
business use"*; applications are reviewed (status confirmed within ~2 business
days). You submit a form describing company, app, use case, and data-handling.
**No upfront fees**, but *"access to some metrics may require a license fee or
minimum device order quantity for commercial use."* Approval grants an evaluation
environment first, then production.

**⚠ Current status:** 2025–2026 forum threads report the **access-request form
removed and the program on hold with no ETA**; program pages now say "Stay tuned."
No official dated statement found. **Treat new hobbyist access as effectively
unavailable right now.**

Sources: https://developer.garmin.com/gc-developer-program/ ·
https://developer.garmin.com/gc-developer-program/activity-api/ ·
https://developer.garmin.com/gc-developer-program/program-faq/

## 2. Authentication

- Developer Program APIs use **OAuth 2.0 (Authorization Code + PKCE)**. Access
  tokens **expire ~3 months**, then refresh.
- Legacy **OAuth 1.0a** (consumer key/secret, HMAC-signed) is **retiring
  2026-12-31**; existing partners migrate via a token-exchange endpoint.
- Users grant consent on Garmin's OAuth page, then must **sync their device to
  Garmin Connect** before data is available.

Source: https://developerportal.garmin.com/sites/default/files/OAuth2PKCE_1.pdf

## 3. Activity data detail — rich, covers everything we need

The Activity API exposes (field names mirrored via a third-party consumer of the
same schema):

- **Summary:** `ActivityId`, `DeviceName`, `ActivityType`, `StartTimeInSeconds`,
  `DurationInSeconds`, `DistanceInMeters`, HR (`Average/MaxHeartRateInBeatsPerMinute`),
  pace/speed (`Average/MaxSpeedInMetersPerSecond`,
  `Average/MaxPaceInMinutesPerKilometer`), cadence
  (`AverageRunCadenceInStepsPerMinute`), etc.
- **Per-sample time-series (`samples[]`):** `HeartRate`, `SpeedMetersPerSecond`,
  `StepsPerMinute` (run cadence), `PowerInWatts`, `TotalDistanceInMeters`,
  `ElevationInMeters`, lat/lng, `TimerDurationInSeconds`. → gives the **smoothed HR
  series and per-sample cadence/pace**.
- **Laps/splits:** Yes — Activity Details include lap records. For richest per-lap
  aggregates (avg pace/HR/cadence per lap), the **`.FIT`/`.TCX` files** are the
  authoritative source (TCX divides the track into device-recorded laps with
  per-lap summaries).
- **⚠ Stride/step length:** **no direct `strideLength` field in the JSON samples.**
  Derive it (`speed ÷ (cadence/60)`), OR read it from the **`.FIT` file**, where
  Garmin records `step_length` (mm) natively. *Verify against a live payload if you
  ever get access.*
- **File download:** original activity file in **.FIT / .GPX / .TCX** — but only in
  response to a Ping, via a **callback URL valid 24 h** that rejects duplicate
  downloads (HTTP 410). Fetch-and-store on notification.

Source (schema mirror):
https://support.mydatahelps.org/hc/en-us/articles/15011091032979-Garmin-Activity-Details-Summary-Export-Format

## 4. Push vs pull

Garmin is **primarily push/webhook-based**, not on-demand query:

- **Push** (Garmin POSTs data to your webhook on user sync) or **Ping** (Garmin
  notifies, you pull) — either way **event-driven off device syncs**.
- You **cannot** freely query "give me activity 12345 now."
- **Historical data = Backfill:** `GET /wellness-api/rest/backfill/activities` with
  a start/end range. Returns `202` immediately then **asynchronously pushes** the
  history to your webhook. **Max 90-day range per request**; Activity Details
  backfill is **push-service only**.

**Implication:** you'd architect a **webhook receiver + your own datastore**, not a
synchronous "fetch on page load." This is a heavier model than Strava's REST pull.

Source: https://developerportal.garmin.com/blog/activity-details-backfill-available-push-service-only-0

## 5. Correlating a Garmin activity with the Strava activity

No official shared cross-service ID. Strategies (if reading from Garmin but
uploading/annotating on Strava):

1. **Strava `external_id`** — Strava activities from Garmin often carry an
   `external_id` derived from the source filename (e.g. `"<id>-activity.fit"`), but
   it's **inconsistent** across sources and sometimes empty. Opportunistic only.
2. **Start-time + duration + distance matching** — the robust fallback: match by
   **start time (±~20 s)**, corroborate with duration/distance (with tolerance —
   platforms smooth/round differently). **Use this as the primary join key.**
3. **`device_name`** — confirms the activity came from a Garmin device.

Source: https://communityhub.strava.com/developers-api-7/how-to-associate-a-strava-activity-to-device-record-3103

## 6. Unofficial / alternative routes (hobbyist)

Since the official program is gated and currently paused:

- **`python-garminconnect`** (cyberjunky) — active; logs into Garmin Connect with
  **your own credentials** (the mobile-app SSO flow). Gives activities, splits,
  health metrics, history, and `.fit`/`.tcx`/`.gpx` downloads.
- **`garth`** (the SSO/auth layer many wrappers use) — README now marks it
  **DEPRECATED**; `garmy` is a newer alternative.
- **`garminexport`** — bulk-export your own activities incl. `.fit`.

**Tradeoffs:** single-user, use-your-own-login, **not sanctioned**, likely conflict
with Garmin Connect ToS, **no support**, and **fragile** (break whenever Garmin
changes SSO/Cloudflare — the community history shows repeated breakage). Fine for a
**personal single-user tool**; **not viable for a multi-user product.**

- **FIT-file parsing (most robust hobbyist path):** manually export the `.FIT` from
  Garmin Connect and parse locally with the **official FIT SDK**. The FIT file has
  **everything the device recorded** — per-record samples (HR, cadence, speed,
  `step_length`) and **`lap` messages with per-lap aggregates**. The only route
  that natively gives **per-lap stride length** without a partnership, and fully
  sanctioned for your own data. Downside: **manual, no automation/webhooks.**

Sources: https://github.com/cyberjunky/python-garminconnect ·
https://developer.garmin.com/fit/cookbook/decoding-activity-files/

## 7. Garmin vs Strava — the decision

| Factor | Garmin (official) | Strava (official) |
|---|---|---|
| Access | Business-only, gated, **currently paused** | **Self-serve, instant** |
| Auth | OAuth 2.0 PKCE (OAuth1 retiring 2026-12-31) | OAuth 2.0, immediate |
| Model | Push/webhook + async backfill | On-demand REST pull |
| Laps | Yes (API + FIT/TCX) | Yes — `/activities/{id}/laps` |
| Streams (HR/cadence/speed) | Yes (samples) | Yes — `/activities/{id}/streams` |
| Stride length | Derived, or **native in FIT** | Derived only |
| Hobbyist feasibility | **Very low right now** | **High** |

## 8. Recommendation

- **Build on Strava** for anything multi-user or shareable — instant self-serve
  access, OAuth 2.0, direct laps + streams endpoints. (Its constraints are rate
  limits and the 2024+ data-sharing terms, plus the photo-upload gap — see the
  [Strava doc](strava-api.md).)
- **Keep Garmin as a personal-use fallback** via unofficial libs or manual FIT
  export + FIT SDK, specifically when you need **raw device fields Strava smooths
  away** (e.g. native `step_length`).
- **Revisit the official Garmin Activity API only if/when the Developer Program
  reopens** to applications.

### Uncertainties flagged
- Exact reopen status of the Garmin Developer Program (strongly indicated paused;
  no official dated statement found).
- Whether `step_length` is ever a first-class Activity API *sample* field vs
  FIT-only — verify against a live payload.
- The FIT SDK path is the concrete, sanctioned way to prove out the data model
  today without any Garmin approval.
