import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CONSENT_FIELD_LABEL,
  evaluateJob,
  extractJobCandidate,
  normalizeAcquisition,
  opaqueRef,
} from '../lib/offline-conversion-eligibility.js';

function eligibleJob(overrides = {}) {
  return {
    customerCreated: true,
    status: 'complete',
    email: 'customer@example.com',
    phone: null,
    consentStatus: 'GRANTED',
    consentCapturedAt: '2026-07-10T12:00:00.000Z',
    completedAt: '2026-07-10T15:30:00.000Z',
    disclosureVersion: '2026-07-10',
    ...overrides,
  };
}

test('a customer-created completed job with matching data and disclosure is eligible', () => {
  assert.deepEqual(evaluateJob(eligibleJob()), { eligible: true, reason: null });
});

test('staff and test jobs are ineligible', () => {
  assert.equal(evaluateJob(eligibleJob({ customerCreated: false })).reason, 'STAFF_OR_TEST_JOB');
  assert.equal(evaluateJob(eligibleJob({ isTest: true })).reason, 'STAFF_OR_TEST_JOB');
});

test('incomplete jobs are ineligible', () => {
  assert.equal(evaluateJob(eligibleJob({ status: 'scheduled' })).reason, 'JOB_NOT_COMPLETED');
});

test('denied consent is ineligible', () => {
  assert.equal(evaluateJob(eligibleJob({ consentStatus: 'DENIED' })).reason, 'CONSENT_DENIED');
});

test('an email or phone is required for enhanced conversion matching', () => {
  assert.equal(
    evaluateJob(eligibleJob({ email: null, phone: null })).reason,
    'MISSING_CUSTOMER_IDENTIFIER'
  );
});

test('the configured customer-facing disclosure is required', () => {
  assert.equal(evaluateJob(eligibleJob({ disclosureVersion: null })).reason, 'PRIVACY_DISCLOSURE_MISSING');
});

test('a valid completion timestamp is required', () => {
  assert.equal(evaluateJob(eligibleJob({ completedAt: null })).reason, 'MISSING_COMPLETION_TIME');
  assert.equal(evaluateJob(eligibleJob({ completedAt: 'not-a-date' })).reason, 'MISSING_COMPLETION_TIME');
});

test('paid acquisition requires an explicit click id or paid medium', () => {
  assert.equal(normalizeAcquisition({ source: 'Google' }).paidEvidence, false);
  assert.equal(normalizeAcquisition({ utm_medium: 'cpc' }).paidEvidence, true);
  assert.equal(normalizeAcquisition({ utmMedium: 'paid_search' }).paidEvidence, true);
  assert.equal(normalizeAcquisition({ gclid: 'opaque-click-id' }).paidEvidence, true);
});

test('acquisition normalization records presence and classifications, not raw values', () => {
  const result = normalizeAcquisition({
    source: 'Google',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'brand',
    landing_page: 'https://example.com/secret-path',
    gclid: 'opaque-click-id',
  });

  assert.deepEqual(result, {
    paidEvidence: true,
    paidMarker: 'gclid',
    sourceClass: 'google',
    mediumClass: 'cpc',
    hasCampaign: true,
    hasLandingContext: true,
    hasGclid: true,
    hasGbraid: false,
    hasWbraid: false,
  });
  assert.equal(JSON.stringify(result).includes('opaque-click-id'), false);
  assert.equal(JSON.stringify(result).includes('secret-path'), false);
});

test('candidate extraction accepts timestamped direct ZenBooker consent without invoice value fallback', () => {
  const candidate = extractJobCandidate(
    {
      event: 'job.completed',
      data: {
        id: 'job-sensitive-id',
        status: 'complete',
        created_by: 'customer',
        completed_at: '2026-07-10T15:30:00.000Z',
        customer: {
          id: 'zen-customer-sensitive',
          email: 'customer@example.com',
          phone: '+16125550123',
        },
        booking_session: 'booking-session-sensitive',
        consent_status: 'GRANTED',
        consent_captured_at: '2026-07-10T12:00:00.000Z',
        invoice: { total: 99999 },
        tracking: { utm_medium: 'cpc' },
      },
    },
    { disclosureVersion: '2026-07-10' }
  );

  assert.equal(candidate.jobId, 'job-sensitive-id');
  assert.equal(candidate.zenCustomerId, 'zen-customer-sensitive');
  assert.equal(candidate.bookingSession, 'booking-session-sensitive');
  assert.equal(candidate.customerCreated, true);
  assert.equal(candidate.status, 'complete');
  assert.equal(candidate.email, 'customer@example.com');
  assert.equal(candidate.phone, '+16125550123');
  assert.equal(candidate.consentStatus, 'GRANTED');
  assert.equal(candidate.consentCapturedAt, '2026-07-10T12:00:00.000Z');
  assert.equal(candidate.disclosureVersion, '2026-07-10');
  assert.equal(candidate.acquisition.paidEvidence, true);
  assert.equal('conversionValue' in candidate, false);
});

test('candidate extraction grants only the configured explicit custom-field answer', () => {
  const label = 'Measurement consent';
  for (const affirmative of ['yes', 'TRUE', 'checked', 'Agreed', 'I agree']) {
    const candidate = extractJobCandidate(
      {
        data: {
          id: 'job-sensitive-id',
          custom_fields: [
            {
              label,
              answer: affirmative,
              answered_at: '2026-07-10T12:00:00.000Z',
            },
          ],
        },
      },
      { disclosureVersion: '2026-07-10', consentFieldLabel: label },
    );

    assert.equal(candidate.consentStatus, 'GRANTED');
    assert.equal(candidate.consentCapturedAt, '2026-07-10T12:00:00.000Z');
  }
});

test('candidate extraction uses the exact default label and does not grant machine-only custom values', () => {
  const extract = (answer) => extractJobCandidate(
    {
      data: {
        custom_fields: [{
          label: DEFAULT_CONSENT_FIELD_LABEL,
          answer,
          answered_at: '2026-07-10T12:00:00.000Z',
        }],
      },
    },
    { disclosureVersion: '2026-07-10' },
  );

  assert.equal(extract('yes').consentStatus, 'GRANTED');
  assert.equal(extract('GRANTED').consentStatus, 'UNKNOWN');
});

test('candidate extraction supports object and nested custom-field shapes without retaining answers', () => {
  const label = 'Measurement consent';
  const fromObject = extractJobCandidate(
    {
      data: {
        id: 'job-sensitive-id',
        custom_fields: {
          [label]: {
            value: 'yes',
            captured_at: '2026-07-10T12:00:00.000Z',
          },
        },
      },
    },
    { disclosureVersion: '2026-07-10', consentFieldLabel: label },
  );
  const nested = extractJobCandidate(
    {
      data: {
        job: {
          id: 'job-sensitive-id',
          customFieldAnswers: [
            {
              custom_field: { name: label },
              value: 'I agree',
              created_at: '2026-07-10T12:00:00.000Z',
            },
          ],
        },
      },
    },
    { disclosureVersion: '2026-07-10', consentFieldLabel: label },
  );

  assert.equal(fromObject.consentStatus, 'GRANTED');
  assert.equal(nested.consentStatus, 'GRANTED');
  assert.equal(JSON.stringify(fromObject).includes('yes'), false);
  assert.equal(JSON.stringify(nested).includes('I agree'), false);
});

test('candidate extraction supports timestamped ZenBooker service-field selections', () => {
  const label = 'Measurement consent';
  const candidate = extractJobCandidate(
    {
      data: {
        id: 'job-sensitive-id',
        services: [{
          service_selections: [{
            field_name: label,
            selected_options: [{
              display_label: 'Yes',
              answered_at: '2026-07-10T12:00:00.000Z',
            }],
          }],
        }],
      },
    },
    { disclosureVersion: '2026-07-10', consentFieldLabel: label },
  );

  assert.equal(candidate.consentStatus, 'GRANTED');
  assert.equal(candidate.consentCapturedAt, '2026-07-10T12:00:00.000Z');
  assert.equal(JSON.stringify(candidate).includes('Yes'), false);
});

test('candidate extraction supports official ZenBooker job_fields using job creation time', () => {
  const candidate = extractJobCandidate(
    {
      data: {
        id: 'job-sensitive-id',
        created_at: '2026-07-11T12:00:00.000Z',
        job_fields: [{
          field_type: 'service_modifier',
          field_name: DEFAULT_CONSENT_FIELD_LABEL,
          input_method: 'radio_buttons',
          selected_options: [{ text: 'I agree' }],
        }],
      },
    },
    { disclosureVersion: '2026-07-10' },
  );

  assert.equal(candidate.consentStatus, 'GRANTED');
  assert.equal(candidate.consentCapturedAt, '2026-07-11T12:00:00.000Z');
  assert.equal(JSON.stringify(candidate).includes('I agree'), false);
});

test('candidate extraction rejects consent captured before a dated disclosure version', () => {
  const candidate = extractJobCandidate(
    {
      data: {
        id: 'job-sensitive-id',
        created_at: '2026-07-09T12:00:00.000Z',
        job_fields: [{
          field_name: DEFAULT_CONSENT_FIELD_LABEL,
          selected_options: [{ text: 'I agree' }],
        }],
      },
    },
    { disclosureVersion: '2026-07-10' },
  );

  assert.equal(candidate.consentStatus, 'UNKNOWN');
  assert.equal(candidate.consentCapturedAt, null);
});

test('custom-field and direct-machine consent require their own explicit capture evidence', () => {
  const label = 'Measurement consent';
  const options = { disclosureVersion: '2026-07-10', consentFieldLabel: label };

  const customWithoutCapture = extractJobCandidate({
    data: {
      created_at: '2026-07-10T12:00:00.000Z',
      custom_fields: [{ label, answer: 'yes' }],
    },
  }, options);
  const directHumanAnswer = extractJobCandidate({
    data: {
      consent_status: 'yes',
      consent_captured_at: '2026-07-10T12:00:00.000Z',
    },
  }, options);
  const legacyGoogleConsent = extractJobCandidate({
    data: {
      consent: {
        ad_user_data: 'GRANTED',
        timestamp: '2026-07-10T12:00:00.000Z',
      },
    },
  }, options);

  assert.deepEqual(
    [customWithoutCapture, directHumanAnswer, legacyGoogleConsent].map((candidate) => ({
      status: candidate.consentStatus,
      capturedAt: candidate.consentCapturedAt,
    })),
    [
      { status: 'UNKNOWN', capturedAt: null },
      { status: 'UNKNOWN', capturedAt: null },
      { status: 'UNKNOWN', capturedAt: null },
    ],
  );
});

test('missing, denied, ambiguous, and untimestamped direct consent never grant', () => {
  const label = 'Measurement consent';
  const extract = (data) => extractJobCandidate(
    { data: { id: 'job-sensitive-id', ...data } },
    { disclosureVersion: '2026-07-10', consentFieldLabel: label },
  );

  assert.deepEqual(
    {
      status: extract({}).consentStatus,
      capturedAt: extract({}).consentCapturedAt,
    },
    { status: 'UNKNOWN', capturedAt: null },
  );
  assert.equal(extract({
    custom_fields: [{
      label,
      answer: 'no',
      answered_at: '2026-07-10T12:00:00.000Z',
    }],
  }).consentStatus, 'DENIED');
  assert.equal(extract({
    custom_fields: [{
      label,
      answer: 'sounds good',
      answered_at: '2026-07-10T12:00:00.000Z',
    }],
  }).consentStatus, 'UNKNOWN');
  assert.equal(extract({
    custom_fields: [
      { label, answer: 'yes', answered_at: '2026-07-10T12:00:00.000Z' },
      { label, answer: 'yes', answered_at: '2026-07-10T12:00:00.000Z' },
    ],
  }).consentStatus, 'UNKNOWN');
  assert.deepEqual(
    {
      status: extract({ consent_status: 'GRANTED' }).consentStatus,
      capturedAt: extract({ consent_status: 'GRANTED' }).consentCapturedAt,
    },
    { status: 'UNKNOWN', capturedAt: null },
  );
});

test('candidate extraction preserves sibling customer, tracking, and created_at fields for nested jobs', () => {
  const candidate = extractJobCandidate(
    {
      event: 'job.completed',
      created_at: '2026-07-10T15:30:00.000Z',
      data: {
        job: {
          id: 'job-sensitive-id',
          status: 'completed',
          created_by: 'customer',
        },
        customer: {
          id: 'zen-customer-sensitive',
          email: 'customer@example.com',
        },
        tracking: { utm_medium: 'cpc' },
      },
    },
    { disclosureVersion: '2026-07-10' },
  );

  assert.equal(candidate.jobId, 'job-sensitive-id');
  assert.equal(candidate.zenCustomerId, 'zen-customer-sensitive');
  assert.equal(candidate.email, 'customer@example.com');
  assert.equal(candidate.completedAt, '2026-07-10T15:30:00.000Z');
  assert.equal(candidate.acquisition.paidEvidence, true);
  assert.deepEqual(evaluateJob(candidate), { eligible: true, reason: null });
});

test('opaque references are deterministic and never contain the source identifier', () => {
  const first = opaqueRef('job-sensitive-id');
  const second = opaqueRef('job-sensitive-id');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.equal(first.includes('job-sensitive-id'), false);
});
