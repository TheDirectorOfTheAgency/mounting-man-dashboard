// lib/install-post-auto-publish.mjs
//
// One approve path for the phone Publish tap and for the Square+photo
// auto-run. Both pass the same deterministic confidence gate. With a cloud
// dispatcher configured they claim the publish lease and fire the GitHub
// workflow; with none (the default — cloud dispatch is off) they hand the job
// to M1 as READY_FOR_M1 and send one plain ping. Woodward never runs
// publish_one.py or go.py.

import { randomBytes } from 'node:crypto';

import axios from 'axios';

import {
  confidenceFactsFromRecord,
  evaluateInstallPostConfidence,
  resolveInstallPostConfidence,
} from './install-post-confidence.mjs';
import {
  INSTALL_POST_STATES,
  statusForReason,
  transitionRecord,
} from './install-post-queue.mjs';
import { sendReadyForM1Ping } from './install-post-ready-notify.mjs';

const IN_FLIGHT = new Set([
  INSTALL_POST_STATES.PUBLISHING,
  INSTALL_POST_STATES.VERIFYING,
]);

function defaultReadyNotifier({ record, logger }) {
  return sendReadyForM1Ping({ record, httpClient: axios, logger });
}

/**
 * Approve one exact revision, then dispatch the cloud runner or hand off to M1.
 *
 * Fails closed when the photo is missing or the deterministic gate HOLDs —
 * the same checks the auto-run applies, evaluated against the locked record
 * so a correction racing the tap cannot slip past. Reconcile re-runs an
 * earlier approval and skips the gate; it needs a dispatcher.
 */
export async function approveAndDispatchInstallPost({
  store,
  jobId,
  revision,
  dispatcher,
  now = Date.now,
  reconcile = false,
  readyNotifier = defaultReadyNotifier,
  logger = console,
} = {}) {
  if (!store) return { ok: false, reason: 'unavailable', record: null };
  if (!jobId) return { ok: false, reason: 'not_found', record: null };
  if (!dispatcher) {
    if (reconcile) {
      const record = await store.loadRecord(jobId);
      return {
        ok: false,
        reason: 'dispatch_unconfigured',
        record,
        status: statusForReason('dispatch_unconfigured'),
      };
    }
    return handOffToM1({ store, jobId, revision, now, readyNotifier, logger });
  }

  const at = new Date(now()).toISOString();
  const dispatchId = randomBytes(12).toString('hex');
  let refusal = null;
  let refused = null;
  let holdReasons = null;
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

    if (!unresolved) {
      const gate = evaluateInstallPostConfidence(confidenceFactsFromRecord(current));
      if (!gate.pass) {
        refusal = 'needs_human';
        holdReasons = gate.reasons;
        return null;
      }
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
      ...(holdReasons ? { holdReasons } : {}),
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
 * No cloud dispatcher: gate, then park the approved revision as READY_FOR_M1.
 * A repeat for the same revision is a quiet success (no second ping).
 */
async function handOffToM1({ store, jobId, revision, now, readyNotifier, logger }) {
  const at = new Date(now()).toISOString();
  let refusal = null;
  let refused = null;
  let holdReasons = null;

  const handed = await store.withRecordLock(jobId, async (current) => {
    refused = current;
    const transition = transitionRecord(current, { type: 'handoff', revision, at });
    if (!transition.ok) {
      refusal = transition.reason;
      return null;
    }
    const gate = evaluateInstallPostConfidence(confidenceFactsFromRecord(current));
    if (!gate.pass) {
      refusal = 'needs_human';
      holdReasons = gate.reasons;
      return null;
    }
    return transition.record;
  });

  if (!handed.ok) {
    if (refusal === 'already_ready') {
      return { ok: true, record: refused, readyForM1: true, alreadyReady: true };
    }
    const reason = refusal || handed.reason;
    return {
      ok: false,
      reason,
      record: refused,
      status: statusForReason(reason),
      ...(holdReasons ? { holdReasons } : {}),
    };
  }

  let ping = { skipped: 'no_notifier' };
  if (typeof readyNotifier === 'function') {
    try {
      ping = await readyNotifier({ record: handed.record, logger });
    } catch (err) {
      logger.warn?.('[install-post-auto-publish] ready ping failed open', {
        errorType: err?.name || 'Error',
      });
      ping = { forwarded: false, error: true };
    }
  }
  return { ok: true, record: handed.record, readyForM1: true, ping };
}

/**
 * Approve when a Square job already has a bound photo: cloud dispatch when a
 * dispatcher exists, otherwise READY_FOR_M1. No-ops (photo_required) when the
 * photo is missing — never invents one. Confidence HOLD stops here so Woodward
 * can correct city/street/size.
 */
export async function autoDispatchIfPhotoBound({
  store,
  jobId,
  dispatcher,
  now = Date.now,
  typesafeHttpClient,
  typesafeApiKey = process.env.TYPESAFE_API_KEY,
  readyNotifier,
  logger = console,
} = {}) {
  if (!store || !jobId) {
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

  const apiKey = typesafeApiKey;
  const jevClient = typesafeHttpClient
    || (String(apiKey || '').trim() ? axios : undefined);
  const gate = await resolveInstallPostConfidence(confidenceFactsFromRecord(record), {
    apiKey,
    httpClient: jevClient,
    logger,
  });
  if (!gate.pass) {
    return {
      ok: false,
      reason: 'needs_human',
      holdReasons: gate.reasons,
      record,
    };
  }

  return approveAndDispatchInstallPost({
    store,
    jobId,
    revision: record.revision,
    dispatcher,
    now,
    reconcile: record.state === INSTALL_POST_STATES.INDETERMINATE,
    ...(readyNotifier !== undefined ? { readyNotifier } : {}),
    logger,
  });
}

/** Best-effort approve for every staged record that already has a photo. */
export async function autoDispatchStagedJobs({
  records = [],
  store,
  dispatcher,
  now = Date.now,
  logger = console,
  typesafeHttpClient,
  typesafeApiKey,
  readyNotifier,
} = {}) {
  const results = [];
  if (!store) return results;
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
        typesafeHttpClient,
        typesafeApiKey,
        readyNotifier,
        logger,
      });
      results.push({
        jobId: record.jobId,
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason,
        holdReasons: outcome.holdReasons || null,
        dispatchId: outcome.dispatchId || null,
        readyForM1: Boolean(outcome.readyForM1),
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
