import { extractClickIdentifiers, opaqueRef } from './offline-conversion-eligibility.js';

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

function parseIdentityMember(member) {
  if (typeof member !== 'string') return null;
  if (/^[a-f0-9]{24}$/.test(member)) return { ref: member, at: null };
  const match = /^(\d*):([a-f0-9]{24})$/.exec(member);
  if (!match) return null;
  return { ref: match[2], at: match[1] ? Number(match[1]) : null };
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
  const zenCustomerRef = (zenCustomerId) =>
    opaqueRef(requireValue(zenCustomerId, 'ZenBooker customer ID'));
  const sessionRefFor = (bookingSession) =>
    opaqueRef(requireValue(bookingSession, 'ZenBooker booking session'));
  const captureIndex = (zenCustomerId) => `attrib:captures:${zenCustomerRef(zenCustomerId)}`;
  const captureKey = (zenCustomerId, bookingSession) =>
    `attrib:capture:${zenCustomerRef(zenCustomerId)}:${sessionRefFor(bookingSession)}`;
  const observedJobIndex = (zenCustomerId) => `attrib:observed-jobs:${zenCustomerRef(zenCustomerId)}`;
  const observedJobKey = (zenCustomerId, jobId) =>
    `attrib:observed-job:${zenCustomerRef(zenCustomerId)}:${jobRef(jobId)}`;
  const jobBridgeKey = (jobId) => `attrib:job-bridge:${jobRef(jobId)}`;
  const sessionJobKey = (ref) => `attrib:session-job:${ref}`;
  const identitySessionKey = (bookingSession) =>
    `attrib:identity-session:${sessionRefFor(bookingSession)}`;
  const sessionTouchKey = (ref) => `attrib:session-touch:${ref}`;
  const unpaidSessionKey = (ref) => `attrib:unpaid-session:${ref}`;
  const unpaidIndex = (zenCustomerId) => `attrib:unpaid-captures:${zenCustomerRef(zenCustomerId)}`;
  const unpaidCaptureKey = (zenCustomerId, bookingSession) =>
    `attrib:unpaid-capture:${zenCustomerRef(zenCustomerId)}:${sessionRefFor(bookingSession)}`;
  const sourceJobKey = (jobId) => `attrib:src-job:${jobRef(jobId)}`;
  const sourceMonthKey = (month) => `attrib:src-month:${month}`;
  const sourceMonthsKey = 'attrib:src-months';
  const identityKey = (token) => `attrib:src-who:${token}`;
  const SOURCE_TTL_SECONDS = 400 * 24 * 60 * 60;

  async function addIndexedRecord({ indexKey, recordKey, member, value }) {
    await kv.set(recordKey, value, { ex: ttlSeconds });
    await kv.sadd(indexKey, member);
    await kv.expire(indexKey, ttlSeconds);
  }

  return {
    async saveBookingAttribution({
      zenCustomerId,
      bookingSession,
      acquisition,
      gclid = null,
      gbraid = null,
      wbraid = null,
      capturedAt = null,
    }) {
      requireValue(zenCustomerId, 'ZenBooker customer ID');
      requireValue(bookingSession, 'ZenBooker booking session');
      const click = extractClickIdentifiers({ gclid, gbraid, wbraid });
      const ref = sessionRefFor(bookingSession);
      const value = {
        customerRef: zenCustomerRef(zenCustomerId),
        sessionRef: ref,
        acquisition: sanitizeAcquisition(acquisition),
        gclid: click.gclid,
        gbraid: click.gbraid,
        wbraid: click.wbraid,
        capturedAt: sanitizeTimestamp(capturedAt) || new Date().toISOString(),
      };
      await Promise.all([
        kv.set(bookingSessionKey(bookingSession), value, { ex: ttlSeconds }),
        kv.set(bookingCustomerKey(zenCustomerId), value, { ex: ttlSeconds }),
        addIndexedRecord({
          indexKey: captureIndex(zenCustomerId),
          recordKey: captureKey(zenCustomerId, bookingSession),
          member: ref,
          value,
        }),
      ]);
      return value;
    },

    async getBookingAttribution({ bookingSession } = {}) {
      // A customer's latest capture may belong to a different booking. Only an
      // exact session establishes attribution; legacy customer keys are not proof.
      if (typeof bookingSession !== 'string' || !bookingSession.trim()) return null;
      return kv.get(bookingSessionKey(bookingSession));
    },

    async listCaptures(zenCustomerId) {
      const refs = await kv.smembers(captureIndex(zenCustomerId));
      const prefix = `attrib:capture:${zenCustomerRef(zenCustomerId)}:`;
      const values = await Promise.all((refs || []).map((ref) => kv.get(`${prefix}${ref}`)));
      // Verify the persisted customer binding before exposing the caller's ID in memory.
      // Keep raw customer IDs out of KV, including for legacy or misplaced captures.
      return values.filter(Boolean).map((value) => ({
        ...value,
        customerId: value.customerRef === zenCustomerRef(zenCustomerId) ? zenCustomerId : null,
      }));
    },

    async recordObservedJob({ zenCustomerId, jobId, createdAt = null }) {
      requireValue(zenCustomerId, 'ZenBooker customer ID');
      requireValue(jobId, 'ZenBooker job ID');
      const ref = jobRef(jobId);
      const value = {
        jobId: String(jobId),
        createdAt: sanitizeTimestamp(createdAt),
      };
      await addIndexedRecord({
        indexKey: observedJobIndex(zenCustomerId),
        recordKey: observedJobKey(zenCustomerId, jobId),
        member: ref,
        value,
      });
      return value;
    },

    async listObservedJobs(zenCustomerId) {
      const refs = await kv.smembers(observedJobIndex(zenCustomerId));
      const prefix = `attrib:observed-job:${zenCustomerRef(zenCustomerId)}:`;
      const values = await Promise.all((refs || []).map((ref) => kv.get(`${prefix}${ref}`)));
      return values.filter(Boolean);
    },

    async saveJobBridge({
      jobId,
      sessionRef = null,
      source,
      acquisition,
      gclid = null,
      gbraid = null,
      wbraid = null,
    }) {
      requireValue(jobId, 'ZenBooker job ID');
      requireValue(source, 'Bridge source');
      const click = extractClickIdentifiers({ gclid, gbraid, wbraid });
      const key = jobBridgeKey(jobId);
      const existing = await kv.get(key);
      if (existing?.sessionRef && existing.sessionRef !== sessionRef) {
        const reverseKey = sessionJobKey(existing.sessionRef);
        const reverse = await kv.get(reverseKey);
        if (reverse?.jobId === String(jobId)) await kv.del(reverseKey);
      }
      const value = {
        source: String(source),
        sessionRef: sessionRef || null,
        acquisition: sanitizeAcquisition(acquisition),
        gclid: click.gclid,
        gbraid: click.gbraid,
        wbraid: click.wbraid,
      };
      await kv.set(key, value, { ex: ttlSeconds });
      if (sessionRef) {
        await kv.set(sessionJobKey(sessionRef), { jobId: String(jobId) }, { ex: ttlSeconds });
      }
      return value;
    },

    async getJobBridge(jobId) {
      if (!jobId) return null;
      return kv.get(jobBridgeKey(jobId));
    },

    async clearWindowBridge(jobId) {
      if (!jobId) return false;
      const key = jobBridgeKey(jobId);
      const existing = await kv.get(key);
      if (!existing || existing.source !== 'window') return false;
      await kv.del(key);
      if (existing.sessionRef) {
        const reverseKey = sessionJobKey(existing.sessionRef);
        const reverse = await kv.get(reverseKey);
        if (reverse?.jobId === String(jobId)) await kv.del(reverseKey);
      }
      return true;
    },

    async getJobIdForSession(bookingSession) {
      if (typeof bookingSession !== 'string' || !bookingSession.trim()) return null;
      const record = await kv.get(sessionJobKey(opaqueRef(bookingSession)));
      return record?.jobId || null;
    },

    async allowRecentIdentityResolve(bookingSession, { limit = 3, ttlSeconds = 60 * 60 } = {}) {
      requireValue(bookingSession, 'ZenBooker booking session');
      const key = identitySessionKey(bookingSession);
      const current = Number(await kv.get(key)) || 0;
      if (current >= limit) return false;
      await kv.set(key, String(current + 1), { ex: ttlSeconds });
      return true;
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
          ...extractClickIdentifiers(job),
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

    async saveSessionTouch({
      bookingSession,
      zenCustomerId = null,
      first = null,
      last = null,
      capturedAt = null,
    }) {
      requireValue(bookingSession, 'ZenBooker booking session');
      const ref = sessionRefFor(bookingSession);
      const existingTouch = await kv.get(sessionTouchKey(ref));
      const touch = {
        first: existingTouch?.first || first || null,
        last: last || existingTouch?.last || first || null,
        capturedAt: sanitizeTimestamp(capturedAt) || new Date().toISOString(),
      };
      await kv.set(sessionTouchKey(ref), touch, { ex: ttlSeconds });

      const paid = await kv.get(bookingSessionKey(bookingSession));
      if (paid?.acquisition?.paidEvidence) {
        return { sessionRef: ref, paid: true, touch };
      }

      const previous = await kv.get(unpaidSessionKey(ref));
      const unpaid = {
        sessionRef: ref,
        capturedAt: touch.capturedAt,
        customerRef: zenCustomerId ? zenCustomerRef(zenCustomerId) : (previous?.customerRef || null),
      };
      await kv.set(unpaidSessionKey(ref), unpaid, { ex: ttlSeconds });
      if (zenCustomerId) {
        await addIndexedRecord({
          indexKey: unpaidIndex(zenCustomerId),
          recordKey: unpaidCaptureKey(zenCustomerId, bookingSession),
          member: ref,
          value: { ...unpaid, customerRef: zenCustomerRef(zenCustomerId) },
        });
      }
      return { sessionRef: ref, paid: false, touch };
    },

    async getUnpaidSession({ bookingSession } = {}) {
      if (typeof bookingSession !== 'string' || !bookingSession.trim()) return null;
      return kv.get(unpaidSessionKey(sessionRefFor(bookingSession)));
    },

    async getSessionTouch({ bookingSession, sessionRef } = {}) {
      let ref = sessionRef || null;
      if (!ref && typeof bookingSession === 'string' && bookingSession.trim()) {
        ref = sessionRefFor(bookingSession);
      }
      if (typeof ref !== 'string' || !/^[a-f0-9]{24}$/.test(ref)) return null;
      return kv.get(sessionTouchKey(ref));
    },

    async listUnpaidCaptures(zenCustomerId) {
      const refs = await kv.smembers(unpaidIndex(zenCustomerId));
      const prefix = `attrib:unpaid-capture:${zenCustomerRef(zenCustomerId)}:`;
      const values = await Promise.all((refs || []).map((ref) => kv.get(`${prefix}${ref}`)));
      return values.filter(Boolean).map((value) => ({
        ...value,
        customerId: value.customerRef === zenCustomerRef(zenCustomerId) ? zenCustomerId : null,
      }));
    },

    async saveJobSource({
      jobId,
      month,
      firstBucket,
      lastBucket,
      firstDetail = null,
      lastDetail = null,
      repeat = false,
      revenue = null,
      matched = false,
    }) {
      requireValue(jobId, 'ZenBooker job ID');
      const ref = jobRef(jobId);
      const value = {
        jobId: String(jobId),
        month: month || null,
        firstBucket: firstBucket || 'unknown',
        lastBucket: lastBucket || 'unknown',
        firstDetail: firstDetail || null,
        lastDetail: lastDetail || null,
        repeat: Boolean(repeat),
        revenue: Number.isFinite(revenue) ? Math.round(revenue * 100) / 100 : null,
        matched: Boolean(matched),
      };
      await kv.set(sourceJobKey(jobId), value, { ex: SOURCE_TTL_SECONDS });
      if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) {
        await kv.sadd(sourceMonthKey(month), ref);
        await kv.expire(sourceMonthKey(month), SOURCE_TTL_SECONDS);
        await kv.sadd(sourceMonthsKey, month);
        await kv.expire(sourceMonthsKey, SOURCE_TTL_SECONDS);
        if (typeof kv.srem === 'function') {
          const known = await kv.smembers(sourceMonthsKey);
          for (const other of known || []) {
            if (other !== month && /^\d{4}-\d{2}$/.test(other)) {
              await kv.srem(sourceMonthKey(other), ref);
            }
          }
        }
      }
      return value;
    },

    async getJobSource(jobId) {
      if (jobId == null || String(jobId).trim() === '') return null;
      return kv.get(sourceJobKey(jobId));
    },

    async listSourceMonths() {
      const months = await kv.smembers(sourceMonthsKey);
      return (months || []).filter((month) => /^\d{4}-\d{2}$/.test(month)).sort();
    },

    async listJobSources(month) {
      if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return [];
      const refs = await kv.smembers(sourceMonthKey(month)) || [];
      const values = await Promise.all(refs.map((ref) => kv.get(`attrib:src-job:${ref}`)));
      return refs.map((ref, index) => {
        const value = values[index];
        if (!value) return null;
        return { ...value, jobRef: ref };
      }).filter(Boolean);
    },

    async flagRepeatIdentity({ jobId, tokens = [], createdAt = null } = {}) {
      const ref = jobRef(jobId);
      let repeat = false;
      const requestedAt = Date.parse(createdAt || '');
      for (const token of tokens) {
        if (typeof token !== 'string' || !/^[cep]:[a-f0-9]{24,64}$/.test(token)) continue;
        const key = identityKey(token);
        const members = await kv.smembers(key) || [];
        const parsed = members.map(parseIdentityMember).filter(Boolean);
        const own = parsed.find((item) => item.ref === ref && item.at != null);
        const at = Number.isNaN(requestedAt) ? (own?.at ?? null) : requestedAt;
        if (at != null && parsed.some((item) => item.ref !== ref && item.at != null && item.at < at)) {
          repeat = true;
        }
        if (typeof kv.srem === 'function') {
          for (const member of members) {
            const item = parseIdentityMember(member);
            if (item?.ref === ref) await kv.srem(key, member);
          }
        }
        const stamp = at == null ? '' : String(at);
        await kv.sadd(key, `${stamp}:${ref}`);
        await kv.expire(key, SOURCE_TTL_SECONDS);
      }
      return repeat;
    },
  };
}
