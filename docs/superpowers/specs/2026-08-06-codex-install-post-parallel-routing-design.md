# Codex Installation-Post Parallel Routing Design

## Goal

Add a Codex-native Installation Posts thread as a parallel canary destination for every staged Square installation-post seed while preserving the current Discord notification and Discord photo-to-publisher path unchanged.

## Architecture

The Vercel Square webhook remains the source of truth and continues to stage each resolved seed in the existing protected `install-post:pending:*` store and post to Discord. A new M1 LaunchAgent polls the existing protected pending endpoint, sends each not-yet-relayed seed into one persistent local Codex thread named `Installation Posts`, and records an idempotency receipt locally.

The relay uses the local Codex app-server with the existing ChatGPT/Codex OAuth session. It passes a minimal child environment, explicitly forces and verifies the built-in `openai` model provider, and refuses metered API-key or custom-base-URL routes. No customer name, full address, credential, or unrelated environment variable is sent to Codex; the prompt contains only allowlisted installation facts plus a non-customer queue reference.

## Codex Project and Thread

The Codex thread runs with cwd `/Users/thedirector/vault-local/Projects/Mounting-Man/installation-posts-codex`. That project contains an `AGENTS.md` runbook instructing Codex to hold the seed until Mr. Wayne attaches the matching photo, then invoke the existing canonical publisher:

`/Users/thedirector/.hermes/skills/business-ops/mounting-man-installation-posts-hermes/scripts/fast_install_post.py`

The relay creates or resumes one persisted thread, sets its user-facing name to `Installation Posts`, sends a short staging turn, and waits for Codex to acknowledge it. It never publishes from the staging turn.

## Reliability and Safety

- Discord remains unchanged and active throughout the canary.
- The relay never marks a Vercel pending seed complete; the existing publish completion path retains ownership.
- A seed is locally marked relayed only after Codex finishes the staging turn successfully.
- A lock prevents overlapping LaunchAgent runs.
- Invalid/missing thread state creates one replacement thread and retries once.
- State and relay credentials live outside Git with owner-only permissions.
- Logs contain queue references and status only, never seed JSON, customer data, or credentials.
- A synthetic `--canary` mode verifies thread creation, naming, turn completion, and persisted read-back without publishing or using customer data.

## Verification

1. Unit tests prove prompt redaction, idempotency, successful receipt persistence, failure non-persistence, and Discord-preserving architecture.
2. Project test suite and production build pass.
3. LaunchAgent plist validates and loads.
4. A synthetic live canary appears in the named Codex thread and can be read back through app-server.
5. Existing Discord notifier test still proves a Discord API post occurs.
