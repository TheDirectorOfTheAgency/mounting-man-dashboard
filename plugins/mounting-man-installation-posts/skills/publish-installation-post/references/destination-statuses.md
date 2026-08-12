# Destination status semantics

- `POSTED`: the destination accepted the post and returned a stable receipt.
- `VERIFIED`: the live public result was read back successfully. Website must be
  `VERIFIED` before the aggregate can be published.
- `ALREADY_POSTED`: a matching idempotency receipt already existed.
- `QUEUED`: downstream work is pending. This is not complete.
- `SKIPPED`: allowed only for a destination whose stored manifest marks it as
  not expected, such as SamsungFrameMounting for a non-gallery job.
- `BLOCKED`: configuration, authorization, or a required runtime is absent.
- `TRANSIENT_FAILURE`: retryable only through `retry_failed_destinations`.
- `PERMANENT_FAILURE`: requires repair or a new preview, not blind replay.
- `INDETERMINATE`: the destination might have applied the post. Reconcile; do
  not retry blindly.

Overall `PUBLISHED` requires website `VERIFIED` and every required destination
`POSTED`, `VERIFIED`, or `ALREADY_POSTED`.
