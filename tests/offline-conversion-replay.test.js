import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { opaqueRef } from '../lib/offline-conversion-eligibility.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import {
  getReplayExitCode,
  parseReplayArgs,
  runSelectedReplay,
} from '../scripts/replay-offline-conversions.mjs';

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  const writes = [];
  return {
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
      writes.push({ operation: 'del', key });
      return values.delete(key) ? 1 : 0;
    },
    async sadd(key, ...members) {
      writes.push({ operation: 'sadd', key, members });
      const set = sets.get(key) || new Set();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) || new Set())];
    },
    async expire(key, seconds) {
      writes.push({ operation: 'expire', key, seconds });
      return 1;
    },
  };
}

async function seedCandidate(store, {
  jobId = 'job-sensitive-1',
  customerId = 'customer-sensitive-1',
  paymentId = 'payment-sensitive-1',
  completedAt = '2026-07-10T15:30:00.000Z',
  paidAt = '2026-07-10T16:00:00.000Z',
  amount = 55000,
  refundedAmount = 5000,
} = {}) {
  await store.saveJobMapping({ jobId, squareCustomerId: customerId });
  await store.savePendingJob({
    jobId,
    squareCustomerId: customerId,
    completedAt,
    consentStatus: 'GRANTED',
    consentCapturedAt: '2026-07-10T12:00:00.000Z',
    disclosureVersion: '2026-07-10',
    acquisition: {
      paidEvidence: true,
      paidMarker: 'gclid',
      hasGclid: true,
    },
  });
  await store.savePayment({
    paymentId,
    squareCustomerId: customerId,
    status: 'COMPLETED',
    currency: 'USD',
    amount,
    refundedAmount,
    completedAt: paidAt,
    webhookSignatureKeyConfigured: true,
    webhookSignatureVerified: true,
  });
  return {
    jobRef: opaqueRef(jobId),
    paymentRef: opaqueRef(paymentId),
    expectedPaymentNetAmount: amount - refundedAmount,
  };
}

function squareCustomer() {
  return {
    email_address: 'private.customer@example.com',
    phone_number: '+16125550123',
    given_name: 'Private',
    family_name: 'Customer',
  };
}

test('replay CLI defaults to selected dry-run and cannot mass apply', () => {
  const jobRef = opaqueRef('job-sensitive-1');
  const paymentRef = opaqueRef('payment-sensitive-1');
  const assertionArgs = [
    '--payment-ref',
    paymentRef,
    '--expected-net-value',
    '500.00',
  ];
  assert.deepEqual(parseReplayArgs(['--job-ref', jobRef, ...assertionArgs]), {
    mode: 'dry-run',
    selections: [{ jobRef, paymentRef, expectedPaymentNetAmount: 50000 }],
    json: false,
  });
  assert.throws(() => parseReplayArgs([]), /requires at least one --job-ref/);
  assert.throws(() => parseReplayArgs(['--apply']), /requires at least one --approve-job-ref/);
  assert.throws(
    () => parseReplayArgs(['--apply', '--job-ref', jobRef]),
    /only explicit --approve-job-ref/
  );
  assert.deepEqual(
    parseReplayArgs(['--apply', '--approve-job-ref', jobRef, ...assertionArgs]),
    {
      mode: 'apply',
      selections: [{ jobRef, paymentRef, expectedPaymentNetAmount: 50000 }],
      json: false,
    }
  );
  assert.throws(
    () => parseReplayArgs(['--job-ref', jobRef, '--payment-ref', paymentRef]),
    /one paired --payment-ref and --expected-net-value/
  );
});

test('replay CLI preserves payment and value pairing across multiple selections', () => {
  const first = {
    jobRef: opaqueRef('job-sensitive-2'),
    paymentRef: opaqueRef('payment-sensitive-2'),
  };
  const second = {
    jobRef: opaqueRef('job-sensitive-1'),
    paymentRef: opaqueRef('payment-sensitive-1'),
  };
  const parsed = parseReplayArgs([
    '--job-ref', first.jobRef,
    '--job-ref', second.jobRef,
    '--payment-ref', first.paymentRef,
    '--payment-ref', second.paymentRef,
    '--expected-net-value', '400.90',
    '--expected-net-value', '750.75',
  ]);

  assert.deepEqual(parsed.selections, [
    { ...second, expectedPaymentNetAmount: 75075 },
    { ...first, expectedPaymentNetAmount: 40090 },
  ]);
  assert.throws(
    () => parseReplayArgs([
      '--job-ref', first.jobRef,
      '--job-ref', first.jobRef,
      '--payment-ref', first.paymentRef,
      '--payment-ref', second.paymentRef,
      '--expected-net-value', '1.00',
      '--expected-net-value', '2.00',
    ]),
    /may appear only once/
  );
});

test('replay exit status fails closed when any selected job is blocked or failed', () => {
  assert.equal(getReplayExitCode({ failed: 0 }), 0);
  assert.equal(getReplayExitCode({ failed: 1 }), 1);
  assert.equal(getReplayExitCode({}), 1);

  const cli = spawnSync(
    process.execPath,
    ['scripts/replay-offline-conversions.mjs'],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /requires at least one --job-ref/);
});

test('selected dry-run proves the evidence chain without Google or KV writes', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const selection = await seedCandidate(store);
  const writesBefore = kv.writes.length;
  let uploadCalls = 0;

  const result = await runSelectedReplay({
    selections: [selection],
    store,
    mode: 'dry-run',
    fetchCustomer: async () => squareCustomer(),
    uploadConversion: async () => {
      uploadCalls += 1;
      return { success: true };
    },
  });

  assert.equal(result.ready, 1);
  assert.equal(result.results[0].status, 'ready');
  assert.deepEqual(
    result.results[0].evidence,
    ['job_mapping', 'pending_job', 'stored_payment', 'paid_gclid']
  );
  assert.equal(uploadCalls, 0);
  assert.equal(kv.writes.length, writesBefore);
});

test('selected validation calls validateOnly and never writes success or any KV state', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const selection = await seedCandidate(store);
  const writesBefore = kv.writes.length;
  const uploads = [];

  const result = await runSelectedReplay({
    selections: [selection],
    store,
    mode: 'validate',
    fetchCustomer: async () => squareCustomer(),
    uploadConversion: async (value) => {
      uploads.push(value);
      return {
        success: true,
        validated: true,
        googleRequestId: 'validation-request',
        googleJobId: 'validation-job',
      };
    },
  });

  assert.equal(result.validated, 1);
  assert.equal(result.results[0].googleRequestId, 'validation-request');
  assert.equal(result.results[0].googleJobId, 'validation-job');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].validateOnly, true);
  assert.equal(await store.hasSuccess(selection.jobRef), false);
  assert.equal(kv.writes.length, writesBefore);
});

test('apply uploads only explicitly selected approved refs and records success only there', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const approved = await seedCandidate(store);
  const unselected = await seedCandidate(store, {
    jobId: 'job-sensitive-2',
    customerId: 'customer-sensitive-2',
    paymentId: 'payment-sensitive-2',
    completedAt: '2026-07-20T15:30:00.000Z',
    paidAt: '2026-07-20T16:00:00.000Z',
  });
  const uploads = [];

  const result = await runSelectedReplay({
    selections: [approved],
    store,
    mode: 'apply',
    fetchCustomer: async () => squareCustomer(),
    uploadConversion: async (value) => {
      uploads.push(value);
      return { success: true, googleRequestId: 'apply-request' };
    },
  });

  assert.equal(result.uploaded, 1);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].orderId, approved.jobRef);
  assert.equal(uploads[0].validateOnly, false);
  assert.equal(await store.hasSuccess(approved.jobRef), true);
  assert.equal(await store.hasSuccess(unselected.jobRef), false);
});

test('apply fails closed without complete granted consent metadata while validate allows unknown', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const selection = await seedCandidate(store);
  const mapping = await store.getJobMapping(selection.jobRef);
  await store.savePendingJob({
    jobId: selection.jobRef,
    squareCustomerId: mapping.squareCustomerId,
    completedAt: '2026-07-10T15:30:00.000Z',
    consentStatus: 'UNKNOWN',
    consentCapturedAt: null,
    disclosureVersion: '2026-07-10',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
  });
  let uploadCalls = 0;
  const common = {
    selections: [selection],
    store,
    fetchCustomer: async () => squareCustomer(),
    uploadConversion: async () => {
      uploadCalls += 1;
      return { success: true };
    },
  };

  const validation = await runSelectedReplay({ ...common, mode: 'validate' });
  assert.equal(validation.results[0].status, 'validated');
  const apply = await runSelectedReplay({ ...common, mode: 'apply' });
  assert.equal(apply.results[0].status, 'consent_not_granted');
  assert.equal(uploadCalls, 1);
  assert.equal(await store.hasSuccess(selection.jobRef), false);
});

test('operator results exclude raw PII, click ids, and returned hash-like values', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const selection = await seedCandidate(store);
  const sensitiveHash = 'a'.repeat(64);
  const customer = squareCustomer();

  const result = await runSelectedReplay({
    selections: [selection],
    store,
    mode: 'apply',
    fetchCustomer: async () => customer,
    uploadConversion: async () => ({
      success: true,
      googleRequestId: sensitiveHash,
    }),
  });
  const output = JSON.stringify(result);

  for (const forbidden of [
    customer.email_address,
    customer.phone_number,
    customer.given_name,
    customer.family_name,
    'raw-click-id',
    sensitiveHash,
  ]) {
    assert.equal(output.includes(forbidden), false, `operator output leaked ${forbidden}`);
  }
});

test('replay rejects wrong payment refs and stale expected live net values without upload', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const selection = await seedCandidate(store);
  let uploadCalls = 0;
  const common = {
    store,
    mode: 'apply',
    fetchCustomer: async () => squareCustomer(),
    uploadConversion: async () => {
      uploadCalls += 1;
      return { success: true };
    },
  };

  const wrongPayment = await runSelectedReplay({
    ...common,
    selections: [{
      ...selection,
      paymentRef: opaqueRef('different-payment'),
    }],
  });
  assert.equal(wrongPayment.results[0].status, 'missing_or_mismatched_payment');

  const staleValue = await runSelectedReplay({
    ...common,
    selections: [{
      ...selection,
      expectedPaymentNetAmount: 40000,
    }],
  });
  assert.equal(staleValue.results[0].status, 'payment_value_mismatch');
  assert.equal(uploadCalls, 0);
  assert.equal(await store.hasSuccess(selection.jobRef), false);
});
