# Codex Installation-Post Parallel Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes for tracking.

**Goal:** Deliver every staged installation-post seed to a persistent Codex `Installation Posts` thread without changing or disabling Discord routing.

**Architecture:** A local M1 relay polls the existing authenticated pending-seed endpoint and uses Codex app-server JSON-RPC to stage sanitized seed context in one persisted thread. A LaunchAgent runs the idempotent relay, while local state records only successful Codex deliveries.

**Tech Stack:** Node.js ESM, Node test runner, Codex app-server JSON-RPC, launchd, existing Vercel pending API.

## Global Constraints

- Discord routing remains active and unchanged.
- Never send customer name, full address, credentials, or unrelated environment variables to Codex.
- Use existing Codex OAuth; fail closed when metered API or custom provider variables are present.
- A staging turn must never publish an installation post.
- Only a successful Codex turn may create a local relayed receipt.

---

### Task 1: Tested relay core

**Files:**
- Create: `scripts/codex-install-post-relay.mjs`
- Create: `tests/codex-install-post-relay.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: protected pending endpoint JSON `{ pending: Array<PendingSeed> }`.
- Produces: exported `buildCodexSeedPrompt`, `relayPendingSeeds`, `CodexAppServerClient`, and CLI modes `--dry-run`, `--canary`, default live poll.

- [x] **Step 1: Write failing tests** for sanitized prompts, idempotent skip, success receipt, failed-turn non-receipt, and a minimal child environment.
- [x] **Step 2: Run** `node --test tests/codex-install-post-relay.test.mjs` and confirm failure because the module does not exist.
- [x] **Step 3: Implement the smallest relay core** that fetches pending seeds, resumes/creates and names the Codex thread, starts a no-publish staging turn, waits for completion, and atomically stores successful receipts.
- [x] **Step 4: Add** `test:codex-install-post-relay` to `package.json` and run the focused test until green.
- [x] **Step 5: Run** the complete `npm test` suite.

### Task 2: M1 runtime and canary

**Files:**
- Create: `scripts/launchd/ai.theagency.codex-install-post-relay.plist`
- Create: `scripts/install-codex-install-post-relay.mjs`
- Create: `/Users/thedirector/vault-local/Projects/Mounting-Man/installation-posts-codex/AGENTS.md`
- Create: owner-only runtime config under `~/.config/the-agency/` (not Git)
- Install: `~/Library/LaunchAgents/ai.theagency.codex-install-post-relay.plist`

**Interfaces:**
- Consumes: Vercel `CRON_SECRET` retrieved without printing it.
- Produces: a supervised polling job, persisted Codex thread id, idempotency receipts, and sanitized logs.

- [x] **Step 1: Write and validate** the plist and installer.
- [x] **Step 2: Read the verified production secret from an existing owner-only environment file**, write the runtime config mode `0600`, and never print the value.
- [x] **Step 3: Install and bootstrap** the LaunchAgent without restarting Hermes or changing Discord.
- [x] **Step 4: Run a synthetic `--canary`**, verify `thread/read` returns the named thread and canary staging exchange, and confirm no Webflow publisher ran.
- [x] **Step 5: Verify launchd service state and sanitized logs.**

### Task 3: Documentation and final proof

**Files:**
- Modify: `/Users/thedirector/vault-local/Context/scripts-registry.md`
- Modify: `/Users/thedirector/.hermes/skills/business-ops/mounting-man-installation-posts-hermes/SKILL.md`

**Interfaces:**
- Consumes: verified runtime paths and behavior.
- Produces: current operating documentation for future Q/Codex sessions.

- [x] **Step 1: Document** the relay path, LaunchAgent label, state/config paths, and Discord-canary rule.
- [x] **Step 2: Run** focused tests, full tests, `npm run build`, plist validation, LaunchAgent status, and synthetic Codex read-back.
- [x] **Step 3: Inspect** `git diff --check`, `git diff`, and both repository statuses to confirm only intended changes.
