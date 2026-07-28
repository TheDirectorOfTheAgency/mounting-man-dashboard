import assert from 'node:assert/strict';
import test from 'node:test';

import { createOfflineConversionCoordinator } from '../lib/offline-conversion-coordinator.js';
import { opaqueRef } from '../lib/offline-conversion-eligibility.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';

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
      members.forEach((member) => set.add(member));
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

function job(overrides = {}) {
  return {
    jobId: 'job-1',
    squareCustomerId: 'customer-1',
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'GRANTED',
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
    email: 'customer@example.com',
    phone: '+16125550123',
    firstName: 'Private',
    lastName: 'Customer',
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    paymentId: 'payment-1',
    squareCustomerId: 'customer-1',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    refundedAmount: 5000,
    completedAt: '2026-07-10T16:00:00.000Z',
    ...overrides,
  };
}

function setup({ mode = 'one_shot', uploadResults = [{ success: true, googleRequestId: 'request-1' }] } = {}) {
  const store = createAttributionStore(createFakeKv());
  void store.saveJobMapping({ jobId: 'job-1', squareCustomerId: 'customer-1' });
  const calls = [];
  const results = [...uploadResults];
  const uploadConversion = async (value) => {
    calls.push(value);
    return results.shift() || { success: true, googleRequestId: `request-${calls.length}` };
  };
  const coordinator = createOfflineConversionCoordinator({ store, uploadConversion, mode });
  return { store, coordinator, calls };
}

test('payment-before-job cannot write later without a fresh exact payment assertion', async () => {
  const { coordinator, calls } = setup();
  assert.equal((await coordinator.registerPayment(payment())).status, 'pending_job');

  const result = await coordinator.registerJob(job());

  assert.equal(result.status, 'payment_assertion_required');
  assert.equal(calls.length, 0);
});
test('job-before-payment remains pending until the completed payment arrives', async () => {
  const { coordinator, calls } = setup();
  assert.equal((await coordinator.registerJob(job())).status, 'pending_payment');
  assert.equal(calls.length, 0);

  const result = await coordinator.registerPayment(payment(), {
    customer: { email: 'customer@example.com', phone: '+16125550123' },
  });

  assert.equal(result.status, 'uploaded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversionValue, 500);
  assert.equal(calls[0].validateOnly, false);
  assert.equal(calls[0].email, 'customer@example.com');
  assert.equal(JSON.stringify(calls[0]).includes('payment-1'), false);
});

test('zero qualifying payments stays pending', async () => {
  const { coordinator, calls } = setup();
  const result = await coordinator.registerJob(job());
  assert.equal(result.status, 'pending_payment');
  assert.equal(calls.length, 0);
});

test('observe-only matching reports multiple payments in the window as ambiguous', async () => {
  const { coordinator, calls } = setup({ mode: 'observe' });
  await coordinator.registerPayment(payment({ paymentId: 'payment-1' }));
  await coordinator.registerPayment(payment({ paymentId: 'payment-2', completedAt: '2026-07-10T17:00:00.000Z' }));

  const result = await coordinator.registerJob(job());

  assert.equal(result.status, 'ambiguous_payment');
  assert.equal(calls.length, 0);
});

test('refunds are subtracted from the amount actually collected', async () => {
  const { coordinator, calls } = setup();
  await coordinator.registerJob(job());
  await coordinator.registerPayment(
    payment({ amount: 100000, refundedAmount: 25000 }),
    { customer: job() }
  );
  assert.equal(calls[0].conversionValue, 750);
});

test('non-USD, non-completed, non-positive, and out-of-window payments do not qualify', async () => {
  for (const changed of [
    { currency: 'CAD' },
    { status: 'PENDING' },
    { amount: 5000, refundedAmount: 5000 },
    { completedAt: '2026-06-01T00:00:00.000Z' },
  ]) {
    const { coordinator, calls } = setup();
    await coordinator.registerJob(job());
    const result = await coordinator.registerPayment(payment(changed), { customer: job() });
    assert.equal(result.status, 'pending_payment');
    assert.equal(calls.length, 0);
  }
});

test('observe mode records a resolved candidate without calling Google', async () => {
  const { coordinator, calls } = setup({ mode: 'observe' });
  await coordinator.registerPayment(payment());
  const result = await coordinator.registerJob(job());
  assert.equal(result.status, 'observed');
  assert.equal(calls.length, 0);
});

test('validate mode calls Google with validateOnly and never records success', async () => {
  const { coordinator, calls, store } = setup({ mode: 'validate' });
  await coordinator.registerJob(job());
  const result = await coordinator.registerPayment(payment(), { customer: job() });
  assert.equal(result.status, 'validated');
  assert.equal(calls[0].validateOnly, true);
  assert.equal(await store.hasSuccess(result.jobRef), false);
});

test('failed one-shot upload releases its claim for a later retry', async () => {
  const { coordinator, calls } = setup({
    uploadResults: [
      { success: false, retryable: true, errorCode: 'GOOGLE_TRANSIENT_FAILURE' },
      { success: true, googleRequestId: 'request-2' },
    ],
  });
  await coordinator.registerJob(job());
  assert.equal(
    (await coordinator.registerPayment(payment(), { customer: job() })).status,
    'upload_failed'
  );
  assert.equal(
    (await coordinator.registerPayment(payment(), { customer: job() })).status,
    'uploaded'
  );
  assert.equal(calls.length, 2);
});

test('an existing success record prevents duplicate upload', async () => {
  const { coordinator, calls, store } = setup();
  await coordinator.registerJob(job());
  const first = await coordinator.registerPayment(payment(), { customer: job() });
  assert.equal(first.status, 'uploaded');
  assert.equal(await store.hasSuccess(first.jobRef), true);

  const second = await coordinator.registerPayment(payment(), { customer: job() });
  assert.equal(second.status, 'already_uploaded');
  assert.equal(calls.length, 1);
});

test('continuous mode uploads every eligible paid job and deduplicates duplicate events by success', async () => {
  const { coordinator, calls, store } = setup({ mode: 'continuous' });
  void store.saveJobMapping({ jobId: 'job-2', squareCustomerId: 'customer-2' });

  await coordinator.registerJob(job());
  assert.equal(
    (await coordinator.registerPayment(payment(), { customer: job() })).status,
    'uploaded'
  );
  assert.equal(
    (await coordinator.registerPayment(payment(), { customer: job() })).status,
    'already_uploaded'
  );

  await coordinator.registerJob(job({
    jobId: 'job-2',
    squareCustomerId: 'customer-2',
    completedAt: '2026-07-20T15:30:00.000Z',
  }));
  assert.equal((await coordinator.registerPayment(payment({
    paymentId: 'payment-2',
    squareCustomerId: 'customer-2',
    completedAt: '2026-07-20T16:00:00.000Z',
  }), { customer: job() })).status, 'uploaded');

  assert.equal(calls.length, 2);
});

test('active alias retries transient and partial failures without recording success', async () => {
  const { coordinator, calls, store } = setup({
    mode: 'active',
    uploadResults: [
      { success: false, retryable: true, errorCode: 'GOOGLE_TRANSIENT_FAILURE' },
      { success: false, retryable: false, errorCode: 'GOOGLE_PARTIAL_FAILURE' },
      { success: true, googleRequestId: 'request-3' },
    ],
  });
  await coordinator.registerJob(job());

  const transient = await coordinator.registerPayment(payment(), { customer: job() });
  assert.equal(transient.status, 'upload_failed');
  assert.equal(transient.retryable, true);
  assert.equal(await store.hasSuccess(transient.jobRef), false);

  const partial = await coordinator.registerPayment(payment(), { customer: job() });
  assert.equal(partial.status, 'upload_failed');
  assert.equal(partial.errorCode, 'GOOGLE_PARTIAL_FAILURE');
  assert.equal(await store.hasSuccess(partial.jobRef), false);

  assert.equal(
    (await coordinator.registerPayment(payment(), { customer: job() })).status,
    'uploaded'
  );
  assert.equal(calls.length, 3);
});

test('concurrent continuous duplicates permit only one in-flight upload', async () => {
  const store = createAttributionStore(createFakeKv());
  await store.saveJobMapping({ jobId: 'job-1', squareCustomerId: 'customer-1' });
  let releaseUpload;
  const uploadStarted = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  let calls = 0;
  const coordinator = createOfflineConversionCoordinator({
    store,
    mode: 'continuous',
    uploadConversion: async () => {
      calls += 1;
      await uploadStarted;
      return { success: true, googleRequestId: 'request-1' };
    },
  });
  await coordinator.registerJob(job());

  const first = coordinator.registerPayment(payment(), { customer: job() });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await coordinator.registerPayment(payment(), { customer: job() });
  releaseUpload();

  assert.equal(second.status, 'upload_in_progress');
  assert.equal(second.retryable, true);
  assert.equal((await first).status, 'uploaded');
  assert.equal(calls, 1);
});

test('automatic payment registration binds only the exact incoming payment event', async () => {
  const { coordinator, calls, store } = setup({ mode: 'continuous' });
  await store.savePendingJob(job());
  await store.savePayment(payment({
    paymentId: 'stale-window-payment',
    amount: 90000,
    refundedAmount: 15000,
  }));

  const result = await coordinator.registerPayment(
    payment({
      paymentId: 'incoming-payment',
      amount: 50000,
      refundedAmount: 10000,
    }),
    { customer: job() }
  );

  assert.equal(result.status, 'uploaded');
  assert.equal(result.paymentRef, opaqueRef('incoming-payment'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversionValue, 400);
});

test('continuous mode fails closed when mapping or paid click evidence is missing', async () => {
  const withoutMapping = createAttributionStore(createFakeKv());
  const noMapCoordinator = createOfflineConversionCoordinator({
    store: withoutMapping,
    mode: 'continuous',
    uploadConversion: async () => assert.fail('must not upload'),
  });
  await noMapCoordinator.registerPayment(payment());
  assert.equal(
    (await noMapCoordinator.registerJob(job())).status,
    'missing_or_mismatched_mapping'
  );

  const { coordinator, calls } = setup({ mode: 'continuous' });
  await coordinator.registerPayment(payment());
  assert.equal(
    (await coordinator.registerJob(job({
      acquisition: {
        paidEvidence: true,
        paidMarker: 'paid_medium',
        mediumClass: 'cpc',
      },
    }))).status,
    'missing_paid_click_evidence'
  );
  assert.equal(calls.length, 0);
});
