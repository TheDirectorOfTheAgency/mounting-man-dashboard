// Server-side fallback for the thank-you enhanced-conversion identity.
//
// When /api/attribution/booking-identity cannot resolve user data in time
// (ZenBooker has not created the job yet, or the list call is slow), it parks
// a pending record. Once the ZenBooker job exists AND is linked to that exact
// booking session (KV session→job bridge written by the job webhook or a
// later capture), this module sends the hashed email/phone to Google Ads as an
// ENHANCEMENT adjustment of the Booked Appointment (WEBPAGE) conversion, keyed
// by order_id = booking_session (the tag's transaction_id).
//
// An enhancement never creates a conversion; it only attaches identifiers to
// the one the thank-you tag already recorded with that order id, so the
// booking cannot be counted twice. We additionally dedupe by booking session:
//   - thank-you path resolved in time  → ec:thankyou:<sessionRef>, never deferred
//   - deferred upload accepted         → ec:enhanced:<sessionRef>, never again
// Google itself rejects a second enhancement (CONVERSION_ALREADY_ENHANCED).
//
// Privacy (docs/enhanced-conversions-thank-you.md): plain email/phone never
// leave this process and never reach KV or logs. KV holds the booking session
// (an opaque ZenBooker ID needed as the Google order id), an opaque customer
// reference, and timestamps. Logs carry 12-char refs, reasons and counts only.

import axios from 'axios';
import { getAccessToken, getDeveloperToken } from './google-ads-auth.js';
import { hashedUserData, parseJobsBody } from './booking-identity.js';
import { opaqueRef } from './offline-conversion-eligibility.js';

export const BOOKED_APPOINTMENT_ACTION_ID = '6491204814';
const GOOGLE_ADS_CUSTOMER_ID = '1287907452';
const DEFAULT_GOOGLE_ADS_API_VERSION = 'v24';
// Google accepts enhancement data up to 24h after the conversion; stop a bit
// earlier so a stuck record never uploads stale identifiers.
export const DEFERRED_MAX_AGE_MS = 23 * 60 * 60 * 1000;
// The thank-you tag fires only after the identity endpoint answers, and Google
// needs time to ingest that conversion. Uploading earlier returns
// CONVERSION_NOT_FOUND. First attempt waits; not-found / transient failures
// back off and retry until the 23 h cut-off.
export const FIRST_ATTEMPT_DELAY_MS = 60 * 60 * 1000;
export const RETRY_BACKOFF_MS = [60, 120, 240, 360].map((m) => m * 60 * 1000);
const PENDING_TTL_SECONDS = 26 * 60 * 60;
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLAIM_TTL_SECONDS = 5 * 60;
const PENDING_INDEX = 'ec:pending-index';

const shortRef = (sessionRef) => String(sessionRef || '').slice(0, 12);

export function createDeferredIdentityStore(kv) {
  for (const method of ['set', 'get', 'del', 'sadd', 'smembers']) {
    if (typeof kv?.[method] !== 'function') throw new Error(`KV adapter is missing ${method}`);
  }
  const pendingKey = (ref) => `ec:pending:${ref}`;
  const thankYouKey = (ref) => `ec:thankyou:${ref}`;
  const enhancedKey = (ref) => `ec:enhanced:${ref}`;
  const claimKey = (ref) => `ec:claim:${ref}`;
  const dropFromIndex = async (ref) => {
    if (typeof kv.srem === 'function') await kv.srem(PENDING_INDEX, ref);
  };

  return {
    async markThankYouResolved(bookingSession) {
      const ref = opaqueRef(bookingSession);
      await kv.set(thankYouKey(ref), { at: new Date().toISOString() }, { ex: DONE_TTL_SECONDS });
      await kv.del(pendingKey(ref));
      await dropFromIndex(ref);
      return ref;
    },
    async savePending({ bookingSession, customerId, now = Date.now() }) {
      const ref = opaqueRef(bookingSession);
      if (await kv.get(thankYouKey(ref)) || await kv.get(enhancedKey(ref))) return null;
      const existing = await kv.get(pendingKey(ref));
      const value = {
        sessionRef: ref,
        orderId: String(bookingSession),
        customerRef: opaqueRef(customerId),
        requestedAt: existing?.requestedAt || new Date(now).toISOString(),
      };
      await kv.set(pendingKey(ref), value, { ex: PENDING_TTL_SECONDS });
      await kv.sadd(PENDING_INDEX, ref);
      if (typeof kv.expire === 'function') await kv.expire(PENDING_INDEX, PENDING_TTL_SECONDS);
      return value;
    },
    async getPending(sessionRef) {
      return sessionRef ? kv.get(pendingKey(sessionRef)) : null;
    },
    async listPendingRefs() {
      return (await kv.smembers(PENDING_INDEX)) || [];
    },
    async isDone(sessionRef) {
      return Boolean(await kv.get(thankYouKey(sessionRef)) || await kv.get(enhancedKey(sessionRef)));
    },
    async claim(sessionRef, owner) {
      const result = await kv.set(claimKey(sessionRef), owner, { nx: true, ex: CLAIM_TTL_SECONDS });
      return result === 'OK' || result === true;
    },
    async release(sessionRef) {
      await kv.del(claimKey(sessionRef));
    },
    async markEnhanced(sessionRef, meta = {}) {
      await kv.set(enhancedKey(sessionRef), { at: new Date().toISOString(), ...meta }, { ex: DONE_TTL_SECONDS });
      await kv.del(pendingKey(sessionRef));
      await kv.del(claimKey(sessionRef));
      await dropFromIndex(sessionRef);
    },
    async recordAttempt(sessionRef, { nextAttemptAt, lastCodes = [] }) {
      const pending = await kv.get(pendingKey(sessionRef));
      if (!pending) return null;
      const value = {
        ...pending,
        attempts: (Number(pending.attempts) || 0) + 1,
        nextAttemptAt: new Date(nextAttemptAt).toISOString(),
        lastCodes: lastCodes.slice(0, 6),
      };
      // Keep the original expiry instead of extending it on every retry (audit #7).
      const requestedMs = Date.parse(pending.requestedAt || '');
      const remaining = Number.isFinite(requestedMs)
        ? Math.ceil((requestedMs + PENDING_TTL_SECONDS * 1000 - Date.now()) / 1000)
        : PENDING_TTL_SECONDS;
      if (remaining <= 0) {
        await kv.del(pendingKey(sessionRef));
        return null;
      }
      await kv.set(pendingKey(sessionRef), value, { ex: Math.min(remaining, PENDING_TTL_SECONDS) });
      return value;
    },
    async drop(sessionRef) {
      await kv.del(pendingKey(sessionRef));
      await dropFromIndex(sessionRef);
    },
  };
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const firstValue = (layers, read) => {
  for (const layer of layers) {
    const value = read(layer);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
};

// Normalizes every job shape we accept (same set as the webhook FIELD_MAP and
// attribution bridge): a bare job, { data: job }, { data: { job } }, { job },
// { result: job }, and JSON strings of any of these (including ZenBooker's
// bare-empty lat/lng bodies). Returns { id, customer: { id, email, phone } }.
export function normalizeJobLike(input) {
  const root = typeof input === 'string' ? parseJobsBody(input) : input;
  if (!isRecord(root)) return null;
  const data = isRecord(root.data) ? root.data : null;
  const layers = [
    isRecord(data?.job) ? data.job : null,
    isRecord(root.job) ? root.job : null,
    isRecord(root.result) ? root.result : null,
    data,
    root,
  ].filter(Boolean);
  const customer = (layer) => (isRecord(layer.customer) ? layer.customer : {});
  const job = {
    id: firstValue(layers, (l) => l.id ?? l.job_id),
    customer: {
      id: firstValue(layers, (l) => customer(l).id ?? l.customer_id),
      email: firstValue(layers, (l) => customer(l).email ?? l.customer_email),
      phone: firstValue(layers, (l) => customer(l).phone ?? customer(l).phone_number ?? l.customer_phone),
    },
  };
  return job.id || job.customer.id || job.customer.email || job.customer.phone ? job : null;
}

function adjustmentIdentifiers(userData) {
  const identifiers = [];
  if (userData?.sha256_email_address) identifiers.push({ hashedEmail: userData.sha256_email_address });
  if (userData?.sha256_phone_number) identifiers.push({ hashedPhoneNumber: userData.sha256_phone_number });
  return identifiers;
}

const ALREADY_DONE_CODES = ['CONVERSION_ALREADY_ENHANCED'];
// CONVERSION_NOT_FOUND is NOT permanent: the tag's conversion may not be
// ingested yet. Only configuration errors that no retry can fix are permanent.
const PERMANENT_CODES = ['MISSING_ORDER_ID_FOR_WEBPAGE', 'INVALID_CONVERSION_ACTION_TYPE', 'INVALID_USER_IDENTIFIER'];

function googleErrorCodes(value) {
  const text = JSON.stringify(value || {});
  return [...new Set((text.match(/[A-Z][A-Z_]{5,}/g) || []))]
    .filter((code) => /ENHANCED|NOT_FOUND|ORDER_ID|CONVERSION|INVALID|TOO_RECENT|PERMISSION|UNAUTH|QUOTA|INTERNAL|UNAVAILABLE|DEADLINE/.test(code))
    .slice(0, 6);
}

export function createEnhancementUploader({
  env = process.env,
  httpClient = axios,
  getToken = getAccessToken,
  getDevToken = getDeveloperToken,
} = {}) {
  return async function uploadEnhancement({ orderId, userData, validateOnly = false }) {
    const actionId = env.GOOGLE_ADS_BOOKED_APPOINTMENT_ACTION_ID || BOOKED_APPOINTMENT_ACTION_ID;
    const apiVersion = env.GOOGLE_ADS_API_VERSION || DEFAULT_GOOGLE_ADS_API_VERSION;
    const userIdentifiers = adjustmentIdentifiers(userData);
    if (!orderId || userIdentifiers.length === 0) return { ok: false, permanent: true, codes: ['NO_IDENTIFIERS'] };
    const body = {
      conversionAdjustments: [{
        conversionAction: `customers/${GOOGLE_ADS_CUSTOMER_ID}/conversionActions/${actionId}`,
        adjustmentType: 'ENHANCEMENT',
        orderId: String(orderId),
        userIdentifiers,
      }],
      partialFailure: true,
      validateOnly: Boolean(validateOnly),
    };
    try {
      const token = await getToken();
      const response = await httpClient.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${GOOGLE_ADS_CUSTOMER_ID}:uploadConversionAdjustments`,
        body,
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'developer-token': getDevToken() }, timeout: 10000 },
      );
      const partial = response?.data?.partialFailureError;
      if (partial) {
        const codes = googleErrorCodes(partial);
        if (codes.some((code) => ALREADY_DONE_CODES.includes(code))) return { ok: true, alreadyEnhanced: true, codes };
        return {
          ok: false,
          permanent: codes.some((code) => PERMANENT_CODES.includes(code)) && !codes.includes('CONVERSION_NOT_FOUND'),
          codes,
        };
      }
      return { ok: true, validated: Boolean(validateOnly) };
    } catch (error) {
      const status = error?.response?.status;
      return {
        ok: false,
        // Request-level 4xx (auth, malformed) will not fix itself, but they are
        // config problems, not booking problems: keep retrying until expiry so a
        // fixed credential still delivers. Nothing is marked done.
        permanent: false,
        codes: [status ? `http_${status}` : (error?.code || 'network'), ...googleErrorCodes(error?.response?.data)],
      };
    }
  };
}

// Resolve one parked booking. `job` may be supplied (webhook payload) or is
// fetched by id. Returns { outcome, ... } with no PII.
export async function resolveDeferredSession({
  sessionRef,
  idStore,
  attributionStore,
  job = null,
  loadJob,
  upload,
  now = Date.now(),
  validateOnly = false,
  owner = `deferred-${now}`,
}) {
  const pending = await idStore.getPending(sessionRef);
  if (!pending) return { outcome: 'no_pending' };
  if (await idStore.isDone(sessionRef)) {
    await idStore.drop(sessionRef);
    return { outcome: 'already_resolved' };
  }
  const requestedAt = Date.parse(pending.requestedAt || '');
  const age = now - requestedAt;
  if (!(age >= 0) || age > DEFERRED_MAX_AGE_MS) {
    if (!validateOnly) await idStore.drop(sessionRef);
    return { outcome: 'expired', attempts: Number(pending.attempts) || 0 };
  }
  const dueAt = Date.parse(pending.nextAttemptAt || '') || (requestedAt + FIRST_ATTEMPT_DELAY_MS);
  if (now < dueAt) return { outcome: 'waiting' };
  const scheduleRetry = async (codes) => {
    if (validateOnly) return;
    const attempts = Number(pending.attempts) || 0;
    const delay = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)];
    await idStore.recordAttempt(sessionRef, { nextAttemptAt: now + delay, lastCodes: codes || [] });
  };
  const jobId = await attributionStore?.getJobIdForSession?.(pending.orderId);
  if (!jobId) return { outcome: 'not_linked' };
  const jobRefShort = opaqueRef(jobId).slice(0, 12);
  let resolvedJob = normalizeJobLike(job);
  const usable = (candidate) => candidate && (!candidate.id || String(candidate.id) === String(jobId))
    && candidate.customer.id && (candidate.customer.email || candidate.customer.phone);
  if (!usable(resolvedJob) && loadJob) {
    const fetched = normalizeJobLike(await loadJob(jobId));
    if (fetched && (usable(fetched) || !resolvedJob)) resolvedJob = fetched;
  }
  if (!resolvedJob || (resolvedJob.id && String(resolvedJob.id) !== String(jobId))) {
    return { outcome: 'job_unavailable', jobRef: jobRefShort };
  }
  // Missing data is not proof of a mismatch: leave it parked for the cron.
  if (!resolvedJob.customer.id) return { outcome: 'job_incomplete', jobRef: jobRefShort };
  if (opaqueRef(resolvedJob.customer.id) !== pending.customerRef) {
    if (!validateOnly) await idStore.drop(sessionRef);
    return { outcome: 'customer_mismatch', jobRef: jobRefShort };
  }
  const userData = hashedUserData({ email: resolvedJob.customer.email, phone: resolvedJob.customer.phone });
  if (!userData) return { outcome: 'job_incomplete', jobRef: jobRefShort };
  if (!validateOnly && !(await idStore.claim(sessionRef, owner))) return { outcome: 'in_progress' };
  try {
    const result = await upload({ orderId: pending.orderId, userData, validateOnly });
    const fields = Object.keys(userData);
    // Done only when Google accepted it (or already holds an enhancement for
    // this order id). validateOnly never marks anything.
    if (result.ok && !validateOnly) {
      await idStore.markEnhanced(sessionRef, { alreadyEnhanced: Boolean(result.alreadyEnhanced) });
      return { outcome: result.alreadyEnhanced ? 'already_enhanced' : 'enhanced', fields, jobRef: jobRefShort };
    }
    if (result.ok) return { outcome: 'validated', fields, jobRef: jobRefShort };
    if (!validateOnly) {
      if (result.permanent) await idStore.drop(sessionRef);
      else await scheduleRetry(result.codes);
      await idStore.release(sessionRef);
    }
    const notFound = (result.codes || []).includes('CONVERSION_NOT_FOUND');
    return { outcome: result.permanent ? 'rejected' : (notFound ? 'conversion_not_ingested' : 'upload_retry'), codes: result.codes };
  } catch {
    if (!validateOnly) {
      await scheduleRetry(['exception']);
      await idStore.release(sessionRef);
    }
    return { outcome: 'upload_retry', codes: ['exception'] };
  }
}

export function logDeferredOutcome(logger, sessionRef, result, path) {
  (logger || console).info('booking_identity_deferred', {
    bookingRef: shortRef(sessionRef),
    path,
    outcome: result.outcome,
    ...(result.fields ? { fields: result.fields } : {}),
    ...(result.jobRef ? { jobRef: result.jobRef } : {}),
    ...(result.codes ? { codes: result.codes } : {}),
    ...(result.attempts !== undefined ? { attempts: result.attempts } : {}),
  });
}

// Webhook path: a job just arrived and may have been linked to a session.
export async function resolveDeferredForJob({ jobId, job, attributionStore, idStore, upload, logger = console, now = Date.now() }) {
  if (!jobId || !attributionStore?.getJobBridge || !idStore) return null;
  const bridge = await attributionStore.getJobBridge(jobId);
  if (!bridge?.sessionRef) return null;
  const pending = await idStore.getPending(bridge.sessionRef);
  if (!pending) return null;
  const result = await resolveDeferredSession({
    sessionRef: bridge.sessionRef, idStore, attributionStore, job, upload, now,
  });
  logDeferredOutcome(logger, bridge.sessionRef, result, 'webhook');
  return result;
}

// Cron path: sweep every parked booking.
export async function sweepDeferredIdentities({ idStore, attributionStore, loadJob, upload, logger = console, now = Date.now(), validateOnly = false, limit = 50 }) {
  // Visit every parked ref in random order and cap only the ones that do real
  // work, so cheap "waiting"/"not_linked" entries cannot starve the rest (audit #7).
  const refs = [...(await idStore.listPendingRefs())];
  for (let i = refs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [refs[i], refs[j]] = [refs[j], refs[i]];
  }
  const counts = {};
  let worked = 0;
  for (const ref of refs) {
    if (worked >= limit) {
      counts.deferred_to_next_run = (counts.deferred_to_next_run || 0) + 1;
      continue;
    }
    let result;
    try {
      result = await resolveDeferredSession({ sessionRef: ref, idStore, attributionStore, loadJob, upload, now, validateOnly });
    } catch {
      result = { outcome: 'error' };
    }
    if (result.outcome === 'no_pending' && !validateOnly) await idStore.drop(ref);
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    if (!['not_linked', 'no_pending', 'waiting', 'already_resolved'].includes(result.outcome)) worked += 1;
    if (!['not_linked', 'no_pending', 'waiting'].includes(result.outcome)) logDeferredOutcome(logger, ref, result, 'cron');
  }
  return { pending: refs.length, counts };
}
