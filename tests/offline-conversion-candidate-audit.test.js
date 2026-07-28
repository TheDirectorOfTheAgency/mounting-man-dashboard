import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttributionStore } from '../lib/offline-conversion-store.js';
import {
  auditCandidateAttributionStore,
  fetchZenBookerJobs,
} from '../scripts/audit-offline-conversion-candidates.mjs';

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async del(key) {
      return values.delete(key) ? 1 : 0;
    },
    async sadd(key, ...members) {
      const set = sets.get(key) || new Set();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) || new Set())];
    },
    async expire() {
      return 1;
    },
  };
}

function livePayment(overrides = {}) {
  return {
    id: 'square-payment-sensitive',
    status: 'COMPLETED',
    amount_money: { amount: 55000, currency: 'USD' },
    refunded_money: { amount: 0, currency: 'USD' },
    ...overrides,
  };
}

test('ZenBooker job reads are constrained to the audit window', async () => {
  const urls = [];
  const beginTime = new Date('2026-06-24T00:00:00.000Z');
  const endTime = new Date('2026-07-24T00:00:00.000Z');

  await fetchZenBookerJobs({
    apiKey: 'test-key',
    beginTime,
    endTime,
    fetcher: async (url) => {
      urls.push(new URL(url));
      return { results: [], has_more: false };
    },
  });

  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get('start_date_min'), beginTime.toISOString());
  assert.equal(urls[0].searchParams.get('start_date_max'), endTime.toISOString());
  assert.equal(urls[0].searchParams.get('sort_by'), 'start_time');
  assert.equal(urls[0].searchParams.get('sort_order'), 'ascending');
});

test('candidate audit marks a locally evidenced paid completion ready for validate mode only', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.saveJobMapping({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    squareBookingId: 'square-booking-sensitive',
  });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    completedAt: '2026-07-10T16:00:00.000Z',
    webhookSignatureKeyConfigured: true,
    webhookSignatureVerified: true,
  });

  const audit = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });

  assert.equal(audit.status, 'ready_for_validate');
  assert.equal(audit.mappingPresent, true);
  assert.equal(audit.pendingJobPresent, true);
  assert.equal(audit.storedPaymentPresent, true);
  assert.equal(audit.storedPaymentMatchesLive, true);
  assert.equal(audit.paidEvidencePresent, true);
  assert.equal(audit.successAlreadyRecorded, false);
  assert.deepEqual(audit.evidence, [
    'job_mapping',
    'pending_job',
    'stored_payment',
    'verified_square_webhook',
    'paid_gclid',
  ]);
  assert.equal(JSON.stringify(audit).includes('sensitive'), false);
});

test('candidate audit blocks when local paid acquisition evidence is missing', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.saveJobMapping({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
  });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'UNKNOWN',
    acquisition: { paidEvidence: false },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    completedAt: '2026-07-10T16:00:00.000Z',
  });

  const audit = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });

  assert.equal(audit.status, 'blocked');
  assert.equal(audit.paidEvidencePresent, false);
  assert.equal(audit.blocker, 'No local paid-acquisition evidence found for the job.');
});

test('candidate audit blocks validation when payment lacks verified Square webhook provenance', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  await store.saveJobMapping({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
  });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'UNKNOWN',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    completedAt: '2026-07-10T16:00:00.000Z',
  });

  const audit = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });

  assert.equal(audit.status, 'blocked');
  assert.equal(audit.storedPaymentTrusted, false);
  assert.match(audit.blocker, /verified Square webhook provenance/);
});

test('candidate audit reads JSON-string KV records written through REST backfills', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.saveJobMapping({ jobId: 'zen-job-sensitive', squareCustomerId: 'square-customer-sensitive' });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    completedAt: '2026-07-10T16:00:00.000Z',
    webhookSignatureKeyConfigured: true,
    webhookSignatureVerified: true,
  });

  const stringReturningKv = {
    get: async (key) => {
      const value = await kv.get(key);
      return value && typeof value === 'object' ? JSON.stringify(value) : value;
    },
    smembers: kv.smembers,
  };
  const audit = await auditCandidateAttributionStore({
    kv: stringReturningKv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });

  assert.equal(audit.mappingPresent, true);
  assert.equal(audit.storedPaymentPresent, true);
  assert.equal(audit.status, 'ready_for_validate');
});

test('candidate audit treats success records as a hard dedupe stop', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.saveJobMapping({ jobId: 'zen-job-sensitive', squareCustomerId: 'square-customer-sensitive' });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gbraid', hasGbraid: true },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    completedAt: '2026-07-10T16:00:00.000Z',
  });
  await store.markSuccess('zen-job-sensitive', { googleRequestId: 'request-sensitive' });

  const audit = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });

  assert.equal(audit.status, 'already_uploaded');
  assert.equal(audit.successAlreadyRecorded, true);
  assert.equal(audit.blocker, 'Success record already exists; do not upload again.');
});

test('candidate audit fails closed on a mismatched mapping or incomplete stored payment', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  await store.saveJobMapping({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'different-square-customer',
  });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'wbraid', hasWbraid: true },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'PENDING',
    currency: 'USD',
    amount: 55000,
    completedAt: '2026-07-10T16:00:00.000Z',
  });

  const mismatch = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });
  assert.equal(mismatch.status, 'blocked');
  assert.equal(mismatch.mappingPresent, false);
  assert.match(mismatch.blocker, /mapping does not match/);

  await store.saveJobMapping({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
  });
  const incompletePayment = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment(),
    squareCustomer: { id: 'square-customer-sensitive' },
  });
  assert.equal(incompletePayment.status, 'blocked');
  assert.equal(incompletePayment.storedPaymentCompleted, false);
  assert.match(incompletePayment.blocker, /does not exactly match/);
});

test('candidate audit rejects stale amount, wrong payment ref, and refund mismatch', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  await store.saveJobMapping({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
  });
  await store.savePendingJob({
    jobId: 'zen-job-sensitive',
    squareCustomerId: 'square-customer-sensitive',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
  });
  await store.savePayment({
    squareCustomerId: 'square-customer-sensitive',
    paymentId: 'square-payment-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    refundedAmount: 5000,
    completedAt: '2026-07-10T16:00:00.000Z',
  });

  const staleAmount = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment({
      amount_money: { amount: 40000, currency: 'USD' },
      refunded_money: { amount: 5000, currency: 'USD' },
    }),
    squareCustomer: { id: 'square-customer-sensitive' },
  });
  assert.equal(staleAmount.status, 'blocked');
  assert.equal(staleAmount.storedPaymentMatchesLive, false);

  const wrongPayment = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment({ id: 'different-square-payment' }),
    squareCustomer: { id: 'square-customer-sensitive' },
  });
  assert.equal(wrongPayment.status, 'blocked');
  assert.equal(wrongPayment.storedPaymentPresent, false);

  const refundMismatch = await auditCandidateAttributionStore({
    kv,
    job: { id: 'zen-job-sensitive' },
    payment: livePayment({
      refunded_money: { amount: 10000, currency: 'USD' },
    }),
    squareCustomer: { id: 'square-customer-sensitive' },
  });
  assert.equal(refundMismatch.status, 'blocked');
  assert.equal(refundMismatch.storedPaymentMatchesLive, false);
});
