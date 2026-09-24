# The Agency - Dashboard Deployment Guide

## Production Git SHA

Live production is `https://mounting-man-dashboard.vercel.app`. Confirm `GET /api/health` `gitCommit` matches GitHub `main` (needs `customerLocation` / `parseGoogleStyleAddress` from #39 or newer). Vercel Git integration should build production on every `main` push. If the Vercel project Git link is disconnected, merging will not deploy — reconnect Git in the Vercel project settings or redeploy the current `main` SHA from the dashboard. Do not pin production to an older ads-apply merge.

## 🎯 Quick Start (5 minutes)

### Step 1: Get Your API Tokens

**Square API Token:**
1. Go to https://developer.squareup.com/apps
2. Select your application
3. Copy your **Access Token** (Production)
4. Copy your **Location ID** (you have: LVNM3Z4RVRWDK)

**Webflow API Token:**
1. Go to https://webflow.com/dashboard/account/integrations
2. Click "Generate API token"
3. Copy the token

### Step 2: Set Up Environment Variables

```bash
# In the project directory, create .env.local
cp .env.example .env.local

# Edit .env.local and fill in:
NEXT_PUBLIC_SQUARE_ACCESS_TOKEN=your_square_token_here
NEXT_PUBLIC_SQUARE_LOCATION_ID=LVNM3Z4RVRWDK
NEXT_PUBLIC_WEBFLOW_TOKEN=your_webflow_token_here
NEXT_PUBLIC_WEBFLOW_SITE_ID=6536f19431181574585ac1ce
NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID=68167d5a313e2fd6f18650c9
```

**CRITICAL:** Never commit `.env.local` to git. It's in `.gitignore`.

### Step 3: Deploy to Vercel

**Option A: Vercel CLI (Fastest)**
```bash
npm install -g vercel
vercel login
vercel
# Follow prompts, select your project name (e.g., "mounting-man-dashboard")
# Vercel will ask for environment variables - copy/paste from .env.local
```

**Option B: GitHub + Vercel Dashboard (Recommended)**
```bash
# Initialize git
git init
git add .
git commit -m "Initial commit: The Agency dashboard"

# Create repo on GitHub (https://github.com/new)
# Then push:
git remote add origin https://github.com/yourusername/mounting-man-dashboard.git
git push -u origin main

# Go to https://vercel.com/new
# Import your GitHub repo
# Add environment variables from .env.local
# Click Deploy
```

### Step 4: Access Your Dashboard

Your dashboard will be live at: `https://mounting-man-dashboard.vercel.app`

(Or whatever custom domain you assign)

---

## 🔄 How It Works

**Automatic Updates:**
- Dashboard refreshes data every 5 minutes automatically
- Shows real-time Square revenue data
- Shows live Webflow blog post counts
- Updates on page load

**Data Sources:**
- **Square API:** Pulls all completed payments, filters by month/day
- **Webflow API:** Counts published installation posts

---

## 📊 What You See

| Metric | Source | Updates |
|--------|--------|---------|
| All-Time Revenue | Square API | Every 5 min |
| This Month Revenue | Square API | Every 5 min |
| Today's Revenue | Square API | Every 5 min |
| Jobs Completed | Square API | Every 5 min |
| Avg Job Value | Calculated | Every 5 min |
| Blog Posts Live | Webflow API | Every 5 min |
| Draft Posts | Webflow API | Every 5 min |

---

## 🛠️ Local Development

Want to test/modify before deploying?

```bash
# Install dependencies
npm install

# Create .env.local (see Step 2 above)

# Run locally
npm run dev

# Open http://localhost:3000
```

Edit `components/Dashboard.js` to customize the UI. Changes hot-reload automatically.

---

## 🔐 Security Notes

1. **Never commit `.env.local`** - It's in `.gitignore`
2. **API tokens are environment variables** - Vercel keeps them private
3. **All API calls go through Next.js** - Your tokens never exposed to the browser
4. **Don't share `.env.local`** - It contains your live credentials

---

## 🚀 Scaling & Advanced Features

**Future enhancements:**
- Add more metrics (customer acquisition, cost per job, etc.)
- Real-time alerts when revenue milestones hit
- Historical revenue graphs (month-over-month)
- Geographic heat maps
- Campaign performance tracking
- Custom reports
- Slack/Telegram integration for alerts

---

## ❌ Troubleshooting

**"API connection failed" error?**
- Check `.env.local` has correct token values
- Verify tokens are from the right environments (Production, not Sandbox)
- Check Vercel environment variables match `.env.local`

**"Missing collection ID" error?**
- Verify `NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID` is correct
- Should be: `68167d5a313e2fd6f18650c9`

**Dashboard shows "Loading..." forever?**
- Check browser console (F12) for error messages
- Verify API tokens are valid
- Check Vercel logs: `vercel logs`

**Data looks old?**
- Dashboard auto-refreshes every 5 minutes
- Click refresh in browser to force immediate update
- Check "Last updated" timestamp

---

## 📞 Need Help?

1. Check the `.env.example` file for required variables
2. Review API documentation:
   - Square: https://developer.squareup.com/docs/payments-api/overview
   - Webflow: https://developers.webflow.com/
3. Check Vercel logs: `vercel logs --follow`

---

**Version:** 1.0  
**Status:** Production Ready  
**Last Updated:** September 2026

## Install-post happy path (THE-264)

Route: Square + photo → confidence gate → `READY_FOR_M1` → M1 publish worker → site + socials (see **M1 publish worker** below; the GitHub Actions `publish-install-post.yml` path is off). GBP is **user-paste only** (never machine-post GBP or Reddit).

Set these in **Vercel project settings** (Production). Do not commit values to git.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Optional | After the deterministic city/street gate PASSes, call TypeSafe Jev (`jev-latest`) with city/street/size only. `noul` false or confidence `< 0.7` HOLDs auto-publish. API errors fail open. Never log this key. |
| `INSTALL_POST_GBP_NOTIFY_URL` | Required for auto GBP fence | Dedicated operator webhook. After the install page is HTTP 200, POSTs **two fence-only bodies** (caption, then Book URL = live `/installations/...` page) for Mr. Wayne to paste. Independent of Woodward. |
| `INSTALL_POST_GBP_NOTIFY_KEY` | Required with the URL | Bearer key. Same header shape as Woodward: `Authorization: Bearer <key>` plus `x-webhook-secret`. |

HOLD wakes Woodward with `deskAction: needs_human` and reason codes only (`blank_city`, `metro_placeholder_city`, `unknown_city`, `google_blob_street`, `missing_tv_size`, `seed_count`, `jev_hold`). `unknown_city` means the city is not in `lib/install-post-locations.mjs` (mirrors `cloud/install-post-runner/references/location-ids.md` + Houston item ids in `location-slugs.json`); `missing_tv_size` covers a blank size or the bare word "TV". No customer PII.

## Install-post photo ask (THE-276)

At payment time the photo is usually missing. The dashboard no longer wakes Woodward for that. It sends the operator a deterministic photo ask that carries the existing signed upload link. No LLM is involved.

### How the operator gets the upload link

1. Square payment webhook (or the seed cron fallback) claims the 24h install-post dedup, then stages **one cloud job per Square visit**.
2. The job gets a signed operator link: `https://mounting-man-dashboard.vercel.app/install-posts/open#<capability>` (48h TTL, capability in the URL fragment only).
3. If the job has no photo, `lib/install-post-photo-ask.mjs` sends that link over every configured channel:
   - **Webhook** `INSTALL_POST_PHOTO_ASK_URL`: a JSON POST with `title`, `text` (label → link), `url`, `links[]`, `defaultAction.url`. Point it at Pushcut, an iOS Shortcut relay, an ntfy relay, or a Zapier/Make hook that forwards as SMS/email/push.
   - **SMS** `INSTALL_POST_PHOTO_ASK_SMS_TO`: Twilio text `Mounting Man — Add install photo & publish` + `label → link`.
4. The operator taps the link on the phone. The card opens, they drop the photo, and the existing upload → confidence gate → publish path runs.

Woodward is woken (`deskAction: request_photo`, no link in the payload) only as the exception path: no channel configured, every channel failed, or the queue produced no link. Confidence HOLDs still wake Woodward with `needs_human`. The photo ask fires once per Square visit (same 24h dedup claim as the rest of intake). Multi-TV visits list one link per job.

| Variable | Required | Purpose |
| --- | --- | --- |
| `INSTALL_POST_PHOTO_ASK_URL` | One channel required | Operator webhook for the photo ask. |
| `INSTALL_POST_PHOTO_ASK_KEY` | Optional | Sent as `Authorization: Bearer <key>` plus `x-webhook-secret`. |
| `INSTALL_POST_PHOTO_ASK_SMS_TO` | One channel required | Operator phone (E.164). Needs `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (optional `TWILIO_FROM_NUMBER`). |

Status (no link) is returned as `photoAsk` in the seed-cron JSON: `delivered`, `skipped` (`no_channel`, `no_operator_links`, `photo_present`), and per-channel `forwarded`/`error`.

## Install-post near-zero path (THE-273 / THE-274 / THE-275)

Cloud Actions dispatch is **off**: `INSTALL_POST_DISPATCH_TOKEN` stays empty and `createConfiguredDispatcher()` returns `null`. The M1 publisher (`jewel-way-run`) is the canonical publisher; `cloud/install-post-runner` is frozen and non-canonical (see its `FROZEN.md`).

- **PASS + photo, no dispatcher** → job becomes `READY_FOR_M1` (approved revision recorded, no lease, no timeout, not a failure) and one plain ping goes to Mr. Wayne. A repeat for the same revision is a no-op. Any correction or new photo reopens it to `READY`.
- **Manual Publish tap** runs the same deterministic gate as the auto-run. A HOLD answers `422 { error: "needs_human", holdReasons }` and nothing is approved.
- **Seeds** carry `location-id` and `metro-area` for known cities; editing city/state on the phone card refreshes both.

| Variable | Required | Purpose |
| --- | --- | --- |
| `INSTALL_POST_READY_NOTIFY_URL` | Optional | Override for the ready ping. Falls back to `INSTALL_POST_GBP_NOTIFY_URL`. Fixed-template body (`kind: install_post_ready_for_m1`, job id, size/brand/city) — no LLM, no Woodward wake, no street or customer data. |
| `INSTALL_POST_READY_NOTIFY_KEY` | With the URL | Bearer key. Falls back to `INSTALL_POST_GBP_NOTIFY_KEY`. |

## M1 publish worker + GBP decouple (THE-273)

**PUBLISHED no longer depends on the machine GBP queue.** `/api/install-post/runner/callback` saves a verified website result on its own and never writes `install-post:gbp:*`. After the save it sends the GBP paste pack (caption, then Book URL) to `INSTALL_POST_GBP_NOTIFY_URL`, fail-open. The M1 Playwright GBP worker gets no new work from publishes; do not reload it.

**How M1 picks jobs:**

1. Dashboard parks a gate-passed, photo-bound job as `READY_FOR_M1` (unchanged) and adds it to the `install-post:m1-ready-index` set.
2. launchd `com.themountingman.install-post-worker` runs `m1/install-post-worker/install-post-worker.mjs` every 120s. It preflights (secret file present, wrapper executable) and never claims when misconfigured.
3. `POST /api/install-post/m1/claim` `{ workerId }` (runner HMAC signature) takes the publish lease on the oldest `READY_FOR_M1` approval, moves it to `PUBLISHING`, and returns the envelope: safe seed, photo `hostedUrl` + `sha256`, `dispatchId`, `artMode: "never"`. Idle poll = one `SMEMBERS`.
4. The worker downloads the photo, checks the digest (mismatch → `BLOCKED`), writes `seed.json` + `photo.webp` (0600) and runs:
   `/Users/thedirector/jewel-way-run/bin/run_fast_install_post.sh --seed-json <seed.json> --image <photo.webp> --art-mode never`
5. It takes the last `https://www.themountingman.com/installations/<slug>` URL the wrapper printed and reads it back. HTTP 200 → `PUBLISHED` (whatever the exit code, so a job never posts twice). Timeout, or a URL that doesn't read back → `INDETERMINATE`. Non-zero exit with no URL → `RETRYABLE_FAILURE`; a new Publish tap re-queues it as `READY_FOR_M1`.
6. It reports to `/api/install-post/runner/callback` with the `dispatchId`. An undelivered callback is parked under the worker state dir and resent next pass (no second publish).

A worker that dies mid-run leaves the job `PUBLISHING`; the card ages it to `INDETERMINATE` after 15 minutes (the worker kills the wrapper at 12). Reconcile still needs a human while cloud dispatch is off.

Not changed: `INSTALL_POST_DISPATCH_*` stays empty and `publish-install-post.yml` stays disabled. `fast_install_post.py` is not forked. Reddit stays dead. The Jev/TypeSafe install-post gate stays off. Woodward naming (`WOODWARD_*`) is untouched.

| Variable | Where | Purpose |
| --- | --- | --- |
| `INSTALL_POST_RUNNER_SECRET` | Vercel (Production) **and** M1 secret file | HMAC for `/api/install-post/m1/claim` and `/api/install-post/runner/callback`. Use one long random value in both places. If it was ever stored as a GitHub Actions secret, rotate it. |
| `INSTALL_POST_RUNNER_SECRET_FILE` | M1 plist | Path to the 0600 file holding the secret. Default `~/.config/themountingman/install-post-worker/runner-secret`. |
| `INSTALL_POST_API_BASE` | M1 plist | Dashboard origin. Default `https://mounting-man-dashboard.vercel.app`. |
| `INSTALL_POST_M1_WORKER_ID` | M1 plist | Lease owner label. Default `m1-publish-01`. |
| `INSTALL_POST_M1_PUBLISH_WRAPPER` | M1 plist | Canonical wrapper. Default `/Users/thedirector/jewel-way-run/bin/run_fast_install_post.sh`. |
| `INSTALL_POST_M1_STATE_DIR` | M1 plist | Logs, lock, temp job files, parked callbacks. Default `~/.local/state/themountingman/install-post-worker`. |
| `INSTALL_POST_M1_PUBLISH_TIMEOUT_MS` | M1 plist (optional) | Wrapper kill timeout. Default 720000 (12 min). |

**Deploy order:**

1. Set `INSTALL_POST_RUNNER_SECRET` in Vercel Production, then deploy the dashboard.
2. On the M1, from a checkout of this repo: `node scripts/install-m1-install-post-worker.mjs --env-file /secure/path/.env` (the file only needs `INSTALL_POST_RUNNER_SECRET`; add `--wrapper PATH` if the wrapper moved). This writes the 0600 secret file, copies the worker, fills the plist, and bootstraps launchd.
3. Check `~/.local/state/themountingman/install-post-worker/worker.log`. You should see `worker_status=idle` or `worker_status=reported ... state=PUBLISHED`. The first successful pass asks the dashboard to rescan, so jobs parked before this deploy are picked up.
4. Remove with `node scripts/install-m1-install-post-worker.mjs --uninstall`.
