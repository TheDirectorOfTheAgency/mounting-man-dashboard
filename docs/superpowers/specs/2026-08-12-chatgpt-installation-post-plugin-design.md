# ChatGPT Installation-Post Plugin Design

**Issue:** THE-144
**Date:** 2026-08-12
**Status:** Audit/design gate; private synthetic pilot only

## Goal and non-goals

Add one persistent ChatGPT operator conversation over the working Square installation-post queue and canonical multi-destination publisher. ChatGPT is an interface; the backend remains the integrity and effects boundary.

This project does not disable, modify, redirect, or retire Discord; retire the M1/local relay; route real jobs exclusively to ChatGPT; publish real customer content during testing; publish a public plugin; change billing; or cut production over.

## Audit result

### Working system to preserve

- Square webhook and cron ingestion already create sanitized, per-TV seeds.
- Upstash job records already separate safe job state from Square source references, use opaque deterministic job IDs, hash the safe seed plus bound image, invalidate approval after mutations, and suppress duplicate publish claims.
- The phone path already proves one job/revision-bound photo and explicit approval flow. Its capability cookie and same-origin `Origin` defense are browser-specific and are not MCP authentication.
- Discord remains the production operator surface. Its staged JSON/photo handoff calls the canonical `fast_install_post.py` publisher and must remain unchanged.
- The canonical publisher currently covers Webflow, Instagram, LinkedIn, Facebook, X, Reddit primary plus conditional gallery subreddit, and GBP queueing. No Pinterest publisher exists. TikTok has only unused configuration verification.

### Gaps that prevent cutover

- No MCP transport, OAuth resource-server boundary, tool schemas, actor audit, or ChatGPT file-input path exists.
- The checked-in cloud runner is Webflow-only. It vendors copy logic, dispatches via GitHub Actions, and is not the complete canonical publisher.
- Current publisher status is lossy: one successful social destination can make the aggregate say `posted` while another is failed or queued.
- GBP worker completion does not reconcile the central social receipt; Reddit can misclassify gallery partial success; cached Webflow reuse does not re-read the public page.
- Current queue approval binds one combined seed+photo revision, but THE-144 also requires explicit facts, website copy, per-platform captions, destination manifest, and approval-nonce identities.
- Current ChatGPT account plan is unverified. Official OpenAI documentation says full MCP write actions and Workspace Agents require a managed Business/Enterprise-class workspace; Workspace Agents are not installed in the current environment.
- ChatGPT-to-MCP file transfer is documented only for tools declaring `_meta["openai/fileParams"]`; iPhone camera/photo behavior still needs a real account/device test.

## Approaches considered

### A. Thin MCP adapter over the existing queue and a versioned canonical-publisher contract — recommended

Extract queue actions into shared service functions. Expose the issue-specified MCP tools through a separate OAuth-authenticated resource server. Keep ChatGPT inputs narrow, require immutable IDs and revisions at every mutation, and call one canonical publisher contract for preview and dispatch.

Advantages: reuses proven queue invariants, leaves Discord and phone paths intact, minimizes new authority, enables one persistent conversation, and keeps backend effects deterministic.

Tradeoffs: complete publishing remains blocked until the current local publisher is versioned and its receipt defects are fixed behind a cloud-safe adapter. OAuth deployment and mobile proof require workspace/admin action.

### B. Extend the Webflow-only cloud runner into a second publisher — rejected

Adding social calls directly to `cloud/install-post-runner/runner.py` looks quick but would deepen the existing fork. It would duplicate the working clients, captions, X guard, Reddit/GBP semantics, and retry logic, making drift and false success more likely.

### C. Create a ChatGPT-specific queue and let the model orchestrate platforms — rejected

A second queue would split the system of record. Freeform captions or destination selection at execution time would weaken approval integrity and invite prompt injection. ChatGPT must never improvise social calls.

## Target architecture

```text
Square webhook / cron
  -> existing Upstash installation job records (system of record)
      -> unchanged Discord + M1 fallback
      -> unchanged private phone card
      -> new shared install-post service layer
          -> OAuth-authenticated remote MCP adapter
              -> one persistent ChatGPT conversation
          -> immutable preview + approval manifest
          -> versioned canonical publisher adapter
              -> Webflow
              -> Instagram
              -> LinkedIn
              -> Facebook
              -> X (@MountingManTV guard)
              -> Reddit primary / conditional gallery
              -> GBP
          -> per-destination receipts and retry/reconciliation
```

## Reused, wrapped, adapted, and new

### Reused unchanged

- Square ingestion and existing Discord notification/staging behavior.
- Upstash job/source separation, opaque per-TV job identity, safe seed allowlist, state machine, record lock, and publish lease.
- Existing browser phone flow.
- Canonical seed normalization, content generation, platform captions, Webflow verification, platform clients, X handle guard, and public pricing rules.
- M1 relay and GBP/Reddit workers during the pilot.

### Wrapped

- Queue reads and transitions become transport-neutral service functions used by both existing APIs and MCP.
- The canonical publisher gains a strict preview/dispatch/status contract without allowing callers to supply freeform destinations at publish time.

### Cloud-adapted later, behind parity gates

- Configuration and credentials move behind environment/secret-provider interfaces.
- Local image, log, GBP, and Reddit queue storage move behind blob/receipt/queue interfaces.
- The exact canonical publisher source and dependencies become versioned with recorded hashes.

### Genuinely new

- Private plugin and installation-post skill artifacts.
- OAuth-authenticated MCP surface and owner-scoped actor audit.
- Natural-reference resolver that returns confirmation or one disambiguation question and never binds by language alone.
- Server-side ChatGPT file download, byte/MIME/dimension validation, metadata removal, hashing, controlled storage, and immutable job binding.
- Preview manifest covering facts, website copy, platform captions, destination set, and revisions.
- Approval nonce bound to the manifest hash and one-time publish lease.
- Complete destination-level status vocabulary and selective retry contract.

## MCP surface

Every tool requires an authenticated owner principal. Job text is data, never instructions. Unknown fields are rejected.

### `list_pending_installations`

Returns stable, paginated safe cards and sanitized seed JSON. It never returns source references, customer identity, full address, contact data, or credentials.

### `get_installation_job`

Requires opaque `job_id`. Returns only the safe public projection, current revision identities, preview summary, approval state, and destination receipts.

### `resolve_installation_reference`

Accepts natural reference text and optional safe filters. It ranks safe facts but never mutates or binds. One strong candidate returns `confirmation_required`; multiple plausible candidates return `ambiguous` plus one concise distinguishing question; zero returns `not_found`.

### `attach_installation_photo`

Declares `_meta["openai/fileParams"]` for the photo argument. Requires exact job ID, current facts revision, and confirmed candidate identity. The server downloads only the ChatGPT-provided ephemeral file through an allowlisted HTTPS path, validates decoded pixels/MIME/size/dimensions, rotates safely, emits metadata-free WebP, computes SHA-256 server-side, stores it under controlled ownership, and binds it under the record lock.

### `preview_installation_post`

Requires exact job ID and current facts/photo revisions. Calls the canonical preview adapter in no-network mode and returns website copy plus every manifest destination caption. It stores immutable revisions and a destination manifest version; preview output is not approval.

### `publish_installation_everywhere`

Requires exact manifest ID and approval nonce, not freeform captions or destinations. The nonce is single-use, short-lived, owner-bound, and covered by the publish lease. Dispatch is disabled by default outside an approved pilot environment.

### `get_installation_publish_status`

Returns every manifest destination with one of: `posted`, `verified`, `queued`, `skipped`, `blocked`, `transient_failure`, `permanent_failure`, or `indeterminate`. Overall success is impossible unless every required destination is terminally acceptable under the manifest.

### `retry_failed_destinations`

Requires the same immutable manifest. Its first call stores and returns a short-lived nonce bound to the exact transient-failure destination set; ChatGPT shows that set and asks for fresh approval. The confirmed second call consumes the nonce atomically and dispatches only that set. Indeterminate lanes require reconciliation rather than blind retry, and successful destinations are always suppressed.

## Natural-reference matching

Normalize only safe tokens: street name without house number, city, TV size, brand, mount/bracket, room, subtotal, completion recency bucket, and opaque suffix. Use exact/whole-token matches before fuzzy variants. Never use customer names.

- Exact opaque suffix is decisive but still returns the record for confirmation.
- A unique high-scoring natural match returns `confirmation_required`, never an automatic bind.
- Equal or close top candidates are ambiguous.
- Generic recency phrases such as “the job I just did” are ambiguous whenever more than one recent record exists.
- Identical TVs within a multi-TV job remain ambiguous until a room, opaque suffix, or already bound photo distinguishes them.
- Photo-before-reference remains an unattached, expiring upload owned by the authenticated actor; it cannot publish or bind by itself.
- Multiple photos are ordered by server receipt time and digest, not client filename. Each bind is explicit and revisioned.

## Integrity model

Maintain distinct identities:

- immutable job ID;
- facts revision;
- image SHA-256 and photo revision;
- website-copy revision;
- per-platform caption revisions;
- destination manifest version and manifest hash;
- preview ID;
- approval nonce hash and expiry;
- dispatch ID;
- destination idempotency key.

The manifest hash covers the job ID and all revisions plus ordered required destinations. Any facts, photo, copy, caption, or destination change clears preview and approval. Destination idempotency is `SHA-256(job_id | manifest_hash | destination)`. Approval nonces are stored hashed and consumed atomically.

## Destination readiness and success semantics

The initial manifest is `website`, `instagram`, `linkedin`, `facebook`, `x`, `reddit_mountingman`, conditional `reddit_frame`, and `gbp`. Pinterest is recorded as `unsupported`, not silently skipped. TikTok and other inactive scaffolds are excluded.

Webflow public read-back is necessary but never sufficient for overall success. Queue acceptance is `queued`, not `posted`. A timeout after a provider may have accepted content is `indeterminate` until reconciled. Destination URLs/provider IDs are stored when available. Retry operates per destination and never repeats a confirmed success.

## Security design

- Use OpenAI-supported OAuth 2.1 for the remote MCP resource server; fail closed until issuer, audience, scopes, and owner subject are configured.
- Keep platform credentials server-side and out of prompts, visible JSON, URLs, logs, workflow inputs, and Git.
- Require owner scope for reads and a distinct publish scope plus write confirmation for publish/retry.
- Validate tool input with closed schemas and size limits.
- Treat all seed strings as untrusted display data; they cannot alter tool calls, destinations, or approval.
- Permit photo downloads only from configured OpenAI ephemeral-file HTTPS hosts. Disable redirects or revalidate each redirect; block loopback, private, link-local, and non-HTTPS targets.
- Decode images with bounded pixels, verify magic bytes and MIME, strip EXIF/GPS/XMP, and re-encode before storage.
- Audit actor subject, tool, request ID, job ID, before/after revision, result class, and timestamp without customer data or secrets.
- Do not accept arbitrary URLs, paths, captions, destinations, or files from the model.

## OpenAI capability gate

Official current behavior supports remote MCP with OAuth 2.1, private workspace plugin sharing by an admin, plugin use across ChatGPT web/desktop/mobile, and explicit file transfer when the tool declares `_meta["openai/fileParams"]`.

The durable one-conversation fallback is the operator repeatedly calling `list_pending_installations`. Workspace Agent external triggers can continue a conversation using a caller-defined `conversation_key`, but Workspace Agents are not installed and their API cannot return final agent output. No generic MCP-to-user push-notification API is documented.

Full MCP writes and Workspace Agents require a managed Business/Enterprise-class workspace. The current account plan is unverified. Therefore local plugin/MCP artifacts and synthetic tests can proceed, but workspace publishing, mobile proof, unattended writes, external triggers, and production activation are blocked until Mr. Wayne verifies/approves the workspace and an admin enables the private app.

## Verification gates

1. Contract tests for all tools, closed schemas, OAuth refusal, privacy, prompt injection, ambiguity, revisions, approval replay, and destination status.
2. Server-side photo tests for fake MIME, invalid/oversized images, dimensions, metadata removal, SSRF, reverse-order uploads, and multiple photos.
3. Canonical preview parity against golden synthetic fixtures.
4. Complete publisher dry-run contract proving no external calls and every destination receipt.
5. Existing Node, runner, canonical publisher, and Discord regression suites.
6. M1-unavailable synthetic canary with dispatch disabled.
7. Independent critical/high review.
8. Separate approval for remote deployment/auth configuration.
9. Real ChatGPT web/iPhone photo transfer proof on Mr. Wayne’s account.
10. Separate explicit approval for one parallel real-job pilot; Discord and M1 remain active.

## Current blockers

- Fable 5/Claude is not currently available through the required `q-model-router`; Codex completed the audit/design gate and records that model-specific review as unavailable.
- A versioned, dependency-locked canonical publisher with complete destination receipt fixes does not yet exist.
- OAuth issuer/workspace/app-admin configuration is not selected or authorized.
- Current plan and Business workspace entitlement are unverified; Workspace Agents are not installed.
- Mobile camera/photo-to-MCP behavior is documented in principle but not proven on Mr. Wayne’s account.
- Remote deployment, credential configuration, real customer canary, production cutover, Discord changes, and M1 retirement require separate approval.
