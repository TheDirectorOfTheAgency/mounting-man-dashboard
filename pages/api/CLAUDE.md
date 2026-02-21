# API Routes

All routes are GET-only server-side proxies to external APIs. They run as Vercel serverless functions.

## Pattern
Each route follows the same structure:
1. Check method → 405 if not GET
2. Read env vars → return error if missing
3. Paginate through external API (cursor or offset)
4. Calculate/aggregate metrics
5. Return JSON with `lastUpdated` timestamp
6. Catch errors → log to console → return 500 with `error` + `details`

## Files
- `square-revenue.js` — Square Payments API. Paginates all COMPLETED payments. Returns allTime/thisMonth/today revenue + job counts + 7-day history array. Amounts converted from cents to dollars.
- `webflow-posts.js` — Webflow Collections API. Paginates all items. Returns published/draft/archived/total counts.
- `google-ads.js` — Google Ads REST API via OAuth2. 15-minute in-memory cache. 4 GAQL queries (month spend, week spend, 30-day daily, campaign detail). Falls back to hardcoded data if API credentials missing or fail. `allTimeSpend` is always hardcoded ($350K).
