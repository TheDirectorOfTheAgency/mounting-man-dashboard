import crypto from 'node:crypto';

const PAID_MEDIA = new Set([
  'cpc',
  'paid',
  'paid_search',
  'paidsearch',
  'ppc',
  'sem',
]);
const PAID_CLICK_MARKERS = new Set(['gclid', 'gbraid', 'wbraid']);
const AFFIRMATIVE_CONSENT_VALUES = new Set(['yes', 'true', 'checked', 'agreed', 'i agree']);
const DENIED_CONSENT_VALUES = new Set(['no', 'false', 'unchecked', 'denied', 'i do not agree']);

export const DEFAULT_CONSENT_FIELD_LABEL =
  'I consent to The Mounting Man securely sharing hashed contact information and service outcome data with advertising platforms for measurement';

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizedString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizedValue(value) {
  return value === undefined || value === null
    ? ''
    : String(value).trim().toLowerCase();
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

export function hasPaidClickEvidence(acquisition = {}) {
  const marker = normalizedString(acquisition.paidMarker);
  if (!acquisition.paidEvidence || !PAID_CLICK_MARKERS.has(marker)) return false;
  if (marker === 'gclid') return Boolean(acquisition.hasGclid);
  if (marker === 'gbraid') return Boolean(acquisition.hasGbraid);
  return Boolean(acquisition.hasWbraid);
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

function validTimestamp(value) {
  return hasValue(value) && !Number.isNaN(Date.parse(value));
}

function enforceDisclosureEffectiveDate(consent, disclosureVersion) {
  if (consent.consentStatus !== 'GRANTED') return consent;
  const datedVersion = String(disclosureVersion || '').match(/^\d{4}-\d{2}-\d{2}$/);
  if (!datedVersion) return consent;
  const effectiveAt = Date.parse(`${datedVersion[0]}T00:00:00.000Z`);
  const capturedAt = Date.parse(consent.consentCapturedAt);
  if (Number.isNaN(capturedAt) || capturedAt < effectiveAt) {
    return { consentStatus: 'UNKNOWN', consentCapturedAt: null };
  }
  return consent;
}

function normalizeCustomConsentValue(value) {
  const normalized = normalizedValue(value);
  if (AFFIRMATIVE_CONSENT_VALUES.has(normalized)) return 'GRANTED';
  if (DENIED_CONSENT_VALUES.has(normalized)) return 'DENIED';
  return 'UNKNOWN';
}

function directConsent(job) {
  const machineStatus = firstPresent(
    job.consent_status,
    job.consentStatus,
    job.consent?.status,
    job.consent?.consent_status,
    job.consent?.consentStatus
  );
  const legacyStatus = firstPresent(
    job.consent?.ad_user_data,
    job.consent?.adUserData,
    job.ad_user_data_consent,
    job.adUserDataConsent
  );
  const capturedAt = firstPresent(
    job.consent_captured_at,
    job.consentCapturedAt,
    job.consent_timestamp,
    job.consentTimestamp,
    job.consent?.captured_at,
    job.consent?.capturedAt,
    job.consent?.timestamp
  );
  if (!hasValue(machineStatus) && !hasValue(legacyStatus)) {
    return { present: false, consentStatus: 'UNKNOWN', consentCapturedAt: null };
  }

  const normalizedMachineStatus = normalizedValue(machineStatus);
  const normalizedLegacyStatus = normalizedValue(legacyStatus);
  if (
    normalizedMachineStatus === 'denied'
    || DENIED_CONSENT_VALUES.has(normalizedLegacyStatus)
  ) {
    return {
      present: true,
      consentStatus: 'DENIED',
      consentCapturedAt: validTimestamp(capturedAt) ? String(capturedAt) : null,
    };
  }
  if (normalizedMachineStatus === 'granted' && validTimestamp(capturedAt)) {
    return {
      present: true,
      consentStatus: 'GRANTED',
      consentCapturedAt: String(capturedAt),
    };
  }
  return { present: true, consentStatus: 'UNKNOWN', consentCapturedAt: null };
}

function fieldLabel(field = {}) {
  return firstPresent(
    field.field_name,
    field.fieldName,
    field.label,
    field.name,
    field.title,
    field.custom_field_label,
    field.customFieldLabel,
    field.field?.label,
    field.field?.name,
    field.custom_field?.label,
    field.custom_field?.name,
    field.customField?.label,
    field.customField?.name
  );
}

function fieldAnswer(field = {}) {
  const selectedOptions = Array.isArray(field.selected_options)
    ? field.selected_options
    : Array.isArray(field.selectedOptions)
      ? field.selectedOptions
      : [];
  const selectedAnswer = selectedOptions.length === 1
    ? firstPresent(
        selectedOptions[0]?.display_label,
        selectedOptions[0]?.displayLabel,
        selectedOptions[0]?.text,
        selectedOptions[0]?.name,
        selectedOptions[0]?.value
      )
    : undefined;
  return firstPresent(
    field.answer,
    field.value,
    field.response,
    field.checked,
    field.selected,
    selectedAnswer
  );
}

function fieldCapturedAt(field = {}) {
  const selectedOptions = Array.isArray(field.selected_options)
    ? field.selected_options
    : Array.isArray(field.selectedOptions)
      ? field.selectedOptions
      : [];
  const selectedTimestamp = selectedOptions.length === 1
    ? firstPresent(
        selectedOptions[0]?.answered_at,
        selectedOptions[0]?.answeredAt,
        selectedOptions[0]?.captured_at,
        selectedOptions[0]?.capturedAt,
        selectedOptions[0]?.created_at,
        selectedOptions[0]?.createdAt
      )
    : undefined;
  return firstPresent(
    field.answered_at,
    field.answeredAt,
    field.captured_at,
    field.capturedAt,
    field.created_at,
    field.createdAt,
    field.updated_at,
    field.updatedAt,
    selectedTimestamp
  );
}

function customFieldEntries(container) {
  if (Array.isArray(container)) return container.filter((value) => value && typeof value === 'object');
  if (!container || typeof container !== 'object') return [];
  return Object.entries(container).map(([label, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value, label: fieldLabel(value) || label };
    }
    return { label, value };
  });
}

function customFieldConsent(job, consentFieldLabel) {
  const expectedLabel = normalizedValue(consentFieldLabel);
  const services = Array.isArray(job.services) ? job.services : [];
  const containers = [
    { values: job.job_fields, useJobCreatedAt: true },
    { values: job.jobFields, useJobCreatedAt: true },
    { values: job.custom_fields },
    { values: job.customFields },
    { values: job.custom_field_answers },
    { values: job.customFieldAnswers },
    { values: job.service_fields },
    { values: job.serviceFields },
    { values: job.customer?.custom_fields },
    { values: job.customer?.customFields },
    ...services.flatMap((service) => [
      { values: service?.custom_fields },
      { values: service?.customFields },
      { values: service?.service_selections },
      { values: service?.serviceSelections },
      { values: service?.service_fields },
      { values: service?.serviceFields },
    ]),
  ];
  const matches = containers
    .flatMap(({ values, useJobCreatedAt = false }) =>
      customFieldEntries(values).map((field) => ({ ...field, useJobCreatedAt }))
    )
    .filter((field) => normalizedValue(fieldLabel(field)) === expectedLabel);
  if (matches.length === 0) {
    return { present: false, consentStatus: 'UNKNOWN', consentCapturedAt: null };
  }
  if (matches.length !== 1) {
    return { present: true, consentStatus: 'UNKNOWN', consentCapturedAt: null };
  }

  const status = normalizeCustomConsentValue(fieldAnswer(matches[0]));
  const capturedAt = firstPresent(
    fieldCapturedAt(matches[0]),
    job.custom_field_consent_captured_at,
    job.customFieldConsentCapturedAt,
    job.booking_consent_captured_at,
    job.bookingConsentCapturedAt,
    job.consent_captured_at,
    job.consentCapturedAt,
    matches[0].useJobCreatedAt ? job.created_at : null,
    matches[0].useJobCreatedAt ? job.createdAt : null
  );
  if (status === 'DENIED') {
    return {
      present: true,
      consentStatus: 'DENIED',
      consentCapturedAt: validTimestamp(capturedAt) ? String(capturedAt) : null,
    };
  }
  if (status === 'GRANTED' && validTimestamp(capturedAt)) {
    return {
      present: true,
      consentStatus: 'GRANTED',
      consentCapturedAt: String(capturedAt),
    };
  }
  return { present: true, consentStatus: 'UNKNOWN', consentCapturedAt: null };
}

function normalizeConsent(job, consentFieldLabel) {
  const direct = directConsent(job);
  const custom = customFieldConsent(job, consentFieldLabel);
  if (direct.present && custom.present) {
    if (
      direct.consentStatus === custom.consentStatus
      && direct.consentStatus !== 'UNKNOWN'
      && direct.consentCapturedAt === custom.consentCapturedAt
    ) {
      return {
        consentStatus: direct.consentStatus,
        consentCapturedAt: direct.consentCapturedAt,
      };
    }
    return { consentStatus: 'UNKNOWN', consentCapturedAt: null };
  }
  if (custom.present) return custom;
  if (direct.present) return direct;
  return { consentStatus: 'UNKNOWN', consentCapturedAt: null };
}

export function extractJobCandidate(
  payload,
  {
    disclosureVersion,
    consentFieldLabel = DEFAULT_CONSENT_FIELD_LABEL,
  } = {}
) {
  const data = payload?.data || {};
  const nestedJob = data?.job || payload?.job || null;
  const job = nestedJob
    ? {
        ...data,
        ...nestedJob,
        customer: nestedJob.customer || data.customer,
        tracking: {
          ...(data.tracking || {}),
          ...(nestedJob.tracking || {}),
        },
      }
    : data && Object.keys(data).length > 0
      ? data
      : payload || {};
  const customer = job.customer || data.customer || job.client || {};
  const tracking = {
    ...(payload?.tracking || {}),
    ...(data?.tracking || {}),
    ...(job.referral || {}),
    ...(job.attribution || {}),
    ...(job.tracking || {}),
  };
  const consent = enforceDisclosureEffectiveDate(
    normalizeConsent(job, consentFieldLabel),
    disclosureVersion
  );

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
    consentStatus: consent.consentStatus,
    consentCapturedAt: consent.consentCapturedAt,
    completedAt:
      firstPresent(
        job.completed_at,
        job.completedAt,
        job.completion_time,
        job.completionTime,
        job.end_time,
        job.endTime,
        data.created_at,
        payload?.created_at
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
