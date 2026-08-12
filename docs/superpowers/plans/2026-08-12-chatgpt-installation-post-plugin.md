# ChatGPT Installation-Post Plugin Implementation Plan

**Issue:** THE-144
**Design:** `docs/superpowers/specs/2026-08-12-chatgpt-installation-post-plugin-design.md`

## Goal

Build a private, production-disabled ChatGPT plugin/MCP adapter over the existing installation-post queue. Prove safe pending-job resolution, server-side photo handling, immutable preview/approval contracts, and complete destination status semantics with synthetic fixtures. Leave Discord, the M1/local relay, production routes, and real customer content untouched.

## Global constraints

- One primary writer in the isolated `codex/the-144-chatgpt-installation-post-plugin` worktree.
- No deployment, public/workspace publishing, credential/auth changes, real external publication, production cutover, Discord change, or M1 retirement.
- New transport code fails closed when OAuth or publisher adapters are unavailable.
- ChatGPT never supplies destinations/captions at execution time.
- Tests use synthetic facts/images and fake stores/providers only.
- Existing browser and Discord behavior remains regression-covered.

## Task 1: Freeze audit and architecture gates

**Create:**

- `docs/superpowers/specs/2026-08-12-chatgpt-installation-post-plugin-design.md`
- `docs/superpowers/plans/2026-08-12-chatgpt-installation-post-plugin.md`

**Verification:**

```bash
rg -n "Approaches considered|Reused unchanged|OpenAI capability gate|Current blockers" \
  docs/superpowers/specs/2026-08-12-chatgpt-installation-post-plugin-design.md
git diff --check
```

## Task 2: Add immutable manifest and approval protocol

**Modify:**

- `lib/install-post-queue.mjs`
- `lib/install-post-store.mjs`
- `tests/install-post-queue.test.mjs`
- `tests/install-post-store.test.mjs`

**Interfaces:**

- `DESTINATION_MANIFEST_VERSION`
- `DEFAULT_INSTALL_POST_DESTINATIONS`
- `buildDestinationManifest(seed)`
- `buildPreviewManifest({ jobId, factsRevision, photo, website, captions, destinations })`
- `canonicalManifestHash(manifest)`
- `createApprovalNonce()` / `hashApprovalNonce()`
- `transitionRecord` events for preview, approval-nonce consumption, destination receipt, and retry claim
- Store helpers for one-time nonce/manifest claims and audit receipts

**Tests first:**

- Website plus required social destinations are in the ordered manifest; gallery Reddit is conditional; Pinterest is explicitly unsupported.
- Any facts/photo/copy/caption/destination change changes the manifest hash and invalidates approval.
- Expired/replayed nonce is refused.
- Webflow verified with one social failure is not overall success.
- Destination receipt statuses are closed to the issue vocabulary.
- Successful destinations cannot be retried; transient/indeterminate ones can be claimed once.

**Verification:**

```bash
node --import tsx --test tests/install-post-queue.test.mjs tests/install-post-store.test.mjs
```

## Task 3: Extract transport-neutral queue services and natural matching

**Create:**

- `lib/install-post-service.mjs`
- `tests/install-post-service.test.mjs`

**Modify only if needed to delegate without behavior change:**

- `pages/api/install-post/mobile.js`
- `pages/api/install-post/upload.js`
- `pages/api/install-post/publish.js`

**Interfaces:**

- `listPendingInstallations({ cursor, limit })`
- `getInstallationJob({ jobId })`
- `resolveInstallationReference({ reference, filters })`
- `bindPreparedInstallationPhoto({ jobId, revision, preparedPhoto, actor })`
- `saveInstallationPreview({ jobId, revision, preview, actor })`
- `approveInstallationManifest({ jobId, manifestId, approvalNonce, actor })`
- `getInstallationPublishStatus({ jobId, manifestId })`
- `retryFailedDestinations({ jobId, manifestId, destinations, actor })`

**Tests first:**

- One/multiple pending jobs and stable pagination.
- Unique and ambiguous Susan Drive.
- Same size/brand, same amount, multi-TV, identical TVs, rooms, and generic “just did” ambiguity.
- Prompt-injection strings are display data and never change actions.
- Photo/reference in either order and multiple-photo identities.
- Owner-scoped audit receipt contains no PII.

**Verification:**

```bash
node --import tsx --test tests/install-post-service.test.mjs tests/install-post-mobile-api.test.js
```

## Task 4: Add server-side ChatGPT photo ingestion

**Dependency:**

- Add `sharp` as a runtime dependency for decoded-pixel validation, orientation normalization, bounded WebP output, and metadata removal.

**Create:**

- `lib/install-post-mcp-photo.mjs`
- `tests/install-post-mcp-photo.test.mjs`

**Interfaces:**

- `validateChatGptFileDescriptor(file)`
- `downloadChatGptFile(file, { allowedHosts, fetchImpl })`
- `prepareServerInstallationPhoto(bytes, { declaredMime, sharpFactory })`
- `createControlledPhotoStore(...)`

**Tests first:**

- Reject HTTP, credentials in URLs, query-supplied arbitrary URL, private/loopback/link-local hosts, redirect escape, oversized body, fake MIME, unsupported HEIC until decoded support is proven, invalid pixels, extreme dimensions, and too-small image.
- Strip EXIF/GPS/XMP by decoding and metadata-free re-encoding.
- Server computes SHA-256 and byte count; never trusts caller digest.
- Distinct reverse-order images preserve distinct job hashes.

**Verification:**

```bash
node --import tsx --test tests/install-post-mcp-photo.test.mjs
```

## Task 5: Add private MCP tool contract and fail-closed transport

**Create:**

- `lib/install-post-mcp-tools.mjs`
- `pages/api/install-post/mcp.js`
- `pages/api/install-post/oauth-resource.js`
- `tests/install-post-mcp-tools.test.mjs`
- `tests/install-post-mcp-api.test.js`

**Tool names:**

- `list_pending_installations`
- `get_installation_job`
- `resolve_installation_reference`
- `attach_installation_photo`
- `preview_installation_post`
- `publish_installation_everywhere`
- `get_installation_publish_status`
- `retry_failed_destinations`

**Contract:**

- Streamable HTTP JSON-RPC supports `initialize`, `tools/list`, and `tools/call` with stateless requests.
- Every request goes through injected OAuth token validation and owner/scope checks.
- Production default refuses all calls until issuer, audience, JWKS/verification, owner subject, and scopes are configured.
- Tool schemas use `additionalProperties: false` and bounded strings/arrays.
- `attach_installation_photo` declares `_meta["openai/fileParams"]`.
- Write tools carry accurate destructive/write annotations and still require immutable approval.

**Tests first:**

- Discovery exposes only eight tools and safe schemas.
- Missing/invalid/wrong-owner tokens fail before store access.
- Read and publish scopes are distinct.
- File metadata reaches only the attach tool.
- Errors/tool output redact secrets, contacts, names, and full addresses.
- Freeform captions/destinations are rejected.

**Verification:**

```bash
node --import tsx --test tests/install-post-mcp-tools.test.mjs tests/install-post-mcp-api.test.js
```

## Task 6: Add private plugin and skill artifacts

**Create:**

- `plugins/mounting-man-installation-posts/.codex-plugin/plugin.json`
- `plugins/mounting-man-installation-posts/.mcp.json`
- `plugins/mounting-man-installation-posts/skills/mounting-man-installation-posts/SKILL.md`
- `plugins/mounting-man-installation-posts/skills/mounting-man-installation-posts/agents/openai.yaml`

**Skill behavior:**

- Use one persistent conversation.
- List pending jobs rather than inventing push behavior.
- Present sanitized seed JSON.
- Resolve natural references but require candidate confirmation.
- Attach only through the file-input tool.
- Preview before approval; describe every destination.
- Never call publish without exact manifest/nonce and explicit operator instruction.
- Report destination matrix without converting Webflow-only or partial success into overall success.

**Verification:**

```bash
python3 /Users/thedirector/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/mounting-man-installation-posts
python3 /Users/thedirector/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/mounting-man-installation-posts/skills/mounting-man-installation-posts
```

Do not install the plugin, create a marketplace entry, publish it, or configure a live workspace.

## Task 7: Add canonical publisher boundary and complete-status contract

**Create:**

- `cloud/install-post-runner/publisher-contract.py`
- `cloud/install-post-runner/tests/test_publisher_contract.py`
- `cloud/install-post-runner/CANONICAL_PUBLISHER_PROVENANCE.json`

**Modify:**

- `cloud/install-post-runner/runner.py`
- `.github/workflows/publish-install-post.yml`

**Contract:**

- Record source hashes for `fast_install_post.py`, `content.py`, `clients.py`, GBP worker, and Reddit worker.
- Preview mode must be no-network and return website plus every platform caption revision.
- Dispatch returns one receipt per manifest destination.
- Runner refuses mutable code refs and incomplete destination adapters.
- Webflow reuse performs a fresh public read-back.
- GBP/Reddit worker receipts reconcile centrally and partial success remains partial.
- Existing Webflow-only runner remains testable but cannot be selected as `publish_everywhere`.

**Protected boundary:**

Do not modify the active unversioned Hermes publisher/Discord gateway or deploy the adapted runner in this issue without separate approval. If the complete publisher cannot be versioned without touching those live surfaces, finish the contract/tests and record the exact blocker.

**Verification:**

```bash
PYTHONDONTWRITEBYTECODE=1 \
  /Users/thedirector/Projects/mounting-man-dashboard-attribution/cloud/install-post-runner/.venv/bin/pytest -q \
  cloud/install-post-runner/tests
```

## Task 8: Mandatory synthetic and regression verification

**Create:**

- `tests/install-post-chatgpt-canary.test.mjs`
- `docs/superpowers/evidence/2026-08-12-the-144-synthetic-canary.md`

**Synthetic sequence:**

1. Stage one synthetic job and list it through the MCP tool.
2. Stage two nearly identical Susan Drive jobs and prove one disambiguation question.
3. Attach two generated metadata-bearing images in reverse order and prove hashes bind to the intended job IDs.
4. Build website plus all-platform previews and immutable manifest hash.
5. Prove facts/photo/caption/destination mutations invalidate approval.
6. Run publisher contract in fake/no-network mode and record per-destination receipts.
7. Prove the same flow operates with no M1 service involved.

**Full verification:**

```bash
npm test
npm run build
PYTHONDONTWRITEBYTECODE=1 \
  /Users/thedirector/Projects/mounting-man-dashboard-attribution/cloud/install-post-runner/.venv/bin/pytest -q \
  cloud/install-post-runner/tests
cd /Users/thedirector/.hermes/hermes-agent && \
  pytest -q tests/gateway/test_discord_install_post_seed.py
python3 -m py_compile \
  /Users/thedirector/.hermes/hermes-agent/gateway/platforms/discord.py \
  /Users/thedirector/.hermes/skills/business-ops/mounting-man-installation-posts-hermes/scripts/fast_install_post.py
git diff --check
git status --short --branch
```

Run repository secret/PII scans using patterns only; never print matching credential values or customer records.

## Task 9: Independent blocker-focused review and correction

Review only the final branch diff for:

- OAuth/resource-server bypass;
- prompt injection and over-broad schemas;
- SSRF/path traversal/arbitrary URL/file access;
- image validation/metadata leakage;
- revision/nonce replay and race conditions;
- partial-success misclassification;
- destination retry duplication;
- browser/Discord regressions;
- hidden production activation.

Fix every critical/high finding test-first, rerun the same failing path, then the full verification set. If Fable 5 remains unavailable through `q-model-router`, record that exact review-lane blocker and use an independent Codex review without claiming Fable completion.

## Task 10: Final evidence and Linear update

Record on THE-144:

- architecture found;
- reuse/wrap/adapt/new boundaries;
- local plugin/skill/MCP artifacts and validation;
- deployment/auth handles or exact missing handles;
- current account/workspace requirements;
- web/iPhone evidence or exact blocker;
- full destination-readiness matrix;
- Discord regression evidence;
- M1/cloud dependency status;
- test/security review evidence;
- exact next owner action for a parallel real-job pilot;
- explicit statement that Discord was not disabled, redirected, modified, or retired.

Keep THE-144 In Progress unless every definition-of-done item is genuinely verified. No production activation is implied by passing local tests.
