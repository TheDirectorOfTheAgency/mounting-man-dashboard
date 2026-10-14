# Review request go-live (TMM play #2)

Staging-only until Marshall approves production merge. **Review replies are out of scope** — Marshall handles Google/Yelp replies himself. This feature only stages neutral post-payment review **request** emails for approval.

## What ships

**Review requests** — Square completed payments stage an email draft in Vercel KV (idempotent per `paymentId`) when `GOOGLE_REVIEW_URL` is set and the customer has email. Status: `staged` → `approved` → `sent` | `skipped`. **No auto-send by default. No SMS.**

Email sends only when both are true:

1. `REVIEW_REQUEST_SEND_ENABLED=true` (defaults off)
2. Operator runs `approve_review_request` for that `payment_id`

## Required environment variables

| Variable | Required for | Notes |
|----------|----------------|-------|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Staging queue | Same Upstash KV as attribution / install-post dedup |
| `GOOGLE_REVIEW_URL` | Staging | Webhook **refuses** to stage if missing |
| `MCP_SQUARE_PAYROLL_SECRET` | Grok/car MCP tools | Same as other mounting-man MCP routes |

### Optional (email send on approve)

| Variable | Default | Notes |
|----------|---------|-------|
| `REVIEW_REQUEST_SEND_ENABLED` | off | Must be `true` **and** item `approved` to send |
| `RESEND_API_KEY` | — | Resend REST API |
| `REVIEW_REQUEST_FROM_EMAIL` | — | e.g. `Marshall <hello@themountingman.com>` |

Resend is the implemented send channel. With the send flag off, copy `emailBody` from `list_staged_review_requests` (`include_email: true`) and send manually.

## Operator approval (Grok / car MCP)

Connector: `mounting-man-zenbooker` — `https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-zenbooker`

Auth: `Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET>` (or existing OAuth PKCE for Grok).

| Tool | Action |
|------|--------|
| `list_staged_review_requests` | Read queue (`status` defaults to `staged`) |
| `approve_review_request` | `{ "payment_id": "..." }` — sends only if send flag on |
| `skip_review_request` | `{ "payment_id": "..." }` |

## Policy

- Ask **every** paid customer the same neutral way (no sentiment gating, no incentives).

## Flip-on checklist

1. Set `GOOGLE_REVIEW_URL` on staging/preview.
2. Confirm KV on the Vercel project.
3. Deploy PR preview; complete a test payment or run `scripts/review-loop-dry-run.mjs`.
4. Grok: `list_staged_review_requests` → `skip_review_request` or `approve_review_request` while `REVIEW_REQUEST_SEND_ENABLED` is **off**.
5. When ready for auto-send on approve: Resend domain, `RESEND_API_KEY`, `REVIEW_REQUEST_FROM_EMAIL`, then `REVIEW_REQUEST_SEND_ENABLED=true`.

## Dry run

```bash
GOOGLE_REVIEW_URL=https://g.page/r/.../review node scripts/review-loop-dry-run.mjs
```

Sample: `docs/review-loop-dry-run-sample.md`.
