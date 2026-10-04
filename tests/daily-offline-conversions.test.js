import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAdUserDataConsent } from '../lib/ad-user-data-consent.js';
import {
  createDailyUploadLedger,
  prepareDailyOrders,
  runDailyOfflineConversions,
} from '../lib/daily-offline-conversions.js';
import { netCentsFromSquarePayment, netJobValueCents, roundCents } from '../lib/offline-conversion-value.js';
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

function payment(overrides = {}) {
  return {
    id: 'payment-1',
    order_id: 'order-1',
    customer_id: 'customer-1',
    status: 'COMPLETED',
    amount_money: { amount: 10000, currency: 'USD' },
    tip_money: { amount: 1500, currency: 'USD' },
    total_money: { amount: 11500, currency: 'USD' },
    refunded_money: { amount: 0, currency: 'USD' },
    updated_at: '2026-10-04T18:29:57.000Z',
    ...overrides,
  };
}

const usCustomer = {
  email_address: 'Validation.Only+test@gmail.com',
  phone_number: '(612) 555-0123',
  address: { country: 'US' },
};

test('net value excludes tips, subtracts refunds, and rounds to cents', () => {
  assert.equal(roundCents(100.4), 100);
  assert.equal(roundCents(100.5), 101);
  assert.equal(roundCents('1,500.6'), 1501);
  assert.equal(netJobValueCents({
    amountCents: 11500.4,
    tipCents: 1499.6,
    refundCents: 500.2,
    amountIncludesTip: true,
  }), 11500 - 1500 - 500);

  const withTipOnAmountMoney = netCentsFromSquarePayment(payment());
  assert.equal(withTipOnAmountMoney, 10000);

  const refunded = netCentsFromSquarePayment(payment({
    refunded_money: { amount: 2500, currency: 'USD' },
  }));
  assert.equal(refunded, 7500);

  const totalOnly = netCentsFromSquarePayment({
    status: 'COMPLETED',
    total_money: { amount: 11500, currency: 'USD' },
    tip_money: { amount: 1500, currency: 'USD' },
    refunded_money: { amount: 500, currency: 'USD' },
  });
  assert.equal(totalOnly, 9500);
});

test('US paid jobs are GRANTED and ad_personalization is not part of the decision', () => {
  assert.equal(resolveAdUserDataConsent({ countryCode: 'US', paid: true }), 'GRANTED');
  assert.equal(resolveAdUserDataConsent({ countryCode: 'USA', paid: true }), 'GRANTED');
  assert.equal(resolveAdUserDataConsent({ countryCode: '', paid: true }), 'GRANTED');
  assert.equal(resolveAdUserDataConsent({ countryCode: 'CA', paid: true }), null);
  assert.equal(resolveAdUserDataConsent({ countryCode: 'US', paid: false }), null);
  assert.equal(
    resolveAdUserDataConsent({ countryCode: 'US', paid: true, explicitStatus: 'DENIED' }),
    'DENIED',
  );
});

test('daily preparation uploads the net Square amount with hashed identifier types', () => {
  const { prepared, rejected } = prepareDailyOrders({
    payments: [
      payment(),
      payment({
        id: 'payment-ca',
        order_id: 'order-ca',
        customer_id: 'customer-ca',
      }),
      payment({
        id: 'payment-denied',
        order_id: 'order-denied',
        customer_id: 'customer-denied',
        refunded_money: { amount: 200, currency: 'USD' },
      }),
    ],
    customersById: {
      'customer-1': usCustomer,
      'customer-ca': { ...usCustomer, address: { country: 'CA' } },
      'customer-denied': usCustomer,
    },
    explicitStatusByOrderId: { 'order-denied': 'DENIED' },
  });

  assert.equal(rejected.find((row) => row.orderId === 'order-ca').reason, 'not_us_paid');
  assert.equal(rejected.find((row) => row.orderId === 'order-denied').reason, 'consent_denied');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].upload.conversionValue, 100);
  assert.equal(prepared[0].upload.consentStatus, 'GRANTED');
  assert.equal(prepared[0].upload.orderId, 'order-1');
  assert.equal(prepared[0].summary.conversionTime, '2026-10-04 18:29:57+00:00');
  assert.deepEqual(prepared[0].summary.identifierTypes, ['hashed_email', 'hashed_phone']);
  assert.equal(prepared[0].upload.gclid, null);
});

test('gclid is included when the payment carries one', () => {
  const { prepared } = prepareDailyOrders({
    payments: [payment({ gclid: 'click-1', gbraid: 'braid-1' })],
    customersById: { 'customer-1': usCustomer },
  });
  assert.equal(prepared[0].upload.gclid, 'click-1');
  assert.equal(prepared[0].upload.gbraid, null);
  assert.deepEqual(prepared[0].summary.identifierTypes, ['hashed_email', 'hashed_phone', 'gclid']);
});

test('daily upload is idempotent and records Google partial failures without a second upload', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  const calls = [];
  const uploadConversion = async (value) => {
    calls.push(value);
    if (calls.length === 1) {
      return {
        success: false,
        partialFailureError: {
          message: 'partial',
          details: [{
            errors: [{
              errorCode: { conversionUploadError: 'INVALID_CONVERSION_ACTION' },
              message: 'action rejected',
            }],
          }],
        },
      };
    }
    return { success: true, googleRequestId: 'request-1' };
  };
  const payments = [payment({
    refunded_money: { amount: 500, currency: 'USD' },
  })];
  const customersById = { 'customer-1': usCustomer };

  const failed = await runDailyOfflineConversions({
    payments,
    customersById,
    ledger,
    uploadConversion,
  });
  assert.equal(failed.uploadedCount, 0);
  assert.equal(failed.errors[0].error.includes('action rejected'), true);
  assert.equal(calls.length, 1);

  const uploaded = await runDailyOfflineConversions({
    payments,
    customersById,
    ledger,
    uploadConversion,
  });
  assert.equal(uploaded.uploadedCount, 1);
  assert.equal(uploaded.totalValue, 95);
  assert.equal(uploaded.orders[0].orderId, 'order-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].validateOnly, false);
  assert.equal(calls[1].consentStatus, 'GRANTED');

  const duplicate = await runDailyOfflineConversions({
    payments,
    customersById,
    ledger,
    uploadConversion,
  });
  assert.equal(duplicate.uploadedCount, 0);
  assert.equal(duplicate.skipped[0].reason, 'already_uploaded');
  assert.equal(calls.length, 2);
});

test('a Google 403 stops the batch and keeps the permission error', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  let calls = 0;
  const result = await runDailyOfflineConversions({
    payments: [
      payment(),
      payment({ id: 'payment-2', order_id: 'order-2' }),
    ],
    customersById: { 'customer-1': usCustomer },
    ledger,
    uploadConversion: async () => {
      calls += 1;
      return {
        success: false,
        httpStatus: 403,
        googleStatus: 'PERMISSION_DENIED',
        googleMessage: 'The caller does not have permission',
        errorCode: 'GOOGLE_REQUEST_FAILURE',
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.uploadedCount, 0);
  assert.match(result.errors[0].error, /403 PERMISSION_DENIED/);
  assert.match(result.errors[0].error, /does not have permission/);
});

test('validateOnly does not record success, so a later real run can upload', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  const calls = [];
  const uploadConversion = async (value) => {
    calls.push(value);
    return { success: true, googleRequestId: 'request-dry' };
  };
  const args = {
    payments: [payment()],
    customersById: { 'customer-1': usCustomer },
    ledger,
    uploadConversion,
  };
  const dry = await runDailyOfflineConversions({ ...args, validateOnly: true });
  assert.equal(dry.validateOnly, true);
  assert.equal(dry.uploadedCount, 1);
  assert.equal(calls[0].validateOnly, true);
  const real = await runDailyOfflineConversions(args);
  assert.equal(real.uploadedCount, 1);
  assert.equal(calls.length, 2);
});

test('a job the existing hook already uploaded is not sent again', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  await store.saveJobMapping({ jobId: 'job-1', squareCustomerId: 'customer-1' });
  await store.savePendingJob({
    jobId: 'job-1',
    squareCustomerId: 'customer-1',
    completedAt: '2026-10-04T18:00:00.000Z',
    consentStatus: 'UNKNOWN',
    acquisition: { paidEvidence: true, paidMarker: 'gclid', hasGclid: true },
  });
  const saved = await store.listPendingJobs('customer-1');
  await store.markSuccess(saved[0].jobRef, { googleRequestId: 'hook-request' });

  let calls = 0;
  const result = await runDailyOfflineConversions({
    payments: [payment()],
    customersById: { 'customer-1': usCustomer },
    store,
    ledger: createDailyUploadLedger(kv),
    uploadConversion: async () => {
      calls += 1;
      return { success: true };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.skipped[0].reason, 'already_uploaded');
});
