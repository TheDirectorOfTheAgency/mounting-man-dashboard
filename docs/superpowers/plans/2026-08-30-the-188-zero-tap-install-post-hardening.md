# THE-188 Zero-Tap Installation-Post Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flawed PR #22 LinkedIn and GBP behavior with a verified zero-Grok-shell cloud publisher plus a narrowly scoped, source-controlled M1 GBP adapter.

**Architecture:** GitHub Actions owns website, Instagram, Facebook, LinkedIn, and X. LinkedIn uses a JPEG rendition with the current versioned Images/Posts APIs and accepts either documented Post-ID URN form without readback. Vercel/Upstash owns independent GBP Update/Photos state and expiring per-surface leases; the M1 polls that API, supplies strict UI evidence, and never owns queue truth.

**Tech Stack:** Next.js 14 Pages Router, Node test runner, Upstash Redis via `@vercel/kv`, GitHub Actions, Python 3.12, requests, Pillow, Playwright with the existing M1 Chrome profile, launchd.

## Global Constraints

- Never Reddit.
- Never Grok Bot shell execution or approval-card dependency.
- Never automate the GBP UI from GitHub Actions/Vercel.
- Never upload WebP to LinkedIn; use a real JPEG rendition.
- Use `Linkedin-Version: 202608` and `X-Restli-Protocol-Version: 2.0.0` on current LinkedIn API calls.
- LinkedIn success is HTTP 201 plus `x-restli-id` matching `urn:li:share:*` or `urn:li:ugcPost:*`; do not perform token-incompatible image/post GET verification.
- GBP remains pending until Update is `posted` or `pending_review` and Photos is `posted` with proof.
- Every GBP claim is per surface, expiring, token-bound, and conflict-safe.
- Unknown GBP statuses and schema mismatches fail closed.
- An indeterminate create is reconciled before retry.
- No NAP, website, hours, phone, address, customer data, or credentials are changed or logged.
- The existing checkout is a linked worktree; preserve unrelated branches and commits.

---

### Task 1: Current LinkedIn Images/Posts publisher

**Files:**
- Modify: `cloud/install-post-runner/publisher/social.py`
- Modify: `cloud/install-post-runner/tests/test_social.py`
- Modify: `cloud/install-post-runner/requirements.txt`
- Modify: `cloud/install-post-runner/requirements-dev.txt`
- Modify: `.github/workflows/publish-install-post.yml`
- Modify: `.env.example`

**Interfaces:**
- Produces `linkedin_jpeg_bytes(image_bytes: bytes) -> bytes`.
- `SocialPublisher._linkedin(...) -> str` returns the documented Post ID from `x-restli-id`.
- The workflow consumes optional `LINKEDIN_VERSION`, defaulting to `202608` in code.

- [ ] **Step 1: Replace the existing PR assertions with failing contract tests.**
  - Assert a WebP fixture becomes bytes beginning `FF D8 FF`.
  - Assert upload uses `Content-Type: image/jpeg` and a `.jpg` filename.
  - Assert calls are `POST /rest/images?action=initializeUpload`, upload `PUT`, then `POST /rest/posts`.
  - Assert both `urn:li:share:*` and `urn:li:ugcPost:*` 201 receipts are accepted.
  - Assert no LinkedIn GET occurs.
  - Assert malformed/missing receipt is retryable and a non-person author is blocked.
- [ ] **Step 2: Run `python -m pytest -q cloud/install-post-runner/tests/test_social.py` and verify RED because legacy endpoints/receipt rules remain.**
- [ ] **Step 3: Implement JPEG conversion and current API payloads.**
  - Initialize with `{ "initializeUploadRequest": { "owner": author } }`.
  - Create Post with `author`, `commentary`, `visibility: "PUBLIC"`, `distribution.feedDistribution: "MAIN_FEED"`, `content.media.id`, `lifecycleState: "PUBLISHED"`, and `isReshareDisabledByAuthor: false`.
  - Remove legacy asset polling and UGC readback.
- [ ] **Step 4: Pin Pillow with hash checking and update the workflow install path without weakening `--require-hashes`.**
- [ ] **Step 5: Run focused Python tests and `python -m compileall -q cloud/install-post-runner`; verify GREEN.**
- [ ] **Step 6: Commit with `fix: use current LinkedIn image post APIs`.**

### Task 2: Atomic per-surface GBP queue protocol

**Files:**
- Modify: `lib/install-post-gbp-queue.mjs`
- Modify: `pages/api/install-post/gbp.js`
- Modify: `tests/install-post-gbp-queue.test.js`
- Modify: `.env.example`

**Interfaces:**
- `queue.claim(slug, { surface, workerId, now }) -> { ok, item, leaseToken }`.
- `queue.complete(slug, { surface, status, proof, leaseToken, error, now }) -> { ok, item }`.
- `queue.heartbeat({ workerId, version, now }) -> { ok, heartbeat }`.
- Queue adapter additionally requires `eval(script, keys, args)` for compare-and-delete lock release; tests provide a deterministic fake.

- [ ] **Step 1: Add failing queue tests.**
  - Concurrent Update and Photos completions retain both results.
  - Live lease blocks a second claim; expired lease can be reclaimed.
  - Missing/wrong lease token is rejected.
  - Unknown status, Photos `pending_review`, and `posted` without proof are rejected.
  - Pending index removes only after both surfaces complete.
  - Completed/missing stale members are removed.
  - Heartbeat stores only worker ID, version, and timestamp.
- [ ] **Step 2: Run `node --test tests/install-post-gbp-queue.test.js` and verify RED for the missing lease/atomic behavior.**
- [ ] **Step 3: Implement token-owned item locks, per-surface leases, strict report validation, derived aggregate state, index cleanup, and heartbeat.**
- [ ] **Step 4: Update API actions to `claim`, `complete`, and `heartbeat`; reject old ambiguous completion except a documented legacy Update-only compatibility request.**
- [ ] **Step 5: Run focused Node tests and `node --check` on the queue and API route; verify GREEN.**
- [ ] **Step 6: Commit with `fix: serialize GBP surface state`.**

### Task 3: Source-controlled M1 GBP remote adapter

**Files:**
- Create: `m1/gbp-worker/gbp_worker.py`
- Create: `m1/gbp-worker/tests/test_gbp_worker.py`
- Create: `m1/gbp-worker/com.themountingman.gbp-worker.plist`
- Create: `scripts/install-gbp-worker-m1.sh`
- Modify: `.env.example`

**Interfaces:**
- `DashboardQueueClient.pull()`, `.claim(slug, surface)`, `.complete(...)`, and `.heartbeat()` use Bearer auth and never log the secret.
- `classify_update_evidence(evidence) -> posted|pending_review|indeterminate|retryable_failure`.
- `classify_photos_evidence(evidence) -> posted|indeterminate|retryable_failure`.
- `next_missing_surface(item) -> update|photos|None` processes one surface per fresh browser session.

- [ ] **Step 1: Add failing worker tests.**
  - API payload/auth redaction and schema validation.
  - HTTPS allowlisted image download with type/size/hash checks.
  - Update refuses missing image preview, Learn More, CTA URL, or explicit submission evidence.
  - Photos refuses file-selection-only, blank-dialog, or no-gallery-confirmation evidence.
  - Pending-review Update leaves Photos next.
  - Posted Update is never recreated while Photos retries.
  - Post-click timeout reports indeterminate and requires reconciliation.
  - Wrong Google account fails closed.
- [ ] **Step 2: Run `python -m unittest -v m1/gbp-worker/tests/test_gbp_worker.py` and verify RED because the adapter does not exist.**
- [ ] **Step 3: Port only the proven Chrome/session/navigation primitives from the active local worker; replace local file ownership with the remote client and strict evidence classifiers.**
- [ ] **Step 4: Add bounded retry/backoff before click, no blind retry after click, sanitized screenshots, and heartbeat.**
- [ ] **Step 5: Add an installer that atomically backs up the active worker, copies the source-controlled worker/plist, validates syntax, reloads launchd, and supports rollback. Never embed credentials.**
- [ ] **Step 6: Run worker unit tests, `python -m py_compile`, plist validation, and a no-publish `--check-session`/`--dry-run` smoke; verify GREEN.**
- [ ] **Step 7: Commit with `feat: add remote GBP surface worker`.**

### Task 4: Deployment gates, integration verification, and release

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/verify-install-post-release.mjs`
- Modify: `pages/api/health.js`
- Modify: `tests/health-endpoint.test.js`
- Modify: relevant install-post intake tests
- Modify: `docs/superpowers/specs/2026-08-30-the-188-zero-tap-install-post-hardening-design.md`

**Interfaces:**
- CI runs Node tests/build plus Python runner and M1 worker tests.
- Release verifier checks deployed commit, GBP endpoint auth behavior, GitHub workflow availability, and sanitized M1 heartbeat without publishing.

- [ ] **Step 1: Add failing tests/source guards proving no Reddit and no Grok Bot/M1 shell fallback in the zero-tap intake path.**
- [ ] **Step 2: Add CI and release verifier; update health response only with safe deployment identity.**
- [ ] **Step 3: Run `npm test`, both Python suites, `npm run lint`, `npm run build`, syntax/config checks, and secret/PII source scans.**
- [ ] **Step 4: Generate a whole-branch review package and obtain an independent spec/code-quality review; fix all Critical/Important findings test-first.**
- [ ] **Step 5: Push the branch and update PR #22; require green checks before merge.**
- [ ] **Step 6: Verify required GitHub/Vercel/M1 secret presence without printing values. Create missing worker secret once and inject it through secret stores only.**
- [ ] **Step 7: Merge/deploy only after protected-action approval; verify production health equals the merge SHA, unauthenticated GBP returns 401, authenticated pull succeeds, and heartbeat is current.**
- [ ] **Step 8: Run synthetic concurrent/partial/indeterminate queue canaries with no public posting and prove idempotency.**
- [ ] **Step 9: Obtain explicit approval for one real public canary; verify website, Instagram, Facebook, LinkedIn, X, GBP Update, and GBP Photos, then replay and prove zero duplicates.**
- [ ] **Step 10: Update the canonical installation-post skill and script registry only after live proof; retain rollback commands and the previous M1 worker backup.**
