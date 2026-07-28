import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttributionStore } from '../lib/offline-conversion-store.js';

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  const writes = [];

  return {
    values,
    sets,
    writes,
    async set(key, value, options = {}) {
      writes.push({ operation: 'set', key, value, options });
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
      writes.push({ operation: 'sadd', key, value: members });
      const set = sets.get(key) || new Set();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) || new Set())];
    },
    async expire(key, seconds) {
      writes.push({ operation: 'expire', key, value: seconds });
      return 1;
    },
  };
}

test('stores and reads a job-to-Square mapping behind an opaque key', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const mapping = { jobId: 'job-sensitive', squareCustomerId: 'sq-customer-1', squareBookingId: 'sq-booking-1' };

  await store.saveJobMapping(mapping);

  assert.deepEqual(await store.getJobMapping(mapping.jobId), {
    squareCustomerId: 'sq-customer-1',
    squareBookingId: 'sq-booking-1',
  });
  assert.equal([...kv.values.keys()].some((key) => key.includes(mapping.jobId)), false);
});

test('booking attribution is retrievable by session or customer without storing raw identifiers or click ids', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.saveBookingAttribution({
    zenCustomerId: 'zen-customer-sensitive',
    bookingSession: 'booking-session-sensitive',
    acquisition: {
      paidEvidence: true,
      paidMarker: 'gclid',
      sourceClass: 'google',
      mediumClass: 'cpc',
      hasCampaign: true,
      hasLandingContext: true,
      hasGclid: true,
      gclid: 'raw-click-id-must-not-persist',
    },
  });

  const bySession = await store.getBookingAttribution({
    bookingSession: 'booking-session-sensitive',
  });
  const byCustomer = await store.getBookingAttribution({
    zenCustomerId: 'zen-customer-sensitive',
  });
  assert.deepEqual(bySession.acquisition, byCustomer.acquisition);
  assert.equal(bySession.acquisition.paidMarker, 'gclid');

  const serialized = JSON.stringify(kv.writes);
  for (const forbidden of [
    'zen-customer-sensitive',
    'booking-session-sensitive',
    'raw-click-id-must-not-persist',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `stored forbidden value ${forbidden}`);
  }
});

test('pending jobs retain only coordinator metadata and never raw PII or click ids', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.savePendingJob({
    jobId: 'job-sensitive',
    squareCustomerId: 'sq-customer-1',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    email: 'customer@example.com',
    phone: '+16125550123',
    firstName: 'Private',
    lastName: 'Customer',
    gclid: 'raw-click-id',
  });

  const jobs = await store.listPendingJobs('sq-customer-1');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].completedAt, '2026-07-10T15:30:00.000Z');
  assert.equal(jobs[0].acquisition.paidMarker, 'gclid');

  const serialized = JSON.stringify(kv.writes);
  for (const forbidden of [
    'job-sensitive',
    'customer@example.com',
    '+16125550123',
    'Private',
    'Customer',
    'raw-click-id',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `stored forbidden value ${forbidden}`);
  }
});

test('completed payment storage is customer-scoped and strips unknown fields', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  await store.savePayment({
    squareCustomerId: 'sq-customer-1',
    paymentId: 'payment-1',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    refundedAmount: 5000,
    completedAt: '2026-07-10T16:00:00.000Z',
    cardDetails: { card: { last4: '1234' } },
  });

  const payments = await store.listPayments('sq-customer-1');
  assert.equal(payments.length, 1);
  assert.match(payments[0].paymentRef, /^[a-f0-9]{24}$/);
  assert.deepEqual(
    await store.getPayment('sq-customer-1', payments[0].paymentRef),
    payments[0]
  );
  assert.deepEqual(
    { ...payments[0], paymentRef: undefined },
    {
      paymentRef: undefined,
      status: 'COMPLETED',
      currency: 'USD',
      amount: 55000,
      refundedAmount: 5000,
      completedAt: '2026-07-10T16:00:00.000Z',
    }
  );
});

test('the one-shot claim is atomic and may be released only by its owner', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  assert.equal(await store.claimOneShot('job-a'), true);
  assert.equal(await store.claimOneShot('job-b'), false);
  assert.equal(await store.releaseOneShot('job-b'), false);
  assert.equal(await store.releaseOneShot('job-a'), true);
  assert.equal(await store.claimOneShot('job-b'), true);
});

test('active upload claims are isolated per job and released for retry', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  assert.equal(await store.claimActiveUpload('job-a', 'worker-a'), true);
  assert.equal(await store.claimActiveUpload('job-a', 'worker-b'), false);
  assert.equal(await store.claimActiveUpload('job-b', 'worker-b'), true);
  assert.equal(await store.releaseActiveUpload('job-a', 'worker-b'), false);
  assert.equal(await store.releaseActiveUpload('job-a', 'worker-a'), true);
  assert.equal(await store.claimActiveUpload('job-a', 'worker-b'), true);
});

test('success records deduplicate by opaque job reference', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);

  assert.equal(await store.hasSuccess('job-sensitive'), false);
  await store.markSuccess('job-sensitive', { googleRequestId: 'request-1' });
  assert.equal(await store.hasSuccess('job-sensitive'), true);

  const serialized = JSON.stringify(kv.writes);
  assert.equal(serialized.includes('job-sensitive'), false);
  const successWrite = kv.writes.find((write) => write.key.startsWith('conv:success:'));
  assert.deepEqual(successWrite.options, {});
});
