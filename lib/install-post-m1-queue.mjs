// lib/install-post-m1-queue.mjs
//
// Pickup side of READY_FOR_M1. The M1 worker (m1/install-post-worker) claims
// one approved job, runs the canonical jewel-way-run publisher, and reports
// through the same signed runner callback the frozen cloud runner used. No
// GitHub Actions dispatch, no GBP queue, no Reddit.

import { randomBytes } from 'node:crypto';

import {
  collectPostedDestinations,
  INSTALL_POST_STATES,
  transitionRecord,
} from './install-post-queue.mjs';

const WORKER_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function sanitizeM1WorkerId(value) {
  const id = String(value || '').trim();
  return WORKER_ID_RE.test(id) ? id : '';
}

/**
 * Exactly what the publisher may see for one approved revision: the safe seed
 * and the bound photo reference. Never a Square identifier or customer detail.
 */
export function buildRunnerEnvelope(record, { dispatchId } = {}) {
  return {
    jobId: record.jobId,
    revision: record.revision,
    approvedAt: record.approval?.approvedAt || '',
    ...(dispatchId ? { dispatchId } : {}),
    seed: record.seed,
    image: {
      sha256: record.image.sha256,
      bytes: record.image.bytes,
      contentType: record.image.contentType,
      hostedUrl: record.image.hostedUrl,
      assetId: record.image.assetId || '',
    },
    postedDestinations: collectPostedDestinations(
      record.postedDestinations,
      record.result?.destinations,
    ),
    // Real install photo only; the publisher must never generate TV art.
    artMode: 'never',
  };
}

function claimable(record) {
  return record?.state === INSTALL_POST_STATES.READY_FOR_M1
    && record.approval?.revision === record.revision
    && Boolean(record.image?.hostedUrl);
}

function approvedAtMs(record) {
  const ms = Date.parse(record?.approval?.approvedAt || record?.updatedAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

async function claimOne({ store, record, workerId, at, dispatchId }) {
  let refusal = null;
  let claimed = false;
  const outcome = await store.withRecordLock(record.jobId, async (current) => {
    if (!claimable(current)) {
      refusal = 'not_ready_for_m1';
      return null;
    }
    let claim = await store.claimPublishLease({ jobId: current.jobId, revision: current.revision, dispatchId });
    // READY_FOR_M1 never holds a live lease, so a leftover key for this
    // revision (an earlier dispatch that was released late) is safe to take
    // over while this record lock is held.
    if (claim === 'duplicate') {
      claim = await store.claimPublishLease({
        jobId: current.jobId, revision: current.revision, dispatchId, takeover: true,
      });
    }
    if (claim !== 'claimed') {
      refusal = 'unavailable';
      return null;
    }
    claimed = true;
    const transition = transitionRecord(current, {
      type: 'm1_claim',
      revision: current.revision,
      dispatchId,
      workerId,
      at,
    });
    if (!transition.ok) {
      refusal = transition.reason;
      return null;
    }
    return transition.record;
  });

  if (!outcome.ok) {
    if (claimed) await store.releasePublishLease({ jobId: record.jobId, revision: record.revision });
    return { ok: false, reason: refusal || outcome.reason };
  }
  return { ok: true, record: outcome.record };
}

/**
 * Claim the oldest READY_FOR_M1 job for one worker, or return `job: null`.
 *
 * Each claim is one publish lease on one approved revision, so two workers (or
 * a worker and a late phone tap) cannot publish the same Square job twice.
 */
export async function claimNextReadyForM1({
  store,
  workerId,
  now = Date.now,
  dispatchIdFactory = () => randomBytes(12).toString('hex'),
  rescan = false,
} = {}) {
  if (!store) return { ok: false, reason: 'unavailable' };
  const safeWorkerId = sanitizeM1WorkerId(workerId);
  if (!safeWorkerId) return { ok: false, reason: 'worker_id_required' };

  if (rescan) await store.rebuildReadyForM1Index();

  const candidates = [];
  for (const jobId of await store.listReadyForM1Ids()) {
    const record = await store.loadRecord(jobId);
    if (claimable(record)) candidates.push(record);
  }
  candidates.sort((left, right) => approvedAtMs(left) - approvedAtMs(right));

  const at = new Date(now()).toISOString();
  for (const record of candidates) {
    const dispatchId = dispatchIdFactory();
    const claimed = await claimOne({ store, record, workerId: safeWorkerId, at, dispatchId });
    if (claimed.ok) {
      return { ok: true, job: buildRunnerEnvelope(claimed.record, { dispatchId }) };
    }
    if (claimed.reason === 'unavailable') return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, job: null };
}
