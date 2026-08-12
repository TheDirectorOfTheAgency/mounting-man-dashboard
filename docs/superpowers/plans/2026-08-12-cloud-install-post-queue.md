# Cloud Installation-Post Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private, phone-first cloud workflow that binds one installation photo to one immutable Square seed and publishes through the deterministic installation-post pipeline without an M1 or Codex thread.

**Architecture:** Vercel/Upstash remains authoritative. The existing Discord notification receives a job-scoped signed capability in the *fragment* of a `/install-posts/open#<capability>` bootstrap link; the page exchanges it once through a POST body for a narrowly scoped HttpOnly session cookie and scrubs the fragment, so no operator credential ever reaches a URL path, query string, referrer, or access log. That page is a minimal mobile card where safe facts can be corrected, the browser converts the photo to bounded WebP and uploads directly through Webflow’s signed asset upload, and an explicit Publish creates an immutable receipt and dispatches a pinned GitHub Actions cloud runner. The runner consumes only an opaque job/revision reference, verifies hashes, runs the packaged canonical publisher, verifies the public URL, and reports sanitized per-destination results.

**Tech Stack:** Next.js 14 Pages Router, React 18, Upstash Redis REST, Web Crypto/Node crypto, Webflow v2 API, GitHub Actions, Python 3.12, Pillow/requests, Node test runner.

## Global Constraints

- No Linear, copied JSON, Codex conversation, or always-on M1 in the normal path.
- Bind by opaque job ID plus revision; never by recency, customer name, title, or filename.
- Browser/API payloads contain only safe installation facts; no name, full address, phone, email, payment IDs, or permanent credentials.
- Any seed/photo mutation invalidates approval.
- Duplicate clicks, retries, and concurrent workers must produce at most one live post.
- Queue acknowledgement is not success; only publisher output plus public URL read-back is success.
- Historical records remain unapproved.
- Production credentials remain in Vercel/GitHub secret stores and never appear in logs or command arguments.

---

### Task 1: Pure queue protocol and signed capability

**Files:**
- Create: `lib/install-post-queue.mjs`
- Create: `tests/install-post-queue.test.mjs`

**Interfaces:**
- Produces `safeSeed`, `cardLabel`, `canonicalRevision`, `signJobCapability`, `verifyJobCapability`, `signOperatorSession`, `verifyOperatorSession`, `transitionRecord`, and `sanitizePublishResult`.
- Capability and session tokens are separately versioned inside the signed material, so neither can be replayed as the other.
- `buildOperatorLinks` emits `<base>/install-posts/open#<capability>` — the capability is in the fragment, never in the path or query.

- [ ] Write failing tests proving field allowlisting, recognizable labels, deterministic revision hashes, token expiry/tamper rejection, approval invalidation, duplicate lease rejection, and result redaction.
- [ ] Run `node --test tests/install-post-queue.test.mjs` and confirm failures are caused by missing behavior.
- [ ] Implement the minimal protocol.
- [ ] Re-run the focused test and confirm all pass.

### Task 2: Upstash store and job staging integration

**Files:**
- Create: `lib/install-post-store.mjs`
- Modify: `pages/api/webhooks/square-payment.js`
- Modify: `pages/api/cron/square-install-post-seed.js`
- Modify: `pages/api/install-post/pending.js`
- Modify: relevant existing webhook tests

**Interfaces:**
- Produces atomic read/write/claim helpers and a staging helper that stores one normalized record per candidate TV.

- [ ] Add failing tests for recursive legacy decode, one record per TV, unapproved historical import, atomic lease behavior, and no customer/payment fields in mobile records.
- [ ] Run focused tests and verify RED.
- [ ] Implement normalized staging and atomic claim semantics using Upstash REST transactions/conditional operations.
- [ ] Re-run focused tests and verify GREEN.

### Task 3: Mobile job page and direct asset upload

**Files:**
- Create: `pages/install-posts/open.js`
- Create: `pages/api/install-post/session.js`
- Create: `pages/api/install-post/mobile.js`
- Create: `pages/api/install-post/upload.js`
- Create: `lib/install-post-session.mjs`
- Create: `styles/InstallPostQueue.module.css`
- Create: `lib/install-post-photo-client.mjs`
- Create: focused API/UI tests

**Interfaces:**
- The page reads the capability from `location.hash`, POSTs it once to `/api/install-post/session`, and scrubs the fragment with `history.replaceState` in the same tick.
- The session endpoint issues `__Secure-mm-install-post` — `HttpOnly; Secure; SameSite=Strict; Path=/api/install-post` — expiring at the capability's own `exp`.
- Every other route is tokenless and authenticates on that cookie alone; the exchange and all mutations also require a same-origin `Origin`.
- GET returns only safe record/card state.
- PATCH applies safe corrections and creates a new revision.
- POST upload-init validates revision and returns a job-scoped Webflow signed-upload payload.
- Browser converts to WebP under the configured byte/dimension bounds before direct upload.

- [ ] Add failing tests for missing/tampered/expired session, capability replayed as a cookie or query value, foreign Origin on every mutation, cookie flags and path, stale revision rejection, safe correction allowlist, MIME/size validation, and exact job binding.
- [ ] Verify RED.
- [ ] Implement the minimal black mobile card, camera input, client WebP conversion, direct upload, preview, and correction form.
- [ ] Verify focused tests and render/build checks GREEN.

### Task 4: Explicit approval and cloud dispatch

**Files:**
- Create: `pages/api/install-post/publish.js`
- Create: `lib/install-post-dispatch.mjs`
- Create: `.github/workflows/publish-install-post.yml`
- Create: `cloud/install-post-runner/runner.py`
- Create: `cloud/install-post-runner/requirements.txt`
- Create: runner tests

**Interfaces:**
- Publish endpoint atomically creates an approval receipt for exact hashes and dispatches one workflow with opaque job/revision only.
- Runner fetches the approved envelope through a signed internal endpoint, rejects mismatched hashes, publishes, verifies, and posts a signed callback.

- [ ] Add failing tests for duplicate publish taps, changed photo/seed after approval, concurrent claims, callback signature, timeout/indeterminate state, and sanitized results.
- [ ] Verify RED.
- [ ] Package the smallest cloud-safe subset of the canonical publisher, preserving house copy, mount accuracy, Webflow image/item creation, fingerprint idempotency, and public URL verification.
- [ ] Implement GitHub dispatch/callback with exact revision and retry reconciliation.
- [ ] Verify focused Node/Python tests GREEN.

### Task 5: Notification handoff and operator feedback

**Files:**
- Modify: `pages/api/webhooks/square-payment.js`
- Modify: `pages/api/cron/square-install-post-seed.js`
- Modify: relevant notification tests

**Interfaces:**
- Discord message includes recognizable label and one `Add photo & publish` URL per TV, each carrying its capability only in the URL fragment; no raw JSON or customer details in the new operator block.

- [ ] Add failing tests for multi-TV link separation, safe labels, no capability in any generated path or query, and no full address/name/IDs in operator links/messages.
- [ ] Verify RED.
- [ ] Implement links and state feedback.
- [ ] Verify focused tests GREEN.

### Task 6: Full verification, deployment, canary, and cutover

**Files:**
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-08-12-cloud-install-post-queue-design.md`
- Modify: installation-post skill and `~/vault-local/Context/scripts-registry.md` after live proof

**Interfaces:**
- Produces sanitized deployment/canary receipt and rollback commands.

- [ ] Run `npm test`, Python runner tests, `npm run build`, secret/PII scans, and inspect the final diff.
- [ ] Run independent blocker-focused review against the final candidate; fix blockers test-first and rerun all checks.
- [ ] Configure repository/Vercel/GitHub secret presence without printing values and deploy the exact revision.
- [ ] With M1 not participating, run two similar synthetic jobs and reverse-order photos; prove exact pairing and duplicate suppression without live publishing.
- [ ] Run one selected live canary, verify the public URL and image, replay Publish, and prove no duplicate.
- [ ] Only after proof, unload `ai.theagency.codex-install-post-relay`, update the canonical skill/registry, and retain rollback instructions.
