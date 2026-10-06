# Booking attribution identity

Captured acquisition evidence and click IDs may enrich a completed booking only
through its exact `bookingSession` lookup. A customer ID is not booking identity:
a repeat customer's latest capture can belong to another job.

Missing, blank, invalid, unknown, or expired session references return no captured
attribution. The webhook can still use paid evidence and click IDs supplied by the
current booking itself. Without current paid evidence it returns
`NO_PAID_ACQUISITION`; it must not infer paid acquisition from customer history.
Store failures retain the existing retryable response and do not reach the
coordinator. Existing consent/disclosure checks still run before enrichment.

Legacy customer capture keys remain under the existing 90-day TTL and capture
write contract, but are never read for booking attribution. Session-key format,
click-ID retention, consent policy, job mappings and upload deduplication are
unchanged. Existing session records need no migration.

## Release and audit

This change prevents future fallback lookups only after deployment. It does not
repair previously persisted pending-job attribution or uploaded conversions.
Before calling the incident resolved, an authorized operator must audit historical
booking/session-to-job joins and distinguish exact matches from fallback-derived
records. Counts of accepted uploads or skipped orders alone do not establish
which records were affected. Any live correction/backfill requires a separate
reviewed decision; do not replay conversion uploads as part of validating this fix.

Other reported uploader identity, refund, conversion-time, click-selection and
notification issues are outside this focused change.

## Synthetic verification

`npm test` includes store and webhook integration regressions for two bookings by
one customer, missing/blank/unknown sessions, exact older sessions after a newer
capture, repeated delivery, independent webhook evidence, consent denial, KV
failure and retry, and click-ID redaction from responses/logs. No live customer
records, APIs, or conversion uploads are used by these regressions.
