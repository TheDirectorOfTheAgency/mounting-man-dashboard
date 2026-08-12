// lib/install-post-states.mjs
//
// The installation-post state machine's vocabulary and timing policy.
//
// Split out from install-post-queue.mjs so the phone card can share it: this
// module has no Node builtins and is safe to pull into the browser bundle.

export const INSTALL_POST_STATES = Object.freeze({
  AWAITING_PHOTO: 'AWAITING_PHOTO',
  READY: 'READY',
  PUBLISHING: 'PUBLISHING',
  VERIFYING: 'VERIFYING',
  PUBLISHED: 'PUBLISHED',
  RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  BLOCKED: 'BLOCKED',
  INDETERMINATE: 'INDETERMINATE',
});

/**
 * How long a dispatched publish may stay in flight before it is treated as
 * abandoned. The workflow itself is capped at 10 minutes, so anything past this
 * window means the runner died or its callback never landed.
 */
export const STALE_PUBLISH_MS = 15 * 60 * 1000;

const POLL_DELAY_MS = 4000;

/**
 * How long the phone card should wait before asking again, or 0 when the job
 * has stopped moving on its own and only the operator can advance it.
 */
export function installPostPollDelayMs(state) {
  return state === INSTALL_POST_STATES.PUBLISHING || state === INSTALL_POST_STATES.VERIFYING
    ? POLL_DELAY_MS
    : 0;
}
