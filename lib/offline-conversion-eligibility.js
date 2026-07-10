import crypto from 'node:crypto';

const PAID_MEDIA = new Set([
  'cpc',
  'paid',
  'paid_search',
  'paidsearch',
  'ppc',
  'sem',
]);

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizedString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function opaqueRef(value) {
  if (!hasValue(value)) throw new Error('Cannot create an opaque reference without a value');
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

export function normalizeAcquisition(value = {}) {
  const source = normalizedString(firstPresent(value.utm_source, value.utmSource, value.source));
  const medium = normalizedString(firstPresent(value.utm_medium, value.utmMedium, value.medium));
  const gclid = firstPresent(value.gclid, value.google_click_id, value.googleClickId);
  const gbraid = firstPresent(value.gbraid, value.google_braid);
  const wbraid = firstPresent(value.wbraid, value.web_braid);
  const hasGclid = hasValue(gclid);
  const hasGbraid = hasValue(gbraid);
  const hasWbraid = hasValue(wbraid);
  const paidMedium = PAID_MEDIA.has(medium);
  const paidMarker = hasGclid
    ? 'gclid'
    : hasGbraid
      ? 'gbraid'
      : hasWbraid
        ? 'wbraid'
        : paidMedium
          ? 'paid_medium'
          : null;

  return {
    paidEvidence: Boolean(paidMarker),
    paidMarker,
    sourceClass: source || null,
    mediumClass: medium || null,
    hasCampaign: hasValue(firstPresent(value.utm_campaign, value.utmCampaign, value.campaign)),
    hasLandingContext: hasValue(
      firstPresent(
        value.landing_page,
        value.landingPage,
        value.landing_url,
        value.landingUrl,
        value.first_page,
        value.firstPage
      )
    ),
    hasGclid,
    hasGbraid,
    hasWbraid,
  };
}

function inferCustomerCreated(job) {
  const explicit = firstPresent(
    job.customer_created,
    job.customerCreated,
    job.is_customer_created,
    job.isCustomerCreated
  );
  if (typeof explicit === 'boolean') return explicit;

  const creator = normalizedString(
    firstPresent(job.created_by, job.createdBy, job.creator_type, job.creatorType)
  );
  if (creator) return ['customer', 'client', 'online', 'website'].includes(creator);
  return false;
}

function normalizeConsent(job) {
  const raw = normalizedString(
    firstPresent(
      job.consent?.ad_user_data,
      job.consent?.adUserData,
      job.ad_user_data_consent,
      job.adUserDataConsent
    )
  );
  if (raw === 'granted' || raw === 'yes' || raw === 'true') return 'GRANTED';
  if (raw === 'denied' || raw === 'no' || raw === 'false') return 'DENIED';
  return 'UNKNOWN';
}

export function extractJobCandidate(payload, { disclosureVersion } = {}) {
  const job = payload?.data?.job || payload?.data || payload?.job || payload || {};
  const customer = job.customer || job.client || {};
  const tracking = {
    ...(payload?.tracking || {}),
    ...(job.referral || {}),
    ...(job.attribution || {}),
    ...(job.tracking || {}),
  };

  return {
    jobId: firstPresent(job.id, job.job_id, job.jobId),
    zenCustomerId:
      firstPresent(
        customer.id,
        customer.customer_id,
        customer.customerId,
        job.customer_id,
        job.customerId
      ) || null,
    bookingSession:
      firstPresent(
        job.booking_session,
        job.booking_session_id,
        job.bookingSession,
        job.bookingSessionId,
        payload?.booking_session,
        payload?.bookingSession
      ) || null,
    customerCreated: inferCustomerCreated(job),
    isTest: Boolean(firstPresent(job.is_test, job.isTest, job.test)),
    status: normalizedString(firstPresent(job.status, job.job_status, job.jobStatus)),
    email: firstPresent(customer.email, job.customer_email, job.customerEmail) || null,
    phone: firstPresent(customer.phone, customer.phone_number, job.customer_phone, job.customerPhone) || null,
    firstName: firstPresent(customer.first_name, customer.firstName, job.customer_first_name) || null,
    lastName: firstPresent(customer.last_name, customer.lastName, job.customer_last_name) || null,
    consentStatus: normalizeConsent(job),
    completedAt:
      firstPresent(
        job.completed_at,
        job.completedAt,
        job.completion_time,
        job.completionTime,
        job.end_time,
        job.endTime
      ) || null,
    disclosureVersion: hasValue(disclosureVersion) ? String(disclosureVersion) : null,
    acquisition: normalizeAcquisition(tracking),
  };
}

export function evaluateJob(candidate = {}) {
  if (!candidate.customerCreated || candidate.isTest) {
    return { eligible: false, reason: 'STAFF_OR_TEST_JOB' };
  }
  if (!['complete', 'completed'].includes(normalizedString(candidate.status))) {
    return { eligible: false, reason: 'JOB_NOT_COMPLETED' };
  }
  if (normalizedString(candidate.consentStatus) === 'denied') {
    return { eligible: false, reason: 'CONSENT_DENIED' };
  }
  if (!hasValue(candidate.email) && !hasValue(candidate.phone)) {
    return { eligible: false, reason: 'MISSING_CUSTOMER_IDENTIFIER' };
  }
  if (!hasValue(candidate.disclosureVersion)) {
    return { eligible: false, reason: 'PRIVACY_DISCLOSURE_MISSING' };
  }
  if (!hasValue(candidate.completedAt) || Number.isNaN(Date.parse(candidate.completedAt))) {
    return { eligible: false, reason: 'MISSING_COMPLETION_TIME' };
  }
  return { eligible: true, reason: null };
}
