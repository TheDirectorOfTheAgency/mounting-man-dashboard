# Review loop go-live (TMM play #2)

Staging-only until Marshall approves production merge. Nothing sends or posts automatically until env flags and per-item approvals are in place.

## What ships

1. **Review requests** — Square `payment.*` / completed payments stage an email draft in Vercel KV (idempotent per `paymentId`). Status: `staged` → `approved` → `sent` | `skipped`. **No SMS.**
2. **Reply drafts** — Daily cron (`/api/cron/review-reply-drafts`, ~7 PM America/Chicago via `0 0 * * *` UTC) pulls new Google reviews via Places (`get_new_reviews` logic) and stores reply drafts. Yelp is stubbed with a TODO. **Nothing is posted to Google or Yelp.**

## Required environment variables

| Variable | Required for | Notes |
|----------|----------------|-------|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Staging + drafts | Same Upstash KV as attribution / install-post dedup |
| `GOOGLE_REVIEW_URL` | Staging review requests | Staging **refuses** if missing |
| `GOOGLE_PLACES_API_KEY` + `GOOGLE_PLACE_ID` | Reply draft cron | Cron degrades gracefully if missing |
| `CRON_SECRET` | Cron auth | `Authorization: Bearer $CRON_SECRET` |
| `MCP_SQUARE_PAYROLL_SECRET` | Grok/car MCP tools | Same as other mounting-man MCP routes |

### Optional (email send on approve)

| Variable | Default | Notes |
|----------|---------|-------|
| `REVIEW_REQUEST_SEND_ENABLED` | off | Must be `true` **and** item `approved` to send |
| `RESEND_API_KEY` | — | Resend REST API |
| `REVIEW_REQUEST_FROM_EMAIL` | — | e.g. `Marshall <hello@themountingman.com>` |

The app does **not** currently wire Gmail API or Zapier send for review requests; Resend is the implemented channel. Marshall can still copy the staged `emailBody` from the MCP list and send manually while `REVIEW_REQUEST_SEND_ENABLED` is off.

## Operator approval (Grok / car MCP)

Connector: `mounting-man-zenbooker` on `https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-zenbooker`

Auth: `Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET>` (or OAuth PKCE flow already configured for Grok).

| Tool | Action |
|------|--------|
| `list_staged_review_requests` | Read queue (`status` defaults to `staged`) |
| `approve_review_request` | `{ "payment_id": "..." }` — sends only if send flag on |
| `skip_review_request` | `{ "payment_id": "..." }` |
| `list_review_reply_drafts` | Read reply drafts (`status` defaults to `draft`) |
| `approve_review_reply_draft` | `{ "review_id": "...", "source": "google" }` — marks approved; **does not post** |
| `skip_review_reply_draft` | Same ids |

## Policy reminders

- Ask **every** paid customer the same neutral way (no sentiment gating, no incentives).
- Reply drafts are personal; low-star drafts apologize and invite offline resolution.

## Flip-on checklist

1. Set `GOOGLE_REVIEW_URL` in Vercel (production preview/staging first).
2. Confirm KV connected to the project.
3. Deploy branch to staging; trigger a test Square payment or use `scripts/review-loop-dry-run.mjs` locally.
4. In Grok, run `list_staged_review_requests` and approve one test with `skip_review_request` or `approve_review_request` while send flag is **off**.
5. Configure Resend domain + `RESEND_API_KEY` + `REVIEW_REQUEST_FROM_EMAIL`.
6. Set `REVIEW_REQUEST_SEND_ENABLED=true` only when ready for automatic email on approve.
7. Set `GOOGLE_PLACES_API_KEY` + `GOOGLE_PLACE_ID`; verify cron via `curl -H "Authorization: Bearer $CRON_SECRET" https://<preview>/api/cron/review-reply-drafts`.
8. Review `list_review_reply_drafts` daily; paste approved replies into Google Business Profile manually (until a future GBP write path exists).

## Dry run

```bash
GOOGLE_REVIEW_URL=https://g.page/r/.../review node scripts/review-loop-dry-run.mjs
```

Sample output (redacted): `docs/review-loop-dry-run-sample.md`.
