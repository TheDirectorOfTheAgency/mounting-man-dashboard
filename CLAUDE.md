# Mounting Man Dashboard

## Identity
- Tactical Business Intelligence Dashboard for The Mounting Man (TV mounting service), plus the back-office automation that grew around it
- Owner: The Agency (theagency)
- Status: Active, production
- Live: https://mounting-man-dashboard.vercel.app
- Design: Spy/HUD aesthetic — dark backgrounds (#0a0a0a), neon green (#c8e632), Orbitron for headings/numbers, IBM Plex Mono for body, scan lines + noise overlays

> **This repo is no longer "a dashboard."** The dashboard is roughly 10% of the code.
> The rest is webhook plumbing: Square, ZenBooker, Google Ads offline conversions,
> and a cloud installation-post publisher. Read "Subsystems" before changing anything.

---

## ⚠️ Security debt — read first

`CLAUDE.md` and `GOOGLE_ADS_AUDIT_2026-02-21.md` previously committed the **live Google Ads
developer token in plaintext**. The value has been removed from this file, but **it is still
in git history** and history has not been rewritten.

- [ ] **Rotate the Google Ads developer token** (Google Ads → Admin → API Center → Reset token). Rotating is the only real fix; a reset also re-pairs the token to the calling GCP project, which is a known good outcome here (see "Google Ads debugging notes").
- [ ] Purge or rotate any other credential in `GOOGLE_ADS_AUDIT_2026-02-21.md`.
- **Never put a token value in a tracked file.** Names of env vars only.

---

## Architecture

- **Next.js 14, Pages Router** (NOT App Router). React 18. No TypeScript.
- **Two halves:**
  1. **Read path** — `pages/index.js` → `components/Dashboard.js`, which polls five `/api/*` routes on an interval. Client never talks to Square/Webflow/Google directly.
  2. **Write path** — inbound webhooks and crons that reconcile Square, ZenBooker, Google Ads and Webflow. Most of the repo's logic and *all* of its tests live here.
- **Storage:** Upstash Redis via `@vercel/kv` (`KV_REST_API_*`). No SQL database. A *second, separate* Redis (`AGENCY_REDIS_*`) backs the agency telemetry/Siri-queue routes.
- **Auth:** none on the dashboard itself. Webhook and operator routes use per-route shared secrets or signed capabilities.
- **Tests:** 33 files, ~300 assertions, `node --test` via `tsx`. Pure-function and handler-factory style — every handler exports a `createXHandler({ deps })` factory so tests inject fakes. **Follow that pattern for new routes.**
- **CI:** there is **no PR CI**. The only workflow is `workflow_dispatch`-only. Local `npm test` + `npm run build` are the gate.

### Conventions that actually hold
- Handlers export a factory (`createZenbookerWebhookHandler`, `createBookingAttributionHandler`, `createGclidReceiverHandler`) plus a default instance. Tests use the factory.
- **Webhook routes return 200 for everything after auth passes.** ZenBooker disables a subscription after four non-2xx replies. Only method / bad secret / unconfigured secret return non-2xx. Do not "fix" this by returning 503.
- Money crosses the API boundary in **dollars**; Square gives **cents**.
- Customer identifiers are never logged raw — hash to an opaque ref via `opaqueRef()` and log 12 chars.
- CSS classes use the `hud-*` prefix (`tailwind.config.js` + `styles/globals.css`).

---

## Subsystems

### 1. Dashboard (read path)
`components/Dashboard.js` (~666 lines, still monolithic) polls:
`/api/square-revenue`, `/api/webflow-posts`, `/api/google-ads`, `/api/telemetry`, `/api/thread-feed`.

Sub-components inside that one file: `HudGauge`, `StatusDot`, `DataRow`, `TrackingBar`, `NodeBlock`.

### 2. Offline conversions (ZenBooker → Google Ads)
**Why:** Samsung Frame, MantelMount and stone/tile customers phone Marshall, who books for them. Those jobs are invisible to Google Ads because the GTM tag only fires on self-booked `/thank-you` visits.

**Chain:** `job.completed` webhook → `extractJobCandidate()` → `evaluateJob()` eligibility gate → coordinator matches the job to a *trusted* Square payment → `uploadOfflineConversion()` (Enhanced Conversions for Leads: SHA-256 hashed PII + `orderId`).

- `OFFLINE_CONVERSION_MODE`: `observe` | `validate` | `one_shot` | `continuous` (`active` aliases `continuous`). **Defaults to `observe`** — nothing uploads unless it is set.
- Consent is enforced: a `DENIED` status blocks upload, and consent captured before `PRIVACY_DISCLOSURE_VERSION`'s date is downgraded to `UNKNOWN`.
- Dedup and claims live in KV: `conv:success:*`, `conv:claim:*`, `attrib:*`.
- WRITE calls to Google Ads **omit** `login-customer-id`; READ calls **include** it. See "Google Ads debugging notes".

**Attribution capture is deliberately lossy.** `normalizeAcquisition()` records *that* a click id existed (`hasGclid`, `paidMarker`) and discards the value. Enhanced Conversions for Leads needs no GCLID, so this is fine — but it means click-based upload is impossible from that data.

`/api/attribution/gclid` is the one exception: it retains the **raw** click identifier under `attrib:click:*` (90-day TTL). It is **capture-only** — no upload, nothing reads those keys yet, and ZenBooker is not pointed at it.

### 3. ZenBooker → Square invoicing
`pages/api/webhooks/zenbooker-to-square.js` (~1700 lines, the largest file here). Finds or creates the Square customer, builds full-priced invoice lines from `services[].pricing_summary`, creates an order applying processing-fee tax to every line and sales tax only to hardware lines, then creates a **draft** invoice. It does not publish or auto-send. `ZENBOOKER_SQUARE_INVOICE_DRY_RUN` short-circuits the write.

### 4. Installation-post queue (cloud publisher)
Square payment webhook stages an immutable seed → operator gets a phone card at `/install-posts/open#<capability>` → photo upload binds to one exact `(seed, photo)` revision → an explicit **Publish** tap dispatches the GitHub Actions runner (`cloud/install-post-runner/`), which holds the Webflow token and publishes + verifies.

States: `AWAITING_PHOTO → READY → PUBLISHING → VERIFYING → PUBLISHED`, plus `RETRYABLE_FAILURE`, `BLOCKED`, `INDETERMINATE`. Only **Reconcile** exits `INDETERMINATE`. Stale after 15 min.

**⚠️ Legacy dual path:** `scripts/codex-install-post-relay.mjs` + its launchd plist poll the same pending endpoint from an M1. The cloud queue replaced it, but the plan's retirement step is **unchecked** and the agent may still be loaded. Check `launchctl list | grep codex-install-post-relay` on the M1.

### 5. Agency-side routes (not Mounting Man)
`/api/telemetry`, `/api/thread-feed` (Discord), `/api/vault/write` (commits notes to `the-agency-vault`), `/api/shortcuts/tell-q` (Siri → Redis queue → Telegram receipt), `/pages/obsidian.js`.

---

## File map

```
CLAUDE.md                                  # This file
pages/api/CLAUDE.md                        # STALE — describes only the 3 original proxies

# Dashboard read path
pages/index.js                             # Entry, renders <Dashboard />
components/Dashboard.js                    # 666 lines, monolithic, all dashboard UI
pages/api/square-revenue.js                # Square Payments proxy → revenue + 7-day history
pages/api/webflow-posts.js                 # Webflow Collections proxy → post counts
pages/api/google-ads.js                    # Google Ads REST (v20), 15-min cache, hardcoded fallback
pages/api/telemetry.js                     # Agency Redis: agent status / priorities
pages/api/thread-feed.js                   # Discord message feed for The Agency guild

# Offline conversions / attribution
lib/google-ads-auth.js                     # Shared OAuth2 refresh
lib/google-ads-conversions.js              # uploadClickConversions (API v24), retry classification
lib/hash-pii.js                            # Normalize + SHA-256 for Enhanced Conversions
lib/offline-conversion-eligibility.js      # Payload extraction, consent, paid-evidence gates
lib/offline-conversion-coordinator.js      # Job↔payment matching, claims, modes
lib/offline-conversion-store.js            # All KV keys for attribution + conversions
pages/api/webhooks/zenbooker.js            # job.completed → eligibility → coordinator
pages/api/attribution/booking.js           # Browser capture (CORS). Booleans only, no raw ids
pages/api/attribution/gclid.js             # Raw GCLID receiver. Capture-only, not wired
public/tmm-attribution-v1.js               # Browser helper on themountingman.com

# ZenBooker → Square
pages/api/webhooks/zenbooker-to-square.js  # Customer + order + DRAFT invoice
lib/zenbooker-square-mapper.mjs            # Service → catalog mapping
lib/zenbooker-square-invoice.mjs           # Invoice line construction

# Installation-post queue
pages/api/webhooks/square-payment.js       # Payment → review SMS + seed staging + Discord
pages/api/install-post/{session,mobile,pending,upload,publish}.js
pages/api/install-post/runner/{envelope,callback}.js
pages/install-posts/open.js                # Operator phone card
lib/install-post-{queue,store,seeds,states,session,dispatch,photo-client}.mjs
cloud/install-post-runner/                 # Python runner executed by GitHub Actions
.github/workflows/publish-install-post.yml # workflow_dispatch ONLY

# Crons (see vercel.json)
pages/api/cron/square-install-post-seed.js # Seeds install posts from paid Square jobs
pages/api/cron/square-refresh.js           # Warms the Square revenue cache
pages/api/cron/jobs-snapshot.js            # Weekly lat/lng snapshot for /api/jobs-near

# Public / misc
pages/near-you.js, pages/api/jobs-near.js  # "Jobs near you" by zip
pages/accent-wall-visualizer.js, pages/api/gemini.js
pages/privacy.js, pages/terms.js           # Required for the consent/disclosure chain
pages/api/health.js                        # Commit SHA, env, conversion mode
pages/api/qbo-callback.js                  # ⚠️ Self-labelled "temporary", still deployed
```

---

## Commands

```bash
npm run dev            # Local dev at http://localhost:3000
npm run build          # Production build
npm test               # Full suite (node --test via tsx) — ~300 assertions
npm run lint           # ESLint

npm run test:zenbooker-square              # Focused mapper/invoice tests
npm run check:zenbooker-square-catalog     # Verify Square catalog matches the mapper
npm run audit:offline-conversion-candidates
npm run backfill:attribution-job-maps
npm run replay:offline-conversions
```

Always run `npm test` **and** `npm run build` before pushing. There is no CI to catch you.

---

## Scheduled work

| Trigger | Target | Cadence |
|---|---|---|
| Vercel cron | `/api/cron/square-install-post-seed` | `* 14-23,0 * * *` |
| Vercel cron | `/api/cron/square-refresh` | `0 15,17,19,21,23,1 * * *` |
| Vercel cron | `/api/cron/jobs-snapshot` | `0 8 * * 0` (Sun 2 AM CT) |
| GitHub Actions | `publish-install-post.yml` | dispatch only — never on push |
| launchd (M1) | `ai.theagency.codex-install-post-relay` | every 90s **if still loaded** — legacy |

---

## Environment variables

All production values live in **Vercel project settings**. Local dev uses `.env.local` (gitignored).
`.env.example` is the template. **Names only below — never commit a value.**

**Square** — `NEXT_PUBLIC_SQUARE_ACCESS_TOKEN`, `NEXT_PUBLIC_SQUARE_LOCATION_ID` (`LVNM3Z4RVRWDK`), `SQUARE_WEBHOOK_SIGNATURE_KEY`
**Webflow** — `NEXT_PUBLIC_WEBFLOW_TOKEN`, `NEXT_PUBLIC_WEBFLOW_SITE_ID`, `NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID`
**Google Ads** — `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION`, `GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID`
**Conversions** — `OFFLINE_CONVERSION_MODE`, `PRIVACY_DISCLOSURE_VERSION`
**ZenBooker** — `ZENBOOKER_WEBHOOK_SECRET`, `ZENBOOKER_GCLID_SECRET`, `ZENBOOKER_CONSENT_FIELD_LABEL`, `ZENBOOKER_API_KEY`, `ZENBOOKER_BASE_URL`, `ZENBOOKER_SQUARE_INVOICE_DRY_RUN`
**Install-post** — `INSTALL_POST_ACCESS_SECRET`, `INSTALL_POST_RUNNER_SECRET`, `INSTALL_POST_BASE_URL`, `INSTALL_POST_DISPATCH_{TOKEN,OWNER,REPO,WORKFLOW,REF}`
**Storage** — `KV_REST_API_URL`, `KV_REST_API_TOKEN` (auto-set by Vercel); `AGENCY_REDIS_URL`, `AGENCY_REDIS_TOKEN` (separate agency Redis)
**Notifications** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `DISCORD_BOT_TOKEN`, `DISCORD_Q_BOT_TOKEN`, `DISCORD_Q_USER_ID`, `TELEGRAM_BOT_TOKEN`
**Misc** — `CRON_SECRET`, `VAULT_GITHUB_TOKEN`, `VAULT_WRITE_SECRET`, `TELL_Q_SECRET`, `GOOGLE_GEMINI_API_KEY`, `DEPLOYMENT_COMMIT_SHA`, `NEXT_PUBLIC_DASHBOARD_REFRESH_INTERVAL`

**Note:** `NEXT_PUBLIC_*` on the Square/Webflow tokens is legacy and wrong — they are only used server-side, but the prefix ships them to the browser bundle. Migrating them is on the roadmap.

---

## Google Ads

### Accounts
- **The Mounting Man** (advertiser): `128-790-7452` — owned by mntvmounting@gmail.com
- **The Agency MCC #1**: `316-742-8631` — marshallwayneemail@gmail.com — **has** the developer token
- **The Agency MCC #2**: `601-738-6949` — no developer token
- Cancelled: `931-361-6976` (ignore)

### Debugging notes (2026-02-20 → resolved 2026-02-21)
These cost two days. Do not re-derive them.

1. **`marshallwayneemail@gmail.com` tokens always return `DEVELOPER_TOKEN_INVALID`**, regardless of OAuth client, dev token, or login-customer-id. Never use them for API access.
2. **Use `mntvmounting@gmail.com` tokens.** They work.
3. For **READ**, `login-customer-id` must be `3167428631` (the MCC owning the dev token). Omitting it or using the advertiser id causes `DEVELOPER_TOKEN_INVALID`.
4. For **WRITE**, **omit `login-customer-id`** — mntvmounting is the direct owner of the advertiser account, so the request carries full write access. An MCC Standard/Admin upgrade is not needed.
5. **Root cause of the original failure:** a developer token is *permanently paired* to the first Google API Console project that uses it. The old token was paired to a different project than the OAuth client in use, so it could never work.
6. **Fix:** reset the developer token in Admin → API Center. Resetting re-pairs it to the calling project and works immediately.

### DO NOT USE ZAPIER
There is a Zapier MCP connector for Google Ads — **do not use it.** It only exposes pre-built actions, cannot create or modify ads/ad groups/keywords/bids/conversion actions, silently overrides parameters like date ranges, and adds latency. Use the REST API directly.

### Conversion actions
- **Booked Appointment** (`6491204814`) — GTM on `/thank-you`. Working.
- **Landing Page Phone Calls – DM** (`1065481863`) — Google forwarding numbers.
- **Phone Call from Ad Extension** (`7509075265`) — `AD_CALL`, auto-tracked.
- **Website Click-to-Call** (`7509024467`) — `send_to: AW-506833748/CvjaCNO9yvwbENTW1vEB`. **Still needs its GTM tag.**
- **Offline Job Completed** (`7509313857`) — `UPLOAD_CLICKS` / `PURCHASE`, `primaryForGoal: false`.
- Disabled duplicates: `7509075268`, `7509075271`.

---

## Business constants (hardcoded, not from any API)
- Targets: **$32,000/mo** revenue, **20 jobs/mo**
- Geographic split: Minneapolis 81%, Houston 12%, Austin 7%
- `"Social Ready: 3"` in `Dashboard.js`
- `allTimeSpend: 350000` in `google-ads.js` — removed/archived campaigns can't be summed via API
- Square location: `LVNM3Z4RVRWDK`. Team member map lives in `lib/install-post-seeds.mjs` (`DEFAULT_TEAM_MEMBER_MAP`) and is duplicated in two other files.

---

## Known issues

**Correctness / risk**
- **Live developer token is in git history.** Rotate it. See "Security debt".
- **Google Ads API version is split:** `google-ads.js` is on **v20**, `google-ads-conversions.js` defaults to **v24**. Unify them.
- **Two installation-post publishers may both be live** (cloud queue + M1 launchd relay). Verify and retire the M1 one.
- **`payment.team_member_id` is missing on ~67% of 2026 Square payments**, so any per-technician reporting is a floor, not a total. January 2026 has zero technician attribution at all.
- `pages/api/qbo-callback.js` is self-labelled temporary and still deployed.
- `pages/api/telemetry.js` falls back to a **hardcoded Upstash host** when `AGENCY_REDIS_URL` is unset, and returns empty rather than failing loudly.

**Structural**
- `NEXT_PUBLIC_*` prefix leaks Square/Webflow tokens into the client bundle.
- No error boundary — if `Dashboard.js` throws, the page goes blank.
- `Dashboard.js` (666 lines) and `zenbooker-to-square.js` (~1700 lines) are both overdue for decomposition.
- `DEFAULT_TEAM_MEMBER_MAP` is duplicated across three files.
- `pages/api/CLAUDE.md` is stale — it documents only the three original proxies.
- No PR CI. `_document.js` references `bg-agency-black`, which is not in the Tailwind config (harmless).
- Geographic distribution and "Social Ready" are hardcoded.

---

## Roadmap

**Security**
- [ ] Rotate the Google Ads developer token exposed in git history
- [ ] Migrate `NEXT_PUBLIC_` Square/Webflow secrets to server-only vars

**Measurement**
- [ ] Enable Enhanced Conversions for Leads in the Google Ads UI (Settings → Measurement) — cannot be done via Basic Access API
- [ ] Configure the ZenBooker `job.completed` webhook URL
- [ ] Add the Website Click-to-Call GTM tag (`AW-506833748/CvjaCNO9yvwbENTW1vEB`)
- [ ] Verify Google forwarding numbers are active
- [ ] Verify ZenBooker payload field names against the extractor after the first live webhook
- [ ] Decide whether the raw GCLID receiver feeds click-based upload, or stays capture-only
- [ ] After two weeks of clean data, promote "Offline Job Completed" to `primaryForGoal: true`
- [ ] Add an OFFLINE CONVERSIONS panel to the dashboard

**Cleanup**
- [ ] Unify the Google Ads API version across both modules
- [ ] Confirm the M1 relay is unloaded, then retire the launchd scripts
- [ ] Remove `qbo-callback.js` or finish it
- [ ] Refresh `pages/api/CLAUDE.md`
- [ ] De-duplicate the team member map
- [ ] Add PR CI running `npm test` + `npm run build`
- [ ] Add error boundaries; decompose `Dashboard.js`

**Product**
- [ ] Customer acquisition cost tracking
- [ ] Revenue forecasting
- [ ] Geographic heatmap from real data (the API supports geo queries now)
- [ ] Campaign performance detail view
- [ ] Slack/email alerts on milestones
