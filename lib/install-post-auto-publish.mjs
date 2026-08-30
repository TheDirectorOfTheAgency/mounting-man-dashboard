// lib/install-post-auto-publish.mjs
//
// One approve+dispatch path for the phone Publish tap and for the Square+photo
// auto-run. Both claim the same publish lease and fire the same GitHub
// workflow. Grok Bot / Woodward never run publish_one.py or go.py.

import { randomBytes } from 'node:crypto';

import {
  INSTALL_POST_STATES,
  statusForReason,
  transitionRecord,
} from './install-post-queue.mjs';

const IN_FLIGHT = new Set([
  INSTALL_POST_STATES.PUBLISHING,
  INSTALL_POST_STATES.VERIFYING,
]);

/**
 * Approve one exact revision and dispatch the cloud runner.
 *
 * Same signed envelope/callback contract as the phone tap. Fails closed when
 * the photo is missing — the desk may ask for the photo, nothing else.
 */
export async function approveAndDispatchInstallPost({
  store,
  jobId,
  revision,
  dispatcher,
  now = Date.now,
  reconcile = false,
} = {}) {
  if (!store) return { ok: false, reason: 'unavailable', record: null };
  if (!dispatcher) return { ok: false, reason: 'dispatch_unconfigured', record: null };
  if (!jobId) return { ok: false, reason: 'not_found', record: null };

  const at = new Date(now()).toISOString();
  const dispatchId = randomBytes(12).toString('hex');
  let refusal = null;
  let refused = null;
  let claimed = false;

  const approved = await store.withRecordLock(jobId, async (stored) => {
    const expired = transitionRecord(stored, { type: 'timeout', at });
    const current = expired.ok ? expired.record : stored;
    refused = current;

    if (current.state === INSTALL_POST_STATES.PUBLISHED) {
      refusal = 'already_published';
      return null;
    }
    if (!current.image) {
      refusal = 'photo_required';
      return null;
    }
    if (revision !== current.revision) {
      refusal = 'stale_revision';
      return null;
    }

    const unresolved = current.state === INSTALL_POST_STATES.INDETERMINATE;
    if (unresolved && !reconcile) {
      refusal = 'reconcile_required';
      return null;
    }
    if (!unresolved && reconcile) {
      refusal = 'not_reconcilable';
      return null;
    }

    let claim = await store.claimPublishLease({ jobId, revision: current.revision, dispatchId });
    if (claim === 'duplicate') {
      const held = current.lease?.revision === current.revision;
      if (held && !unresolved) {
        refusal = 'duplicate_publish';
        return null;
      }
      claim = await store.claimPublishLease({
        jobId, revision: current.revision, dispatchId, takeover: true,
      });
    }
    if (claim !== 'claimed') {
      refusal = 'unavailable';
      return null;
    }
    claimed = true;

    const transition = transitionRecord(current, {
      type: unresolved ? 'reconcile' : 'approve',
      revision: current.revision,
      dispatchId,
      at,
    });
    if (!transition.ok) {
      refusal = transition.reason;
      return null;
    }
    return transition.record;
  });

  if (!approved.ok) {
    if (claimed) await store.releasePublishLease({ jobId, revision });
    return {
      ok: false,
      reason: refusal || approved.reason,
      record: refused,
      status: statusForReason(refusal || approved.reason),
    };
  }

  try {
    await dispatcher.dispatch({
      jobId,
      revision: approved.record.revision,
      dispatchId,
    });
  } catch (err) {
    console.error('[install-post-auto-publish] dispatch failed:', err.message);
    await store.releasePublishLease({ jobId, revision: approved.record.revision });
    const failed = await store.withRecordLock(jobId, async (current) => transitionRecord(current, {
      type: 'result',
      result: { status: INSTALL_POST_STATES.RETRYABLE_FAILURE, message: 'Cloud dispatch failed' },
      at: new Date(now()).toISOString(),
    }).record);
    return {
      ok: false,
      reason: 'dispatch_failed',
      record: failed.ok ? failed.record : approved.record,
      status: 502,
    };
  }

  return { ok: true, record: approved.record, dispatchId };
}

/**
 * Dispatch the cloud runner when a Square job already has a bound photo.
 * No-ops (photo_required) when the photo is missing — never invents one.
 */
export async function autoDispatchIfPhotoBound({
  store,
  jobId,
  dispatcher,
  now = Date.now,
} = {}) {
  if (!store || !dispatcher || !jobId) {
    return { ok: false, reason: 'unavailable', record: null };
  }

  const record = await store.loadRecord(jobId);
  if (!record) return { ok: false, reason: 'not_found', record: null };
  if (!record.image) return { ok: false, reason: 'photo_required', record };
  if (record.state === INSTALL_POST_STATES.PUBLISHED) {
    return { ok: false, reason: 'already_published', record };
  }
  if (IN_FLIGHT.has(record.state)) {
    return { ok: false, reason: 'publish_in_flight', record };
  }

  return approveAndDispatchInstallPost({
    store,
    jobId,
    revision: record.revision,
    dispatcher,
    now,
    reconcile: record.state === INSTALL_POST_STATES.INDETERMINATE,
  });
}

/** Best-effort auto-dispatch for every staged record that already has a photo. */
export async function autoDispatchStagedJobs({
  records = [],
  store,
  dispatcher,
  now = Date.now,
  logger = console,
} = {}) {
  const results = [];
  if (!store || !dispatcher) return results;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.jobId || !record.image) {
      results.push({ jobId: record?.jobId || '', skipped: 'photo_required' });
      continue;
    }
    try {
      const outcome = await autoDispatchIfPhotoBound({
        store,
        jobId: record.jobId,
        dispatcher,
        now,
      });
      results.push({
        jobId: record.jobId,
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason,
        dispatchId: outcome.dispatchId || null,
      });
    } catch (err) {
      logger.warn?.('[install-post-auto-publish] staged dispatch failed', {
        errorType: err?.name || 'Error',
      });
      results.push({ jobId: record.jobId, ok: false, reason: 'dispatch_failed' });
    }
  }
  return results;
}
