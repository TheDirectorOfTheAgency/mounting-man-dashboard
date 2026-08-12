# Cloud Installation-Post Queue Design

## Goal

Replace the M1/Codex polling relay with a phone-first cloud workflow where each Square-paid job is recognizable, its photo is bound to the exact immutable job record, and an explicit Publish action runs and verifies the deterministic installation-post publisher without an always-on Mac.

## Operator experience

1. Mr. Wayne opens a bookmarked private `/install-posts` page on his phone.
2. Pending cards display the safe facts already resolved from Square: city, street name, TV size, TV brand, mount type, and pre-tax subtotal.
3. He opens one card. Missing or incorrect safe facts can be corrected before upload.
4. He chooses or takes the installation photo inside that selected card.
5. The browser resizes and converts it to WebP before upload. The upload session is bound to the selected immutable job ID and current seed revision.
6. The page displays the photo thumbnail and exact job facts together.
7. Mr. Wayne taps Publish. Any seed or photo change invalidates the old approval and requires another tap.
8. The page shows `Publishing`, then the verified live URL or a specific retryable/blocked error.

No JSON copying, Linear issue, Codex thread, customer name, full address, phone number, or email is part of the operator path.

## Architecture

- Existing Square webhook and Vercel/Upstash pending records remain intake and authoritative workflow state.
- A private Next.js mobile page and API expose only allowlisted job facts and opaque job IDs.
- Authentication uses an owner-only install-post access secret stored in Vercel; it is accepted through a secure same-site session rather than rendered into job data or logs.
- The Discord handoff link is `/install-posts/open#<capability>`. The capability rides in the URL **fragment**, which browsers never transmit, so it appears in no request line, `Referer`, proxy record, or Vercel access log. The page trades it once through a **POST body** to the tokenless `/api/install-post/session`, then scrubs the fragment with `history.replaceState` before any other work — after that the page URL is inert, and a screenshot, a forwarded link, or the back button carries nothing.
- The exchange returns an `HttpOnly; Secure; SameSite=Strict` cookie named `__Secure-mm-install-post`, scoped to `Path=/api/install-post` so no other route on the origin ever receives it. It expires at exactly the capability's own `exp`, so moving the credential out of the URL cannot extend the 48 hour window.
- The capability is not burned on exchange: the Discord link has to keep working for the full 48 hours, including from a second device. Its confidentiality rests on never being transmitted or logged, not on single use.
- `/api/install-post/{mobile,upload,publish}` are tokenless and authenticate on that cookie alone; there is no capability-shaped route path anywhere in the tree. The exchange and every mutation additionally require a same-origin `Origin` header, so `SameSite=Strict` is not the only thing standing between a cross-site page and a publish.
- The browser performs bounded WebP conversion, then uploads through the job API. The API verifies content type, size, job identity, and seed revision before storing the asset and image hash.
- Publish creates an immutable revision receipt covering job ID, canonical seed hash, image hash, and approved timestamp.
- A cloud runner receives only the opaque job ID/revision, loads the exact approved seed and image, invokes the canonical deterministic publisher with `--art-mode never`, and writes the verified live URL/result back to Upstash.
- The M1 relay remains active only until the cloud route passes live canary verification, then it is unloaded and retired.

## Workflow states

`AWAITING_PHOTO → READY → PUBLISHING → VERIFYING → PUBLISHED`

Failures are `RETRYABLE_FAILURE`, `BLOCKED`, or `INDETERMINATE`. A timeout after a destination may have accepted the post is indeterminate and must reconcile by deterministic slug/fingerprint before retrying.

## Safety invariants

- Bind by opaque job ID and revision, never by recency, title, customer name, or filename.
- Store and display only city, sanitized street name, installation facts, price, technician, hashes, timestamps, and destination receipts.
- Any seed/photo change creates a new revision and invalidates approval.
- One atomic publish lease per job revision; duplicate taps and webhook retries cannot create a second publish.
- Success requires publisher output plus public URL read-back; queue acknowledgement is not success.
- Historical pending records import as unapproved and never auto-publish.
- No operator credential ever occupies a URL path or query string, so nothing that logs URLs can capture one.
- Production credentials stay server-side and never enter browser payloads, issue trackers, GitHub logs, or command arguments.

## Cloud execution

The first production runner is Google Cloud Run in the existing billed `mounting-man-dashboard` project. It packages the canonical Python publisher and dependencies, receives a signed internal request, and uses Secret Manager environment bindings. The normal website publish path is cloud-native. Platforms that require an interactive local browser worker remain independently reported rather than being falsely marked published.

## Verification

- Unit tests: safe card labels, recursive pending-record decoding, auth, field allowlist, revision hashing, approval invalidation, duplicate publish lease, stale upload rejection, and result sanitization.
- Capability-leak tests: the operator URL carries the capability only after `#`; no route file is path-parameterized; a capability presented as a cookie or query string authenticates nothing; the session cookie's flags, path, and expiry; foreign/absent/opaque `Origin` refused on the exchange and every mutation.
- Integration tests: two similar jobs, reverse-order photo upload, duplicate Publish requests, timeout/retry reconciliation, and modified seed/photo after approval.
- Build: full test suite and Next.js production build.
- Cloud canary: M1 offline, synthetic queue records, two distinct photos, no live publish.
- Live canary: one explicitly selected real job, public URL HTTP 200/read-back, duplicate Publish suppressed.
- Cutover: only after canaries pass; then unload the M1 Codex relay and update the script registry and installation-post skill.

## Acceptance criteria

- Phone flow requires selecting a recognizable card, adding a photo, and tapping Publish.
- No desktop, Linear, GitHub UI, Codex conversation, or copied JSON is required.
- M1 power/state does not affect queue intake, upload, publish, or verification.
- Zero wrong photo/job pairings and zero duplicate posts in the two-job adversarial test.
- Every result is visible as verified URL, retryable error, blocked error, or indeterminate state.
