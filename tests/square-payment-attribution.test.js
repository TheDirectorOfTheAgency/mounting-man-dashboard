import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSquarePaymentHandler,
  notifyQInstallPost,
} from '../pages/api/webhooks/square-payment.js';
import { createResponse } from './webhook-test-helpers.js';

function paymentRequest(eventType = 'payment.updated', payment = {}) {
  return {
    method: 'POST',
    headers: { 'x-square-hmacsha256-signature': 'valid-signature' },
    body: {
      type: eventType,
      data: {
        object: {
          payment: {
            id: 'payment-1',
            customer_id: 'customer-1',
            order_id: 'order-1',
            status: 'COMPLETED',
            amount_money: { amount: 55000, currency: 'USD' },
            refunded_money: { amount: 5000, currency: 'USD' },
            updated_at: '2026-07-10T16:00:00.000Z',
            ...payment,
          },
        },
      },
    },
  };
}

function invoiceRequest(invoice = {}) {
  return {
    method: 'POST',
    headers: { 'x-square-hmacsha256-signature': 'valid-signature' },
    body: {
      type: 'invoice.payment_made',
      data: {
        object: {
          invoice: {
            id: 'invoice-1',
            order_id: 'order-1',
            updated_at: '2026-07-10T17:00:00.000Z',
            primary_recipient: { customer_id: 'customer-1' },
            payment_requests: [
              { total_completed_amount_money: { amount: 32500, currency: 'USD' } },
            ],
            ...invoice,
          },
        },
      },
    },
  };
}

function dependencies(overrides = {}) {
  const calls = {
    attribution: [],
    installPost: [],
    logs: [],
    operations: [],
    sms: [],
    dedupSet: [],
  };
  return {
    calls,
    values: {
      readRawBody: async (req) => JSON.stringify(req.body),
      signatureKey: 'test-signature-key',
      signatureVerifier: () => true,
      httpClient: {
        async get(url) {
          assert.match(url, /\/customers\/customer-1$/);
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
      dedupExists: async () => false,
      dedupSet: async (...args) => { calls.dedupSet.push(args); return true; },
      operationsNotifier: async (message) => { calls.operations.push(message); },
      installPostNotifier: async (value) => { calls.installPost.push(value); },
      reviewSmsSender: async (value) => { calls.sms.push(value); return true; },
      attributionCoordinator: {
        async registerPayment(value, options) {
          calls.attribution.push({ value, options });
          return { status: 'observed' };
        },
      },
      logger: {
        info: (...args) => { calls.logs.push(args); },
        warn: (...args) => { calls.logs.push(args); },
      },
      ...overrides,
    },
  };
}

test('preserves origin/main optional signature configuration and validates configured signatures', async () => {
  const unconfigured = dependencies({ signatureKey: '' });
  const unconfiguredRes = createResponse();
  await createSquarePaymentHandler(unconfigured.values)(paymentRequest(), unconfiguredRes);
  assert.equal(unconfiguredRes.statusCode, 200);
  assert.equal(unconfigured.calls.sms.length, 1);

  const invalid = dependencies({ signatureVerifier: () => false });
  const invalidRes = createResponse();
  await createSquarePaymentHandler(invalid.values)(paymentRequest(), invalidRes);
  assert.equal(invalidRes.statusCode, 401);
  assert.equal(invalid.calls.installPost.length, 0);
  assert.equal(invalid.calls.sms.length, 0);

  const notifierFailure = dependencies({
    signatureVerifier: () => false,
    operationsNotifier: async () => { throw new Error('notifier unavailable'); },
  });
  const notifierFailureRes = createResponse();
  await createSquarePaymentHandler(notifierFailure.values)(paymentRequest(), notifierFailureRes);
  assert.equal(notifierFailureRes.statusCode, 401);
  assert.equal(
    notifierFailure.calls.logs.some(([event]) => event === 'square_webhook_signature_rejection_notify_failed'),
    true,
  );
});

test('payment.created and payment.updated preserve Q, review SMS, and observe-only attribution paths', async () => {
  for (const eventType of ['payment.created', 'payment.updated', 'payment.completed']) {
    const deps = dependencies();
    const res = createResponse();
    await createSquarePaymentHandler(deps.values)(paymentRequest(eventType), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'sms_sent');
    assert.equal(res.body.attributionStatus, 'observed');
    assert.equal(deps.calls.installPost.length, 1);
    assert.equal(deps.calls.sms.length, 1);
    assert.equal(deps.calls.attribution.length, 1);
    assert.deepEqual(
      deps.calls.logs.find(([event]) => event === 'square_payment_processed'),
      ['square_payment_processed', { attributionStatus: 'observed', reviewSmsStatus: 'sent' }],
    );
    assert.deepEqual(deps.calls.attribution[0].value, {
      paymentId: 'payment-1',
      squareCustomerId: 'customer-1',
      status: 'COMPLETED',
      currency: 'USD',
      amount: 55000,
      refundedAmount: 5000,
      completedAt: '2026-07-10T16:00:00.000Z',
    });
  }
});

test('partially paid invoice preserves install-post handling without synthesizing payment attribution', async () => {
  const deps = dependencies();
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(
    invoiceRequest({
      payment_requests: [
        {
          computed_amount_money: { amount: 55000, currency: 'USD' },
          total_completed_amount_money: { amount: 10000, currency: 'USD' },
        },
      ],
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'invoice_processed');
  assert.equal(res.body.amount, '100.00');
  assert.equal(res.body.attributionStatus, 'not_applicable');
  assert.equal(deps.calls.installPost.length, 1);
  assert.equal(deps.calls.installPost[0].eventType, 'invoice.payment_made');
  assert.equal(deps.calls.installPost[0].amountCents, 10000);
  assert.equal(deps.calls.sms.length, 0);
  assert.equal(deps.calls.attribution.length, 0);
});

test('paired invoice and payment events record exactly one canonical payment attribution', async () => {
  const deps = dependencies();
  const handler = createSquarePaymentHandler(deps.values);
  const invoiceRes = createResponse();
  const paymentRes = createResponse();

  await handler(invoiceRequest(), invoiceRes);
  await handler(paymentRequest(), paymentRes);

  assert.equal(invoiceRes.body.status, 'invoice_processed');
  assert.equal(invoiceRes.body.attributionStatus, 'not_applicable');
  assert.equal(paymentRes.body.status, 'sms_sent');
  assert.equal(paymentRes.body.attributionStatus, 'observed');
  assert.equal(deps.calls.attribution.length, 1);
  assert.equal(deps.calls.attribution[0].value.paymentId, 'payment-1');
});

test('attribution failure cannot suppress install-post notification or review SMS', async () => {
  const deps = dependencies({
    attributionCoordinator: {
      async registerPayment() {
        throw new Error('KV unavailable');
      },
    },
  });
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(paymentRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'sms_sent');
  assert.equal(res.body.attributionStatus, 'failed');
  assert.equal(deps.calls.installPost.length, 1);
  assert.equal(deps.calls.sms.length, 1);
});

test('duplicate payment retries transient attribution failure without repeating follow-up', async () => {
  let followUpProcessed = false;
  let attributionAttempts = 0;
  const deps = dependencies({
    dedupExists: async () => followUpProcessed,
    dedupSet: async (...args) => {
      deps.calls.dedupSet.push(args);
      followUpProcessed = true;
      return true;
    },
    attributionCoordinator: {
      async registerPayment() {
        attributionAttempts += 1;
        if (attributionAttempts === 1) throw new Error('KV unavailable');
        return { status: 'observed' };
      },
    },
  });
  const handler = createSquarePaymentHandler(deps.values);
  const firstRes = createResponse();
  const duplicateRes = createResponse();

  await handler(paymentRequest(), firstRes);
  await handler(paymentRequest(), duplicateRes);

  assert.equal(firstRes.body.attributionStatus, 'failed');
  assert.equal(duplicateRes.body.status, 'duplicate');
  assert.equal(duplicateRes.body.attributionStatus, 'observed');
  assert.equal(attributionAttempts, 2);
  assert.equal(deps.calls.dedupSet.length, 1);
  assert.equal(deps.calls.installPost.length, 1);
  assert.equal(deps.calls.sms.length, 1);
});

test('non-completed payments and unrelated events remain ignored before side effects', async () => {
  for (const req of [
    paymentRequest('payment.updated', { status: 'PENDING' }),
    { ...paymentRequest(), body: { type: 'refund.updated', data: {} } },
  ]) {
    const deps = dependencies();
    const res = createResponse();
    await createSquarePaymentHandler(deps.values)(req, res);
    assert.equal(res.body.status, 'ignored');
    assert.equal(deps.calls.installPost.length, 0);
    assert.equal(deps.calls.sms.length, 0);
    assert.equal(deps.calls.attribution.length, 0);
  }
});

test('install-post notifier generates seeds, stages pending work, queues Q, and posts to Discord', async () => {
  const writes = [];
  const queueWrites = [];
  const setMembers = [];
  const posts = [];
  const lineItems = [
    {
      name: '65 Inch TV Mounting',
      quantity: '1',
      base_price_money: { amount: 20000 },
      total_money: { amount: 20000 },
    },
  ];

  await notifyQInstallPost(
    {
      orderId: 'order-1',
      payment: { id: 'payment-1', team_member_id: 'TMSiHOOr7RGdl2Ki' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.created',
      firstName: 'Test',
      lastName: 'Customer',
      customer: {
        address: {
          address_line_1: '123 Main St',
          locality: 'Minneapolis',
          administrative_district_level_1: 'MN',
          postal_code: '55401',
        },
      },
      amount: '200.00',
      amountCents: 20000,
    },
    {
      discordBotToken: 'test-token',
      discordUserId: 'q-user',
      exists: async () => false,
      set: async (...args) => { writes.push(args); return true; },
      rpush: async (...args) => { queueWrites.push(args); return true; },
      sadd: async (...args) => { setMembers.push(args); return true; },
      httpClient: {
        async get(url) {
          assert.match(url, /\/orders\/order-1$/);
          return { data: { order: { id: 'order-1', line_items: lineItems } } };
        },
        async post(url, body) {
          posts.push({ url, body });
          return { data: {} };
        },
      },
    },
  );

  assert.equal(queueWrites.length, 1);
  assert.equal(queueWrites[0][0], 'agency:context:siri_queue');
  const queued = JSON.parse(queueWrites[0][1]);
  assert.equal(queued.from, 'square-payment-webhook');
  assert.equal(queued.orderId, 'order-1');
  assert.equal(queued.seeds.length, 1);
  assert.equal(writes.some(([key]) => key === 'install-post:pending:order-1'), true);
  assert.deepEqual(setMembers, [['install-post:pending-index', 'install-post:pending:order-1']]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /discord\.com\/api\/v10\/channels\//);
  assert.match(posts[0].body.content, /Suggested seed JSON|New job paid/);
});
