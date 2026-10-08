# Health report — mounting-man-dashboard

Date: 2026-10-08. Branch reviewed: `main` at `81e366f`. Production: https://mounting-man-dashboard.vercel.app (Vercel team `theagency`, project `mounting-man-dashboard`).

This pass did not merge, deploy, change production env vars, change cron schedules, or edit OAuth (`/api/mcp/auth/*`), ZenBooker MCP (`/api/mcp/mounting-man-zenbooker`), ad-attribution files from PR #56, webhook signature checks, or money math.

## Gates

| Gate | Result |
| --- | --- |
| Node tests (`npm test`) | Pass. 655/655 on main. 658/658 after this branch. No failures, no flakes. |
| Python publisher tests | Pass. 101 passed, 1 skipped. |
| M1 GBP worker unit tests | Pass. 57 tests. Plists load. |
| Lint (`next lint`) | Exit 0. The Dashboard hook warning is gone. Remaining warnings match main (see below). |
| Type check | No `tsconfig` and no TypeScript project. `next build` runs “Linting and checking validity of types” and completed. |
| Production build (`npm run build`) | Pass. Next.js 14.2.35. |

## Needs a decision from Mr. Wayne

These are listed here and not changed.

1. Rotate the Square access token. On 2026-10-05 the `/api/cron/square-refresh` 503 was stored in Vercel runtime logs as a full Axios error, which includes the request `Authorization` header. This branch stops that log leak. It does not rotate the token or edit Vercel env vars.
2. Remove `DISCORD_BOT_TOKEN` from the Vercel **preview** environment when convenient. It is not set for production. Application code no longer reads it (PR #57).
3. The Marshall Wayne X tool is still getting `401 Could not authenticate you` from the X API (last seen 2026-10-08 02:07 UTC on `/api/mcp/marshallwayne-x`). That is a credential problem, not a code fix in this PR.

## Findings

| # | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | High | Errors / Square | `/api/cron/square-refresh` had no catch. A Square 503 became an unhandled Axios error and Vercel stored the request headers. Three events in 7 days, last 2026-10-05 15:00 UTC, route `/api/cron/square-refresh`. Upstream body was a connect reset (`overflow`) while paging payments. | Fixed in code: failures now log status plus a short code and return HTTP 500 JSON. Totals and pagination are unchanged. Token rotation deferred (finding above). |
| 2 | High | Dependencies | `npm audit` started at 61 issues (4 critical, 50 high, 6 moderate, 1 low). | Partially fixed. Non-breaking `npm audit fix` plus the lockfile refresh left 51 (2 critical, 43 high, 5 moderate, 1 low). See dependency section. |
| 3 | High | Errors / X | `marshallwayne_x_tool_failed`: X API 401, 6 events, routes `/api/mcp/marshallwayne-x`, last 2026-10-08 02:07 UTC. | Deferred. Needs a credential check in Vercel, which this pass does not touch. |
| 4 | Medium | Errors / Discord | `discord-error` 401 on `DISCORD_Q_BOT_TOKEN`: 11 events, routes `/api/cron/offline-conversions` and `/api/webhooks/square-payment`, last 2026-10-07 14:20 UTC. A second older group (8 events) last fired 2026-10-04. PR #57 merged 2026-10-07 15:50 UTC and deleted `lib/discord-ops.js`. | Source already clean. Env leftover deferred. See Discord section. |
| 5 | Medium | Performance / Square | When the all-time Redis cache is missing, `square-refresh` pages every historical payment. That is the request that 503’d. `if (!allTimeTotal)` also treats a real zero total as a cache miss. | Deferred. Changing this changes all-time revenue behavior. |
| 6 | Medium | Errors / cron | `/api/cron/installer-refresh` hit the 60 second function limit once, 2026-10-07 16:12 UTC. The route sets `maxDuration: 60` and writes one Redis key per updated job. | Deferred. Schedule and ZenBooker assignment behavior stay as they are. |
| 7 | Medium | Secrets in source | `pages/api/shortcuts/tell-q.js` had a Telegram bot token prefix in a comment. `tell-q` and `pages/api/vault/write.js` fall back to hardcoded shared secrets when their env vars are unset. | Comment removed. Fallback secrets deferred: deleting them changes auth if the env var is missing. Rotate the Telegram bot if that prefix was ever a real token; the old comment remains in git history. |
| 8 | Low | Performance | Google Ads dashboard route ran four independent read queries one after another. | Fixed. Same GAQL, same spend math, issued with `Promise.all`. Upload code was not edited. |
| 9 | Low | Performance | `/api/webflow-posts` paginated the installations collection on every dashboard load, with no cache. | Fixed. 15-minute in-memory cache on a warm instance, same shape as before. Cold starts still fetch. |
| 10 | Low | Lint / client | `Dashboard.js` 5-minute revenue timer closed over the first render’s `squareData`, so a page that loaded Square data after mount never applied the later refresh. Lint warned about the missing hook dependency. | Fixed. The timer calls the latest function, and the update still no-ops until Square data exists. Amounts shown are the same fields. |
| 11 | Low | Headers | `/near-you` and `/accent-wall-visualizer` sent `X-Frame-Options: ALLOWALL`, which is not a real directive. CSP `frame-ancestors` already allowlists the Mounting Man sites. | Fixed. Invalid header removed. CSP unchanged. Local production server confirmed both routes return 200 with that CSP and no `X-Frame-Options`. |
| 12 | Low | Dead dependency | The `vercel` CLI was a production dependency and is not imported by the app. Most remaining high audit findings hang off it. | Moved to `devDependencies` and bumped 50.22.0 → 50.44.0 inside the existing range. Not removed, so `npx vercel` from a full install still works. Major 62 deferred. |
| 13 | Low | Bundle | Home page first load is about 194 kB (`/` page chunk 109 kB plus shared 85 kB). Recharts is on the dashboard. | Deferred. Swapping the chart library is a UI change, not a one-line fix. |
| 14 | Low | Build | `getStaticProps` on `/` calls its own API routes with a 5 second timeout. A local production build shipped the “INITIALIZING” shell because those calls cannot succeed during `next build`. The browser then fetches again. | Deferred. Changing ISR changes first paint. |
| 15 | Info | Lint warnings left | `@next/next/no-img-element` on `accent-wall-visualizer.js` (3) and `install-posts/open.js` (1). `@next/next/no-page-custom-font` on `near-you.js`. | Deferred. `next/image` and moving the Inter font can change layout. No new warnings. |
| 16 | Info | Deprecated package | `@vercel/kv` 3.0.0 is deprecated. The app already talks to Upstash through the KV-prefixed env vars. | Deferred migration. |

## Tests and coverage gaps

No test was failing or flaky. New tests cover the Square refresh error summary (no request headers in the summary) and the Webflow warm cache.

Money paths, and what is still untested:

- **Square payments.** Covered: Chicago week bucketing (`tests/square-revenue-week.test.mjs`), reporting-feed sanitizer (tips, fees, PII stripped), payment webhook attribution / review SMS / observe mode. Not covered: the `/api/square-revenue` HTTP route, the `/api/cron/square-refresh` success path (pagination, Redis writes, cent conversion on that cron), and a live Square call. This PR does not add those, because they sit on the money path.
- **Payroll / reporting MCP.** `pages/api/mcp/mounting-man-reporting.js` is tested for auth, Chicago dates, and a sanitized feed. The route states it does not compute payroll. There is no payroll-calculation module in this repo to cover.
- **Google Ads uploads.** `lib/google-ads-conversions.js` and `lib/daily-offline-conversions.js` are tested for headers, click ids, net value (tips and refunds), idempotency, and a 403 stop. The ZenBooker completion hook is tested in observe mode and does not upload on the default path. Not covered: a live `uploadClickConversions` call, or the Google Ads UI switch for enhanced conversions. Upload code was not edited.
- **ZenBooker webhook.** Auth, consent, staff/test jobs, missing Square mapping, observe mode, KV failure, and log redaction are tested. Live ZenBooker payload field names are still a best-guess (`FIELD_MAP`). Webhook signature checks and `/api/mcp/mounting-man-zenbooker` were not edited, so overnight work on those files is left alone. PR #56 attribution files were not edited; their existing tests passed.

## Discord

- `lib/discord-ops.js` and `tests/discord-ops.test.js` are already gone (PR #57).
- `tests/q-alert.test.js` fails the suite if `lib`, `pages`, or `components` mention Discord outside comments. That test passes.
- `.env.example` has no Discord key.
- Vercel env, read-only, values not decrypted: `DISCORD_BOT_TOKEN` exists with target `preview` only (encrypted, no git branch). It is not on production. Not modified.

## Dependencies

Applied (lockfile, ranges already allowed it):

- `axios` 1.13.5 → 1.20.0 (direct, high severity, minor)
- `postcss` 8.5.6 → 8.5.29 (direct, patch). Next still vendors its own older PostCSS; that copy needs Next 16.
- `vercel` CLI 50.22.0 → 50.44.0 (minor) and moved to devDependencies

Deferred majors (audit fix requires `--force`):

- `next` 14.2.35 → 16.4.0 (critical). Several advisories are App Router, Server Actions, or React Server Components. This app is Pages Router, and it is still inside the flagged range.
- `eslint-config-next` 14 → 16, which follows Next
- `eslint` 8.57.1 → 10 (latest; wanted stays on 8)
- `react` / `react-dom` 18.3.1 → 19
- `tailwindcss` 3.4.19 → 4.3.3
- `recharts` 2.15.4 → 3
- `sharp` 0.33.5 → 0.35.5
- `vercel` CLI 50 → 62.7.0
- `@google/genai` latest major is 2.x. The 1.52 minor was not applied; it is not required to clear a direct audit finding and it can change Gemini calls.

`tar` 7.5.7 is still critical. `npm audit` says a fix exists, and `npm audit fix` (no `--force`) leaves it in place because the Vercel CLI tree pins it. Deferred with the Vercel CLI major.

Not applied, not security-blocking: `autoprefixer` 10.4.24 → 10.6.1, `tsx` 4.21.0 → 4.23.15.

## Production errors, last 7 days

Read-only Vercel runtime error groups for project `prj_B3wjqAKz321YlVY1m4iBWxsk3PWC`:

1. Discord 401 (`DISCORD_Q_BOT_TOKEN`) — 11 — offline-conversions cron and Square payment webhook — last 2026-10-07 14:20 UTC
2. Discord 401 (older group) — 8 — Square payment webhook — last 2026-10-04
3. X API 401 — 6 — `/api/mcp/marshallwayne-x` — last 2026-10-08 02:07 UTC
4. Square 503 while paging payments — 3 — `/api/cron/square-refresh` — last 2026-10-05
5. Function timeout after 60 seconds — 1 — `/api/cron/installer-refresh` — 2026-10-07 16:12 UTC

## Dead code

No `lib` module was unreferenced. Discord source is already gone. The unused production dependency found was the Vercel CLI, moved to devDependencies. Cron schedules in `vercel.json` were not changed.

## What this PR changes

- Square refresh failures no longer log Axios request config.
- Google Ads spend reads run in parallel. Queries and math are the same.
- Webflow post counts cache for 15 minutes on a warm instance.
- Dashboard 5-minute revenue refresh uses the latest data instead of the first render.
- Invalid `X-Frame-Options: ALLOWALL` removed. CSP `frame-ancestors` kept.
- Telegram token prefix removed from a comment.
- `axios`, `postcss`, and the Vercel CLI patch/minor updates. Vercel CLI is a devDependency.
- `HEALTH-REPORT.md` and the two new tests.
