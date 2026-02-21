# Mounting Man Dashboard

## Identity
- Tactical Business Intelligence Dashboard for The Mounting Man (TV mounting service)
- Owner: The Agency (theagency)
- Status: Active, production
- Live: https://mounting-man-dashboard.vercel.app
- Design: Spy/HUD aesthetic — dark backgrounds (#0a0a0a), neon green (#c8e632), Orbitron font for headings/numbers, IBM Plex Mono for body, scan lines + noise overlays

## Architecture
- Next.js 14, Pages Router (NOT App Router)
- Single-page dashboard: `pages/index.js` renders `components/Dashboard.js`
- API routes proxy all external calls — client never talks directly to Square/Webflow/Google
- Auto-refresh every 5 minutes via setInterval in Dashboard.js
- Deployed on Vercel, no database, no auth
- Data flow: External APIs → `/api/*` routes (server-side) → Dashboard.js (client-side fetch)

## File Map
```
CLAUDE.md                              # This file — project context for Claude
pages/index.js                         # Entry point, renders <Dashboard />
pages/_app.js                          # App wrapper, imports globals.css
pages/_document.js                     # HTML shell, loads Google Fonts (Orbitron, IBM Plex Mono, Space Mono)
pages/api/square-revenue.js            # Square Payments API proxy — paginates all payments, calculates revenue metrics
pages/api/webflow-posts.js             # Webflow Collections API proxy — counts published/draft/archived blog posts
pages/api/google-ads.js                # Google Ads REST API — uses shared auth, 15min cache + fallback to hardcoded data
pages/api/webhooks/zenbooker.js        # Zenbooker job.completed webhook → offline conversion upload to Google Ads
lib/google-ads-auth.js                 # Shared OAuth2 token refresh — used by google-ads.js and conversions upload
lib/hash-pii.js                        # PII normalization + SHA-256 hashing for Google Ads Enhanced Conversions
lib/google-ads-conversions.js          # Google Ads uploadClickConversions wrapper (Enhanced Conversions for Leads)
components/Dashboard.js                # THE main component — all UI lives here (~447 lines, monolithic)
styles/globals.css                     # All custom CSS: HUD grid, scan lines, glow effects, noise overlay, panel styles
tailwind.config.js                     # Custom colors (hud-*), fonts (mono, terminal), animations (scan, flicker)
scripts/get-google-refresh-token.js    # One-time OAuth helper to generate Google Ads refresh tokens
.env.example                           # Template for all environment variables
vercel.json                            # Build config (framework: nextjs)
```

### Sub-components inside Dashboard.js
- `HudGauge` — SVG circular progress rings with tick marks (used for revenue/jobs gauges)
- `StatusDot` — Green/red indicator with glow effect
- `DataRow` — Key-value display with optional highlight
- `TrackingBar` — Horizontal progress bar with percentage
- `NodeBlock` — Panel container with header, used throughout

## Tech Stack
- Next.js 14, React 18, Pages Router
- Tailwind CSS 3.4 with custom `hud-*` color palette
- Recharts (AreaChart, LineChart) for data visualization
- Axios for HTTP (both API routes and client-side)
- Fonts: Orbitron (headings), IBM Plex Mono (body), Space Mono (alt mono)
- @vercel/kv (Upstash Redis) for webhook deduplication and offline conversion audit trail (NOTE: @vercel/kv is deprecated, migrate to Upstash Redis Marketplace integration when setting up KV store)
- No TypeScript, no tests, no state management library

## Environment Variables
All set in **Vercel project settings** for production. Local dev uses `.env.local` (gitignored).

### Square API
- `NEXT_PUBLIC_SQUARE_ACCESS_TOKEN` — Production access token (SECRET) — Vercel env
- `NEXT_PUBLIC_SQUARE_LOCATION_ID` — Location ID (safe) — value: `LVNM3Z4RVRWDK`

### Webflow API
- `NEXT_PUBLIC_WEBFLOW_TOKEN` — API token (SECRET) — Vercel env
- `NEXT_PUBLIC_WEBFLOW_SITE_ID` — Site ID (safe) — value: `6536f19431181574585ac1ce`
- `NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID` — Collection ID (safe) — value: `68167d5a313e2fd6f18650c9`

### Google Ads API
- `GOOGLE_ADS_DEVELOPER_TOKEN` — Developer token from MCC (SECRET) — Vercel env
- `GOOGLE_ADS_CLIENT_ID` — OAuth client ID (SECRET) — Vercel env
- `GOOGLE_ADS_CLIENT_SECRET` — OAuth client secret (SECRET) — Vercel env
- `GOOGLE_ADS_REFRESH_TOKEN` — OAuth refresh token (SECRET) — Vercel env
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — MCC ID (safe) — defaults to `3167428631` in code

### Google Ads Offline Conversions
- `GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID` — Conversion action ID (safe) — value: `7509313857`

### Zenbooker Webhook
- `ZENBOOKER_WEBHOOK_SECRET` — Secret for webhook auth (SECRET) — Vercel env

### Vercel KV (Upstash Redis)
- `KV_REST_API_URL` — Auto-set by Vercel when KV database is added
- `KV_REST_API_TOKEN` — Auto-set by Vercel when KV database is added

### Dashboard Config
- `NEXT_PUBLIC_DASHBOARD_REFRESH_INTERVAL` — Refresh interval in ms (safe) — default: `300000` (5 min)

**NOTE:** `NEXT_PUBLIC_*` vars are exposed to the browser bundle. Square/Webflow tokens use this prefix (legacy) but are only used server-side in API routes. Google Ads vars correctly omit the prefix.

## API Integrations

### Square Payments API
- Base: `https://connect.squareup.com/v2/payments`
- Auth: Bearer token + `Square-Version: 2024-01-18` header
- Paginates with cursor, 100 per page, filters COMPLETED only
- Returns: allTime, thisMonth, today totals + job counts + 7-day revenue history
- Amounts are in cents (divided by 100 in code)

### Webflow Collections API
- Base: `https://api.webflow.com/v2/collections/{id}/items`
- Auth: Bearer token
- Paginates with offset/limit, 100 per page
- Returns: published, draft, archived, total counts

### Google Ads REST API
- Base: `https://googleads.googleapis.com/v20/customers/{id}/googleAds:searchStream`
- Auth: OAuth2 refresh token flow + `developer-token` header + `login-customer-id` header
- Customer ID: `1287907452` (The Mounting Man advertiser account)
- MCC (login-customer-id): `3167428631` (The Agency — owns the developer token)
- 4 GAQL queries: monthly spend, weekly spend, 30-day daily breakdown, campaign detail
- 15-minute server-side cache (in-memory)
- Falls back to hardcoded data if credentials missing or API fails
- `allTimeSpend` hardcoded at `350000` — historical data for removed campaigns can't be queried

### Offline Conversion Pipeline (Zenbooker → Google Ads)
- **Why**: Samsung Frame, MantelMount, and stone/tile customers call/text Marshall first. He books for them in Zenbooker. These jobs are invisible to Google Ads because GTM only fires on self-booked /thank-you page visits. This pipeline captures those offline conversions.
- **Flow**: Zenbooker `job.completed` webhook → `POST /api/webhooks/zenbooker?secret=XXXXX` → hash PII (SHA-256) → upload to Google Ads Enhanced Conversions for Leads → dedup via Vercel KV
- **Conversion Action**: "Offline Job Completed" (ID: `7509313857`), type: UPLOAD_CLICKS, category: PURCHASE, `primaryForGoal: false` (promote to primary after 2 weeks of validated data)
- **Auth**: Uses shared `lib/google-ads-auth.js` module. WRITE operations OMIT `login-customer-id` header (direct owner access).
- **PII Hashing**: `lib/hash-pii.js` normalizes then SHA-256 hashes email (Gmail dot/plus removal), phone (E.164), and name (lowercase)
- **Dedup**: Vercel KV key `conv:{jobId}` with 90-day TTL. Monthly stats at `conv:stats:{YYYY-MM}` with 365-day TTL.
- **Field Mapping**: Zenbooker webhook payload field names are best-guess. The handler logs full raw payloads and uses a `FIELD_MAP` config at the top of `zenbooker.js` that tries multiple dot-notation paths per field. Adjust after inspecting first real webhook in Vercel logs.
- **Default Value**: $300 if no invoice amount found in webhook payload
- **Error Handling**: Always returns 200 to Zenbooker (even on upload failure) to prevent retry storms
- **Webhook URL**: `https://mounting-man-dashboard.vercel.app/api/webhooks/zenbooker?secret=mountingman_webhook_2026`
- **KV Status**: ✅ LIVE — Upstash Redis `mounting-man-kv` (Free plan, US East iad1) connected to mounting-man-dashboard with KV_ prefix. Env vars `KV_REST_API_URL` and `KV_REST_API_TOKEN` auto-set. Deduplication verified working 2026-02-21.

## Conventions
- All UI lives in a single monolithic `Dashboard.js` (~447 lines)
- CSS classes use `hud-*` prefix (defined in tailwind.config.js + globals.css)
- API routes are GET-only (except `/api/webhooks/*` which are POST), return JSON with `error` field on failure
- Money values are dollars (not cents) in API responses to client
- Hardcoded business targets: $32,000/mo revenue, 20 jobs/mo
- Hardcoded geographic data: Minneapolis 81%, Houston 12%, Austin 7%
- `"Social Ready: 3"` is hardcoded in Dashboard.js

## Commands
```bash
npm run dev          # Local dev at http://localhost:3000
npm run build        # Production build
npm start            # Run production server locally
npm run lint         # ESLint
vercel               # Deploy preview
vercel --prod        # Deploy to production
vercel logs --follow # Tail deployment logs
```

## Known Issues
- `NEXT_PUBLIC_*` prefix on Square/Webflow tokens exposes them to client bundle (should migrate to server-only)
- ~~Google Ads API auth~~ **FIXED 2026-02-21** — see API Debugging Notes below
- `allTimeSpend` ($350K) is hardcoded — removed/archived campaigns can't be summed via API
- Geographic distribution is hardcoded, not from any API
- "Social Ready: 3" is hardcoded
- No error boundary — if Dashboard.js throws, page goes blank
- No tests of any kind
- `_document.js` references class `bg-agency-black` which doesn't exist in tailwind config (non-breaking, body bg is set in globals.css)

## Google Ads Account Structure

### Accounts
- **The Mounting Man** (advertiser): `128-790-7452` — owned by mntvmounting@gmail.com
- **The Agency MCC #1**: `316-742-8631` — owned by marshallwayneemail@gmail.com — HAS developer token
- **The Agency MCC #2**: `601-738-6949` — owned by marshallwayneemail@gmail.com — NO developer token
- Cancelled account: `931-361-6976` (ignore)

### API Credentials (stored in Vercel env vars + 1Password)
- Developer Token: `b7mhI-wsuUwSCkTdk-UGiA` (Basic Access, RESET 2026-02-21, registered under MCC #1)
- Old Developer Token: `yIQ5GczkxvMT_d8JEXuPxw` (DEAD — was permanently paired to wrong GCP project)
- OAuth Client Project: "The Agency" (gen-lang-client-0151509552) — OLD client credentials
  - Client ID: `155328431466-ms2ucl67h93ne8tcp3c965kdffi170nn.apps.googleusercontent.com`
  - Client Secret: in Vercel env `GOOGLE_ADS_CLIENT_SECRET`
- Refresh Token: generated for mntvmounting@gmail.com using OLD client — in Vercel env `GOOGLE_ADS_REFRESH_TOKEN`
- There is also a NEW client project ("mounting-man-dashboard", ID 525376319550) — NOT currently in use

### Access Grants & API Write Access
- mntvmounting@gmail.com has **Read-only** access to MCC #1 (316-742-8631) — granted 2026-02-20
- **CRITICAL DISCOVERY (2026-02-21):** mntvmounting@gmail.com is the **OWNER** of the advertiser account (128-790-7452) directly. For **WRITE operations**, OMIT the `login-customer-id` header — the request goes directly to the owned account with full write access. For **READ operations**, include `login-customer-id: 3167428631` (needed for developer token validation).
- MCC Standard/Admin upgrade NOT needed for most operations — direct owner access is sufficient

### Critical API Debugging Notes (2026-02-20 → RESOLVED 2026-02-21)
These findings took 2 days to discover — preserved for future reference:
1. `marshallwayneemail@gmail.com` tokens ALWAYS return `DEVELOPER_TOKEN_INVALID` regardless of which OAuth client, dev token, or login-customer-id is used. **Never use marshallwayneemail tokens for API access.**
2. `mntvmounting@gmail.com` tokens work correctly. Use mntvmounting tokens.
3. The `login-customer-id` header MUST be `3167428631` (the MCC that owns the dev token). Using the advertiser ID or omitting it causes `DEVELOPER_TOKEN_INVALID`.
4. **ROOT CAUSE FOUND**: The old developer token `yIQ5GczkxvMT_d8JEXuPxw` was **permanently paired** to a different Google Cloud project. Per Google docs: "Each Google API Console project can be associated with the developer token from only one manager account. Once you make a Google Ads API request, the developer token is permanently paired to the Google API Console project." Since we were using a different OAuth client project than the one originally paired, it always failed.
5. **FIX**: Reset the developer token in Google Ads Admin → API Center → Developer token → "Reset token". This generated new token `b7mhI-wsuUwSCkTdk-UGiA` which is now paired to the correct OAuth client project. API works immediately after reset.
6. **API is fully working** as of 2026-02-21. All GAQL queries succeed (campaigns, keywords, demographics, search terms, etc.).

### DO NOT USE ZAPIER
Claude has a Zapier MCP connector for Google Ads — **do not use it**. It's a limited middleware layer that:
- Only exposes pre-built actions (reports, find campaign, set status)
- Cannot create/modify ads, ad groups, keywords, bids, or conversion actions
- Silently overrides parameters like date ranges
- Adds latency and unpredictability

Instead, use the direct Google Ads REST API via `pages/api/google-ads.js` or direct curl/API calls with the credentials above. For a Claude Code session to make Google Ads changes, use the REST API directly with the mntvmounting OAuth token.

### Conversion Tracking Status (2026-02-21)
Existing tracking that IS working:
- **Booked Appointment** (6491204814) — GTM tag fires on /thank-you page. 21.7 conversions in last 30 days.
- **Landing Page Phone Calls - DM** (1065481863) — Google forwarding numbers on website. Status needs verification.
- **Phone Call from Ad Extension** (7509075265) — AD_CALL type, auto-tracks call extension clicks. Created 2026-02-21.

New actions created but needing GTM tags:
- **Website Click-to-Call** (7509024467) — send_to: `AW-506833748/CvjaCNO9yvwbENTW1vEB`, $150 value

Disabled duplicates (primaryForGoal=false):
- Website Booking Form Submission (7509075268) — duplicate of Booked Appointment
- Phone Call from Website Google Tracking (7509075271) — duplicate of Landing Page Phone Calls

### Campaign Changes Applied (2026-02-21)
- DC - General TV Mounting (23246944048) → **PAUSED**
- DC - Samsung Frame TV (23246943838) → **PAUSED**
- Houston General budget → **$5/day** (budget 15126435724)
- Houston Samsung Frame budget → **$5/day** (budget 15126434527)
- Display Remarketing budget → **$15/day** (budget 14955992821)
- Ad schedules: **6AM-midnight** on MSP General, Samsung Frame, Brand, MantelMount, Remarketing

## Roadmap
- [x] Fix Google Ads API auth — DONE 2026-02-21 (dev token reset)
- [x] Update Vercel env var `GOOGLE_ADS_DEVELOPER_TOKEN` — DONE 2026-02-21
- [x] Redeploy production — DONE 2026-02-21
- [x] Full Google Ads audit — DONE 2026-02-21 (see GOOGLE_ADS_AUDIT_2026-02-21.md)
- [x] Pause DC campaigns — DONE 2026-02-21
- [x] Reduce Houston budgets to $5/day — DONE 2026-02-21
- [x] Apply ad schedules (block 1-6AM) — DONE 2026-02-21
- [x] Increase remarketing budget to $15/day — DONE 2026-02-21
- [x] Create conversion actions via API — DONE 2026-02-21
- [x] Disable duplicate conversion actions — DONE 2026-02-21
- [ ] Add Website Click-to-Call GTM tag (send_to: AW-506833748/CvjaCNO9yvwbENTW1vEB)
- [ ] Verify Google forwarding numbers are active for phone call tracking
- [x] Pause expensive Samsung keyword "Samsung The Frame installation" [PHRASE] — DONE 2026-02-21 (criterion 2453417012864)
- [x] Build Zenbooker → Google Ads offline conversion pipeline — DONE 2026-02-21 (lib/*, pages/api/webhooks/zenbooker.js)
- [x] Create "Offline Job Completed" conversion action (7509313857) — DONE 2026-02-21
- [x] Extract shared Google Ads auth module — DONE 2026-02-21 (lib/google-ads-auth.js)
- [x] Set up Vercel KV database — DONE 2026-02-21 (Upstash Redis `mounting-man-kv`, Free plan, US East iad1, connected with KV_ prefix)
- [x] Set ZENBOOKER_WEBHOOK_SECRET and GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID in Vercel env — DONE 2026-02-21
- [ ] Configure Zenbooker webhook URL: `https://mounting-man-dashboard.vercel.app/api/webhooks/zenbooker?secret=XXXXX`
- [ ] **REQUIRED** Enable Enhanced Conversions for Leads in Google Ads UI (Settings → Measurement → Enhanced conversions → Turn on for leads) — cannot be done via Basic Access API, must be done in UI
- [ ] Verify Zenbooker webhook field names match FIELD_MAP (check Vercel logs after first webhook)
- [ ] After 2 weeks: promote "Offline Job Completed" to primaryForGoal=true
- [ ] Add "OFFLINE CONVERSIONS" panel to Dashboard.js
- [ ] Customer acquisition cost tracking
- [ ] Revenue forecasting
- [ ] Geographic heatmap (replace hardcoded data — API now supports geo queries)
- [ ] Campaign performance detail view
- [ ] Slack/email alerts on milestones
- [ ] Migrate NEXT_PUBLIC_ secrets to server-only env vars
- [ ] Add error boundaries
- [ ] Decompose Dashboard.js into smaller components
