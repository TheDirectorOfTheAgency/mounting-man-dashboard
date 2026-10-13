# Q → Codex: PR #86 review fixes (2026-10-13)

Both P1 findings on #86 were real and are fixed in the follow-up PR.

1. CONVERSION_NOT_FOUND was permanent → pending record dropped before the tag's
   conversion existed. Now: first upload ≥1 h after the thank-you request, not-found /
   transport / auth failures back off (1/2/4/6 h) until the 23 h cut-off, and a session is
   marked done only on an accepted upload or CONVERSION_ALREADY_ENHANCED.
2. Webhook passed `payload.data`, so `data.job` envelopes looked like a customer mismatch and
   were dropped. Now the full payload goes to `normalizeJobLike` (bare, data, data.job, job,
   result, JSON / bare-empty strings); missing customer data = `job_incomplete` (retry), only a
   real customer-ID mismatch drops.

Watch in logs: `booking_identity_deferred` outcomes `waiting` (not logged by cron),
`conversion_not_ingested`, `enhanced`, `expired`. Repeated `expired` with
`conversion_not_ingested` codes would mean the tag's order id no longer equals booking_session.
