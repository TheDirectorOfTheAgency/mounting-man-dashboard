import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSquarePaymentHandler,
  notifyQInstallPost,
} from '../pages/api/webhooks/square-payment.js';
import { resetKronkiteMissingUrlLog } from '../lib/notify-install-post.mjs';
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
    followUpClaims: [],
    installPost: [],
    logs: [],
    operations: [],
    sms: [],
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
      followUpClaim: async (...args) => {
        calls.followUpClaims.push(args);
        return 'claimed';
      },
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
      webhookSignatureKeyConfigured: true,
      webhookSignatureVerified: true,
    });
  }
});

test('no-key compatibility records payment attribution as observe-only untrusted provenance', async () => {
  const deps = dependencies({ signatureKey: '', attributionMode: 'observe' });
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(paymentRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(deps.calls.attribution.length, 1);
  assert.equal(deps.calls.attribution[0].value.webhookSignatureKeyConfigured, false);
  assert.equal(deps.calls.attribution[0].value.webhookSignatureVerified, false);
});

test('no-key compatibility forces the default attribution coordinator to observe mode', async () => {
  let constructedMode = null;
  const deps = dependencies({
    signatureKey: '',
    attributionCoordinator: undefined,
    attributionMode: 'active',
    attributionStoreLoader: async () => ({ safe: true }),
    attributionCoordinatorFactory: ({ mode }) => {
      constructedMode = mode;
      return {
        async registerPayment() {
          return { status: 'observed' };
        },
      };
    },
  });
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(paymentRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(constructedMode, 'observe');
  assert.equal(res.body.attributionStatus, 'observed');
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

test('install-post notifier failure cannot suppress review SMS', async () => {
  const deps = dependencies({
    installPostNotifier: async () => { throw new Error('Kronkite exploded'); },
  });
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(paymentRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'sms_sent');
  assert.equal(deps.calls.sms.length, 1);
  assert.equal(
    deps.calls.logs.some(([event]) => event === 'square_install_post_notify_failed'),
    true,
  );
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

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.retryable, true);
  assert.equal(res.body.status, 'sms_sent');
  assert.equal(res.body.attributionStatus, 'failed');
  assert.equal(deps.calls.installPost.length, 1);
  assert.equal(deps.calls.sms.length, 1);
});

test('duplicate payment retries transient attribution failure without repeating follow-up', async () => {
  let followUpClaimed = false;
  let attributionAttempts = 0;
  const deps = dependencies({
    followUpClaim: async (...args) => {
      deps.calls.followUpClaims.push(args);
      if (followUpClaimed) return 'duplicate';
      followUpClaimed = true;
      return 'claimed';
    },
    attributionCoordinator: {
      async registerPayment() {
        attributionAttempts += 1;
        if (attributionAttempts === 1) {
          return {
            status: 'upload_failed',
            retryable: true,
            errorCode: 'GOOGLE_TRANSIENT_FAILURE',
          };
        }
        return { status: 'observed' };
      },
    },
  });
  const handler = createSquarePaymentHandler(deps.values);
  const firstRes = createResponse();
  const duplicateRes = createResponse();

  await handler(paymentRequest(), firstRes);
  await handler(paymentRequest(), duplicateRes);

  assert.equal(firstRes.statusCode, 503);
  assert.equal(firstRes.body.retryable, true);
  assert.equal(firstRes.body.attributionStatus, 'upload_failed');
  assert.equal(duplicateRes.statusCode, 200);
  assert.equal(duplicateRes.body.status, 'duplicate');
  assert.equal(duplicateRes.body.attributionStatus, 'observed');
  assert.equal(attributionAttempts, 2);
  assert.equal(deps.calls.followUpClaims.length, 2);
  assert.equal(deps.calls.installPost.length, 1);
  assert.equal(deps.calls.sms.length, 1);
});

test('unavailable follow-up claim returns retryable without sending customer follow-up', async () => {
  const deps = dependencies({
    followUpClaim: async () => 'unavailable',
    attributionCoordinator: {
      async registerPayment() {
        return {
          status: 'upload_failed',
          retryable: true,
          errorCode: 'GOOGLE_TRANSIENT_FAILURE',
        };
      },
    },
  });
  const res = createResponse();
  await createSquarePaymentHandler(deps.values)(paymentRequest(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'follow_up_claim_unavailable');
  assert.equal(res.body.retryable, true);
  assert.equal(deps.calls.installPost.length, 0);
  assert.equal(deps.calls.sms.length, 0);
});

test('concurrent duplicate deliveries permit exactly one customer follow-up', async () => {
  let claimed = false;
  const deps = dependencies({
    followUpClaim: async (...args) => {
      deps.calls.followUpClaims.push(args);
      if (claimed) return 'duplicate';
      claimed = true;
      return 'claimed';
    },
  });
  const handler = createSquarePaymentHandler(deps.values);
  const firstRes = createResponse();
  const secondRes = createResponse();

  await Promise.all([
    handler(paymentRequest(), firstRes),
    handler(paymentRequest(), secondRes),
  ]);

  assert.equal(deps.calls.installPost.length, 1);
  assert.equal(deps.calls.sms.length, 1);
  assert.deepEqual(
    [firstRes.body.status, secondRes.body.status].sort(),
    ['duplicate', 'sms_sent'],
  );
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

test('install-post notifier stages pending work and forwards once to Kronkite, not Discord', async () => {
  const writes = [];
  const setMembers = [];
  const posts = [];
  const claimed = new Set();
  const lineItems = [
    {
      name: '65 Inch TV Mounting',
      quantity: '1',
      base_price_money: { amount: 20000 },
      total_money: { amount: 20000 },
    },
  ];
  const customer = {
    given_name: 'Test',
    family_name: 'Customer',
    email_address: 'customer@example.com',
    phone_number: '+16125550123',
    address: {
      address_line_1: '123 Main St',
      locality: 'Minneapolis',
      administrative_district_level_1: 'MN',
      postal_code: '55401',
    },
  };

  const deps = {
    exists: async (key) => claimed.has(key),
    set: async (...args) => {
      claimed.add(args[0]);
      writes.push(args);
      return true;
    },
    rpush: async () => true,
    sadd: async (...args) => { setMembers.push(args); return true; },
    kronkiteUrl: 'https://kronkite.example/square-wake',
    kronkiteKey: 'kronkite-sender-key',
    httpClient: {
      async get(url) {
        assert.match(url, /\/orders\/order-1$/);
        return { data: { order: { id: 'order-1', line_items: lineItems } } };
      },
      async post(url, body, config) {
        posts.push({ url, body, headers: config?.headers || {} });
        return { data: {} };
      },
    },
  };

  const args = {
    orderId: 'order-1',
    payment: { id: 'payment-1', team_member_id: 'TMSiHOOr7RGdl2Ki', source_type: 'CARD' },
    invoice: {},
    isInvoiceEvent: false,
    eventType: 'payment.created',
    firstName: 'Test',
    lastName: 'Customer',
    customer,
    amount: '200.00',
    amountCents: 20000,
  };

  const first = await notifyQInstallPost(args, deps);
  const second = await notifyQInstallPost(args, deps);

  assert.equal(first.skipped, null);
  assert.equal(second.skipped, 'duplicate');
  assert.equal(writes.some(([key]) => key === 'install-post:pending:order-1'), true);
  assert.deepEqual(setMembers, [['install-post:pending-index', 'install-post:pending:order-1']]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://kronkite.example/square-wake');
  assert.equal(posts[0].headers['x-webhook-secret'], 'kronkite-sender-key');
  assert.equal(posts.some(({ url }) => String(url).includes('1485380804707090643')), false);
  assert.equal(posts.some(({ url }) => String(url).includes('discord.com')), false);

  const payload = posts[0].body;
  assert.deepEqual(payload, {
    city: 'Minneapolis',
    streetName: 'Main St',
    tvSize: '65"',
    tvBrand: '',
    wallSurface: '',
    mount: '',
    installationSubtotal: '$200',
    paymentId: 'payment-1',
    orderId: 'order-1',
    paymentSource: 'CARD',
    eventType: 'payment.created',
  });
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['Test Customer', '123 Main', '55401', 'customer@example.com', '+16125550123', 'kronkite-sender-key']) {
    assert.ok(!serialized.includes(forbidden), `sanitized payload leaked ${forbidden}`);
  }
});

test('unset Kronkite URL skips the wake once and still stages the phone queue', async () => {
  resetKronkiteMissingUrlLog();
  const logs = [];
  const writes = [];
  const result = await notifyQInstallPost(
    {
      orderId: 'order-skip',
      payment: { id: 'payment-skip', source_type: 'CASH' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.updated',
      firstName: 'Skip',
      lastName: 'Wake',
      customer: { address: { locality: 'Austin' } },
      amount: '150.00',
      amountCents: 15000,
    },
    {
      exists: async () => false,
      set: async (...args) => { writes.push(args); return true; },
      sadd: async () => true,
      kronkiteUrl: '',
      kronkiteKey: 'unused-key',
      logger: {
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
        error: (...args) => logs.push(['error', ...args]),
      },
      httpClient: {
        async get() { return { data: { order: { id: 'order-skip', line_items: [] } } }; },
        async post() { throw new Error('Kronkite must not be called when URL is unset'); },
      },
    },
  );

  assert.equal(result.kronkite.skipped, 'missing_url');
  assert.equal(writes.some(([key]) => key === 'install-post:pending:order-skip'), true);
  assert.equal(logs.filter(([level, msg]) => level === 'warn' && String(msg).includes('KRONKITE_SQUARE_WEBHOOK_URL unset')).length, 1);
});

test('Kronkite forward failure does not throw and maps EXTERNAL/CHECK', async () => {
  const result = await notifyQInstallPost(
    {
      orderId: 'order-ext',
      payment: { id: 'payment-ext', source_type: 'EXTERNAL', external_details: { type: 'CHECK' } },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.updated',
      firstName: 'Cash',
      lastName: 'Job',
      customer: { address: { locality: 'Houston' } },
      amount: '300.00',
      amountCents: 30000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      kronkiteUrl: 'https://kronkite.example/square-wake',
      kronkiteKey: 'kronkite-sender-key',
      httpClient: {
        async get() { return { data: { order: { id: 'order-ext', line_items: [] } } }; },
        async post() { throw new Error('kronkite down'); },
      },
    },
  );

  assert.equal(result.skipped, null);
  assert.equal(result.kronkite.forwarded, false);
  assert.equal(result.kronkitePayload.paymentSource, 'EXTERNAL/CHECK');
  assert.equal(result.kronkitePayload.city, 'Houston');
});
