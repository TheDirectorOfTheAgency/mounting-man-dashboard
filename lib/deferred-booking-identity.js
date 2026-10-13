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
import { hashedUserData } from './booking-identity.js';
import { opaqueRef } from './offline-conversion-eligibility.js';

export const BOOKED_APPOINTMENT_ACTION_ID = '6491204814';
const GOOGLE_ADS_CUSTOMER_ID = '1287907452';
const DEFAULT_GOOGLE_ADS_API_VERSION = 'v24';
// Google accepts enhancement data up to 24h after the conversion; stop a bit
// earlier so a stuck record never uploads stale identifiers.
export const DEFERRED_MAX_AGE_MS = 23 * 60 * 60 * 1000;
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
    async drop(sessionRef) {
      await kv.del(pendingKey(sessionRef));
      await dropFromIndex(sessionRef);
    },
  };
}

function jobCustomerId(job) {
  return job?.customer?.id || job?.customer_id || null;
}

function unwrapJob(jobLike) {
  if (jobLike?.data && typeof jobLike.data === 'object' && (jobLike.data.id || jobLike.data.customer)) {
    return jobLike.data;
  }
  return jobLike;
}

function adjustmentIdentifiers(userData) {
  const identifiers = [];
  if (userData?.sha256_email_address) identifiers.push({ hashedEmail: userData.sha256_email_address });
  if (userData?.sha256_phone_number) identifiers.push({ hashedPhoneNumber: userData.sha256_phone_number });
  return identifiers;
}

const ALREADY_DONE_CODES = ['CONVERSION_ALREADY_ENHANCED'];
const PERMANENT_CODES = ['CONVERSION_NOT_FOUND', 'MISSING_ORDER_ID_FOR_WEBPAGE', 'INVALID_CONVERSION_ACTION_TYPE'];

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
        return { ok: false, permanent: codes.some((code) => PERMANENT_CODES.includes(code)), codes };
      }
      return { ok: true, validated: Boolean(validateOnly) };
    } catch (error) {
      const status = error?.response?.status;
      return {
        ok: false,
        permanent: status === 400 || status === 403,
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
  const age = now - Date.parse(pending.requestedAt || '');
  if (!(age >= 0) || age > DEFERRED_MAX_AGE_MS) {
    if (!validateOnly) await idStore.drop(sessionRef);
    return { outcome: 'expired' };
  }
  const jobId = await attributionStore?.getJobIdForSession?.(pending.orderId);
  if (!jobId) return { outcome: 'not_linked' };
  let resolvedJob = unwrapJob(job);
  if (!resolvedJob || String(resolvedJob.id || jobId) !== String(jobId)) {
    resolvedJob = unwrapJob(loadJob ? await loadJob(jobId) : null);
  }
  if (!resolvedJob) return { outcome: 'job_unavailable', jobRef: opaqueRef(jobId).slice(0, 12) };
  const customerId = jobCustomerId(resolvedJob);
  if (!customerId || opaqueRef(customerId) !== pending.customerRef) {
    if (!validateOnly) await idStore.drop(sessionRef);
    return { outcome: 'customer_mismatch', jobRef: opaqueRef(jobId).slice(0, 12) };
  }
  const userData = hashedUserData({
    email: resolvedJob.customer?.email || resolvedJob.customer_email,
    phone: resolvedJob.customer?.phone || resolvedJob.customer?.phone_number || resolvedJob.customer_phone,
  });
  if (!userData) {
    if (!validateOnly) await idStore.drop(sessionRef);
    return { outcome: 'no_identifiers' };
  }
  if (!validateOnly && !(await idStore.claim(sessionRef, owner))) return { outcome: 'in_progress' };
  try {
    const result = await upload({ orderId: pending.orderId, userData, validateOnly });
    const fields = Object.keys(userData);
    if (result.ok) {
      if (!validateOnly) await idStore.markEnhanced(sessionRef, { alreadyEnhanced: Boolean(result.alreadyEnhanced) });
      return { outcome: result.alreadyEnhanced ? 'already_enhanced' : (validateOnly ? 'validated' : 'enhanced'), fields, jobRef: opaqueRef(jobId).slice(0, 12) };
    }
    if (!validateOnly) {
      if (result.permanent) await idStore.drop(sessionRef);
      await idStore.release(sessionRef);
    }
    return { outcome: result.permanent ? 'rejected' : 'upload_retry', codes: result.codes };
  } catch {
    if (!validateOnly) await idStore.release(sessionRef);
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
  const refs = (await idStore.listPendingRefs()).slice(0, limit);
  const counts = {};
  for (const ref of refs) {
    let result;
    try {
      result = await resolveDeferredSession({ sessionRef: ref, idStore, attributionStore, loadJob, upload, now, validateOnly });
    } catch {
      result = { outcome: 'error' };
    }
    if (result.outcome === 'no_pending' && !validateOnly) await idStore.drop(ref);
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    if (!['not_linked', 'no_pending'].includes(result.outcome)) logDeferredOutcome(logger, ref, result, 'cron');
  }
  return { pending: refs.length, counts };
}
