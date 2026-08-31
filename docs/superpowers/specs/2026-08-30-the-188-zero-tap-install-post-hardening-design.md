# THE-188 Zero-Tap Installation-Post Hardening Design

## Goal

Make a Square-paid installation plus a dropped photo publish the verified website and configured social destinations without Grok Bot shell execution, while leaving the M1 responsible only for Google Business Profile browser automation.

## Approved operator experience

1. Square stages one sanitized, immutable record per TV.
2. If the record has no photo, Grok Bot asks for the photo only.
3. Dropping the photo binds it to the exact job ID and revision through the existing upload/commit API.
4. The commit dispatches the existing GitHub Actions runner; Grok Bot never runs `go.py`, `publish_one.py`, or an M1 shell command.
5. The runner publishes and records independent receipts for website, Instagram, Facebook, LinkedIn, and X. Reddit is absent.
6. After the verified website publish, the dashboard queues two GBP surfaces: an Update and an independent Photos-tab upload.
7. The M1 worker claims and reports each GBP surface independently. The queue closes only after the Update is accepted (`posted` or `pending_review`) and the Photos upload is verified `posted`.

Grok Bot Auto-review is not a pipeline dependency. It may remain off, but turning it on cannot create a second execution path.

## Architecture

### Cloud publisher

GitHub Actions remains the sole publisher for website, Instagram, Facebook, LinkedIn, and X. Existing per-destination receipts prevent successful destinations from being repeated after a partial failure.

LinkedIn moves from legacy `/v2/assets` plus `/v2/ugcPosts` to the current versioned APIs:

1. Create a LinkedIn-safe JPEG rendition from the bound WebP bytes.
2. `POST /rest/images?action=initializeUpload` with the personal `urn:li:person:*` owner.
3. `PUT` the JPEG bytes to the returned upload URL.
4. `POST /rest/posts` with `content.media.id` set to the returned `urn:li:image:*`, `lifecycleState=PUBLISHED`, `visibility=PUBLIC`, and `distribution.feedDistribution=MAIN_FEED`.
5. Accept only HTTP 201 plus an `x-restli-id` that is either `urn:li:share:*` or `urn:li:ugcPost:*`. Both are valid Post IDs according to LinkedIn's Posts API.

The current token is write-only (`w_member_social`). The publisher must not make post or image GET calls that require `r_member_social`. A successful create receipt is acceptance; first-canary UI visibility is a release check, not a per-publish API dependency.

### GBP queue

The dashboard owns durable state. Every queue item has:

- immutable `jobId`, `revision`, `slug`, image URL/hash, caption, CTA URL, and queued timestamp;
- `surfaces.update` and `surfaces.photos`, each with status, proof, attempt metadata, and last error;
- one expiring lease per surface, identified by an opaque lease token;
- aggregate state derived from surfaces, never stored as an independent source of truth.

Valid surface statuses are `pending`, `claimed`, `pending_review`, `posted`, `retryable_failure`, and `indeterminate`. Photos may not use `pending_review` as completion. Unknown status values fail closed.

Claim and completion mutations are serialized by a per-item lock. The lock uses a random owner token, short expiry, and compare-and-delete release. A completion request must present the matching surface lease token. A second claim while a live lease exists returns conflict; an expired lease may be reclaimed.

A job stays indexed as pending until both surfaces satisfy completion. Completed and missing records are removed from the pending index. Historical `posted` records with no surface receipts remain legacy-complete for compatibility but are tagged as legacy rather than inventing modern proof.

### M1 adapter

The M1 contains only:

- the authenticated Chrome profile for `mntvmounting@gmail.com`;
- a source-controlled worker installed from this repository;
- a dashboard worker secret.

The worker polls `/api/install-post/gbp`, downloads only allowlisted HTTPS image hosts with content-type and size limits, and claims one missing surface at a time.

Update acceptance requires all of the following before submission:

- caption filled;
- bound image preview visible;
- `Learn more` selected;
- exact CTA URL visible in the CTA field;
- explicit Google submission evidence after click.

Photos acceptance requires:

- image preview visible;
- explicit upload/submit action;
- dialog success/closure evidence;
- recent-gallery reconciliation or another unambiguous Google confirmation.

A timeout after clicking is `indeterminate`, not retryable. The worker reconciles before any second create attempt. It reports only the surface it actually processed and never moves local files as the authoritative completion mechanism.

The launchd interval remains bounded polling. A heartbeat records worker version and last successful poll so the cloud can distinguish an empty queue from a dead adapter.

### Deployment and observability

Production health exposes the deployed commit only. Release gates require:

- GitHub branch tests and build green;
- Vercel production health equals the merged commit;
- unauthenticated GBP endpoint returns 401, not 404;
- authenticated empty pull succeeds;
- M1 heartbeat is current;
- dry-run failure-mode tests prove no duplicate create after timeout or concurrent completion;
- one explicitly approved live canary verifies LinkedIn on the personal Posts surface and both GBP surfaces.

No production secret is printed, committed, passed in a URL, or included in workflow inputs.

## Error handling

- External 401/403 is `blocked`; do not loop.
- External 409/429/5xx before create acceptance is retryable with bounded backoff.
- Network loss after a create click/request is `indeterminate`; reconcile before retry.
- A failed destination never erases successful destination receipts.
- A failed GBP surface never marks the other surface complete.
- Worker/API schema mismatch fails closed and leaves the item pending.

## Safety invariants

- Never Reddit.
- Never let GitHub Actions automate the Google Business Profile UI.
- Never let Grok Bot shell into the M1 for install-post publishing.
- Never infer GBP Photos success from Update success, file selection, dialog navigation, or absence of an error string.
- Never infer LinkedIn failure from a `urn:li:share:*` receipt.
- Never use LinkedIn WebP bytes; upload a real JPEG rendition.
- Never retry an indeterminate create without reconciliation.
- Never mutate GBP website, NAP, hours, phone, or address.

## Verification and acceptance

Automated verification must cover:

- WebP-to-JPEG signature and `image/jpeg` upload;
- current LinkedIn Images/Posts endpoints, version headers, person author, image payload, 201 receipt, and no readback;
- share and ugcPost receipts both accepted;
- concurrent GBP surface completions retain both results;
- live lease conflict and expired lease reclaim;
- wrong/missing lease rejection;
- unknown status rejection;
- pending index cleanup only after both surfaces complete;
- strict M1 Update and Photos evidence classifiers;
- missing-surface-only retry and indeterminate reconciliation;
- source scans proving no Reddit or Grok Bot/M1 shell fallback;
- full Node tests, Python tests, lint, and Next.js build.

Release acceptance is one real job that produces exactly one website item, one configured post per cloud social destination, one GBP Update with photo/caption/Learn More CTA, and one independent GBP Photos image. Replaying the same job must create nothing new.
