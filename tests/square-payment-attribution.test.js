import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { createSquarePaymentHandler } from '../pages/api/webhooks/square-payment.js';
import { createResponse } from './webhook-test-helpers.js';

function request(payment = {}, overrides = {}) {
  return {
    method: 'POST',
    headers: { 'x-square-hmacsha256-signature': 'valid-signature' },
    body: {
      type: 'payment.updated',
      data: {
        object: {
          payment: {
            id: 'payment-sensitive',
            customer_id: 'customer-sensitive',
            order_id: 'order-sensitive',
            status: 'COMPLETED',
            amount_money: { amount: 55000, currency: 'USD' },
            refunded_money: { amount: 5000, currency: 'USD' },
            updated_at: '2026-07-10T16:00:00.000Z',
            ...payment,
          },
        },
      },
    },
    ...overrides,
  };
}

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

function dependencies(overrides = {}) {
  const registered = [];
  const sms = [];
  const logs = [];
  return {
    registered,
    sms,
    logs,
    values: {
      signatureKey: 'test-signature-key',
      signatureVerifier: () => true,
      coordinator: {
        async registerPayment(value, options) {
          registered.push({ value, options });
          return { status: 'observed' };
        },
      },
      httpClient: {
        async get() {
          return {
            data: {
              customer: {
                given_name: 'Private',
                family_name: 'Customer',
                email_address: 'customer@example.com',
                phone_number: '+16125550123',
              },
            },
          };
        },
      },
      smsSender: async (value) => { sms.push(value); return true; },
      reviewDedup: { has: async () => false, mark: async () => true },
      logger: {
        info: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
      operationsNotifier: async () => {},
      ...overrides,
    },
  };
}

test('signature configuration and verification are mandatory', async () => {
  const missing = dependencies({ signatureKey: '' });
  const missingRes = createResponse();
  await createSquarePaymentHandler(missing.values)(request(), missingRes);
  assert.equal(missingRes.statusCode, 500);
  assert.equal(missingRes.body.errorCode, 'SQUARE_WEBHOOK_NOT_CONFIGURED');

  const invalid = dependencies({ signatureVerifier: () => false });
  const invalidRes = createResponse();
  await createSquarePaymentHandler(invalid.values)(request(), invalidRes);
  assert.equal(invalidRes.statusCode, 401);

  const notifierFailure = dependencies({
    signatureVerifier: () => false,
    operationsNotifier: async () => { throw new Error('discord unavailable'); },
  });
  const notifierFailureRes = createResponse();
  await createSquarePaymentHandler(notifierFailure.values)(request(), notifierFailureRes);
  assert.equal(notifierFailureRes.statusCode, 401);
  assert.equal(
    notifierFailure.logs.some(([event]) => event === 'square_webhook_signature_rejection_notify_failed'),
    true
  );
});
test('completed payment.updated registers actual and refunded amounts with customer matching data', async () => {
  const deps = dependencies();
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.attributionStatus, 'observed');
  assert.equal(deps.registered.length, 1);
  assert.deepEqual(deps.registered[0].value, {
    paymentId: 'payment-sensitive',
    squareCustomerId: 'customer-sensitive',
    status: 'COMPLETED',
    currency: 'USD',
    amount: 55000,
    refundedAmount: 5000,
    completedAt: '2026-07-10T16:00:00.000Z',
  });
  assert.equal(deps.registered[0].options.customer.email, 'customer@example.com');
  assert.equal(typeof deps.registered[0].options.customer.phone, 'string');
  assert.equal(deps.registered[0].options.customer.phone.startsWith('+1'), true);
  assert.equal(deps.registered[0].options.customer.firstName, 'Private');
  assert.equal(deps.registered[0].options.customer.lastName, 'Customer');
});

test('completed payment.updated persists local attribution payment evidence with the default store path', async () => {
  const kv = createFakeKv();
  const store = createAttributionStore(kv);
  const deps = dependencies({ coordinator: undefined, kvClient: kv, mode: 'observe' });
  const res = createResponse();

  await createSquarePaymentHandler(deps.values)(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.attributionStatus, 'pending_job');
  const payments = await store.listPayments('customer-sensitive');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, 'COMPLETED');
  assert.equal(payments[0].currency, 'USD');
  assert.equal(payments[0].amount, 55000);
  assert.equal(payments[0].refundedAmount, 5000);
  assert.equal(payments[0].completedAt, '2026-07-10T16:00:00.000Z');
  assert.equal(JSON.stringify(payments).includes('payment-sensitive'), false);
  assert.equal(JSON.stringify(payments).includes('customer-sensitive'), false);
});
test('non-completed updates and unrelated events never register attribution', async () => {
  for (const req of [
    request({ status: 'PENDING' }),
    request({}, { body: { type: 'refund.updated', data: {} } }),
  ]) {
    const deps = dependencies();
    const res = createResponse();
    await createSquarePaymentHandler(deps.values)(req, res);
    assert.equal(res.body.status, 'ignored');
    assert.equal(deps.registered.length, 0);
  }
});

test('review SMS behavior is preserved through an injected sender and deduplicated separately', async () => {
  const deps = dependencies();
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(request(), res);
  assert.equal(deps.sms.length, 1);
  assert.equal(deps.sms[0].phone, '+16125550123');
  assert.equal(res.body.reviewSmsStatus, 'sent');

  const duplicate = dependencies({ reviewDedup: { has: async () => true, mark: async () => assert.fail('no mark') } });
  const duplicateRes = createResponse();
  await createSquarePaymentHandler(duplicate.values)(request(), duplicateRes);
  assert.equal(duplicate.sms.length, 0);
  assert.equal(duplicateRes.body.reviewSmsStatus, 'duplicate');
});

test('raw payload, IDs, customer PII, and payment card data never reach logs or responses', async () => {
  const deps = dependencies();
  const req = request({ card_details: { card: { last_4: '9876' } } });
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(req, res);
  const rendered = JSON.stringify({ logs: deps.logs, response: res.body });
  for (const forbidden of [
    'payment-sensitive',
    'customer-sensitive',
    'order-sensitive',
    'customer@example.com',
    '+16125550123',
    'Private',
    'Customer',
    '9876',
  ]) {
    assert.equal(rendered.includes(forbidden), false, `leaked ${forbidden}`);
  }
});
