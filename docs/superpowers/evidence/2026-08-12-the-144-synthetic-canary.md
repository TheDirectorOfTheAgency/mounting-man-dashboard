# THE-144 synthetic canary and activation evidence

Date: 2026-08-12
Branch: `codex/the-144-chatgpt-installation-post-plugin`
Baseline: `fdd3b22`

## Outcome

The audit/design/local-implementation gates are complete. A private,
production-disabled ChatGPT remote-MCP adapter now exists over the reusable
installation-post queue. It exposes the exact eight issue tools, uses the
canonical local publisher only for no-network preview/provenance checks, and
reports all effective destinations independently.

No service was deployed or configured. No real job, photo, post, provider,
queue, customer record, or production endpoint was mutated. Discord was not
disabled, redirected, or modified. The M1 relay/workers were not stopped,
retired, or changed. Production publishing remains hard-disabled in the
dashboard backend route.

## Audit and design gate

- Reused `safeSeed`, `publicJobView`, `canonicalRevision`, `transitionRecord`,
  Upstash record isolation, record locks, and publish leases. The browser
  capability-cookie/Origin model was not reused as remote-MCP authentication.
- Audited the canonical local `fast_install_post.py` flow. Effective lanes are
  website, Facebook, Instagram, LinkedIn, X, Google Business Profile queue,
  Reddit/TheMountingMan, and conditional Reddit/SamsungFrameMounting. Pinterest
  is unsupported and TikTok is inactive scaffolding.
- Rejected the existing GitHub Actions/Webflow-only runner as
  `publish_everywhere`. It does not meet complete-publisher parity and dispatch
  remains disabled.
- Chose the issue's recommended parallel adapter: a narrow OAuth-authenticated
  remote MCP service plus an HMAC-authenticated internal dashboard route. The
  design alternatives and rejection reasons are recorded in the design spec.

## Implemented local artifacts

- Design: `docs/superpowers/specs/2026-08-12-chatgpt-installation-post-plugin-design.md`
- Plan: `docs/superpowers/plans/2026-08-12-chatgpt-installation-post-plugin.md`
- Pure protocol/status contract: `lib/install-post-chatgpt.mjs`
- File validation, pinned download, metadata stripping, and controlled upload:
  `lib/install-post-chatgpt-photo.mjs`
- Queue-backed tool service and single-use approval/retry state:
  `lib/install-post-chatgpt-service.mjs`
- Remote OAuth MCP adapter: `cloud/install-post-mcp/`
- Internal owner-bound backend route: `pages/api/install-post/chatgpt-tools.js`
- Private plugin/skill: `plugins/mounting-man-installation-posts/`
- Canonical provenance/preview adapter and complete-publisher contract:
  `cloud/install-post-runner/publisher/canonical_adapter.py` and
  `cloud/install-post-runner/publisher_contract.py`

Security properties exercised locally include exact owner/scope enforcement,
closed tool schemas, hashed actor audit identities, HMAC replay protection,
allowlisted HTTPS file descriptors, private/mapped-address refusal, DNS-address
pinning for the default downloader, byte/MIME/magic/dimension checks, animated
image refusal, EXIF/GPS/XMP stripping, SHA-256 binding, immutable preview and
destination manifest revisions, atomic single-use publish approval, fresh
destination-bound retry approval, and partial/indeterminate status honesty.

## Synthetic evidence

`npm run canary:install-post-chatgpt` passed 2/2:

1. With no M1 dependency, synthetic jobs were listed and natural-language
   ambiguity was preserved rather than guessed.
2. Two generated metadata-bearing images were attached in reverse job order;
   distinct normalized hashes remained bound to their intended job IDs.
3. All eight destination previews were revision-bound and no approval nonce was
   stored in plaintext.
4. The production-disabled service refused publish dispatch.
5. A synthetic in-memory publisher dispatched an approved manifest once,
   suppressed replay, created a fresh approval challenge for the exact
   transient-failure destination set, and retried only that set once.

No synthetic canary content was sent outside the process.

## Verification receipt

- Dashboard Node suite: **326 passed, 0 failed** (`npm test`).
- Next production build: **passed** (`npm run build`); only pre-existing lint and
  Browserslist warnings were emitted.
- Runner suite: **56 passed, 0 failed**; one local LibreSSL/urllib3 warning.
- Focused active Discord installation-post regression: **2 passed**, 39
  deselected. Discord files were read/tested, not changed.
- Private plugin validator: **passed**.
- Plugin skill validator: **passed**.
- Minimal MCP deployment dependency audit: **0 vulnerabilities**.
- `git diff --check`: **passed**.
- Independent final critical/high review: **no remaining critical/high findings**.
- Canonical publisher audit suite from the active publisher checkout: **93
  passed plus 1 subtest**. Three legacy test modules could not collect in that
  checkout's test environment because `requests_oauthlib` is absent; this was
  not bypassed or installed into the active runtime.

The root dashboard dependency audit still reports 44 advisories (3 critical,
32 high, 8 moderate, 1 low). The direct affected packages reported were
`axios`, `next`, `postcss`, and `vercel`, all already present in the baseline
package manifest. The isolated MCP container lock has zero advisories. A Docker
image build was not exercised because the local Docker daemon is not running.

Fable 5 review was attempted through the required model router, but the routed
review failed before execution with:
`--capacity cannot be used with --spawn=session (single-session mode has fixed capacity 1)`.
The final independent Codex security/operations review completed instead; this
does not satisfy the issue's literal Fable-review gate.

## Activation blockers

THE-144 remains in progress. These gates are intentionally unresolved:

1. **Complete cloud publisher parity:** the current cloud runner is Webflow-only.
   The canonical adapter refuses live publish. A versioned complete publisher
   must implement all eight effective lanes, destination idempotency, provider
   receipts, GBP/Reddit reconciliation, and honest partial/indeterminate
   callbacks before writes can be enabled.
2. **Known canonical receipt defects:** the active local system can collapse
   several social outcomes into one rollup, trust a cached Webflow success,
   omit GBP reconciliation from the central log, and represent Reddit partial
   success imprecisely. Those live files were not modified under this issue's
   protected boundary.
3. **Private remote endpoint and OAuth:** no endpoint, OAuth issuer/client,
   owner subject, secret, DNS, or workspace app was configured. The plugin URL
   deliberately remains a reserved `.invalid` address.
4. **Workspace entitlement/admin gate:** the current account plan could not be
   verified. Workspace Agents is not installed in the callable account, and no
   Workspace Agents tools are available. Full write-capable MCP/custom-app use
   requires the appropriate workspace plan and admin enablement.
5. **Real web/iPhone proof:** ChatGPT web and iPhone file transfer, camera/photo
   picker behavior, persistent-conversation recovery, OAuth refresh, and
   attachment survivability have not been exercised against a real remote MCP
   endpoint.
6. **Photo-first unattached flow:** confirmed-job then photo works, including
   similar multi-TV reverse ordering. Photo-before-reference needs a separate
   authenticated, expiring unattached blob store and is not implemented.
7. **Notification trigger:** Workspace Agent trigger runs can preserve a caller
   `conversation_key`, but agent output cannot currently be retrieved through
   that API, and the official Apps SDK does not document generic MCP server-push
   user notifications. Square-completion proactive prompting therefore remains
   a product/workspace gate.
8. **Review/build debt:** literal Fable 5 review remains blocked by the local
   router error; full canonical publisher test collection needs
   `requests_oauthlib`; root dashboard dependency advisories need a separately
   scoped upgrade; and a real container build still needs a running Docker
   daemon.

## Required next decision

Mr. Wayne must verify or authorize a compatible ChatGPT workspace and have an
admin enable private custom apps/Workspace Agents as needed. After that, the
next safe phase is to provision a private HTTPS OAuth MCP endpoint with
publishing still hard-disabled, connect the reserved plugin to it, and run only
synthetic web and iPhone attachment/preview tests. A real customer pilot and any
production cutover require separate explicit approval after complete-publisher
and receipt-parity evidence.

Official OpenAI references used for the gate include remote MCP authentication,
secure MCP tunnels, private workspace plugin publication, file parameters, and
Workspace Agent trigger runs:

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt
- https://developers.openai.com/plugins/build/plugins#share-a-local-plugin-with-your-workspace
- https://developers.openai.com/plugins/reference#define-file-inputs
- https://developers.openai.com/workspace-agents/trigger-runs
