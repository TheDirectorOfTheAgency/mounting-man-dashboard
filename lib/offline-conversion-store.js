import { opaqueRef } from './offline-conversion-eligibility.js';

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const ONE_SHOT_TTL_SECONDS = 24 * 60 * 60;
const ACTIVE_CLAIM_TTL_SECONDS = 5 * 60;

function requireValue(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value;
}

function sanitizeAcquisition(acquisition = {}) {
  return {
    paidEvidence: Boolean(acquisition.paidEvidence),
    paidMarker: acquisition.paidMarker || null,
    sourceClass: acquisition.sourceClass || null,
    mediumClass: acquisition.mediumClass || null,
    hasCampaign: Boolean(acquisition.hasCampaign),
    hasLandingContext: Boolean(acquisition.hasLandingContext),
    hasGclid: Boolean(acquisition.hasGclid),
    hasGbraid: Boolean(acquisition.hasGbraid),
    hasWbraid: Boolean(acquisition.hasWbraid),
  };
}

function sanitizeConsentStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return ['GRANTED', 'DENIED', 'UNKNOWN'].includes(status) ? status : 'UNKNOWN';
}

function sanitizeTimestamp(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return String(value);
}

export function createAttributionStore(kv, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  for (const method of ['set', 'get', 'del', 'sadd', 'smembers', 'expire']) {
    if (typeof kv?.[method] !== 'function') throw new Error(`KV adapter is missing ${method}`);
  }

  const customerRef = (squareCustomerId) => opaqueRef(requireValue(squareCustomerId, 'Square customer ID'));
  const jobRef = (jobId) => {
    const value = String(requireValue(jobId, 'ZenBooker job ID'));
    return /^[a-f0-9]{24}$/.test(value) ? value : opaqueRef(value);
  };
  const paymentRef = (paymentId) => {
    const value = String(requireValue(paymentId, 'Square payment ID'));
    return /^[a-f0-9]{24}$/.test(value) ? value : opaqueRef(value);
  };
  const mappingKey = (jobId) => `attrib:job-map:${jobRef(jobId)}`;
  const pendingJobKey = (customerId, jobId) =>
    `attrib:pending-job:${customerRef(customerId)}:${jobRef(jobId)}`;
  const pendingJobIndex = (customerId) => `attrib:pending-jobs:${customerRef(customerId)}`;
  const paymentKey = (customerId, paymentId) =>
    `attrib:payment:${customerRef(customerId)}:${paymentRef(paymentId)}`;
  const trustedPaymentKey = (customerId, paymentId) =>
    `attrib:trusted-payment:${customerRef(customerId)}:${paymentRef(paymentId)}`;
  const paymentIndex = (customerId) => `attrib:payments:${customerRef(customerId)}`;
  const paymentBindingKey = (paymentId) => `attrib:payment-binding:${paymentRef(paymentId)}`;
  const successKey = (jobId) => `conv:success:${jobRef(jobId)}`;
  const activeClaimKey = (jobId) => `conv:claim:${jobRef(jobId)}`;
  const bookingSessionKey = (bookingSession) =>
    `attrib:booking-session:${opaqueRef(requireValue(bookingSession, 'ZenBooker booking session'))}`;
  const bookingCustomerKey = (zenCustomerId) =>
    `attrib:booking-customer:${opaqueRef(requireValue(zenCustomerId, 'ZenBooker customer ID'))}`;

  async function addIndexedRecord({ indexKey, recordKey, member, value }) {
    await kv.set(recordKey, value, { ex: ttlSeconds });
    await kv.sadd(indexKey, member);
    await kv.expire(indexKey, ttlSeconds);
  }

  return {
    async saveBookingAttribution({ zenCustomerId, bookingSession, acquisition }) {
      requireValue(zenCustomerId, 'ZenBooker customer ID');
      requireValue(bookingSession, 'ZenBooker booking session');
      const value = {
        acquisition: sanitizeAcquisition(acquisition),
        capturedAt: new Date().toISOString(),
      };
      await Promise.all([
        kv.set(bookingSessionKey(bookingSession), value, { ex: ttlSeconds }),
        kv.set(bookingCustomerKey(zenCustomerId), value, { ex: ttlSeconds }),
      ]);
    },

    async getBookingAttribution({ zenCustomerId, bookingSession } = {}) {
      if (bookingSession) {
        const bySession = await kv.get(bookingSessionKey(bookingSession));
        if (bySession) return bySession;
      }
      if (zenCustomerId) return kv.get(bookingCustomerKey(zenCustomerId));
      return null;
    },

    async saveJobMapping({ jobId, squareCustomerId, squareBookingId = null }) {
      requireValue(jobId, 'ZenBooker job ID');
      requireValue(squareCustomerId, 'Square customer ID');
      await kv.set(
        mappingKey(jobId),
        { squareCustomerId, squareBookingId: squareBookingId || null },
        { ex: ttlSeconds }
      );
    },

    async getJobMapping(jobId) {
      return kv.get(mappingKey(jobId));
    },

    async savePendingJob(job) {
      requireValue(job.jobId, 'ZenBooker job ID');
      requireValue(job.squareCustomerId, 'Square customer ID');
      const ref = jobRef(job.jobId);
      await addIndexedRecord({
        indexKey: pendingJobIndex(job.squareCustomerId),
        recordKey: pendingJobKey(job.squareCustomerId, job.jobId),
        member: ref,
        value: {
          jobRef: ref,
          completedAt: job.completedAt || null,
          consentStatus: sanitizeConsentStatus(job.consentStatus),
          consentCapturedAt: sanitizeTimestamp(job.consentCapturedAt),
          disclosureVersion: job.disclosureVersion || null,
          acquisition: sanitizeAcquisition(job.acquisition),
        },
      });
    },

    async listPendingJobs(squareCustomerId) {
      const refs = await kv.smembers(pendingJobIndex(squareCustomerId));
      const prefix = `attrib:pending-job:${customerRef(squareCustomerId)}:`;
      const values = await Promise.all(refs.map((ref) => kv.get(`${prefix}${ref}`)));
      return values.filter(Boolean);
    },

    async savePayment(payment) {
      requireValue(payment.squareCustomerId, 'Square customer ID');
      requireValue(payment.paymentId, 'Square payment ID');
      const ref = paymentRef(payment.paymentId);
      const webhookSignatureKeyConfigured = Boolean(payment.webhookSignatureKeyConfigured);
      const webhookSignatureVerified = Boolean(payment.webhookSignatureVerified);
      const trustedWebhook = Boolean(
        webhookSignatureKeyConfigured && webhookSignatureVerified
      );
      const recordKey = trustedWebhook
        ? trustedPaymentKey(payment.squareCustomerId, payment.paymentId)
        : paymentKey(payment.squareCustomerId, payment.paymentId);
      const value = {
        paymentRef: ref,
        status: payment.status || null,
        currency: payment.currency || null,
        amount: Number(payment.amount) || 0,
        refundedAmount: Number(payment.refundedAmount) || 0,
        completedAt: payment.completedAt || null,
        trustedWebhook,
        webhookSignatureKeyConfigured,
        webhookSignatureVerified,
      };
      await addIndexedRecord({
        indexKey: paymentIndex(payment.squareCustomerId),
        recordKey,
        member: ref,
        value,
      });
      return value;
    },

    async getPayment(squareCustomerId, paymentId) {
      return (
        await kv.get(trustedPaymentKey(squareCustomerId, paymentId))
        || await kv.get(paymentKey(squareCustomerId, paymentId))
      );
    },

    async listPayments(squareCustomerId) {
      const refs = await kv.smembers(paymentIndex(squareCustomerId));
      const trustedPrefix = `attrib:trusted-payment:${customerRef(squareCustomerId)}:`;
      const prefix = `attrib:payment:${customerRef(squareCustomerId)}:`;
      const values = await Promise.all(refs.map(async (ref) => (
        await kv.get(`${trustedPrefix}${ref}`)
        || await kv.get(`${prefix}${ref}`)
      )));
      return values.filter(Boolean);
    },

    async bindPaymentToJob(paymentId, jobId) {
      const targetJobRef = jobRef(jobId);
      const key = paymentBindingKey(paymentId);
      const result = await kv.set(key, targetJobRef, { nx: true });
      if (result === 'OK' || result === true) return true;
      return (await kv.get(key)) === targetJobRef;
    },

    async getPaymentBinding(paymentId) {
      return kv.get(paymentBindingKey(paymentId));
    },

    async claimOneShot(jobId) {
      const owner = jobRef(jobId);
      const result = await kv.set('attrib:one-shot', owner, { nx: true, ex: ONE_SHOT_TTL_SECONDS });
      return result === 'OK' || result === true;
    },

    async releaseOneShot(jobId) {
      const owner = jobRef(jobId);
      if ((await kv.get('attrib:one-shot')) !== owner) return false;
      await kv.del('attrib:one-shot');
      return true;
    },

    async claimActiveUpload(jobId, owner) {
      requireValue(owner, 'Active upload claim owner');
      const result = await kv.set(activeClaimKey(jobId), owner, {
        nx: true,
        ex: ACTIVE_CLAIM_TTL_SECONDS,
      });
      return result === 'OK' || result === true;
    },

    async releaseActiveUpload(jobId, owner) {
      requireValue(owner, 'Active upload claim owner');
      if ((await kv.get(activeClaimKey(jobId))) !== owner) return false;
      await kv.del(activeClaimKey(jobId));
      return true;
    },

    async markSuccess(jobId, metadata = {}) {
      await kv.set(
        successKey(jobId),
        {
          status: 'uploaded',
          googleRequestId: metadata.googleRequestId || null,
          recordedAt: new Date().toISOString(),
        }
      );
    },

    async hasSuccess(jobId) {
      return Boolean(await kv.get(successKey(jobId)));
    },
  };
}
