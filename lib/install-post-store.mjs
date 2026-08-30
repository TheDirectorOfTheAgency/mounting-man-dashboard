// lib/install-post-store.mjs
//
// Upstash-backed storage for the cloud installation-post queue.
//
// Two separate namespaces, on purpose:
//   install-post:job:<jobId>     safe record the phone and the runner may read
//   install-post:source:<jobId>  Square order/payment refs, server-side only
//
// Nothing in the job namespace may contain a customer name, full address, or
// Square identifier, so a leak of the mobile surface cannot expose them.

import { createHash } from 'node:crypto';

import {
  INSTALL_POST_STATES,
  buildOperatorLinks,
  canonicalRevision,
  safeSeed,
  transitionRecord,
} from './install-post-queue.mjs';

const JOB_KEY_PREFIX = 'install-post:job:';
const SOURCE_KEY_PREFIX = 'install-post:source:';
const LEASE_KEY_PREFIX = 'install-post:lease:';
const LOCK_KEY_PREFIX = 'install-post:lock:';
const UPLOAD_KEY_PREFIX = 'install-post:upload:';
const JOB_INDEX_KEY = 'install-post:job-index';

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_LEASE_TTL_SECONDS = 60 * 60;     // 1 hour — outlives a runner pass
const DEFAULT_LOCK_TTL_SECONDS = 30;
const DEFAULT_UPLOAD_TTL_SECONDS = 30 * 60;

/** Unwrap Upstash values that were JSON-encoded more than once over time. */
export function decodeStoredRecord(raw) {
  let value = raw;
  for (let depth = 0; depth < 5 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

/**
 * Opaque, deterministic job identity.
 *
 * Deterministic so Square webhook retries re-stage the same job instead of
 * creating a second card; opaque so the identifier itself reveals no order,
 * payment, or customer reference.
 */
export function installPostJobId({ orderId = '', paymentId = '', invoiceId = '', seedIndex = 1 } = {}) {
  const material = JSON.stringify([
    String(orderId || ''),
    String(paymentId || ''),
    String(invoiceId || ''),
    Number(seedIndex) || 1,
  ]);
  return `job_${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

function newRecord({ jobId, seed, source, stagedAt }) {
  const safe = safeSeed(seed);
  return {
    jobId,
    createdAt: stagedAt,
    updatedAt: stagedAt,
    source: String(source || ''),
    state: INSTALL_POST_STATES.AWAITING_PHOTO,
    seed: safe,
    image: null,
    revision: canonicalRevision({ seed: safe, image: null }),
    approval: null,
    lease: null,
    result: null,
    postedDestinations: [],
  };
}

/** One normalized, unapproved record per candidate TV. Pure. */
export function buildJobRecords({ seeds, sourceRefs = {}, source = '', stagedAt } = {}) {
  const list = Array.isArray(seeds) ? seeds : [];
  const at = stagedAt || new Date().toISOString();
  return list.map((seed, index) => newRecord({
    jobId: installPostJobId({
      orderId: sourceRefs.orderId,
      paymentId: sourceRefs.paymentId,
      invoiceId: sourceRefs.invoiceId,
      seedIndex: Number(seed?.['seed-index']) || index + 1,
    }),
    seed,
    source,
    stagedAt: at,
  }));
}

/**
 * Convert a legacy `install-post:pending:*` record into job records.
 * Imported jobs are always unapproved — history never auto-publishes.
 */
export function importLegacyPendingRecord(raw) {
  const decoded = decodeStoredRecord(raw);
  if (!decoded) return [];
  const seeds = Array.isArray(decoded.seeds) && decoded.seeds.length
    ? decoded.seeds
    : (decoded.seed ? [decoded.seed] : []);
  if (!seeds.length) return [];

  return buildJobRecords({
    seeds,
    sourceRefs: {
      orderId: decoded.orderId,
      paymentId: decoded.paymentId,
      invoiceId: decoded.invoiceId,
    },
    source: decoded.source || 'legacy-import',
    stagedAt: decoded.stagedAt,
  }).map((record) => transitionRecord(record, { type: 'import' }).record);
}

export function createInstallPostStore(kv, {
  ttlSeconds = DEFAULT_TTL_SECONDS,
  leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
  uploadTtlSeconds = DEFAULT_UPLOAD_TTL_SECONDS,
} = {}) {
  for (const method of ['get', 'set', 'del', 'sadd', 'srem', 'smembers']) {
    if (typeof kv?.[method] !== 'function') throw new Error(`KV adapter is missing ${method}`);
  }

  const jobKey = (jobId) => `${JOB_KEY_PREFIX}${jobId}`;
  const sourceKey = (jobId) => `${SOURCE_KEY_PREFIX}${jobId}`;
  const leaseKey = (jobId, revision) => `${LEASE_KEY_PREFIX}${jobId}:${revision}`;
  const lockKey = (jobId) => `${LOCK_KEY_PREFIX}${jobId}`;
  const uploadKey = (uploadId) => `${UPLOAD_KEY_PREFIX}${uploadId}`;

  async function loadRecord(jobId) {
    if (!jobId) return null;
    const raw = await kv.get(jobKey(jobId));
    return decodeStoredRecord(raw);
  }

  async function saveRecord(record) {
    if (!record?.jobId) throw new Error('record.jobId is required');
    await kv.set(jobKey(record.jobId), JSON.stringify(record), { ex: ttlSeconds });
    await kv.sadd(JOB_INDEX_KEY, record.jobId);
    return record;
  }

  async function listJobIds() {
    const members = await kv.smembers(JOB_INDEX_KEY);
    return Array.isArray(members) ? members : [];
  }

  async function loadSourceRefs(jobId) {
    return decodeStoredRecord(await kv.get(sourceKey(jobId))) || {};
  }

  async function stageJobRecords({ seeds, sourceRefs = {}, source = '', stagedAt } = {}) {
    const candidates = buildJobRecords({ seeds, sourceRefs, source, stagedAt });
    const stored = [];
    for (const candidate of candidates) {
      // Webhook retries must not reset a card the operator already worked on.
      const existing = await loadRecord(candidate.jobId);
      if (existing) {
        stored.push(existing);
        continue;
      }
      await kv.set(sourceKey(candidate.jobId), JSON.stringify({
        orderId: String(sourceRefs.orderId || ''),
        paymentId: String(sourceRefs.paymentId || ''),
        invoiceId: String(sourceRefs.invoiceId || ''),
      }), { ex: ttlSeconds });
      stored.push(await saveRecord(candidate));
    }
    return stored;
  }

  /**
   * Atomic one-dispatch-per-revision gate (Redis SET NX).
   * Fails closed: an unreachable store returns 'unavailable', never 'claimed'.
   *
   * `takeover` overwrites an existing key instead of refusing. It is only valid
   * for a caller holding this job's record lock, which has already established
   * that the key does not correspond to a live dispatch.
   */
  async function claimPublishLease({ jobId, revision, dispatchId, takeover = false }) {
    if (!jobId || !revision) return 'unavailable';
    try {
      const result = await kv.set(
        leaseKey(jobId, revision),
        JSON.stringify({ dispatchId: String(dispatchId || ''), claimedAt: new Date().toISOString() }),
        takeover ? { ex: leaseTtlSeconds } : { nx: true, ex: leaseTtlSeconds },
      );
      return result ? 'claimed' : 'duplicate';
    } catch {
      return 'unavailable';
    }
  }

  async function releasePublishLease({ jobId, revision }) {
    if (!jobId || !revision) return false;
    try {
      await kv.del(leaseKey(jobId, revision));
      return true;
    } catch {
      return false;
    }
  }

  /** Read-modify-write a record under a short-lived exclusive lock. */
  async function withRecordLock(jobId, mutator) {
    let locked = false;
    try {
      locked = Boolean(await kv.set(lockKey(jobId), '1', { nx: true, ex: lockTtlSeconds }));
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (!locked) return { ok: false, reason: 'locked' };

    try {
      const current = await loadRecord(jobId);
      if (!current) return { ok: false, reason: 'not_found' };
      const next = await mutator(current);
      if (!next) return { ok: false, reason: 'aborted', record: current };
      await saveRecord(next);
      return { ok: true, record: next };
    } finally {
      await kv.del(lockKey(jobId)).catch(() => {});
    }
  }

  async function saveUploadSession(session) {
    await kv.set(uploadKey(session.uploadId), JSON.stringify(session), { ex: uploadTtlSeconds });
    return session;
  }

  async function loadUploadSession(uploadId) {
    if (!uploadId) return null;
    return decodeStoredRecord(await kv.get(uploadKey(uploadId)));
  }

  async function deleteUploadSession(uploadId) {
    if (!uploadId) return false;
    await kv.del(uploadKey(uploadId));
    return true;
  }

  return {
    loadRecord,
    saveRecord,
    listJobIds,
    loadSourceRefs,
    stageJobRecords,
    claimPublishLease,
    releasePublishLease,
    withRecordLock,
    saveUploadSession,
    loadUploadSession,
    deleteUploadSession,
  };
}

/**
 * Stage one cloud job per TV and return its operator link.
 *
 * Best-effort by design: if the queue is unconfigured or Upstash is down, the
 * existing Square notification still goes out, just without the new links.
 */
export async function stageOperatorHandoff({
  store,
  seeds,
  sourceRefs,
  source,
  secret,
  baseUrl,
  stagedAt,
} = {}) {
  if (!store || !secret || !baseUrl || !Array.isArray(seeds) || !seeds.length) return [];
  try {
    const records = await store.stageJobRecords({ seeds, sourceRefs, source, stagedAt });
    return buildOperatorLinks({ records, secret, baseUrl });
  } catch (err) {
    console.error('[install-post-queue] staging failed:', err.message);
    return [];
  }
}

let cachedStore;

/** Lazily build the production store. Returns null when Upstash is unset. */
export async function getInstallPostStore() {
  if (cachedStore !== undefined) return cachedStore;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    cachedStore = null;
    return cachedStore;
  }
  const { kv } = await import('@vercel/kv');
  cachedStore = createInstallPostStore(kv);
  return cachedStore;
}
